import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ARTIFACTS_DIR,
  CONFIG,
  CREDENTIALS_PATH,
  GLOBAL_CONFIG_PATH,
  MANIFEST,
} from "./paths.mjs";
import {
  mutateStateJsonSync,
  readStateJsonSync,
  writeStateJsonSync,
} from "./state-files.mjs";

/**
 * @param {string} path
 * @returns {{kind: "manifest" | "config" | "credentials", secret?: boolean} | null}
 */
export function stateOptions(path) {
  if (path === CREDENTIALS_PATH) {
    return { kind: "credentials", secret: true };
  }
  if (path === MANIFEST.shared || path === MANIFEST.local) {
    return { kind: "manifest" };
  }
  if (
    path === CONFIG.shared ||
    path === CONFIG.local ||
    path === GLOBAL_CONFIG_PATH
  ) {
    return { kind: "config" };
  }
  return null;
}

export function readJson(path, fallback) {
  const state = stateOptions(path);
  if (state) return readStateJsonSync(path, fallback, state);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value, mode = 0o644) {
  const state = stateOptions(path);
  if (state) {
    writeStateJsonSync(path, value, state);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

export function normalizeCredentials(value) {
  return {
    ...value,
    apiKey: value.apiKey ?? null,
    tokens: value.tokens ?? {},
    channels: value.channels ?? {},
    passwords: value.passwords ?? {},
    namedPasswords: value.namedPasswords ?? {},
  };
}

export function loadCredentials() {
  if (existsSync(CREDENTIALS_PATH)) {
    const mode = statSync(CREDENTIALS_PATH).mode & 0o777;
    if (mode & ~0o600) chmodSync(CREDENTIALS_PATH, 0o600);
  }
  return normalizeCredentials(readJson(CREDENTIALS_PATH, {}));
}

export function resolveAuthToken(flags) {
  if (flags.token) return flags.token;
  if (process.env.OPEN_ARTIFACTS_API_KEY) {
    return process.env.OPEN_ARTIFACTS_API_KEY;
  }
  const credentials = loadCredentials();
  if (credentials.apiKey) return credentials.apiKey;
  if (process.env.OPEN_ARTIFACTS_TOKEN) {
    return process.env.OPEN_ARTIFACTS_TOKEN;
  }
  const project = {
    ...readJson(CONFIG.shared, {}),
    ...readJson(CONFIG.local, {}),
  };
  const global = readJson(GLOBAL_CONFIG_PATH, {});
  return project.createToken ?? global.createToken ?? null;
}

export function loadConfig(flags) {
  const project = {
    ...readJson(CONFIG.shared, {}),
    ...readJson(CONFIG.local, {}),
  };
  const global = readJson(GLOBAL_CONFIG_PATH, {});
  const apiUrl =
    flags.api ??
    process.env.OPEN_ARTIFACTS_URL ??
    project.apiUrl ??
    global.apiUrl;
  if (!apiUrl) {
    throw new Error(
      'no instance configured. Set OPEN_ARTIFACTS_URL, pass --api <url>, or write .artifacts/config.json {"apiUrl": "https://..."}',
    );
  }
  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    authToken: resolveAuthToken(flags),
  };
}

export function normalizeManifest(value) {
  return {
    manifestVersion: value.manifestVersion ?? 1,
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
  };
}

export function mergeArtifacts(shared, local) {
  const byId = new Map();
  for (const entry of shared) byId.set(entry.id, entry);
  for (const entry of local) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function loadManifest() {
  const shared = normalizeManifest(
    readJson(MANIFEST.shared, { artifacts: [] }),
  );
  const local = normalizeManifest(readJson(MANIFEST.local, { artifacts: [] }));
  return {
    manifestVersion: Math.max(shared.manifestVersion, local.manifestVersion),
    artifacts: mergeArtifacts(shared.artifacts, local.artifacts),
  };
}

export function mutateManifest(local, mutate) {
  return mutateStateJsonSync(
    local ? MANIFEST.local : MANIFEST.shared,
    { artifacts: [] },
    { kind: "manifest" },
    (current) => {
      const manifest = normalizeManifest(current);
      mutate(manifest);
      return { manifestVersion: 2, artifacts: manifest.artifacts };
    },
  );
}

export function mutateCredentials(mutate) {
  mutateStateJsonSync(
    CREDENTIALS_PATH,
    {},
    { kind: "credentials", secret: true },
    (current) => {
      const credentials = normalizeCredentials(current);
      mutate(credentials);
      return credentials;
    },
  );
  ensureGitignored();
}

export function manifestFileForId(id) {
  if (
    normalizeManifest(
      readJson(MANIFEST.local, { artifacts: [] }),
    ).artifacts.some((artifact) => artifact.id === id)
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

export function ensureGitignored() {
  if (!existsSync(".git")) return;
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
  const existing = new Set(current.split("\n").map((line) => line.trim()));
  const missing = lines.filter((line) => !existing.has(line));
  if (missing.length === 0) return;
  writeFileSync(
    ".gitignore",
    `${current.replace(/\n*$/, "\n")}${missing.join("\n")}\n`,
  );
  for (const line of missing)
    console.error(`note: added ${line} to .gitignore`);
}

export function findEntry(manifest, id) {
  const entry = manifest.artifacts.find((artifact) => artifact.id === id);
  if (entry) return entry;
  const known = manifest.artifacts
    .map((artifact) => artifact.id)
    .filter(Boolean);
  const hint = known.length
    ? ` (known id${known.length === 1 ? "" : "s"}: ${known.join(", ")})`
    : "";
  throw new Error(
    `no manifest entry with id "${id}" in ${MANIFEST.shared} or ${MANIFEST.local}${hint}. The id is the artifact's short id, not its Recipe path — use \`artifact.mjs update <id> [recipe]\`. To publish a brand-new Recipe, run \`create\` instead.`,
  );
}
