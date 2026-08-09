import { resolve } from "node:path";
import { buildArtifactRecipe } from "../build-artifact.mjs";
import { loadCredentials } from "./cli-state.mjs";
import { encryptContent } from "./content-crypto.mjs";
import { PROJECT_ROOT } from "./paths.mjs";
import { loadRecipe } from "./recipe.mjs";
import {
  credentialEnvName,
  MAX_CONTENT_BYTES,
  requireRecipePath,
  validateLabel,
} from "./validation.mjs";
import { snapshotResolvedFiles } from "./watch.mjs";

export function resolveRecipePassword(build, flags, artifactId = null) {
  if (!build.loaded.recipe.security.encrypted) return null;
  const name = build.loaded.recipe.security.passwordCredential;
  const credentials = loadCredentials();
  const password =
    flags.password ??
    process.env[credentialEnvName(name)] ??
    credentials.namedPasswords[name] ??
    (artifactId ? credentials.passwords[artifactId] : null);
  if (!password) {
    throw new Error(
      `encrypted Recipe requires --password, ${credentialEnvName(name)}, or credentials.namedPasswords.${name}`,
    );
  }
  return password;
}

export async function prepareRecipePayload(
  recipePath,
  flags,
  artifactId = null,
) {
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
  validateLabel(flags.label);
  if (flags.label) payload.label = flags.label;
  if (password) {
    const encryptedPayload = await encryptContent(
      build.publishContent,
      password,
    );
    if (Buffer.byteLength(encryptedPayload.content) > MAX_CONTENT_BYTES) {
      throw new Error(
        `encrypted output exceeds the ${MAX_CONTENT_BYTES} byte service limit`,
      );
    }
    payload.content = encryptedPayload.content;
    payload.encrypted = encryptedPayload.encrypted;
  }
  return { build, artifact, password, payload };
}

export function recipeMetadataForEntry(entry) {
  if (!entry.recipe) return entry;
  try {
    const { artifact, security } = loadRecipe(
      resolve(PROJECT_ROOT, entry.recipe),
      { projectRoot: PROJECT_ROOT },
    ).recipe;
    return { ...artifact, encrypted: security.encrypted };
  } catch {
    return entry;
  }
}

export function recipeSnapshot(build) {
  return snapshotResolvedFiles(build.loaded.watchFiles);
}

export function extractTitle(content, format) {
  if (format === "html") {
    const match = content.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match?.[1].trim() || null;
  }
  const heading = content.match(/^#\s+(.+)$/m);
  return heading?.[1].trim() || null;
}
