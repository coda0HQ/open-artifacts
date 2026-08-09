export { MAX_CONTENT_BYTES } from "./validate.mjs";

export function requireRecipePath(path) {
  if (!path) throw new Error("a Recipe JSON path is required");
  if (!/\.json$/i.test(path)) {
    throw new Error(
      `direct HTML/Markdown publishing is no longer supported; pass a Recipe JSON file (see references/recipe.md): ${path}`,
    );
  }
  return path;
}

export function credentialEnvName(name) {
  return `OPEN_ARTIFACTS_PASSWORD_${name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}`;
}

export function validateLabel(label) {
  if (label === undefined) return;
  const bytes = Buffer.byteLength(label);
  if (bytes > 60) {
    throw new Error(
      `--label must be at most 60 bytes (got ${bytes}, over by ${bytes - 60}; CJK chars are 3 bytes each — shorten or drop non-ASCII): ${label.slice(0, 60)}`,
    );
  }
}
