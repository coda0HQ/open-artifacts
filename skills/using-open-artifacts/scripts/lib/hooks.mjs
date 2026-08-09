import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./cli-state.mjs";

export function hookInstalled(projectDir) {
  const settings = readJson(join(projectDir, ".claude/settings.json"), {});
  return (settings.hooks?.Stop ?? []).some((group) =>
    (group.hooks ?? []).some((hook) => hook.command?.includes("artifact.mjs")),
  );
}

export function installStopHook(projectDir, scriptUrl) {
  const scriptPath = fileURLToPath(scriptUrl);
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
