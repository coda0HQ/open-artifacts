#!/usr/bin/env node
// Open Artifacts publishing CLI. Zero dependencies; requires Node >= 22.
// Used by the "artifacts" agent skill; also usable by humans.

import { createHash, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildArtifactRecipe,
  recipeBuildSummary,
  writeArtifactPreview,
} from "./build-artifact.mjs";
import { CANVAS_MARKERS, loadCanvasRuntime } from "./lib/compose.mjs";
import { loadRecipe, resolveWatchFiles } from "./lib/recipe.mjs";
import { MAX_CONTENT_BYTES } from "./lib/validate.mjs";

const PBKDF2_ITERATIONS = 600_000;
const PROJECT_ROOT = process.cwd();
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS_DIR = ".artifacts";
// *.local.* siblings mirror Claude Code's .claude/settings.local.json +
// CLAUDE.local.md convention: machine-local, gitignored, merged over the
// committed sibling at read time (local wins). Only state files get a local
// variant — credentials is already gitignored, and content lives on the
// server, so neither needs one.
const filePair = (base) => ({
  shared: join(ARTIFACTS_DIR, `${base}.json`),
  local: join(ARTIFACTS_DIR, `${base}.local.json`),
});
const MANIFEST = filePair("manifest");
const CONFIG = filePair("config");
const CREDENTIALS_PATH = join(ARTIFACTS_DIR, "credentials.json");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function loadConfig(flags) {
  const project = {
    ...readJson(CONFIG.shared, {}),
    ...readJson(CONFIG.local, {}),
  };
  const global = readJson(
    join(homedir(), ".config/open-artifacts/config.json"),
    {},
  );
  const apiUrl =
    flags.api ??
    process.env.OPEN_ARTIFACTS_URL ??
    project.apiUrl ??
    global.apiUrl;
  const createToken =
    process.env.OPEN_ARTIFACTS_TOKEN ??
    project.createToken ??
    global.createToken;
  if (!apiUrl) {
    fail(
      'no instance configured. Set OPEN_ARTIFACTS_URL, pass --api <url>, or write .artifacts/config.json {"apiUrl": "https://..."}',
    );
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ""), createToken };
}

// Merge shared + local manifest entries. Keyed by id only: a local entry with
// the same id replaces the shared one, local entries with new ids are appended
// (matching settings.local.json "local overrides project" semantics). A
// channel can't span both files with different ids in practice — create-time
// migration (commandCreate) keeps each id/channel in exactly one file — so
// id-keyed dedup is the only merge path that actually occurs.
function mergeArtifacts(shared, local) {
  const byId = new Map();
  for (const entry of shared) byId.set(entry.id, entry);
  for (const entry of local) byId.set(entry.id, entry);
  return [...byId.values()];
}

function normalizeManifest(value) {
  return {
    manifestVersion: value.manifestVersion ?? 1,
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
  };
}

function loadManifest() {
  const shared = normalizeManifest(
    readJson(MANIFEST.shared, { artifacts: [] }),
  );
  const local = normalizeManifest(readJson(MANIFEST.local, { artifacts: [] }));
  return {
    manifestVersion: Math.max(shared.manifestVersion, local.manifestVersion),
    artifacts: mergeArtifacts(shared.artifacts, local.artifacts),
  };
}

function saveManifest(manifest, local) {
  writeJson(local ? MANIFEST.local : MANIFEST.shared, {
    manifestVersion: 2,
    artifacts: manifest.artifacts,
  });
}

function loadCredentials() {
  const value = readJson(CREDENTIALS_PATH, {});
  return {
    ...value,
    tokens: value.tokens ?? {},
    channels: value.channels ?? {},
    passwords: value.passwords ?? {},
    namedPasswords: value.namedPasswords ?? {},
  };
}

function saveCredentials(credentials) {
  writeJson(CREDENTIALS_PATH, credentials);
  ensureGitignored();
}

// Resolve which manifest file (shared vs local) an entry currently lives in.
// Used by update/delete/ack/auto-update to write back to the right file
// without persisting an origin tag on the entry.
function manifestFileForId(id) {
  if (
    normalizeManifest(
      readJson(MANIFEST.local, { artifacts: [] }),
    ).artifacts.some((a) => a.id === id)
  ) {
    return {
      local: true,
      manifest: normalizeManifest(readJson(MANIFEST.local, { artifacts: [] })),
    };
  }
  return {
    local: false,
    manifest: normalizeManifest(readJson(MANIFEST.shared, { artifacts: [] })),
  };
}

function ensureGitignored() {
  if (!existsSync(".git")) return;
  // credentials.json is always gitignored. The *.local.* siblings are
  // gitignored only when they actually exist (created by a --local write),
  // so we never gitignore speculative patterns a repo doesn't use.
  const lines = [".artifacts/credentials.json"];
  if (existsSync(MANIFEST.local)) lines.push(".artifacts/manifest.local.json");
  if (existsSync(CONFIG.local)) lines.push(".artifacts/config.local.json");
  if (existsSync(join(ARTIFACTS_DIR, "recipes.local"))) {
    lines.push(".artifacts/recipes.local/");
  }
  if (existsSync(join(ARTIFACTS_DIR, "fragments.local"))) {
    lines.push(".artifacts/fragments.local/");
  }
  if (existsSync(join(ARTIFACTS_DIR, "previews"))) {
    lines.push(".artifacts/previews/");
  }
  const current = existsSync(".gitignore")
    ? readFileSync(".gitignore", "utf8")
    : "";
  const existing = new Set(current.split("\n").map((l) => l.trim()));
  const missing = lines.filter((l) => !existing.has(l));
  if (missing.length === 0) return;
  writeFileSync(
    ".gitignore",
    `${current.replace(/\n*$/, "\n")}${missing.join("\n")}\n`,
  );
  for (const line of missing)
    console.error(`note: added ${line} to .gitignore`);
}

const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");
const fromBase64 = (str) => new Uint8Array(Buffer.from(str, "base64"));

async function encryptContent(plaintext, password) {
  const subtle = webcrypto.subtle;
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    content: toBase64(new Uint8Array(ciphertext)),
    encrypted: {
      salt: toBase64(salt),
      iv: toBase64(iv),
      iterations: PBKDF2_ITERATIONS,
    },
  };
}

// Symmetric inverse of encryptContent. The server's /raw endpoint returns
// {alg, kdf, iterations, salt, iv, ciphertext} for encrypted artifacts; this
// recovers the plaintext so an agent updating a password-protected artifact
// can read back the current page (e.g. a locked design-direction comment)
// without a local source copy. The password is read from credentials.json
// (gitignored, machine-local) so the agent does not re-prompt the user.
async function decryptContent(payload, password) {
  const subtle = webcrypto.subtle;
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const iterations = payload.iterations;
  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    fromBase64(payload.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function snapshotWatch(globs) {
  return snapshotResolvedFiles(resolveWatchFiles(globs, PROJECT_ROOT));
}

function snapshotResolvedFiles(files) {
  const snapshot = {};
  for (const file of files.sort((a, b) =>
    a.projectPath.localeCompare(b.projectPath),
  )) {
    snapshot[file.projectPath] = sha256(readFileSync(file.real));
  }
  return snapshot;
}

function diffSnapshot(previous, current) {
  const changed = [];
  for (const [path, hash] of Object.entries(current)) {
    if (previous[path] !== hash) changed.push(path);
  }
  for (const path of Object.keys(previous)) {
    if (!(path in current)) changed.push(`${path} (deleted)`);
  }
  return changed;
}

async function request(method, url, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    fail(`cannot reach ${url}: ${cause.message}`);
  }
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text.slice(0, 200) };
  }
  // `text` is the unparsed body: endpoints like /raw serve a non-encrypted
  // artifact as text/plain, which is not JSON and would otherwise be lost to
  // the catch above. Callers that need the exact bytes read `text`.
  return { status: response.status, json, text };
}

function requireRecipePath(path) {
  if (!path) fail("a Recipe JSON path is required");
  if (!/\.json$/i.test(path)) {
    fail(
      `direct HTML/Markdown publishing is no longer supported; pass a Recipe JSON file (see references/recipe.md): ${path}`,
    );
  }
  return path;
}

function credentialEnvName(name) {
  return `OPEN_ARTIFACTS_PASSWORD_${name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}`;
}

function resolveRecipePassword(build, flags, artifactId = null) {
  if (!build.loaded.recipe.security.encrypted) return null;
  const name = build.loaded.recipe.security.passwordCredential;
  const credentials = loadCredentials();
  const password =
    flags.password ??
    process.env[credentialEnvName(name)] ??
    credentials.namedPasswords[name] ??
    (artifactId ? credentials.passwords[artifactId] : null);
  if (!password) {
    fail(
      `encrypted Recipe requires --password, ${credentialEnvName(name)}, or credentials.namedPasswords.${name}`,
    );
  }
  return password;
}

async function prepareRecipePayload(recipePath, flags, artifactId = null) {
  const build = buildArtifactRecipe(
    resolve(PROJECT_ROOT, requireRecipePath(recipePath)),
    { projectRoot: PROJECT_ROOT },
  );
  const artifact = build.loaded.recipe.artifact;
  const password = resolveRecipePassword(build, flags, artifactId);
  const payload = {
    content: build.publishContent,
    format: artifact.format,
    title: build.validation.title,
    description: artifact.description,
    favicon: artifact.favicon,
  };
  if (flags.label) {
    const labelBytes = Buffer.byteLength(flags.label);
    if (labelBytes > 60) {
      throw new Error(
        `--label must be at most 60 bytes (got ${labelBytes}, over by ${labelBytes - 60}; CJK chars are 3 bytes each — shorten or drop non-ASCII): ${flags.label.slice(0, 60)}`,
      );
    }
    payload.label = flags.label;
  }
  if (password) {
    const encryptedPayload = await encryptContent(
      build.publishContent,
      password,
    );
    if (Buffer.byteLength(encryptedPayload.content) > MAX_CONTENT_BYTES) {
      fail(
        `encrypted output exceeds the ${MAX_CONTENT_BYTES} byte service limit`,
      );
    }
    payload.content = encryptedPayload.content;
    payload.encrypted = encryptedPayload.encrypted;
  }
  return { build, artifact, password, payload };
}

function recipeMetadataForEntry(entry) {
  if (!entry.recipe) return entry;
  try {
    const { artifact, security } = loadRecipe(
      resolve(PROJECT_ROOT, entry.recipe),
      {
        projectRoot: PROJECT_ROOT,
      },
    ).recipe;
    return { ...artifact, encrypted: security.encrypted };
  } catch {
    return entry;
  }
}

function recipeSnapshot(build) {
  return snapshotResolvedFiles(build.loaded.watchFiles);
}

function extractTitle(content, format) {
  if (format === "html") {
    const match = content.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match?.[1].trim() || null;
  }
  const heading = content.match(/^#\s+(.+)$/m);
  return heading?.[1].trim() || null;
}

function generateChannelToken() {
  return `ch_${Buffer.from(webcrypto.getRandomValues(new Uint8Array(32)))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
}

// Resolve the production level: --level 1|2|3 wins, then the boolean aliases
// --simple / --interactive / --rich, then null (agent decides from the brief).
async function commandCreate(recipePath, flags) {
  if (!recipePath) fail("usage: artifact.mjs create <recipe.json> [options]");
  const config = loadConfig(flags);
  const prepared = await prepareRecipePayload(recipePath, flags);
  const { artifact, build, password, payload } = prepared;
  const channel = artifact.channel;

  if (channel) {
    const credentials = loadCredentials();
    if (!credentials.channels[channel]) {
      credentials.channels[channel] = generateChannelToken();
      saveCredentials(credentials);
    }
    payload.channel = credentials.channels[channel];
  }

  const { status, json } = await request(
    "POST",
    `${config.apiUrl}/api/artifacts`,
    payload,
    config.createToken,
  );
  if (status !== 201 && status !== 200) {
    fail(`create failed (${status}): ${json.error ?? "unknown error"}`);
  }

  const targetFile = artifact.local ? MANIFEST.local : MANIFEST.shared;
  const manifest = normalizeManifest(readJson(targetFile, { artifacts: [] }));
  const otherFile = artifact.local ? MANIFEST.shared : MANIFEST.local;
  const other = normalizeManifest(readJson(otherFile, { artifacts: [] }));
  const matchEntry = (entry) =>
    entry.id === json.id ||
    (channel && recipeMetadataForEntry(entry).channel === channel);
  const otherBefore = other.artifacts.length;
  other.artifacts = other.artifacts.filter((entry) => !matchEntry(entry));
  if (other.artifacts.length !== otherBefore) {
    saveManifest(other, !artifact.local);
  }
  const existingIndex = manifest.artifacts.findIndex(matchEntry);
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
  if (existingIndex >= 0) manifest.artifacts[existingIndex] = entry;
  else manifest.artifacts.push(entry);
  saveManifest(manifest, artifact.local);
  if (artifact.local || password) ensureGitignored();

  if (json.writeToken || password) {
    const credentials = loadCredentials();
    if (json.writeToken) credentials.tokens[json.id] = json.writeToken;
    if (password) {
      credentials.passwords[json.id] = password;
      credentials.namedPasswords[
        build.loaded.recipe.security.passwordCredential
      ] = password;
    }
    saveCredentials(credentials);
  }

  if (
    process.env.CLAUDE_PROJECT_DIR &&
    artifact.watch.length > 0 &&
    !hookInstalled(process.env.CLAUDE_PROJECT_DIR)
  ) {
    console.error(
      'tip: run "artifact.mjs install-hook" to flag this artifact stale automatically when its watched files change',
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
}

function findEntry(manifest, id) {
  const entry = manifest.artifacts.find((a) => a.id === id);
  // `manifest` is the merged view (shared + local), so the error names both
  // files — naming only MANIFEST.shared misleads --local users whose entry
  // lives (or should live) in manifest.local.json. The lookup is by artifact
  // *id* (e.g. `11SzRSnARq8c`), not by Recipe path — `update` and `migrate`
  // take the id as their first positional, with the Recipe path optional.
  if (!entry) {
    const known = manifest.artifacts.map((a) => a.id).filter(Boolean);
    const hint = known.length
      ? ` (known id${known.length === 1 ? "" : "s"}: ${known.join(", ")})`
      : "";
    fail(
      `no manifest entry with id "${id}" in ${MANIFEST.shared} or ${MANIFEST.local}${hint}. The id is the artifact's short id, not its Recipe path — use \`artifact.mjs update <id> [recipe]\`. To publish a brand-new Recipe, run \`create\` instead.`,
    );
  }
  return entry;
}

async function commandUpdate(id, recipePath, flags) {
  const config = loadConfig(flags);
  const merged = loadManifest();
  const entry = findEntry(merged, id);
  const credentials = loadCredentials();
  const token = credentials.tokens[id];
  if (!token) fail(`no write token for ${id} in ${CREDENTIALS_PATH}`);
  const sourceRecipe = recipePath ?? entry.recipe;
  if (!sourceRecipe) {
    const migratedRecipe = await commandMigrate(id, flags);
    return commandUpdate(id, migratedRecipe, flags);
  }
  const prepared = await prepareRecipePayload(sourceRecipe, flags, id);
  const { artifact, build, password, payload } = prepared;
  if (!flags.force) payload.baseVersion = entry.version;
  if (flags.force) payload.force = true;

  const { status, json } = await request(
    "PUT",
    `${config.apiUrl}/api/artifacts/${id}`,
    payload,
    token,
  );
  if (status === 409) {
    fail(
      `version conflict: server is at version ${json.currentVersion}, manifest recorded ${entry.version}. ` +
        "Someone else updated this artifact. Re-run with --force to overwrite.",
    );
  }
  if (status !== 200)
    fail(`update failed (${status}): ${json.error ?? "unknown error"}`);

  const previousHome = manifestFileForId(id);
  previousHome.manifest.artifacts = previousHome.manifest.artifacts.filter(
    (candidate) => candidate.id !== id,
  );
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
  if (previousHome.local === artifact.local) {
    previousHome.manifest.artifacts.push(nextEntry);
    saveManifest(previousHome.manifest, artifact.local);
  } else {
    saveManifest(previousHome.manifest, previousHome.local);
    const nextManifest = normalizeManifest(
      readJson(artifact.local ? MANIFEST.local : MANIFEST.shared, {
        artifacts: [],
      }),
    );
    nextManifest.artifacts = nextManifest.artifacts.filter(
      (candidate) => candidate.id !== id,
    );
    nextManifest.artifacts.push(nextEntry);
    saveManifest(nextManifest, artifact.local);
  }
  if (password) {
    credentials.passwords[id] = password;
    credentials.namedPasswords[
      build.loaded.recipe.security.passwordCredential
    ] = password;
    saveCredentials(credentials);
  }
  if (artifact.local || password) ensureGitignored();

  console.log(json.url ?? entry.url);
  console.error(
    `updated artifact ${id} to version ${json.version} (${build.plan.strategy} Recipe build)`,
  );
}

async function commandDelete(id, flags) {
  const config = loadConfig(flags);
  // Confirm the entry exists (merged read), then delete from whichever file
  // it actually lives in.
  const merged = loadManifest();
  findEntry(merged, id);
  const credentials = loadCredentials();
  const token = credentials.tokens[id];
  if (!token) fail(`no write token for ${id} in ${CREDENTIALS_PATH}`);

  const { status, json } = await request(
    "DELETE",
    `${config.apiUrl}/api/artifacts/${id}`,
    undefined,
    token,
  );
  if (status !== 200)
    fail(`delete failed (${status}): ${json.error ?? "unknown error"}`);

  const { local, manifest } = manifestFileForId(id);
  manifest.artifacts = manifest.artifacts.filter((a) => a.id !== id);
  saveManifest(manifest, local);
  delete credentials.tokens[id];
  if (credentials.passwords) delete credentials.passwords[id];
  saveCredentials(credentials);
  console.error(`deleted artifact ${id}`);
}

function staleArtifacts() {
  const manifest = loadManifest();
  const stale = [];
  for (const entry of manifest.artifacts) {
    const watch = recipeMetadataForEntry(entry).watch ?? entry.watch ?? [];
    if (watch.length === 0) continue;
    const changed = diffSnapshot(entry.snapshot ?? {}, snapshotWatch(watch));
    if (changed.length > 0) stale.push({ entry, changed });
  }
  return stale;
}

// Read the hook payload Claude Code pipes to a Stop hook on stdin. Resolves to
// the parsed object, or null when there is no usable input (no TTY prompt hang;
// a short cap keeps the callback fast even if the caller never closes stdin).
function readHookInput() {
  return new Promise((resolveInput) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolveInput(null);
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.pause();
      stdin.unref?.();
      try {
        resolveInput(data ? JSON.parse(data) : null);
      } catch {
        resolveInput(null);
      }
    };
    const timer = setTimeout(finish, 100);
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", finish);
    stdin.on("error", finish);
  });
}

async function commandStatus(flags) {
  // In hook mode, respect Claude Code's loop protection: when the Stop hook is
  // already keeping the turn going (stop_hook_active), stay silent so Claude is
  // allowed to stop instead of re-nudging up to the 8-continuation cap.
  if (flags.hook) {
    const input = await readHookInput();
    if (input?.stop_hook_active) return;
  }
  if (!existsSync(MANIFEST.shared) && !existsSync(MANIFEST.local)) {
    if (!flags.hook) console.error("no artifact manifest; nothing to check");
    return;
  }
  const stale = staleArtifacts();
  if (stale.length === 0) {
    if (!flags.hook) console.error("all artifacts are up to date");
    return;
  }

  if (flags.hook) {
    // Only artifacts explicitly opted into the automatic loop (autoUpdate:
    // true) may be surfaced here — this is the only thing autoUpdate gates.
    // A stale-but-not-opted-in artifact stays invisible to the hook even
    // though it's still reported by a plain, human-run `status` below.
    const hookStale = stale.filter(({ entry }) => entry.autoUpdate === true);
    if (hookStale.length === 0) return;
    const scriptPath = fileURLToPath(import.meta.url);
    const lines = hookStale.map(({ entry, changed }) => {
      const metadata = recipeMetadataForEntry(entry);
      const scope = metadata.scope ? ` It covers: ${metadata.scope}.` : "";
      return (
        `Artifact "${metadata.title ?? entry.title ?? entry.id}" (${entry.url}, id ${entry.id}) was published from sources that have since changed.${scope} ` +
        `Changed files: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? ", ..." : ""}. ` +
        `If these changes affect the artifact's content, update its Recipe fragments and run: node "${scriptPath}" update ${entry.id}`
      );
    });
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: lines.join("\n"),
        },
      }),
    );
    return;
  }

  for (const { entry, changed } of stale) {
    const metadata = recipeMetadataForEntry(entry);
    console.log(
      `stale: ${entry.id} ${metadata.title ?? entry.title ?? ""} (${entry.url})`,
    );
    if (metadata.scope) console.log(`  scope: ${metadata.scope}`);
    console.log(`  auto-update: ${entry.autoUpdate === true ? "on" : "off"}`);
    console.log(`  changed: ${changed.join(", ")}`);
  }
  process.exitCode = 1;
}

// Advance an entry's snapshot baseline to the current file hashes WITHOUT
// republishing — the "I reviewed the drift and it doesn't affect this artifact"
// path (e.g. a locked design direction, or an unrelated edit to a broadly
// watched file). Offline: no server round-trip. This is why status can stop
// crying wolf without lying that the published page was regenerated.
function commandAck(id) {
  const merged = loadManifest();
  findEntry(merged, id);
  const { local, manifest } = manifestFileForId(id);
  const entry = manifest.artifacts.find((a) => a.id === id);
  const watch = recipeMetadataForEntry(entry).watch ?? entry.watch ?? [];
  entry.snapshot = snapshotWatch(watch);
  entry.reviewedAt = new Date().toISOString();
  saveManifest(manifest, local);
  console.error(
    `acknowledged ${id}: snapshot baseline advanced without republishing`,
  );
}

function updateRecipeAutoUpdate(entry, enabled) {
  if (!entry.recipe) return;
  const recipePath = resolve(PROJECT_ROOT, entry.recipe);
  const recipe = readJson(recipePath, null);
  if (!recipe?.artifact) {
    fail(`cannot update Recipe metadata: ${entry.recipe}`);
  }
  recipe.artifact.autoUpdate = enabled;
  writeJson(recipePath, recipe);
  const build = buildArtifactRecipe(recipePath, {
    projectRoot: PROJECT_ROOT,
  });
  entry.recipeHash = `sha256:${build.loaded.recipeHash}`;
  entry.inputHash = `sha256:${build.inputHash}`;
  entry.outputHash = `sha256:${build.outputHash}`;
}

// Toggle whether an artifact is surfaced by the Stop-hook-driven automatic
// loop (status --hook). This does NOT change the regenerate-vs-ack judgment
// SKILL.md describes: that still runs, unchanged, for whatever staleness the
// hook (or a human's plain `status`) surfaces to the agent. Off/absent by
// default, so no existing artifact's behavior changes. Turning "on" requires
// a write token to already exist for this id (otherwise `update` could never
// succeed for it — the common case for anyone besides the original creator,
// since credentials.json is gitignored while manifest.json is committed) and
// installs the Stop hook if it isn't already present, since the flag is
// inert without it: running this command IS the user's consent for that
// install (unlike `create`, which only ever hints at install-hook).
function commandAutoUpdate(id, mode) {
  if (mode !== "on" && mode !== "off") {
    fail('auto-update mode must be "on" or "off"');
  }
  const merged = loadManifest();
  findEntry(merged, id);
  const { local, manifest } = manifestFileForId(id);
  const entry = manifest.artifacts.find((a) => a.id === id);

  if (mode === "off") {
    updateRecipeAutoUpdate(entry, false);
    entry.autoUpdate = false;
    saveManifest(manifest, local);
    console.error(`auto-update disabled for ${id}`);
    return;
  }

  const credentials = loadCredentials();
  if (!credentials.tokens[id]) {
    fail(
      `no write token for ${id} in ${CREDENTIALS_PATH}; auto-update could never publish it. ` +
        "Run update once with a valid write token (or re-create the artifact) before enabling auto-update.",
    );
  }

  updateRecipeAutoUpdate(entry, true);
  entry.autoUpdate = true;
  saveManifest(manifest, local);

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const { installed, settingsPath } = installStopHook(projectDir);
  console.error(`auto-update enabled for ${id}`);
  console.error(
    installed
      ? `installed Stop hook in ${settingsPath}`
      : "stop hook already installed",
  );
}

function commandList() {
  const manifest = loadManifest();
  if (manifest.artifacts.length === 0) {
    console.error("no artifacts in manifest");
    return;
  }
  for (const entry of manifest.artifacts) {
    const metadata = recipeMetadataForEntry(entry);
    console.log(
      `${entry.id}  v${entry.version}  ${metadata.encrypted ? "[protected] " : ""}${entry.autoUpdate === true ? "[auto-update] " : ""}${metadata.title ?? entry.title ?? ""}  ${entry.url}`,
    );
  }
}

// Fetch the current published content of an artifact and print it. For an
// encrypted artifact, /raw returns JSON ciphertext; decrypt it locally with
// the password stored in credentials.json (gitignored) so the agent can read
// back the plaintext — e.g. a locked design-direction comment at the top of
// the page — when regenerating an update. No plaintext source copy is kept
// on disk (the server is the source of truth); this is the on-demand read.
async function commandShow(id, flags) {
  const config = loadConfig(flags);
  const credentials = loadCredentials();
  const token = credentials.tokens[id];
  const url = `${config.apiUrl}/api/artifacts/${id}/raw${
    flags.v ? `?v=${flags.v}` : ""
  }`;
  const { status, json, text } = await request("GET", url, undefined, token);
  if (status !== 200)
    fail(`show failed (${status}): ${json.error ?? "unknown error"}`);
  // Detect encryption from the server response, not the manifest's `encrypted`
  // flag: that flag reflects only the *current* version, but `--v N` can fetch
  // a historical version whose encryption state differs (an artifact rotated
  // to/from password protection between versions). The /raw envelope carries
  // {alg, kdf, iterations, salt, iv, ciphertext} only for encrypted versions;
  // unencrypted versions are served as text/plain (which `request` exposes via
  // `text`, with `json` left as `{error: ...}` from the failed JSON parse).
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
    fail(
      "this artifact is encrypted; pass --password or have stored it at create time (credentials.json, gitignored)",
    );
  }
  const plaintext = await decryptContent(json, password);
  process.stdout.write(plaintext);
}

// Is the staleness Stop hook already present in this project's settings?
function hookInstalled(projectDir) {
  const settings = readJson(join(projectDir, ".claude/settings.json"), {});
  return (settings.hooks?.Stop ?? []).some((group) =>
    (group.hooks ?? []).some((h) => h.command?.includes("artifact.mjs")),
  );
}

// Write the staleness Stop hook into <projectDir>/.claude/settings.json,
// preserving any existing hooks. Idempotent: returns installed=false if a hook
// pointing at artifact.mjs is already present.
function installStopHook(projectDir) {
  const scriptPath = fileURLToPath(import.meta.url);
  const relativeToProject = relative(projectDir, scriptPath);
  const command = relativeToProject.startsWith("..")
    ? `node "${scriptPath}" status --hook`
    : `node "$CLAUDE_PROJECT_DIR/${relativeToProject}" status --hook`;

  const settingsPath = join(projectDir, ".claude/settings.json");
  if (hookInstalled(projectDir)) return { installed: false, settingsPath };
  const settings = readJson(settingsPath, {});
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  settings.hooks.Stop.push({ hooks: [{ type: "command", command }] });
  writeJson(settingsPath, settings);
  return { installed: true, settingsPath };
}

function commandInstallHook() {
  // Claude Code loads hooks from $CLAUDE_PROJECT_DIR/.claude/settings.json, so
  // resolve the project root from that env var when set (it is set during agent
  // sessions) and fall back to cwd for human-invoked runs.
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const { installed, settingsPath } = installStopHook(projectDir);
  console.error(
    installed
      ? `installed Stop hook in ${settingsPath}`
      : "stop hook already installed",
  );
}

function commandValidate(recipePath) {
  const result = buildArtifactRecipe(
    resolve(PROJECT_ROOT, requireRecipePath(recipePath)),
    { projectRoot: PROJECT_ROOT },
  );
  console.log(JSON.stringify(recipeBuildSummary(result), null, 2));
}

function commandBuild(recipePath, flags) {
  if (!flags.output) fail("build requires --output <path>");
  const result = buildArtifactRecipe(
    resolve(PROJECT_ROOT, requireRecipePath(recipePath)),
    {
      projectRoot: PROJECT_ROOT,
      standalone: flags.standalone === true,
    },
  );
  const output = writeArtifactPreview(result, flags.output);
  const previewRelative = relative(join(ARTIFACTS_DIR, "previews"), output);
  if (
    previewRelative !== ".." &&
    !previewRelative.startsWith("../") &&
    !previewRelative.startsWith(`..\\`)
  ) {
    ensureGitignored();
  }
  console.log(output);
  console.error(
    `built ${Buffer.byteLength(result.content)} bytes (${result.plan.strategy})`,
  );
}

function migrationSlug(id, title) {
  const base = (title ?? "artifact")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "artifact"}-${id.slice(0, 8)}`;
}

function stripMarkedBlock(content, startMarker, endMarker) {
  let result = content;
  let start = result.indexOf(startMarker);
  while (start !== -1) {
    const end = result.indexOf(endMarker, start + startMarker.length);
    if (end === -1) return result.slice(0, start).trim();
    result = result.slice(0, start) + result.slice(end + endMarker.length);
    start = result.indexOf(startMarker);
  }
  return result.trim();
}

function stripLegacyCanvasControls(content) {
  let result = stripMarkedBlock(
    content,
    CANVAS_MARKERS.controlsStart,
    CANVAS_MARKERS.controlsEnd,
  );
  const match = [
    ...result.matchAll(/<div\b[^>]*class=["']([^"']+)["'][^>]*>/gi),
  ].find((candidate) => candidate[1].split(/\s+/).includes("oa-zoom"));
  if (match?.index !== undefined) {
    result = result.slice(0, match.index);
  }
  return result.trim();
}

function stripLegacyCanvasCss(content, runtime) {
  let result = stripMarkedBlock(
    content,
    CANVAS_MARKERS.cssStart,
    CANVAS_MARKERS.cssEnd,
  );
  result = result.replace(runtime.css, "");
  const signature = result.indexOf(
    "/* Viewport. Sized to the visible area below the service header.",
  );
  if (signature !== -1) result = result.slice(0, signature);
  return result.trim();
}

function stripLegacyCanvasJs(content, runtime) {
  let result = stripMarkedBlock(
    content,
    CANVAS_MARKERS.jsStart,
    CANVAS_MARKERS.jsEnd,
  );
  result = result.replace(runtime.js, "");
  const signature = result.search(
    /\(function\s*\(\)\s*\{\s*const canvas = document\.getElementById\(["']canvas["']\)/,
  );
  if (signature !== -1) result = result.slice(0, signature);
  return result.trim();
}

function migrateHtmlSource(source, canvas) {
  const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .join("\n");
  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join("\n");
  let body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? source;
  body = body
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "");
  if (canvas) body = stripLegacyCanvasControls(body);
  const runtime = canvas ? loadCanvasRuntime() : { css: "", js: "" };
  const tokens = readFileSync(
    join(SKILL_ROOT, "references/tokens.css"),
    "utf8",
  ).trim();
  // A legacy non-canvas HTML page may ship with only identity tokens and no
  // measure cap — exactly the bare-page defect the L1 guard now blocks. The
  // guard would then refuse the migrated build, locking the artifact out of
  // any future update. Migration is a mechanical conversion, not a design
  // review: if the source has no width constraint anywhere, wrap it in the
  // prose baseline so the migrated recipe validates and the page renders with
  // a measure cap and padding instead of at 100% width.
  if (!canvas && !/max-width\s*:/i.test(styles) && !/\boa-prose\b/.test(body)) {
    // Strip a bare outer <main> so we don't nest main-in-main when wrapping.
    body = body.replace(/<\/?main\b[^>]*>/gi, "").trim();
    body = `<main class="oa-prose">\n${body}\n</main>`;
  }
  return {
    body: body.trim(),
    theme:
      (canvas ? stripLegacyCanvasCss(styles, runtime) : styles)
        .replace(tokens, "")
        .trim() || "/* Migrated theme fragment. */",
    scripts: canvas ? stripLegacyCanvasJs(scripts, runtime) : scripts.trim(),
  };
}

async function commandMigrate(id, flags) {
  const config = loadConfig(flags);
  const merged = loadManifest();
  const entry = findEntry(merged, id);
  if (entry.recipe && !flags.force) {
    console.log(entry.recipe);
    console.error("artifact already uses a Recipe");
    return entry.recipe;
  }
  const credentials = loadCredentials();
  const token = credentials.tokens[id];
  const { status, json, text } = await request(
    "GET",
    `${config.apiUrl}/api/artifacts/${id}/raw`,
    undefined,
    token,
  );
  if (status !== 200) {
    fail(
      `migration fetch failed (${status}): ${json.error ?? "unknown error"}`,
    );
  }
  const encrypted = json.alg === "AES-GCM" && json.ciphertext !== undefined;
  let source = text;
  let password = null;
  if (encrypted) {
    password = flags.password ?? credentials.passwords[id];
    if (!password) {
      fail("encrypted legacy artifact requires --password for migration");
    }
    source = await decryptContent(json, password);
  }
  const format = entry.format ?? (/^\s*</.test(source) ? "html" : "markdown");
  const title = entry.title ?? extractTitle(source, format) ?? `Artifact ${id}`;
  const canvas = format === "html" && entry.canvas === true;
  const slug = migrationSlug(id, title);
  const home = manifestFileForId(id);
  const local = home.local || encrypted;
  const recipeDirectory = join(
    ARTIFACTS_DIR,
    local ? "recipes.local" : "recipes",
  );
  const fragmentDirectory = join(
    ARTIFACTS_DIR,
    local ? "fragments.local" : "fragments",
    slug,
  );
  const recipePath = join(recipeDirectory, `${slug}.recipe.json`);
  if (existsSync(recipePath) || existsSync(fragmentDirectory)) {
    fail(
      `migration target already exists; refusing to overwrite project files: ${recipePath}`,
    );
  }
  mkdirSync(fragmentDirectory, { recursive: true });
  mkdirSync(recipeDirectory, { recursive: true });
  const relativeFragmentDirectory = relative(
    recipeDirectory,
    fragmentDirectory,
  );
  const fragments = { theme: [], styles: [], body: [], scripts: [] };
  if (format === "markdown") {
    const bodyPath = join(fragmentDirectory, "body.md");
    writeFileSync(bodyPath, source.endsWith("\n") ? source : `${source}\n`);
    fragments.body.push(
      join(relativeFragmentDirectory, "body.md").replaceAll("\\", "/"),
    );
  } else {
    const migrated = migrateHtmlSource(source, canvas);
    const bodyPath = join(fragmentDirectory, "body.html");
    const themePath = join(fragmentDirectory, "theme.css");
    writeFileSync(bodyPath, `${migrated.body}\n`);
    writeFileSync(themePath, `${migrated.theme}\n`);
    fragments.body.push(
      join(relativeFragmentDirectory, "body.html").replaceAll("\\", "/"),
    );
    fragments.theme.push(
      join(relativeFragmentDirectory, "theme.css").replaceAll("\\", "/"),
    );
    if (migrated.scripts) {
      const scriptsPath = join(fragmentDirectory, "behavior.js");
      writeFileSync(scriptsPath, `${migrated.scripts}\n`);
      fragments.scripts.push(
        join(relativeFragmentDirectory, "behavior.js").replaceAll("\\", "/"),
      );
    }
  }
  const recipe = {
    $schema: relative(
      recipeDirectory,
      join(SKILL_ROOT, "references/recipe.schema.json"),
    ).replaceAll("\\", "/"),
    version: 1,
    artifact: {
      title,
      description: entry.description ?? "",
      favicon: entry.favicon ?? "📄",
      format,
      level: entry.level ?? null,
      canvas,
      channel: entry.channel ?? null,
      scope: entry.scope ?? null,
      watch: entry.watch ?? [],
      local,
      autoUpdate: entry.autoUpdate === true,
    },
    document: {
      language: "en",
      theme: "migrated",
      fragments,
    },
    security: {
      encrypted,
      passwordCredential: encrypted ? `artifact-${id}` : null,
    },
    build: { strategy: "auto" },
  };
  writeJson(recipePath, recipe);
  const build = buildArtifactRecipe(recipePath, {
    projectRoot: PROJECT_ROOT,
  });
  const nextEntry = {
    id,
    url: entry.url,
    version: entry.version,
    recipe: build.loaded.projectPath,
    recipeHash: `sha256:${build.loaded.recipeHash}`,
    inputHash: `sha256:${build.inputHash}`,
    outputHash: `sha256:${build.outputHash}`,
    strategy: build.plan.strategy,
    autoUpdate: entry.autoUpdate === true,
    snapshot: recipeSnapshot(build),
    migrationPending: true,
    updatedAt: new Date().toISOString(),
  };
  home.manifest.artifacts = home.manifest.artifacts.filter(
    (candidate) => candidate.id !== id,
  );
  if (home.local === local) {
    home.manifest.artifacts.push(nextEntry);
    saveManifest(home.manifest, local);
  } else {
    saveManifest(home.manifest, home.local);
    const target = normalizeManifest(
      readJson(local ? MANIFEST.local : MANIFEST.shared, { artifacts: [] }),
    );
    target.artifacts = target.artifacts.filter(
      (candidate) => candidate.id !== id,
    );
    target.artifacts.push(nextEntry);
    saveManifest(target, local);
  }
  if (password) {
    credentials.namedPasswords[`artifact-${id}`] = password;
    saveCredentials(credentials);
  }
  if (local) ensureGitignored();
  console.log(build.loaded.projectPath);
  console.error(
    "migrated legacy source to Recipe; run update to publish the deterministic build",
  );
  return build.loaded.projectPath;
}

const HELP = `usage: artifact.mjs <command> [options]

commands:
  validate <recipe>    validate and compose a Recipe without writing output
  build <recipe>       write an explicit preview/export (requires --output)
  create <recipe>      build in memory and publish exactly once
  update <id> [recipe] build in memory and redeploy at the same URL; defaults
                       to the Recipe recorded in Manifest v2
  migrate <id>         create a Recipe and fragments for a legacy artifact;
                       does not publish until update is run
  status               report artifacts whose watched files changed (exit 1 if stale)
  ack <id>             mark drift reviewed: advance the snapshot baseline without
                       republishing (offline; use when changes don't affect it)
  auto-update <id> on|off
                       toggle whether the Stop hook's automatic loop surfaces
                       this artifact (opt-in, off by default); "on" also installs
                       the Stop hook if needed and prints a confirmation
  list                 list artifacts in the manifest
  show <id>            print the current published content (decrypts locally
                       for encrypted artifacts using the stored password)
  delete <id>          delete an artifact from the server and manifest
  install-hook         add a Claude Code Stop hook that runs status --hook

options:
  --output <path>      (build) explicit preview/export output path
  --standalone         (build) wrap HTML for direct file:// preview
  --label <l>          (create/update) version label (max 60 bytes; note: CJK chars are 3 bytes each, so keep labels terse)
  --password <p>       encrypt client-side; server only stores ciphertext
  --api <url>          instance URL (default: OPEN_ARTIFACTS_URL or config)
  --force              overwrite on version conflict
  --v <n>              (show) view a specific version's content
  --hook               (status) emit Claude Code hook JSON instead of text
`;

async function main() {
  const { values: flags, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      standalone: { type: "boolean" },
      label: { type: "string" },
      password: { type: "string" },
      api: { type: "string" },
      force: { type: "boolean" },
      hook: { type: "boolean" },
      v: { type: "string" },
      help: { type: "boolean" },
    },
  });

  const [command, ...rest] = positionals;
  if (flags.help || !command) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "validate":
      if (!rest[0]) fail("validate requires a Recipe JSON path");
      commandValidate(rest[0]);
      break;
    case "build":
      if (!rest[0]) fail("build requires a Recipe JSON path");
      commandBuild(rest[0], flags);
      break;
    case "create":
      if (!rest[0]) fail("create requires a Recipe JSON path");
      await commandCreate(rest[0], flags);
      break;
    case "update":
      if (!rest[0]) fail("update requires an artifact id");
      await commandUpdate(rest[0], rest[1], flags);
      break;
    case "migrate":
      if (!rest[0]) fail("migrate requires an artifact id");
      await commandMigrate(rest[0], flags);
      break;
    case "delete":
      if (!rest[0]) fail("delete requires an artifact id");
      await commandDelete(rest[0], flags);
      break;
    case "status":
      await commandStatus(flags);
      break;
    case "ack":
      if (!rest[0]) fail("ack requires an artifact id");
      commandAck(rest[0]);
      break;
    case "auto-update":
      if (!rest[0]) fail("auto-update requires an artifact id");
      if (!rest[1]) fail('auto-update requires a mode: "on" or "off"');
      commandAutoUpdate(rest[0], rest[1]);
      break;
    case "list":
      commandList();
      break;
    case "show":
      if (!rest[0]) fail("show requires an artifact id");
      await commandShow(rest[0], flags);
      break;
    case "install-hook":
      commandInstallHook();
      break;
    default:
      fail(`unknown command: ${command}\n${HELP}`);
  }
}

main().catch((error) => fail(error.message));
