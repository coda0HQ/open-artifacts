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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PBKDF2_ITERATIONS = 600_000;
const MANIFEST_PATH = ".artifacts/manifest.json";
const CREDENTIALS_PATH = ".artifacts/credentials.json";

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
  const local = readJson(".artifacts/config.json", {});
  const global = readJson(
    join(homedir(), ".config/open-artifacts/config.json"),
    {},
  );
  const apiUrl =
    flags.api ??
    process.env.OPEN_ARTIFACTS_URL ??
    local.apiUrl ??
    global.apiUrl;
  const createToken =
    process.env.OPEN_ARTIFACTS_TOKEN ?? local.createToken ?? global.createToken;
  if (!apiUrl) {
    fail(
      'no instance configured. Set OPEN_ARTIFACTS_URL, pass --api <url>, or write .artifacts/config.json {"apiUrl": "https://..."}',
    );
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ""), createToken };
}

function loadManifest() {
  return readJson(MANIFEST_PATH, { artifacts: [] });
}

function saveManifest(manifest) {
  writeJson(MANIFEST_PATH, manifest);
}

function loadCredentials() {
  return readJson(CREDENTIALS_PATH, { tokens: {} });
}

function saveCredentials(credentials) {
  writeJson(CREDENTIALS_PATH, credentials);
  ensureGitignored();
}

function ensureGitignored() {
  if (!existsSync(".git")) return;
  const line = ".artifacts/credentials.json";
  const current = existsSync(".gitignore")
    ? readFileSync(".gitignore", "utf8")
    : "";
  if (current.split("\n").some((l) => l.trim() === line)) return;
  writeFileSync(".gitignore", `${current.replace(/\n*$/, "\n")}${line}\n`);
  console.error(`note: added ${line} to .gitignore`);
}

const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");

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
  return { status: response.status, json };
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
  const manifest = loadManifest();
  const source = readFileSync(file, "utf8");
  // If this channel was already in the manifest, replace the entry instead
  // of appending a duplicate.
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
    channel: flags.channel ?? null,
    watch,
    snapshot: snapshotWatch(watch),
    sourceFile: relative(process.cwd(), resolve(file)),
    version: json.version,
    updatedAt: new Date().toISOString(),
  };
  if (existingIdx >= 0) {
    manifest.artifacts[existingIdx] = entry;
  } else {
    manifest.artifacts.push(entry);
  }
  saveManifest(manifest);

  // First creation returns a one-time write token; a channel-driven update
  // (status 200) does not. Only persist the wt_ when present.
  if (json.writeToken) {
    const credentials = loadCredentials();
    credentials.tokens[json.id] = json.writeToken;
    saveCredentials(credentials);
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
  if (!entry) fail(`artifact ${id} not found in ${MANIFEST_PATH}`);
  return entry;
}

async function commandUpdate(id, file, flags) {
  const config = loadConfig(flags);
  const manifest = loadManifest();
  const entry = findEntry(manifest, id);
  const credentials = loadCredentials();
  const token = credentials.tokens[id];
  if (!token) fail(`no write token for ${id} in ${CREDENTIALS_PATH}`);

  const sourceFile = file ?? entry.sourceFile;
  if (!sourceFile)
    fail("no file given and no sourceFile recorded in the manifest");
  if (entry.encrypted && !flags.password) {
    fail(
      "this artifact is password protected; pass --password to re-encrypt the update",
    );
  }
  const payload = await preparePayload(sourceFile, {
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

  entry.version = json.version;
  entry.updatedAt = new Date().toISOString();
  entry.snapshot = snapshotWatch(entry.watch ?? []);
  entry.sourceFile = relative(process.cwd(), resolve(sourceFile));
  if (flags.title) entry.title = flags.title;
  if (flags.favicon) entry.favicon = flags.favicon;
  saveManifest(manifest);

  console.log(json.url ?? entry.url);
  console.error(`updated artifact ${id} to version ${json.version}`);
}

async function commandDelete(id, flags) {
  const config = loadConfig(flags);
  const manifest = loadManifest();
  findEntry(manifest, id);
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

  manifest.artifacts = manifest.artifacts.filter((a) => a.id !== id);
  saveManifest(manifest);
  delete credentials.tokens[id];
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

function commandStatus(flags) {
  if (!existsSync(MANIFEST_PATH)) {
    if (!flags.hook) console.error("no artifact manifest; nothing to check");
    return;
  }
  const stale = staleArtifacts();
  if (stale.length === 0) {
    if (!flags.hook) console.error("all artifacts are up to date");
    return;
  }

  if (flags.hook) {
    const scriptPath = fileURLToPath(import.meta.url);
    const lines = stale.map(({ entry, changed }) => {
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
    console.log(`  changed: ${changed.join(", ")}`);
  }
  process.exitCode = 1;
}

function commandList() {
  const manifest = loadManifest();
  if (manifest.artifacts.length === 0) {
    console.error("no artifacts in manifest");
    return;
  }
  for (const entry of manifest.artifacts) {
    console.log(
      `${entry.id}  v${entry.version}  ${entry.encrypted ? "[protected] " : ""}${entry.title ?? ""}  ${entry.url}`,
    );
  }
}

function commandInstallHook() {
  const scriptPath = fileURLToPath(import.meta.url);
  // Claude Code loads hooks from $CLAUDE_PROJECT_DIR/.claude/settings.json, so
  // resolve the project root from that env var when set (it is set during agent
  // sessions) and fall back to cwd for human-invoked runs.
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const relativeToProject = relative(projectDir, scriptPath);
  const command = relativeToProject.startsWith("..")
    ? `node "${scriptPath}" status --hook`
    : `node "$CLAUDE_PROJECT_DIR/${relativeToProject}" status --hook`;

  const settingsPath = join(projectDir, ".claude/settings.json");
  const settings = readJson(settingsPath, {});
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  const exists = settings.hooks.Stop.some((group) =>
    (group.hooks ?? []).some((h) => h.command?.includes("artifact.mjs")),
  );
  if (exists) {
    console.error("stop hook already installed");
    return;
  }
  settings.hooks.Stop.push({ hooks: [{ type: "command", command }] });
  writeJson(settingsPath, settings);
  console.error(`installed Stop hook in ${settingsPath}`);
}

const HELP = `usage: artifact.mjs <command> [options]

commands:
  create <file>        publish a new artifact
  update <id> [file]   redeploy an artifact (uses recorded sourceFile if omitted)
  status               report artifacts whose watched files changed (exit 1 if stale)
  list                 list artifacts in the manifest
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
  --api <url>          instance URL (default: OPEN_ARTIFACTS_URL or config)
  --force              overwrite on version conflict
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
      api: { type: "string" },
      force: { type: "boolean" },
      hook: { type: "boolean" },
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
      commandStatus(flags);
      break;
    case "list":
      commandList();
      break;
    case "install-hook":
      commandInstallHook();
      break;
    default:
      fail(`unknown command: ${command}\n${HELP}`);
  }
}

main().catch((error) => fail(error.message));
