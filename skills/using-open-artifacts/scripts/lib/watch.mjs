import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PROJECT_ROOT } from "./paths.mjs";
import { resolveWatchFiles } from "./recipe.mjs";

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function snapshotResolvedFiles(files) {
  const snapshot = {};
  for (const file of files.sort((left, right) =>
    left.projectPath.localeCompare(right.projectPath),
  )) {
    snapshot[file.projectPath] = sha256(readFileSync(file.real));
  }
  return snapshot;
}

export function snapshotWatch(globs) {
  return snapshotResolvedFiles(resolveWatchFiles(globs, PROJECT_ROOT));
}

export function diffSnapshot(previous, current) {
  const changed = [];
  for (const [path, hash] of Object.entries(current)) {
    if (previous[path] !== hash) changed.push(path);
  }
  for (const path of Object.keys(previous)) {
    if (!(path in current)) changed.push(`${path} (deleted)`);
  }
  return changed;
}
