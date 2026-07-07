#!/usr/bin/env node
// Open Artifacts publishing CLI. Zero dependencies; requires Node >= 22.
// Used by the "artifacts" agent skill; also usable by humans.

import { createHash, webcrypto } from "node:crypto";
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PBKDF2_ITERATIONS = 600_000;
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

// Merge shared + local manifest entries. Keyed by id; a local entry with the
// same id replaces the shared one, local entries with new ids are appended.
// A channel is also unique — a local entry with a channel already present on
// a shared entry of a *different* id wins (local overrides), matching the
// settings.local.json "local overrides project" semantics.
function mergeArtifacts(shared, local) {
  const byId = new Map();
  for (const entry of shared) byId.set(entry.id, entry);
  for (const entry of local) byId.set(entry.id, entry);
  return [...byId.values()];
}

function loadManifest() {
  const shared = readJson(MANIFEST.shared, { artifacts: [] });
  const local = readJson(MANIFEST.local, { artifacts: [] });
  return { artifacts: mergeArtifacts(shared.artifacts, local.artifacts) };
}

function saveManifest(manifest, local) {
  writeJson(local ? MANIFEST.local : MANIFEST.shared, manifest);
}

function loadCredentials() {
  return readJson(CREDENTIALS_PATH, { tokens: {} });
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
    readJson(MANIFEST.local, { artifacts: [] }).artifacts.some(
      (a) => a.id === id,
    )
  ) {
    return {
      local: true,
      manifest: readJson(MANIFEST.local, { artifacts: [] }),
    };
  }
  return {
    local: false,
    manifest: readJson(MANIFEST.shared, { artifacts: [] }),
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

function inferFormat(file, explicit) {
  if (explicit) return explicit;
  return /\.(md|markdown)$/i.test(file) ? "markdown" : "html";
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function snapshotWatch(globs) {
  const snapshot = {};
  for (const pattern of globs) {
    const matches = globSync(pattern, {
      exclude: (p) =>
        p.includes("node_modules") || p.split("/").includes(".git"),
    });
    for (const path of matches.sort()) {
      if (!statSync(path).isFile()) continue;
      snapshot[path] = sha256(readFileSync(path));
    }
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

function parseWatch(flag) {
  if (!flag) return [];
  return flag
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}

async function preparePayload(file, flags) {
  if (!existsSync(file)) fail(`file not found: ${file}`);
  const source = readFileSync(file, "utf8");
  const format = inferFormat(file, flags.format);
  const payload = { format };
  if (flags.title) payload.title = flags.title;
  if (flags.description) payload.description = flags.description;
  if (flags.favicon) payload.favicon = flags.favicon;
  if (flags.label) payload.label = flags.label;
  if (flags.password) {
    const { content, encrypted } = await encryptContent(source, flags.password);
    payload.content = content;
    payload.encrypted = encrypted;
    if (!payload.title) {
      const extracted = extractTitle(source, format);
      if (extracted) payload.title = extracted;
    }
  } else {
    payload.content = source;
  }
  return payload;
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
function resolveLevel(flags) {
  if (flags.level) {
    const n = Number.parseInt(flags.level, 10);
    if (n !== 1 && n !== 2 && n !== 3) {
      fail(
        "--level must be 1, 2, or 3 (aliases: --simple / --interactive / --rich)",
      );
    }
    return n;
  }
  if (flags.simple) return 1;
  if (flags.interactive) return 2;
  if (flags.rich) return 3;
  return null;
}

async function commandCreate(file, flags) {
  if (!flags.favicon)
    fail("--favicon is required (one or two emoji, e.g. --favicon 📊)");
  const config = loadConfig(flags);
  const payload = await preparePayload(file, flags);

  // Channel binding: --channel <slug> makes every create with the same slug
  // land on the same URL (the server creates a new version, not a new
  // artifact). The slug maps to a ch_ token stored in credentials; the
  // server only ever sees the token's hash, so it can't forge it.
  let channelToken = null;
  if (flags.channel) {
    const credentials = loadCredentials();
    credentials.channels ??= {};
    if (!credentials.channels[flags.channel]) {
      credentials.channels[flags.channel] = generateChannelToken();
      saveCredentials(credentials);
    }
    channelToken = credentials.channels[flags.channel];
    payload.channel = channelToken;
  }

  const { status, json } = await request(
    "POST",
    `${config.apiUrl}/api/artifacts`,
    payload,
    config.createToken,
  );
  // 201 = newly created (first use of the channel); 200 = channel already
  // existed, server created a new version at the same URL.
  if (status !== 201 && status !== 200)
    fail(`create failed (${status}): ${json.error ?? "unknown error"}`);

  const watch = parseWatch(flags.watch);
  // The manifest we write to is selected by --local. An entry has exactly one
  // home file: writing --local on an id/channel that already lives in the
  // shared manifest MIGRATES it (delete from shared, write to local), and the
  // reverse — a non-local create on an id/channel in the local manifest —
  // migrates it back to shared. Without both directions, a shared + local
  // entry with the same id would leave delete/update (which use
  // manifestFileForId → local-first) clearing only the local copy and the
  // shared entry would be unreachable from the CLI.
  const targetFile = flags.local ? MANIFEST.local : MANIFEST.shared;
  const manifest = readJson(targetFile, { artifacts: [] });
  const source = readFileSync(file, "utf8");
  // Migrate the entry out of the *other* manifest file so the new home is the
  // single source. Match by id (a re-publish on the same channel reuses the
  // server-side id) and by channel slug (the user may have rebound it).
  const otherFile = flags.local ? MANIFEST.shared : MANIFEST.local;
  const other = readJson(otherFile, { artifacts: [] });
  const before = other.artifacts.length;
  other.artifacts = other.artifacts.filter(
    (a) => a.id !== json.id && (!flags.channel || a.channel !== flags.channel),
  );
  if (other.artifacts.length !== before) saveManifest(other, !flags.local);
  // If this channel was already in this manifest file, replace the entry
  // instead of appending a duplicate.
  const existingIdx = flags.channel
    ? manifest.artifacts.findIndex((a) => a.channel === flags.channel)
    : -1;
  const entry = {
    id: json.id,
    url: json.url,
    title: payload.title ?? extractTitle(source, payload.format) ?? null,
    favicon: flags.favicon,
    format: payload.format,
    encrypted: Boolean(flags.password),
    scope: flags.scope ?? null,
    autoUpdate: false,
    channel: flags.channel ?? null,
    level: resolveLevel(flags),
    watch,
    snapshot: snapshotWatch(watch),
    version: json.version,
    updatedAt: new Date().toISOString(),
  };
  if (existingIdx >= 0) {
    manifest.artifacts[existingIdx] = entry;
  } else {
    manifest.artifacts.push(entry);
  }
  saveManifest(manifest, flags.local);
  if (flags.local) ensureGitignored();

  // First creation returns a one-time write token; a channel-driven update
  // (status 200) does not. Only persist the wt_ when present.
  if (json.writeToken || flags.password) {
    const credentials = loadCredentials();
    if (json.writeToken) credentials.tokens[json.id] = json.writeToken;
    // The password for an encrypted artifact is stored in credentials.json
    // (gitignored, machine-local) so a later `update` or `show` can decrypt
    // the /raw ciphertext without re-prompting the user. The server only ever
    // holds ciphertext; the password never leaves this machine.
    if (flags.password) {
      credentials.passwords ??= {};
      credentials.passwords[json.id] = flags.password;
    }
    saveCredentials(credentials);
  }

  // Installing the staleness hook is the user's choice, so create never writes
  // to their settings — it only hints how to enable end-of-turn drift checks
  // when this artifact tracks files and no hook is installed yet.
  if (
    process.env.CLAUDE_PROJECT_DIR &&
    watch.length > 0 &&
    !hookInstalled(process.env.CLAUDE_PROJECT_DIR)
  ) {
    console.error(
      'tip: run "artifact.mjs install-hook" to flag this artifact stale automatically when its watched files change',
    );
  }

  console.log(json.url);
  const verb = status === 200 ? "updated" : "published";
  console.error(`${verb} artifact ${json.id} (version ${json.version})`);
  if (flags.channel) {
    console.error(`channel "${flags.channel}" → stable URL across updates`);
  }
  if (flags.password) {
    console.error("password protected: share the URL and password separately");
  }
}

function findEntry(manifest, id) {
  const entry = manifest.artifacts.find((a) => a.id === id);
  if (!entry) fail(`artifact ${id} not found in ${MANIFEST.shared}`);
  return entry;
}

async function commandUpdate(id, file, flags) {
  if (!file)
    fail(
      "update requires a file argument: regenerate the page (fetch the current version from the server as a reference, read the project files in the artifact's scope) and pass the new file path",
    );
  const config = loadConfig(flags);
  const merged = loadManifest();
  const entry = findEntry(merged, id);
  const credentials = loadCredentials();
  const token = credentials.tokens[id];
  if (!token) fail(`no write token for ${id} in ${CREDENTIALS_PATH}`);

  if (entry.encrypted && !flags.password) {
    // Reuse the password stored at create time (gitignored, machine-local)
    // so updating a password-protected artifact doesn't re-prompt the user.
    const stored = credentials.passwords?.[id];
    if (!stored) {
      fail(
        "this artifact is password protected; pass --password (or re-create it with --password to store it for future updates)",
      );
    }
    flags = { ...flags, password: stored };
  }
  const payload = await preparePayload(file, {
    ...flags,
    format: flags.format ?? entry.format,
    favicon: flags.favicon ?? undefined,
  });
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

  // Write back to whichever file (shared vs local) the entry lives in. The
  // merged read above found it; --local is ignored here because an entry's
  // home file is a property of where it was created, not of this update.
  const { local, manifest } = manifestFileForId(id);
  const target = manifest.artifacts.find((a) => a.id === id);
  target.version = json.version;
  target.updatedAt = new Date().toISOString();
  target.snapshot = snapshotWatch(target.watch ?? []);
  if (flags.title) target.title = flags.title;
  if (flags.favicon) target.favicon = flags.favicon;
  saveManifest(manifest, local);
  // Refresh the stored password if a new one was given for this update.
  if (flags.password) {
    credentials.passwords ??= {};
    credentials.passwords[id] = flags.password;
    saveCredentials(credentials);
  }

  console.log(json.url ?? target.url);
  console.error(`updated artifact ${id} to version ${json.version}`);
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
    const watch = entry.watch ?? [];
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
      const scope = entry.scope ? ` It covers: ${entry.scope}.` : "";
      return (
        `Artifact "${entry.title ?? entry.id}" (${entry.url}, id ${entry.id}) was published from sources that have since changed.${scope} ` +
        `Changed files: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? ", ..." : ""}. ` +
        `If these changes affect the artifact's content, regenerate it and run: node "${scriptPath}" update ${entry.id} <file>`
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
    console.log(`stale: ${entry.id} ${entry.title ?? ""} (${entry.url})`);
    if (entry.scope) console.log(`  scope: ${entry.scope}`);
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
  entry.snapshot = snapshotWatch(entry.watch ?? []);
  entry.reviewedAt = new Date().toISOString();
  saveManifest(manifest, local);
  console.error(
    `acknowledged ${id}: snapshot baseline advanced without republishing`,
  );
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
    console.log(
      `${entry.id}  v${entry.version}  ${entry.encrypted ? "[protected] " : ""}${entry.autoUpdate === true ? "[auto-update] " : ""}${entry.title ?? ""}  ${entry.url}`,
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
  const merged = loadManifest();
  const entry = findEntry(merged, id);
  const credentials = loadCredentials();
  const token = credentials.tokens[id];
  const url = `${config.apiUrl}/api/artifacts/${id}/raw${
    flags.v ? `?v=${flags.v}` : ""
  }`;
  const { status, json, text } = await request("GET", url, undefined, token);
  if (status !== 200)
    fail(`show failed (${status}): ${json.error ?? "unknown error"}`);
  if (!entry.encrypted) {
    // /raw serves a non-encrypted artifact as text/plain; print the exact body.
    process.stdout.write(text);
    return;
  }
  // Encrypted: /raw returns {alg, kdf, iterations, salt, iv, ciphertext}.
  const password = flags.password ?? credentials.passwords?.[id];
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

const HELP = `usage: artifact.mjs <command> [options]

commands:
  create <file>        publish a new artifact
  update <id> <file>   redeploy an artifact at the same URL (file required:
                       regenerate from the server's current version + project
                       files, then pass the new file)
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
  --title <t>          page title (default: extracted from <title> tag / # heading)
  --description <d>    gallery-style subtitle
  --favicon <emoji>    one or two emoji (required for create)
  --format <f>         html | markdown (default: by file extension)
  --label <l>          version label (max 60 chars)
  --password <p>       encrypt client-side; server only stores ciphertext
  --scope <text>       what this artifact covers (drives auto-update decisions)
  --watch <globs>      comma-separated globs of source files to watch
  --channel <slug>     bind this artifact to a stable URL; reusing the slug on
                       a later create updates the same link (no new URL)
  --level <1|2|3>      production level: 1=simple doc, 2=interactive UI,
                       3=rich motion. Aliases: --simple / --interactive / --rich.
                       Omit to let the agent pick from the brief.
  --local              write the manifest entry to .artifacts/manifest.local.json
                       (gitignored, machine-local) instead of the committed
                       manifest. Reads merge the two (local overrides). Credentials
                       always go to the single .artifacts/credentials.json.
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
      title: { type: "string" },
      description: { type: "string" },
      favicon: { type: "string" },
      format: { type: "string" },
      label: { type: "string" },
      password: { type: "string" },
      scope: { type: "string" },
      watch: { type: "string" },
      channel: { type: "string" },
      level: { type: "string" },
      simple: { type: "boolean" },
      interactive: { type: "boolean" },
      rich: { type: "boolean" },
      api: { type: "string" },
      force: { type: "boolean" },
      hook: { type: "boolean" },
      local: { type: "boolean" },
      v: { type: "string" },
      help: { type: "boolean" },
    },
  });

  const [command, ...rest] = positionals;
  if (flags.help || !command) {
    console.log(HELP);
    return;
  }
  if (flags.format && flags.format !== "html" && flags.format !== "markdown") {
    fail('--format must be "html" or "markdown"');
  }

  switch (command) {
    case "create":
      if (!rest[0]) fail("create requires a file argument");
      await commandCreate(rest[0], flags);
      break;
    case "update":
      if (!rest[0]) fail("update requires an artifact id");
      await commandUpdate(rest[0], rest[1], flags);
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
