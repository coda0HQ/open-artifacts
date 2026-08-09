import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifactRecipe } from "../build-artifact.mjs";
import {
  findEntry,
  loadCredentials,
  loadManifest,
  manifestFileForId,
  mutateManifest,
  readJson,
  writeJson,
} from "../lib/cli-state.mjs";
import { hookInstalled, installStopHook } from "../lib/hooks.mjs";
import { CREDENTIALS_PATH, MANIFEST, PROJECT_ROOT } from "../lib/paths.mjs";
import { recipeMetadataForEntry } from "../lib/recipe-payload.mjs";
import { diffSnapshot, snapshotWatch } from "../lib/watch.mjs";

export function staleArtifacts() {
  const stale = [];
  for (const entry of loadManifest().artifacts) {
    const watch = recipeMetadataForEntry(entry).watch ?? entry.watch ?? [];
    if (watch.length === 0) continue;
    const changed = diffSnapshot(entry.snapshot ?? {}, snapshotWatch(watch));
    if (changed.length > 0) stale.push({ entry, changed });
  }
  return stale;
}

export function readHookInput() {
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

export async function commandStatus(flags, scriptUrl) {
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
    const hookStale = stale.filter(({ entry }) => entry.autoUpdate === true);
    if (hookStale.length === 0) return;
    const scriptPath = fileURLToPath(scriptUrl);
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

export function commandAck(id) {
  findEntry(loadManifest(), id);
  const { local, manifest } = manifestFileForId(id);
  const entry = manifest.artifacts.find((artifact) => artifact.id === id);
  const watch = recipeMetadataForEntry(entry).watch ?? entry.watch ?? [];
  const snapshot = snapshotWatch(watch);
  const reviewedAt = new Date().toISOString();
  mutateManifest(local, (current) => {
    const latest = current.artifacts.find((candidate) => candidate.id === id);
    if (!latest) throw new Error(`manifest entry ${id} moved during ack`);
    latest.snapshot = snapshot;
    latest.reviewedAt = reviewedAt;
  });
  console.error(
    `acknowledged ${id}: snapshot baseline advanced without republishing`,
  );
}

function updateRecipeAutoUpdate(entry, enabled) {
  if (!entry.recipe) return;
  const recipePath = resolve(PROJECT_ROOT, entry.recipe);
  const recipe = readJson(recipePath, null);
  if (!recipe?.artifact) {
    throw new Error(`cannot update Recipe metadata: ${entry.recipe}`);
  }
  recipe.artifact.autoUpdate = enabled;
  writeJson(recipePath, recipe);
  const build = buildArtifactRecipe(recipePath, { projectRoot: PROJECT_ROOT });
  entry.recipeHash = `sha256:${build.loaded.recipeHash}`;
  entry.inputHash = `sha256:${build.inputHash}`;
  entry.outputHash = `sha256:${build.outputHash}`;
}

export function commandAutoUpdate(id, mode, scriptUrl) {
  if (mode !== "on" && mode !== "off") {
    throw new Error('auto-update mode must be "on" or "off"');
  }
  findEntry(loadManifest(), id);
  const { local, manifest } = manifestFileForId(id);
  const entry = manifest.artifacts.find((artifact) => artifact.id === id);
  if (mode === "off") {
    updateRecipeAutoUpdate(entry, false);
    mutateManifest(local, (current) => {
      const latest = current.artifacts.find((candidate) => candidate.id === id);
      if (!latest) throw new Error(`manifest entry ${id} moved during update`);
      latest.autoUpdate = false;
      latest.recipeHash = entry.recipeHash;
      latest.inputHash = entry.inputHash;
      latest.outputHash = entry.outputHash;
    });
    console.error(`auto-update disabled for ${id}`);
    return;
  }
  if (!loadCredentials().tokens[id]) {
    throw new Error(
      `no write token for ${id} in ${CREDENTIALS_PATH}; auto-update could never publish it. ` +
        "Run update once with a valid write token (or re-create the artifact) before enabling auto-update.",
    );
  }
  updateRecipeAutoUpdate(entry, true);
  mutateManifest(local, (current) => {
    const latest = current.artifacts.find((candidate) => candidate.id === id);
    if (!latest) throw new Error(`manifest entry ${id} moved during update`);
    latest.autoUpdate = true;
    latest.recipeHash = entry.recipeHash;
    latest.inputHash = entry.inputHash;
    latest.outputHash = entry.outputHash;
  });
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const { installed, settingsPath } = installStopHook(projectDir, scriptUrl);
  console.error(`auto-update enabled for ${id}`);
  console.error(
    installed
      ? `installed Stop hook in ${settingsPath}`
      : "stop hook already installed",
  );
}

export function commandList() {
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

export function commandInstallHook(scriptUrl) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const { installed, settingsPath } = installStopHook(projectDir, scriptUrl);
  console.error(
    installed
      ? `installed Stop hook in ${settingsPath}`
      : "stop hook already installed",
  );
}

export { hookInstalled };
