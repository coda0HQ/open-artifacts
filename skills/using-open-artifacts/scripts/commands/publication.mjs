import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ensureGitignored,
  findEntry,
  loadConfig,
  loadCredentials,
  loadManifest,
  mutateCredentials,
  mutateManifest,
  normalizeManifest,
  readJson,
  resolveAuthToken,
} from "../lib/cli-state.mjs";
import {
  decryptContent,
  generateChannelToken,
} from "../lib/content-crypto.mjs";
import { hookInstalled } from "../lib/hooks.mjs";
import { CREDENTIALS_PATH, MANIFEST, PROJECT_ROOT } from "../lib/paths.mjs";
import { loadRecipe } from "../lib/recipe.mjs";
import {
  prepareRecipePayload,
  recipeMetadataForEntry,
  recipeSnapshot,
} from "../lib/recipe-payload.mjs";
import { request } from "../lib/transport.mjs";
import { credentialEnvName } from "../lib/validation.mjs";
import { checkpointLiveDraft, saveLiveDraft } from "./live.mjs";
import { commandMigrate } from "./migrate.mjs";

export async function commandCreate(recipePath, flags) {
  const config = loadConfig(flags);
  if (!config.authToken) {
    console.error(
      "tip: no auth token configured; if this instance requires login, run the CLI's `login --provider google` command first (references/auth.md)",
    );
  }
  const { artifact, build, password, payload } = await prepareRecipePayload(
    recipePath,
    flags,
  );
  const channel = artifact.channel;

  if (channel) {
    let channelToken;
    mutateCredentials((credentials) => {
      credentials.channels[channel] ??= generateChannelToken();
      channelToken = credentials.channels[channel];
    });
    payload.channel = channelToken;
  }

  const orgId = flags.org ?? artifact.org ?? null;
  const visibility =
    flags.visibility ??
    artifact.visibility ??
    (config.authToken?.startsWith("sk_") ? "private" : undefined);
  if (orgId) payload.orgId = orgId;
  if (visibility) payload.visibility = visibility;

  const { status, json } = await request(
    "POST",
    `${config.apiUrl}/api/artifacts`,
    payload,
    config.authToken,
  );
  if (status !== 201 && status !== 200) {
    const hint =
      status === 401
        ? " - run the CLI's `login` command to authenticate to this instance (references/auth.md)"
        : "";
    throw new Error(
      `create failed (${status}): ${json.error ?? "unknown error"}${hint}`,
    );
  }

  const matchEntry = (entry) =>
    entry.id === json.id ||
    (channel && recipeMetadataForEntry(entry).channel === channel);
  const entry = {
    id: json.id,
    url: json.url,
    version: json.version,
    recipe: build.loaded.projectPath,
    recipeHash: `sha256:${build.loaded.recipeHash}`,
    inputHash: `sha256:${build.inputHash}`,
    outputHash: `sha256:${build.outputHash}`,
    strategy: build.plan.strategy,
    autoUpdate: artifact.autoUpdate,
    snapshot: recipeSnapshot(build),
    updatedAt: new Date().toISOString(),
  };
  if (visibility) entry.visibility = visibility;
  if (orgId) entry.orgId = orgId;
  const otherManifestPath = artifact.local ? MANIFEST.shared : MANIFEST.local;
  if (existsSync(otherManifestPath)) {
    mutateManifest(!artifact.local, (manifest) => {
      manifest.artifacts = manifest.artifacts.filter(
        (candidate) => !matchEntry(candidate),
      );
    });
  }
  mutateManifest(artifact.local, (manifest) => {
    const existingIndex = manifest.artifacts.findIndex(matchEntry);
    if (existingIndex >= 0) manifest.artifacts[existingIndex] = entry;
    else manifest.artifacts.push(entry);
  });
  if (artifact.local || password) ensureGitignored();

  if (json.writeToken || password) {
    mutateCredentials((credentials) => {
      if (json.writeToken) credentials.tokens[json.id] = json.writeToken;
      if (password) {
        credentials.passwords[json.id] = password;
        credentials.namedPasswords[
          build.loaded.recipe.security.passwordCredential
        ] = password;
      }
    });
  }

  if (
    process.env.CLAUDE_PROJECT_DIR &&
    artifact.watch.length > 0 &&
    !hookInstalled(process.env.CLAUDE_PROJECT_DIR)
  ) {
    console.error(
      'tip: run the CLI\'s "install-hook" command to flag this artifact stale automatically when its watched files change',
    );
  }

  console.log(json.url);
  const verb = status === 200 ? "updated" : "published";
  console.error(
    `${verb} artifact ${json.id} (version ${json.version}, ${build.plan.strategy} Recipe build)`,
  );
  if (channel)
    console.error(`channel "${channel}" → stable URL across updates`);
  if (password) {
    console.error("password protected: share the URL and password separately");
  }
  if (json.liveSupported === true && config.authToken?.startsWith("sk_")) {
    console.error(
      `live mode: this instance supports live editing. Start the watcher and keep it running: ` +
        `node artifact.mjs live ${json.id} --watch — the user opens ${json.url}, clicks Live, picks ` +
        `elements, types a change for each, and submits. Your watcher prints each generate event; ` +
        `the viewer's Live button shows Connected while it is online (references/live.md).`,
    );
  }
}

export async function commandUpdate(
  id,
  recipePath,
  flags,
  inPlace = flags.live === true,
) {
  const config = loadConfig(flags);
  const entry = findEntry(loadManifest(), id);
  const token = loadCredentials().tokens[id];
  if (!token)
    throw new Error(`no write token for ${id} in ${CREDENTIALS_PATH}`);
  const sourceRecipe = recipePath ?? entry.recipe;
  if (!sourceRecipe) {
    const migratedRecipe = await commandMigrate(id, flags);
    return commandUpdate(id, migratedRecipe, flags, inPlace);
  }
  const { artifact, build, password, payload } = await prepareRecipePayload(
    sourceRecipe,
    flags,
    id,
  );
  let json;
  let draft = null;
  if (inPlace) {
    if (flags.force) {
      throw new Error(
        "--force cannot be used with --live; Live drafts use revision CAS",
      );
    }
    draft = await saveLiveDraft({
      artifactId: id,
      apiUrl: config.apiUrl,
      baseVersion: entry.version,
      payload,
      capability: token,
      request,
    });
    json = { url: entry.url, version: entry.version };
  } else {
    if (!flags.force) payload.baseVersion = entry.version;
    if (flags.force) payload.force = true;
    const response = await request(
      "PUT",
      `${config.apiUrl}/api/artifacts/${id}`,
      payload,
      token,
    );
    if (response.status === 409) {
      throw new Error(
        `version conflict: server is at version ${response.json.currentVersion}, manifest recorded ${entry.version}. ` +
          "Someone else updated this artifact. Re-run with --force to overwrite.",
      );
    }
    if (response.status !== 200) {
      throw new Error(
        `update failed (${response.status}): ${response.json.error ?? "unknown error"}`,
      );
    }
    json = response.json;
  }

  const nextEntry = {
    id,
    url: json.url ?? entry.url,
    version: json.version,
    recipe: build.loaded.projectPath,
    recipeHash: `sha256:${build.loaded.recipeHash}`,
    inputHash: `sha256:${build.inputHash}`,
    outputHash: `sha256:${build.outputHash}`,
    strategy: build.plan.strategy,
    autoUpdate: artifact.autoUpdate,
    snapshot: recipeSnapshot(build),
    updatedAt: new Date().toISOString(),
  };
  if (draft) {
    nextEntry.draft = {
      revision: draft.revision,
      baseVersion: draft.baseVersion,
      state: draft.state,
      updatedAt: draft.updatedAt,
    };
  }
  const otherManifestPath = artifact.local ? MANIFEST.shared : MANIFEST.local;
  if (existsSync(otherManifestPath)) {
    mutateManifest(!artifact.local, (manifest) => {
      manifest.artifacts = manifest.artifacts.filter(
        (candidate) => candidate.id !== id,
      );
    });
  }
  mutateManifest(artifact.local, (manifest) => {
    manifest.artifacts = manifest.artifacts.filter(
      (candidate) => candidate.id !== id,
    );
    manifest.artifacts.push(nextEntry);
  });
  if (password) {
    mutateCredentials((credentials) => {
      credentials.passwords[id] = password;
      credentials.namedPasswords[
        build.loaded.recipe.security.passwordCredential
      ] = password;
    });
  }
  if (artifact.local || password) ensureGitignored();

  console.log(json.url ?? entry.url);
  if (draft) {
    console.error(
      `saved Live draft revision ${draft.revision} based on published version ${entry.version} (${build.plan.strategy} Recipe build)`,
    );
  } else {
    console.error(
      `updated artifact ${id} to version ${json.version} (${build.plan.strategy} Recipe build)`,
    );
  }
}

export async function commandDelete(id, flags) {
  const config = loadConfig(flags);
  findEntry(loadManifest(), id);
  const token = loadCredentials().tokens[id];
  if (!token)
    throw new Error(`no write token for ${id} in ${CREDENTIALS_PATH}`);
  const { status, json } = await request(
    "DELETE",
    `${config.apiUrl}/api/artifacts/${id}`,
    undefined,
    token,
  );
  if (status !== 200) {
    throw new Error(
      `delete failed (${status}): ${json.error ?? "unknown error"}`,
    );
  }
  for (const local of [false, true]) {
    const path = local ? MANIFEST.local : MANIFEST.shared;
    if (!existsSync(path)) continue;
    mutateManifest(local, (manifest) => {
      manifest.artifacts = manifest.artifacts.filter(
        (entry) => entry.id !== id,
      );
    });
  }
  mutateCredentials((credentials) => {
    delete credentials.tokens[id];
    if (credentials.passwords) delete credentials.passwords[id];
  });
  console.error(`deleted artifact ${id}`);
}

export async function commandShow(id, flags) {
  const config = loadConfig(flags);
  const credentials = loadCredentials();
  const token = resolveAuthToken(flags) ?? credentials.tokens[id];
  const url = `${config.apiUrl}/api/artifacts/${id}/raw${
    flags.v ? `?v=${flags.v}` : ""
  }`;
  const { status, json, text } = await request("GET", url, undefined, token);
  if (status !== 200) {
    throw new Error(
      `show failed (${status}): ${json.error ?? "unknown error"}`,
    );
  }
  const isEncrypted = json.alg === "AES-GCM" && json.ciphertext !== undefined;
  if (!isEncrypted) {
    process.stdout.write(text);
    return;
  }
  const entry = loadManifest().artifacts.find(
    (candidate) => candidate.id === id,
  );
  let credentialName = null;
  if (entry?.recipe) {
    try {
      credentialName = loadRecipe(resolve(PROJECT_ROOT, entry.recipe), {
        projectRoot: PROJECT_ROOT,
      }).recipe.security.passwordCredential;
    } catch {
      credentialName = null;
    }
  }
  const password =
    flags.password ??
    (credentialName
      ? process.env[credentialEnvName(credentialName)]
      : undefined) ??
    (credentialName ? credentials.namedPasswords[credentialName] : undefined) ??
    credentials.passwords?.[id];
  if (!password) {
    throw new Error(
      "this artifact is encrypted; pass --password or have stored it at create time (credentials.json, gitignored)",
    );
  }
  process.stdout.write(await decryptContent(json, password));
}

export async function commandLiveCheckpoint(id, flags) {
  const config = loadConfig(flags);
  const entry = findEntry(loadManifest(), id);
  const capability = loadCredentials().tokens[id] ?? config.authToken;
  if (!capability) {
    throw new Error(
      `no write token for ${id} in ${CREDENTIALS_PATH} and no manager login is configured`,
    );
  }
  const publication = await checkpointLiveDraft({
    artifactId: id,
    apiUrl: config.apiUrl,
    capability,
    request,
  });
  const localManifest = normalizeManifest(
    readJson(MANIFEST.local, { artifacts: [] }),
  );
  const local = localManifest.artifacts.some(
    (candidate) => candidate.id === id,
  );
  mutateManifest(local, (manifest) => {
    const index = manifest.artifacts.findIndex(
      (candidate) => candidate.id === id,
    );
    if (index < 0) {
      throw new Error(`manifest entry disappeared while checkpointing ${id}`);
    }
    const current = manifest.artifacts[index];
    manifest.artifacts[index] = {
      ...current,
      url: publication.url ?? current.url,
      version: publication.version,
      draft: {
        revision: publication.draftRevision ?? current.draft?.revision,
        baseVersion: current.draft?.baseVersion ?? entry.version,
        state: "checkpointed",
        checkpointVersion: publication.version,
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
  });
  console.log(publication.url ?? entry.url);
  console.error(
    `checkpointed Live draft revision ${publication.draftRevision ?? entry.draft?.revision ?? "unknown"} as immutable version ${publication.version}`,
  );
}
