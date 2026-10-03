#!/usr/bin/env node
// Open Artifacts publishing CLI. Zero dependencies; requires Node >= 22.
// Used by the "artifacts" agent skill; also usable by humans.

import { execFile } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { runArtifactQualitySmoke } from "./artifact-quality-smoke.mjs";
import {
  buildArtifactRecipe,
  recipeBuildSummary,
  writeArtifactPreview,
} from "./build-artifact.mjs";
import { CANVAS_MARKERS, loadCanvasRuntime } from "./lib/compose.mjs";
import { waitForEventAck } from "./lib/live-ack.mjs";
import { loadRecipe, resolveWatchFiles } from "./lib/recipe.mjs";
import { MAX_CONTENT_BYTES } from "./lib/validate.mjs";

const execFileAsync = promisify(execFile);

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

function writeJson(path, value, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function loadCredentials() {
  if (existsSync(CREDENTIALS_PATH)) {
    // One-time migration: a credentials file created by an older CLI version
    // before 0600 enforcement shipped may still be group/world-readable.
    // Tighten it on first load; chmodSync no-ops the mode bits to 0600.
    const mode = statSync(CREDENTIALS_PATH).mode & 0o777;
    if (mode & ~0o600) chmodSync(CREDENTIALS_PATH, 0o600);
  }
  const value = readJson(CREDENTIALS_PATH, {});
  return {
    ...value,
    apiKey: value.apiKey ?? null,
    tokens: value.tokens ?? {},
    channels: value.channels ?? {},
    passwords: value.passwords ?? {},
    namedPasswords: value.namedPasswords ?? {},
  };
}

function resolveAuthToken(flags) {
  if (flags.token) return flags.token;
  if (process.env.OPEN_ARTIFACTS_API_KEY) {
    return process.env.OPEN_ARTIFACTS_API_KEY;
  }
  // A logged-in sk_ is the valid create credential for a login-gated instance;
  // it wins over OPEN_ARTIFACTS_TOKEN / config createToken (which are
  // CREATE_TOKEN-gate secrets for self-hosted instances and would publish as
  // anonymous on a SaaS instance, hiding the artifact from the user's
  // dashboard). Explicit --token / OPEN_ARTIFACTS_API_KEY still override it.
  const credentials = loadCredentials();
  if (credentials.apiKey) return credentials.apiKey;
  if (process.env.OPEN_ARTIFACTS_TOKEN) {
    return process.env.OPEN_ARTIFACTS_TOKEN;
  }
  const project = {
    ...readJson(CONFIG.shared, {}),
    ...readJson(CONFIG.local, {}),
  };
  const global = readJson(
    join(homedir(), ".config/open-artifacts/config.json"),
    {},
  );
  const fromConfig = project.createToken ?? global.createToken;
  if (fromConfig) return fromConfig;
  return null;
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
  if (!apiUrl) {
    fail(
      'no instance configured. Set OPEN_ARTIFACTS_URL, pass --api <url>, or write .artifacts/config.json {"apiUrl": "https://..."}',
    );
  }
  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    authToken: resolveAuthToken(flags),
  };
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

function saveCredentials(credentials) {
  writeJson(CREDENTIALS_PATH, credentials, 0o600);
  ensureGitignored();
}

// Read-modify-write the credentials file in one place, re-reading immediately
// before the write. commandCreate already does this inline; update, delete, and
// migrate held a snapshot read before their network round-trip and wrote it back
// afterward, so a credentials write by another process during that window — a
// concurrent create adding a token, say — was silently clobbered. A lost write
// token is unrecoverable (no endpoint re-issues one). Routing every mutation
// through here keeps the read adjacent to the write and gives future callers one
// correct path instead of a pattern to remember.
//
// A narrow RMW race still exists (no file lock); running `update` calls
// concurrently is unsupported, documented in SKILL.md. This closes the
// network-sized window, which is the one that actually bit.
function mutateCredentials(mutate) {
  const credentials = loadCredentials();
  mutate(credentials);
  saveCredentials(credentials);
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
  if (existsSync(join(ARTIFACTS_DIR, "reference-dna.local"))) {
    lines.push(".artifacts/reference-dna.local/");
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

// undici's TypeError("fetch failed") hides the real network error in a nested
// cause chain (getaddrinfo ENOTFOUND, read ECONNRESET, TLS handshake, ...).
// Surface the deepest message so a dead connection is diagnosable instead of
// a bare "fetch failed".
function deepCause(err) {
  let root = err;
  let guard = 0;
  while (root?.cause && root?.cause !== root && guard++ < 10) {
    root = root.cause;
  }
  return root?.message ? root.message : String(err);
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
    fail(`cannot reach ${url}: ${deepCause(cause)}`);
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
    const loaded = loadRecipe(resolve(PROJECT_ROOT, entry.recipe), {
      projectRoot: PROJECT_ROOT,
    });
    const { artifact, security } = loaded.recipe;
    return {
      ...artifact,
      encrypted: security.encrypted,
      watch: [
        ...artifact.watch,
        ...(loaded.referenceDna ? [loaded.referenceDna.projectPath] : []),
      ],
    };
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
  if (!config.authToken) {
    // Non-blocking: an open self-hosted instance legitimately allows anonymous
    // create. But a login-gated instance (coda0.com) will 401 this request and
    // even a successful channel-publish lands as anonymous (owner_id empty),
    // so the artifact won't appear in the user's dashboard. Warn up front.
    console.error(
      "tip: no auth token configured; if this instance requires login, run the CLI's `login --provider google` command first (references/auth.md)",
    );
  }
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
    fail(`create failed (${status}): ${json.error ?? "unknown error"}${hint}`);
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
    referenceDna: build.loaded.referenceDna
      ? {
          path: build.loaded.referenceDna.projectPath,
          sha256: `sha256:${build.loaded.referenceDna.hash}`,
          sourceMode: build.loaded.referenceDna.value.provenance.sourceMode,
          attestation: build.loaded.referenceDna.value.provenance.attestation,
        }
      : undefined,
    snapshot: recipeSnapshot(build),
    updatedAt: new Date().toISOString(),
  };
  if (visibility) entry.visibility = visibility;
  if (orgId) entry.orgId = orgId;
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
  // Live-capable instance + logged-in (sk_) operator: tell the agent to open
  // the live long-connection by default and what the user does on their side.
  // The agent only polls — it never operates the viewer page itself.
  if (json.liveSupported === true && config.authToken?.startsWith("sk_")) {
    console.error(
      `live mode: this instance supports live editing. Start the watcher and keep it running: ` +
        `node artifact.mjs live ${json.id} --watch — the user opens ${json.url}, clicks Live, picks ` +
        `elements, types a change for each, and submits. Your watcher prints each generate event; ` +
        `the viewer's Live button shows Connected while it is online (references/live.md).`,
    );
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

async function commandUpdate(
  id,
  recipePath,
  flags,
  inPlace = flags.live === true,
) {
  const config = loadConfig(flags);
  const merged = loadManifest();
  const entry = findEntry(merged, id);
  const credentials = loadCredentials();
  const token = credentials.tokens[id];
  if (!token) fail(`no write token for ${id} in ${CREDENTIALS_PATH}`);
  const sourceRecipe = recipePath ?? entry.recipe;
  if (!sourceRecipe) {
    const migratedRecipe = await commandMigrate(id, flags);
    return commandUpdate(id, migratedRecipe, flags, inPlace);
  }
  const prepared = await prepareRecipePayload(sourceRecipe, flags, id);
  const { artifact, build, password, payload } = prepared;
  if (!flags.force) payload.baseVersion = entry.version;
  if (flags.force) payload.force = true;

  const { status, json } = await request(
    "PUT",
    `${config.apiUrl}/api/artifacts/${id}${inPlace ? "/live" : ""}`,
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
    referenceDna: build.loaded.referenceDna
      ? {
          path: build.loaded.referenceDna.projectPath,
          sha256: `sha256:${build.loaded.referenceDna.hash}`,
          sourceMode: build.loaded.referenceDna.value.provenance.sourceMode,
          attestation: build.loaded.referenceDna.value.provenance.attestation,
        }
      : undefined,
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
    mutateCredentials((credentials) => {
      credentials.passwords[id] = password;
      credentials.namedPasswords[
        build.loaded.recipe.security.passwordCredential
      ] = password;
    });
  }
  if (artifact.local || password) ensureGitignored();

  console.log(json.url ?? entry.url);
  console.error(
    `updated artifact ${id} ${inPlace ? "in place at" : "to"} version ${json.version} (${build.plan.strategy} Recipe build)`,
  );
}

async function commandDelete(id, flags) {
  const config = loadConfig(flags);
  // Confirm the entry exists (merged read), then delete from whichever file
  // it actually lives in.
  const merged = loadManifest();
  findEntry(merged, id);
  // Read only to authorize the request; the write-back re-reads (mutateCredentials)
  // so a concurrent credentials write during the DELETE round-trip is not lost.
  const token = loadCredentials().tokens[id];
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
  mutateCredentials((credentials) => {
    delete credentials.tokens[id];
    if (credentials.passwords) delete credentials.passwords[id];
  });
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
  // Prefer sk_/API key so private SaaS artifacts pass authorizeView; fall back
  // to the per-artifact wt_ for self-hosted capability-only deploys.
  const token = resolveAuthToken(flags) ?? credentials.tokens[id];
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

async function commandSmoke(recipePath) {
  const result = buildArtifactRecipe(
    resolve(PROJECT_ROOT, requireRecipePath(recipePath)),
    { projectRoot: PROJECT_ROOT },
  );
  const artifact = result.loaded.recipe.artifact;
  if (artifact.format !== "html") {
    fail(
      "smoke requires an HTML Recipe; Markdown has viewer-owned rendering and React has no authored CSS fragments",
    );
  }
  if (artifact.canvas) {
    fail(
      "smoke is for scrolling HTML artifacts; Canvas has its own runtime and ship gate in references/canvas.md",
    );
  }
  const qualitySmoke = await runArtifactQualitySmoke(result.publishContent);
  console.log(
    JSON.stringify({ ...recipeBuildSummary(result), qualitySmoke }, null, 2),
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
  // Read only to authorize the request; the write-back re-reads
  // (mutateCredentials) so a concurrent credentials write during migrate's
  // long round-trip (GET raw, then build) is not lost.
  const token = loadCredentials().tokens[id];
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
    // Re-read here — do not close over a pre-network credentials snapshot.
    // The earlier load was dropped so migrate's write-back goes through
    // mutateCredentials; this password lookup is post-GET and needs a fresh
    // read (or --password). A dangling `credentials` binding here crashed
    // every encrypted migrate (#38 review).
    password = flags.password ?? loadCredentials().passwords[id];
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
    mutateCredentials((credentials) => {
      credentials.namedPasswords[`artifact-${id}`] = password;
    });
  }
  if (local) ensureGitignored();
  console.log(build.loaded.projectPath);
  console.error(
    "migrated legacy source to Recipe; run update to publish the deterministic build",
  );
  return build.loaded.projectPath;
}

export function buildCliLoginUrl(apiUrl, provider, redirectUri) {
  const loginPath =
    provider === "google" || provider === "github"
      ? `/auth/${provider}/login`
      : "/login";
  const params = new URLSearchParams({
    cli: "1",
    redirect_uri: redirectUri,
  });
  return `${apiUrl.replace(/\/+$/, "")}${loginPath}?${params}`;
}

async function openBrowser(url) {
  if (process.env.OPEN_ARTIFACTS_NO_BROWSER === "1") {
    console.error(`open: ${url}`);
    return;
  }
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  await execFileAsync(command, args);
}

async function startOAuthCallbackServer(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("missing code");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><body><p>Login complete. You can close this tab.</p></body></html>",
      );
      server.close();
      if (server.__resolveCode) server.__resolveCode(code);
    });
    server.on("error", reject);
    server.__codePromise = new Promise((resolveCode) => {
      server.__resolveCode = resolveCode;
    });
    server.listen(preferredPort ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not bind loopback callback server"));
        return;
      }
      resolve({
        port: address.port,
        code: server.__codePromise,
        close: () => server.close(),
      });
    });
  });
}

async function commandLogin(flags) {
  const config = loadConfig(flags);
  const provider = flags.provider ?? null;
  if (provider !== null && provider !== "google" && provider !== "github") {
    fail('login --provider must be "google" or "github" when set');
  }
  const preferredPort = flags.port ? Number(flags.port) : undefined;
  if (preferredPort !== undefined && !Number.isInteger(preferredPort)) {
    fail("login --port must be an integer");
  }

  const callback = await startOAuthCallbackServer(preferredPort);
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
  const loginUrl = buildCliLoginUrl(config.apiUrl, provider, redirectUri);

  console.error(
    "login requires a SaaS instance with OAuth and /api/keys/exchange enabled",
  );
  console.error(`opening ${loginUrl}`);
  await openBrowser(loginUrl);

  const loginTimeoutMs = Number(process.env.OPEN_ARTIFACTS_LOGIN_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(loginTimeoutMs) && loginTimeoutMs > 0
      ? loginTimeoutMs
      : 10 * 60 * 1000;
  let timeoutId;
  let code;
  try {
    code = await Promise.race([
      callback.code,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("login timed out waiting for browser callback"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    callback.close();
    fail(error instanceof Error ? error.message : "login cancelled");
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  const { status, json } = await request(
    "POST",
    `${config.apiUrl}/api/keys/exchange`,
    { code },
  );
  if (status !== 200 && status !== 201) {
    fail(
      `login failed (${status}): ${json.error ?? "exchange endpoint unavailable on this instance"}`,
    );
  }
  const apiKey = json.apiKey ?? json.key;
  if (!apiKey || typeof apiKey !== "string") {
    fail("login failed: exchange response did not include an apiKey");
  }
  mutateCredentials((credentials) => {
    credentials.apiKey = apiKey;
  });
  console.error("logged in; API key stored in credentials.json");
}

function commandLogout() {
  mutateCredentials((credentials) => {
    delete credentials.apiKey;
  });
  console.error("logged out; removed stored API key");
}

async function commandWhoami(flags) {
  const config = loadConfig(flags);
  // whoami must use an sk_ only — resolveAuthToken may return createToken /
  // OPEN_ARTIFACTS_TOKEN ahead of a stored API key, so prefer sk_ explicitly.
  const token = resolveAuthToken(flags);
  const sk = token?.startsWith("sk_") ? token : loadCredentials().apiKey;
  if (!sk?.startsWith("sk_")) {
    fail(
      "not logged in; run the CLI's `login` command on a SaaS instance first",
    );
  }
  const { status, json } = await request(
    "GET",
    `${config.apiUrl}/api/me`,
    undefined,
    sk,
  );
  if (status !== 200) {
    fail(`whoami failed (${status}): ${json.error ?? "unknown error"}`);
  }
  const login = json.login ?? json.email ?? json.id ?? "unknown";
  console.log(login);
}

// Live editing (SaaS instance with LIVE_DO bound).
//
// Two modes, both harness-agnostic (one JSON line on stdout, then exit):
//
//   node artifact.mjs live <id>                    # poll: block for one event
//   node artifact.mjs live <id> --reply <eid> done --version <n>
//                                                 # reply: ack + broadcast
//
// The agent loop: poll -> receive {type:'generate', items:[{element, prompt}], ...}
// -> for each item, edit the artifact source to apply its prompt to its element
// (match by id -> class -> tag -> outerHTML; no variant wrapper — Live is
// one-shot edit-and-reload) -> `update` to republish -> `--reply <eid> done
// --version <n>` -> the Worker broadcasts 'done' to the browser, which reloads
// the frame. Session ends.
async function commandLive(rest, flags) {
  const config = loadConfig(flags);
  const id = rest[0];
  if (!id)
    fail(
      "usage: artifact.mjs live <id> [--reply <eid> <status> --version <n>]",
    );
  const token = resolveAuthToken(flags);
  const sk = token?.startsWith("sk_") ? token : loadCredentials().apiKey;
  if (!sk?.startsWith("sk_")) {
    fail(
      "not logged in; run the CLI's `login` command on a SaaS instance first",
    );
  }
  const base = `${config.apiUrl}/api/artifacts/${encodeURIComponent(id)}/live`;

  // Reply mode: POST /reply {id, type, version, ...data} then exit. --data
  // carries the canonical edit-result JSON (status/appliedEntryIds/failed/
  // files/notes) so the browser can show what was applied, mirroring
  // impeccable's `live-poll.mjs --reply <id> done --data '<json>'`.
  const replyId = flags.reply;
  if (replyId) {
    const status = rest[1] ?? "done";
    const version = flags.version;
    const body = { id: replyId, type: status, version };
    if (flags.data !== undefined) {
      try {
        const data = JSON.parse(flags.data);
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          throw new Error("object required");
        }
        Object.assign(body, data);
      } catch {
        fail(`--data must be a JSON object, got: ${flags.data}`);
      }
    }
    const { status: httpStatus, json } = await request(
      "POST",
      `${base}/reply`,
      body,
      sk,
    );
    if (httpStatus !== 200) {
      fail(`live reply failed (${httpStatus}): ${json.error ?? "unknown"}`);
    }
    console.log(JSON.stringify({ ok: true }));
    return;
  }

  // Poll mode: long-poll one event, print JSON, exit. --watch loops.
  const typesRaw = flags.types;
  // Default 60s: a long-poll must complete before the edge drops an idle
  // client connection (~127s; a longer request dies mid-hold as "other side
  // closed" and the watch loop retries). 60s is comfortable margin under that.
  const timeoutMs = Number(process.env.OPEN_ARTIFACTS_LIVE_TIMEOUT_MS);
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  // Per-process watcher id (v4), sent on every poll. The DO uses it to
  // supersede a dead in-flight poll when the watch loop re-polls, so a stale
  // waiter can't consume a comment the watcher would then miss (the "other
  // side closed" retry loop). Unique per watcher process so two watchers on
  // one artifact never prune each other's waiters.
  const watcherId = `w_${randomBytes(8).toString("hex")}`;
  // Inline fetch wrapper that does NOT process.exit on network error — watch
  // mode must survive transient failures and retry. (`request()` below calls
  // fail()/process.exit on fetch throw, which would kill the watcher.)
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${sk}`,
  };
  const fetchJson = async (method, url, body) => {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new Error(`cannot reach ${url}: ${deepCause(cause)}`);
    }
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text.slice(0, 200) };
    }
    return { status: response.status, json };
  };
  const pollOnce = async (exclude = []) => {
    const params = new URLSearchParams({ timeout: String(timeout) });
    params.set("watcher", watcherId);
    if (typesRaw) params.set("types", typesRaw);
    if (exclude.length) params.set("exclude", exclude.join(","));
    const { status: httpStatus, json } = await fetchJson(
      "GET",
      `${base}/poll?${params}`,
    );
    if (httpStatus !== 200) {
      // 401/403/404 are definitive, not transient: the artifact is missing or
      // this token is not authorized for it (private/owner gate). Tag the
      // error (err.status) so the watch loop can distinguish the class without
      // parsing the message, and name the cause so an operator chasing a
      // silent 404 loop can fix it.
      const err = new Error(
        `live poll failed (${httpStatus}): ${json.error ?? "unknown"}`,
      );
      if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
        err.status = httpStatus;
        err.message +=
          " — the artifact may not exist or this token is not authorized for it; verify the id and that you are logged in as its owner (`whoami`; references/auth.md)";
      }
      throw err;
    }
    return json;
  };
  const reply = async (eid, type, version) => {
    const { status: httpStatus, json } = await fetchJson(
      "POST",
      `${base}/reply`,
      { id: eid, type, version },
    );
    if (httpStatus !== 200) {
      throw new Error(
        `live reply failed (${httpStatus}): ${json.error ?? "unknown"}`,
      );
    }
    return json;
  };

  // Ack-status polling: the watch loop waits for each event's `done` reply to
  // clear it from the DO's pending queue before polling the next, so the loop
  // paces one event at a time and avoids re-delivering a lease-expired,
  // unreplied event ahead of a newer one. The reply POST is synchronous, so
  // this is about pacing the decoupled watcher, not confirming the reply.
  // When the user submits a NEWER event during the wait, the ack poll returns
  // "new" and the loop delivers it immediately (poll excludes in-flight ids,
  // so the still-pending event is never re-delivered). The deadline/exit/
  // resilience logic lives in lib/live-ack.mjs (unit-tested).
  const fetchStatus = async () => {
    const { status: httpStatus, json } = await fetchJson(
      "GET",
      `${base}/status`,
    );
    if (httpStatus !== 200) {
      throw new Error(
        `live status failed (${httpStatus}): ${json.error ?? "unknown"}`,
      );
    }
    return json;
  };
  // Drop queued exit rows so a stale exit from a prior session can't poison a
  // new --watch (pollOnce would otherwise re-offer it for up to the 1h GC).
  // Called when the watcher observes an exit, via pollOnce or /status.
  const consumeExit = async () => {
    try {
      await fetchJson("POST", `${base}/consume-exit`);
    } catch (e) {
      console.error(`[live watch] consume-exit failed: ${e.message}`);
    }
  };
  const parseMs = (raw, def, min = 0) => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= min ? n : def;
  };
  const ackTimeoutMs = parseMs(flags["ack-timeout"], 600_000);
  const ackPollMs = parseMs(flags["ack-poll"], 1000, 1);
  // Strip a base64 screenshot from an event before printing it to stdout. The
  // live protocol does not transmit screenshots, but a stale cached page could
  // still submit one (the browser channel is untrusted); a multi-MB base64 blob
  // would flood the agent's context and hide the actual request content. The
  // browser stops sending it after this change, so this is a defensive guard,
  // not the primary path.
  const stripForAgent = (evt) => {
    if (!evt || typeof evt !== "object" || !("screenshot" in evt)) return evt;
    const { screenshot: _screenshot, ...clean } = evt;
    return clean;
  };

  // `live <id> --wait-ack <eid>`: block until the event leaves pendingEvents
  // (or the ack timeout / session exit). Standalone defensive probe.
  const waitAckId = flags["wait-ack"];
  if (waitAckId) {
    const result = await waitForEventAck(fetchStatus, waitAckId, {
      pollIntervalMs: ackPollMs,
      maxWaitMs: ackTimeoutMs,
    });
    if (result !== "cleared") {
      fail(
        result === "exit"
          ? `session exited before event ${waitAckId} was acknowledged`
          : `ack timeout waiting for event ${waitAckId}`,
      );
    }
    console.log(JSON.stringify({ ok: true, id: waitAckId }));
    return;
  }

  if (!flags.watch) {
    // One-shot: print one event and exit.
    console.log(JSON.stringify(stripForAgent(await pollOnce())));
    return;
  }

  // Watch mode: stay online for the whole Live session. On each event,
  // immediately reply `ack` so the host shows "agent is editing", print the
  // event JSON for the agent to act on, then keep polling for the next event
  // (a second `live` poll returns `done` after the agent republishes, or
  // `exit` when the browser closes the session). Exits on `exit` or Ctrl-C.
  console.error("[live watch] online; waiting for events (Ctrl-C to stop)");
  // Presence heartbeat: POST /live/heartbeat on a fixed interval so the
  // viewer's Live toggle shows this watcher as connected (agentActive in
  // /live/status). Fire-and-forget — a transient failure must not kill the
  // watcher; presence decays server-side after ~3 missed beats.
  const heartbeatMs = parseMs(
    process.env.OPEN_ARTIFACTS_LIVE_HEARTBEAT_MS,
    20_000,
    1,
  );

  // Ids delivered this session (grow-only). Passed as the poll exclude so a
  // lease-expired, unreplied event is never re-delivered ahead of newer ones,
  // even when the ack-wait early-returns on a new submission.
  const delivered = new Set();

  // WebSocket transport: when supported by the runtime (Node >= 22 has global
  // WebSocket) and not explicitly disabled via OPEN_ARTIFACTS_LIVE_TRANSPORT=poll,
  // connect to the DO via ticketed WebSocket. This allows the Durable Object
  // to hibernate between events (zero duration billing when idle) instead of
  // holding continuous 60s long-poll promises. On connection or ticket failure,
  // falls back automatically to the HTTP long-poll loop below.
  const transportPreference = process.env.OPEN_ARTIFACTS_LIVE_TRANSPORT;
  const allowWs =
    transportPreference !== "poll" && typeof WebSocket === "function";

  if (allowWs) {
    try {
      const ended = await watchOverWs({
        base,
        sk,
        delivered,
        fetchJson,
        reply,
        consumeExit,
        stripForAgent,
        heartbeatMs,
        ackTimeoutMs,
      });
      if (ended) return;
    } catch (e) {
      const auth =
        e && (e.status === 401 || e.status === 403 || e.status === 404);
      if (auth) {
        console.error(
          `[live watch] ticket rejected (${e.status}); the artifact may not exist or this token is not authorized for it — falling back to poll`,
        );
      } else {
        console.error(
          `[live watch] ticket/ws unavailable (${e.message}); falling back to HTTP long-poll`,
        );
      }
    }
  }

  const heartbeat = async () => {
    try {
      await fetchJson("POST", `${base}/heartbeat`);
    } catch {
      // transient; presence decays server-side
    }
  };
  void heartbeat();
  const heartbeatTimer = setInterval(heartbeat, heartbeatMs);
  let authWarned = false;
  while (true) {
    let evt;
    try {
      evt = await pollOnce([...delivered]);
    } catch (e) {
      // Transient poll error — back off and retry. An auth-class failure
      // (401/403/404, tagged by pollOnce with the artifact/token hint in the
      // message) prints in full once so a stale id or token is diagnosable
      // instead of a silent 404 spin; retries then stay terse.
      const auth =
        e && (e.status === 401 || e.status === 403 || e.status === 404);
      if (auth) {
        if (!authWarned) {
          authWarned = true;
          console.error(`[live watch] ${e.message}`);
        }
        console.error(
          "[live watch] poll rejected (401/403/404); retrying in 2s",
        );
      } else {
        console.error(`[live watch] ${e.message}; retrying in 2s`);
      }
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    // A poll timeout is a heartbeat of the loop, not an event: printing it on
    // stdout would spam the agent's event stream (every poll interval) and
    // could be mistaken for something to act on. One-shot mode still prints
    // the timeout JSON — that is its contract.
    if (evt.type === "timeout") continue;
    delivered.add(evt.id);
    console.log(JSON.stringify(stripForAgent(evt)));
    if (evt.type === "exit") {
      clearInterval(heartbeatTimer);
      await consumeExit();
      console.error("[live watch] session ended");
      break;
    }
    if (evt.type === "generate" || evt.type === "edit") {
      try {
        await reply(evt.id, "ack");
      } catch (e) {
        console.error(`[live watch] ack failed: ${e.message}`);
      }
      // Wait for the agent's `done` to clear the event before polling the
      // next, so the loop paces one event at a time and avoids re-delivering
      // a lease-expired, unreplied event ahead of a newer one. Disable with
      // --ack-timeout=0 for the legacy fire-and-forget behavior. An `exit`
      // arriving during the wait (user closed the session) breaks the loop so
      // the watcher stops promptly instead of blocking for the ack timeout.
      // A NEWER generate arriving during the wait returns "new": poll now and
      // deliver it immediately instead of blocking for the full ack timeout.
      if (ackTimeoutMs > 0) {
        const result = await waitForEventAck(fetchStatus, evt.id, {
          pollIntervalMs: ackPollMs,
          maxWaitMs: ackTimeoutMs,
          knownIds: delivered,
        });
        if (result === "exit") {
          clearInterval(heartbeatTimer);
          await consumeExit();
          console.error("[live watch] session ended during edit");
          break;
        }
        if (result === "new") {
          continue;
        }
        if (result === "timeout") {
          console.error(
            `[live watch] ack timeout on event ${evt.id}; continuing`,
          );
        }
      }
    }
    // The agent (the parent process consuming our stdout) now edits source,
    // republishes, and the host reloads. A subsequent poll here will block
    // until the next event (another generate, or exit). We do NOT auto-reply
    // `done` — that's the agent's job after it republishes; the agent calls
    // `live <id> --reply <eid> done --version <n>` itself.
  }
}

async function watchOverWs({
  base,
  sk: _sk,
  delivered,
  fetchJson,
  reply,
  consumeExit,
  stripForAgent,
  heartbeatMs,
  ackTimeoutMs,
}) {
  let ws = null;
  let heartbeatTimer = null;
  let closedExpected = false;

  const { status, json } = await fetchJson("POST", `${base}/ticket`);
  if (status !== 200 || typeof json?.ticket !== "string") {
    const err = new Error(
      `ticket request failed (${status}): ${json?.error ?? "tickets unsupported"}`,
    );
    err.status = status;
    throw err;
  }
  const ticket = json.ticket;
  const wsUrl = `${base.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket)}`;

  const incomingEvents = [];
  let pendingEventResolve = null;
  let pendingEventReject = null;
  const clearedIds = new Set();
  const ackResolvers = new Map(); // evtId -> resolver

  await new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      return reject(err);
    }
    let opened = false;
    socket.onopen = () => {
      opened = true;
      ws = socket;
      resolve();
    };
    socket.onerror = (e) => {
      if (!opened) {
        reject(new Error(e?.message || "websocket connection failed"));
      }
    };
    socket.onclose = () => {
      if (!opened) {
        reject(new Error("websocket closed before open"));
      }
    };
  });

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "event" && msg.event) {
      const evt = msg.event;
      // If waiting on an ack for a different event, a new generate/edit event
      // triggers the "new" fast-path to deliver it without waiting out the ack timeout.
      // An exit event aborts the ack-wait.
      for (const [id, resolver] of ackResolvers.entries()) {
        if (evt.type === "exit") {
          resolver("exit");
        } else if (evt.id !== id) {
          resolver("new");
        }
      }
      if (pendingEventResolve) {
        const r = pendingEventResolve;
        pendingEventResolve = null;
        pendingEventReject = null;
        r(evt);
      } else {
        incomingEvents.push(evt);
      }
    } else if (msg.type === "cleared" && typeof msg.id === "string") {
      clearedIds.add(msg.id);
      const resolver = ackResolvers.get(msg.id);
      if (resolver) {
        ackResolvers.delete(msg.id);
        resolver("cleared");
      }
    }
  };

  let isClosed = false;
  let closeError = null;

  ws.onclose = () => {
    isClosed = true;
    closeError = new Error("websocket closed unexpectedly");
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (!closedExpected && pendingEventReject) {
      pendingEventReject(closeError);
    }
    for (const resolver of ackResolvers.values()) {
      resolver("timeout");
    }
    ackResolvers.clear();
  };

  const getNextEvent = () => {
    if (incomingEvents.length > 0) {
      return Promise.resolve(incomingEvents.shift());
    }
    if (isClosed && !closedExpected) {
      return Promise.reject(
        closeError || new Error("websocket closed unexpectedly"),
      );
    }
    return new Promise((resolve, reject) => {
      pendingEventResolve = resolve;
      pendingEventReject = reject;
    });
  };

  // Sync ready with already-delivered ids so pending events in SQLite are delivered
  ws.send(JSON.stringify({ type: "ready", delivered: [...delivered] }));

  // Periodic heartbeat frames over WebSocket (wakes DO briefly without holding duration)
  heartbeatTimer = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "hb" }));
    } catch {
      // socket closed
    }
  }, heartbeatMs);

  while (true) {
    const evt = await getNextEvent();
    if (evt.type === "timeout") continue;
    delivered.add(evt.id);
    console.log(JSON.stringify(stripForAgent(evt)));

    if (evt.type === "exit") {
      closedExpected = true;
      clearInterval(heartbeatTimer);
      try {
        ws.close();
      } catch {}
      await consumeExit();
      console.error("[live watch] session ended");
      return true;
    }

    if (evt.type === "generate" || evt.type === "edit") {
      try {
        await reply(evt.id, "ack");
      } catch (e) {
        console.error(`[live watch] ack failed: ${e.message}`);
      }

      if (ackTimeoutMs > 0 && !clearedIds.has(evt.id)) {
        let timer = null;
        const result = await new Promise((resolve) => {
          timer = setTimeout(() => {
            ackResolvers.delete(evt.id);
            resolve("timeout");
          }, ackTimeoutMs);
          ackResolvers.set(evt.id, (res) => {
            clearTimeout(timer);
            ackResolvers.delete(evt.id);
            resolve(res);
          });
        });

        if (result === "exit") {
          closedExpected = true;
          clearInterval(heartbeatTimer);
          try {
            ws.close();
          } catch {}
          await consumeExit();
          console.error("[live watch] session ended during edit");
          return true;
        }
        if (result === "timeout") {
          console.error(
            `[live watch] ack timeout on event ${evt.id}; continuing`,
          );
        }
      }
    }
  }
}

const HELP = `usage: artifact.mjs <command> [options]

commands:
  validate <recipe>    validate and compose a Recipe without writing output
  build <recipe>       write an explicit preview/export (requires --output)
  smoke <recipe>       render a scrolling HTML artifact at 320/375/414/768px
  create <recipe>      build in memory and publish exactly once
  update <id> [recipe] build in memory and redeploy at the same URL; defaults
                       to the Recipe recorded in Manifest v2; --live replaces
                       the currently served version in place
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
  login [--provider google|github]
                       OAuth login via loopback callback; stores sk_ in
                       credentials.json (requires a SaaS instance)
  logout               remove the stored API key from credentials.json
  whoami               print the authenticated SaaS user for the current API key
  live <id>            live editing: poll one event (stdout JSON, exit),
                       or --reply <eid> <status> --version <n> [--data <json>]
                       to ack (--data carries the canonical edit-result JSON)
  live <id> --watch    stay online for the session: poll, auto-ack each
                       generate/edit, print each event on stdout, exit on
                       "exit"; waits for each event's done reply (polls
                       /live/status) before polling the next (--ack-timeout=0
                       disables)
  live <id> --wait-ack <eid>
                       block until event <eid> leaves the pending queue
                       (polls /live/status) or the ack timeout elapses

options:
  --output <path>      (build) explicit preview/export output path
  --standalone         (build) wrap HTML for direct file:// preview
                       (smoke starts its own local HTTP preview)
  --label <l>          (create/update) version label (max 60 bytes; note: CJK chars are 3 bytes each, so keep labels terse)
  --password <p>       encrypt client-side; server only stores ciphertext
  --api <url>          instance URL (default: OPEN_ARTIFACTS_URL or config)
  --token <t>          bearer token (overrides OPEN_ARTIFACTS_API_KEY and env)
  --visibility <v>     (create) private, org, or public (default private with sk_)
  --org <id>           (create) organization id for org-scoped artifacts
  --provider <name>    (login) google or github OAuth provider
  --port <n>           (login) loopback callback port (default: ephemeral)
  --force              overwrite on version conflict
  --live               (update) replace the current version without creating a new one
  --v <n>              (show) view a specific version's content
  --hook               (status) emit Claude Code hook JSON instead of text
  --ack-timeout <ms>   (live --watch/--wait-ack) max wait for an event's done
                       reply before continuing; default 600000, 0 disables
  --ack-poll <ms>      (live --watch/--wait-ack) /live/status poll interval;
                       default 1000 (remote-Worker friendly)

poll timeout: OPEN_ARTIFACTS_LIVE_TIMEOUT_MS (default 60000). The server
clamps polls to its own ceiling (60s); keep this under it.
  --data <json>        (live --reply) canonical edit-result JSON object,
                       merged into the reply body (status/appliedEntryIds/
                       failed/files/notes)

auth precedence for requests: --token > OPEN_ARTIFACTS_API_KEY > credentials.json apiKey >
OPEN_ARTIFACTS_TOKEN > config createToken
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
      token: { type: "string" },
      visibility: { type: "string" },
      org: { type: "string" },
      provider: { type: "string" },
      port: { type: "string" },
      force: { type: "boolean" },
      live: { type: "boolean" },
      hook: { type: "boolean" },
      v: { type: "string" },
      reply: { type: "string" },
      data: { type: "string" },
      types: { type: "string" },
      version: { type: "string" },
      watch: { type: "boolean" },
      "wait-ack": { type: "string" },
      "ack-timeout": { type: "string" },
      "ack-poll": { type: "string" },
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
    case "smoke":
      if (!rest[0]) fail("smoke requires a Recipe JSON path");
      await commandSmoke(rest[0]);
      break;
    case "create":
      if (!rest[0]) fail("create requires a Recipe JSON path");
      await commandCreate(rest[0], flags);
      break;
    case "update":
      if (!rest[0]) fail("update requires an artifact id");
      await commandUpdate(rest[0], rest[1], flags, flags.live === true);
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
    case "login":
      await commandLogin(flags);
      break;
    case "logout":
      commandLogout();
      break;
    case "whoami":
      await commandWhoami(flags);
      break;
    case "live":
      await commandLive(rest, flags);
      break;
    default:
      fail(`unknown command: ${command}\n${HELP}`);
  }
}

main().catch((error) => fail(error.message));
