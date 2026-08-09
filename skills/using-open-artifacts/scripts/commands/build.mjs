import { relative, resolve } from "node:path";
import {
  buildArtifactRecipe,
  recipeBuildSummary,
  writeArtifactPreview,
} from "../build-artifact.mjs";
import { ensureGitignored } from "../lib/cli-state.mjs";
import { ARTIFACTS_DIR, PROJECT_ROOT } from "../lib/paths.mjs";
import { requireRecipePath } from "../lib/validation.mjs";

export function commandValidate(recipePath) {
  const result = buildArtifactRecipe(
    resolve(PROJECT_ROOT, requireRecipePath(recipePath)),
    { projectRoot: PROJECT_ROOT },
  );
  console.log(JSON.stringify(recipeBuildSummary(result), null, 2));
}

export function commandBuild(recipePath, flags) {
  if (!flags.output) throw new Error("build requires --output <path>");
  const result = buildArtifactRecipe(
    resolve(PROJECT_ROOT, requireRecipePath(recipePath)),
    { projectRoot: PROJECT_ROOT, standalone: flags.standalone === true },
  );
  const output = writeArtifactPreview(result, flags.output);
  const previewRelative = relative(joinPreviewRoot(), output);
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

function joinPreviewRoot() {
  return resolve(ARTIFACTS_DIR, "previews");
}
