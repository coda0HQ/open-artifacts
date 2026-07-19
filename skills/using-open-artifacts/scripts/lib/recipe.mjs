import { createHash } from "node:crypto";
import {
  globSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const RECIPE_KEYS = new Set([
  "$schema",
  "version",
  "artifact",
  "document",
  "security",
  "build",
]);
const ARTIFACT_KEYS = new Set([
  "title",
  "description",
  "favicon",
  "format",
  "level",
  "canvas",
  "channel",
  "scope",
  "watch",
  "local",
  "autoUpdate",
]);
const DOCUMENT_KEYS = new Set(["language", "theme", "fragments"]);
const FRAGMENT_KEYS = new Set(["theme", "styles", "body", "scripts"]);
const SECURITY_KEYS = new Set(["encrypted", "passwordCredential"]);
const BUILD_KEYS = new Set(["strategy"]);

export const BUILD_LIMITS = Object.freeze({
  maxFragments: 128,
  maxFragmentBytes: 4 * 1024 * 1024,
  maxAggregateBytes: 8 * 1024 * 1024,
  stagedFragments: 24,
  stagedAggregateBytes: 512 * 1024,
  stagedFrames: 8,
  stagedSections: 20,
  stagedSingleFragmentBytes: 128 * 1024,
});

const fail = (message) => {
  throw new Error(`invalid recipe: ${message}`);
};

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function rejectUnknown(object, allowed, path) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${path}.${key} is not supported`);
  }
}

function requireKeys(object, keys, path) {
  for (const key of keys) {
    if (!(key in object)) fail(`${path}.${key} is required`);
  }
}

function requireString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    fail(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function optionalString(value, path) {
  if (value === null || value === undefined) return null;
  return requireString(value, path);
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function requireStringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${path} must be an array of strings`);
  }
  return value;
}

function isEmojiFavicon(value) {
  const segments = [
    ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value),
  ];
  return (
    segments.length >= 1 &&
    segments.length <= 2 &&
    segments.every((segment) =>
      /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(
        segment.segment,
      ),
    )
  );
}

function parseArtifact(raw) {
  if (!isObject(raw)) fail("artifact must be an object");
  rejectUnknown(raw, ARTIFACT_KEYS, "artifact");
  requireKeys(
    raw,
    [
      "favicon",
      "format",
      "canvas",
      "channel",
      "scope",
      "watch",
      "local",
      "autoUpdate",
    ],
    "artifact",
  );
  const format = raw.format ?? "html";
  if (format !== "html" && format !== "markdown" && format !== "react") {
    fail('artifact.format must be "html", "markdown", or "react"');
  }
  const level = raw.level ?? null;
  if (level !== null && ![1, 2, 3].includes(level)) {
    fail("artifact.level must be 1, 2, 3, or null");
  }
  const canvas = requireBoolean(raw.canvas ?? false, "artifact.canvas");
  if (canvas && format !== "html") {
    fail("artifact.canvas requires artifact.format to be html");
  }
  const channel = optionalString(raw.channel, "artifact.channel");
  if (channel !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(channel)) {
    fail("artifact.channel must be a kebab-case slug or null");
  }
  const watch = requireStringArray(raw.watch ?? [], "artifact.watch");
  if (watch.some((pattern) => pattern.trim() === "")) {
    fail("artifact.watch cannot contain empty patterns");
  }
  if (
    watch.some(
      (pattern) =>
        isAbsolute(pattern) ||
        pattern.includes("\0") ||
        pattern.split(/[\\/]/).includes(".."),
    )
  ) {
    fail("artifact.watch patterns must remain inside the project root");
  }
  const title = optionalString(raw.title, "artifact.title");
  const description =
    raw.description === null || raw.description === undefined
      ? ""
      : requireString(raw.description, "artifact.description", {
          allowEmpty: true,
        });
  const favicon = requireString(raw.favicon, "artifact.favicon");
  if (title !== null && title.length > 200) {
    fail("artifact.title must not exceed 200 characters");
  }
  if (description.length > 1000) {
    fail("artifact.description must not exceed 1000 characters");
  }
  if (!isEmojiFavicon(favicon)) {
    fail("artifact.favicon must be one or two emoji");
  }
  return {
    title,
    description,
    favicon,
    format,
    level,
    canvas,
    channel,
    scope: optionalString(raw.scope, "artifact.scope"),
    watch,
    local: requireBoolean(raw.local ?? false, "artifact.local"),
    autoUpdate: requireBoolean(raw.autoUpdate ?? false, "artifact.autoUpdate"),
  };
}

function parseDocument(raw) {
  if (!isObject(raw)) fail("document must be an object");
  rejectUnknown(raw, DOCUMENT_KEYS, "document");
  requireKeys(raw, ["language", "fragments"], "document");
  if (!isObject(raw.fragments)) fail("document.fragments must be an object");
  rejectUnknown(raw.fragments, FRAGMENT_KEYS, "document.fragments");
  const fragments = {};
  for (const key of FRAGMENT_KEYS) {
    fragments[key] = requireStringArray(
      raw.fragments[key] ?? [],
      `document.fragments.${key}`,
    );
  }
  if (fragments.body.length === 0) {
    fail("document.fragments.body must contain at least one file");
  }
  // document.theme is the design direction label, shown in the recipe comment
  // and read by the author. It carries no runtime effect — HTML theme comes
  // from theme fragments, Markdown from the viewer default — so it is optional
  // and may be null (a Markdown Recipe with no direction omits it entirely).
  const theme =
    raw.theme === null || raw.theme === undefined
      ? null
      : requireString(raw.theme, "document.theme");
  return {
    language: requireString(raw.language ?? "en", "document.language"),
    theme,
    fragments,
  };
}

function parseSecurity(raw) {
  if (!isObject(raw)) fail("security must be an object");
  rejectUnknown(raw, SECURITY_KEYS, "security");
  requireKeys(raw, ["encrypted", "passwordCredential"], "security");
  const encrypted = requireBoolean(
    raw.encrypted ?? false,
    "security.encrypted",
  );
  const passwordCredential = optionalString(
    raw.passwordCredential,
    "security.passwordCredential",
  );
  if (encrypted && passwordCredential === null) {
    fail("security.passwordCredential is required when encrypted is true");
  }
  if (!encrypted && passwordCredential !== null) {
    fail("security.passwordCredential requires encrypted to be true");
  }
  if (
    passwordCredential !== null &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(passwordCredential)
  ) {
    fail("security.passwordCredential must be a kebab-case name");
  }
  return { encrypted, passwordCredential };
}

function parseBuild(raw) {
  if (!isObject(raw)) fail("build must be an object");
  rejectUnknown(raw, BUILD_KEYS, "build");
  requireKeys(raw, ["strategy"], "build");
  if ((raw.strategy ?? "auto") !== "auto") {
    fail('build.strategy must be "auto"');
  }
  return { strategy: "auto" };
}

function resolveProjectFile(projectRoot, recipeDir, fragmentPath) {
  requireString(fragmentPath, "fragment path");
  if (
    isAbsolute(fragmentPath) ||
    fragmentPath.includes("\0") ||
    /^(?:[a-z]+:)?\/\//i.test(fragmentPath)
  ) {
    fail(`fragment path must be project-relative: ${fragmentPath}`);
  }
  const absolute = resolve(recipeDir, fragmentPath);
  const rel = relative(projectRoot, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`fragment escapes the project root: ${fragmentPath}`);
  }
  // Echo the project-relative path the resolver actually tried alongside the
  // authored path, so a wrong fragment path points at the on-disk location
  // rather than the (possibly CWD-relative) string the author typed.
  const resolvedRel = rel.split(sep).join("/");
  let info;
  try {
    info = lstatSync(absolute);
  } catch {
    fail(
      `fragment does not exist: ${fragmentPath} (resolved to ${resolvedRel})`,
    );
  }
  if (!info.isFile() && !info.isSymbolicLink()) {
    fail(
      `fragment is not a file: ${fragmentPath} (resolved to ${resolvedRel})`,
    );
  }
  const real = realpathSync(absolute);
  const realRel = relative(projectRoot, real);
  if (
    realRel === ".." ||
    realRel.startsWith(`..${sep}`) ||
    isAbsolute(realRel)
  ) {
    fail(`fragment symlink escapes the project root: ${fragmentPath}`);
  }
  if (!statSync(real).isFile()) {
    fail(
      `fragment is not a file: ${fragmentPath} (resolved to ${resolvedRel})`,
    );
  }
  return { absolute, real, projectPath: resolvedRel };
}

export function resolveWatchFiles(patterns, projectRoot = process.cwd()) {
  const root = realpathSync(resolve(projectRoot));
  const files = new Map();
  for (const pattern of patterns) {
    const matches = globSync(pattern, {
      cwd: root,
      exclude: (candidate) =>
        candidate.includes("node_modules") ||
        candidate.split(/[\\/]/).includes(".git"),
    });
    for (const candidate of matches) {
      const absolute = resolve(root, candidate);
      let real;
      try {
        real = realpathSync(absolute);
      } catch {
        continue;
      }
      const projectPath = relative(root, real);
      if (
        projectPath === ".." ||
        projectPath.startsWith(`..${sep}`) ||
        isAbsolute(projectPath)
      ) {
        fail(`artifact.watch resolves outside the project root: ${candidate}`);
      }
      if (statSync(real).isFile()) {
        files.set(real, projectPath.split(sep).join("/"));
      }
    }
  }
  return [...files].map(([real, projectPath]) => ({ real, projectPath }));
}

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function loadRecipe(recipePath, options = {}) {
  const projectRoot = realpathSync(
    resolve(options.projectRoot ?? process.cwd()),
  );
  const absoluteRecipe = resolve(recipePath);
  const recipeReal = realpathSync(absoluteRecipe);
  const recipeRel = relative(projectRoot, recipeReal);
  if (
    recipeRel === ".." ||
    recipeRel.startsWith(`..${sep}`) ||
    isAbsolute(recipeRel)
  ) {
    fail("recipe must live inside the project root");
  }
  let rawText = readFileSync(recipeReal, "utf8");
  rawText = rawText.replaceAll("\r\n", "\n");
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    fail(`JSON parse failed: ${error.message}`);
  }
  if (!isObject(raw)) fail("root must be an object");
  rejectUnknown(raw, RECIPE_KEYS, "recipe");
  requireKeys(
    raw,
    ["version", "artifact", "document", "security", "build"],
    "recipe",
  );
  if (raw.version !== 1) fail("version must be 1");

  const recipe = {
    schema:
      raw.$schema === undefined ? null : requireString(raw.$schema, "$schema"),
    version: 1,
    artifact: parseArtifact(raw.artifact),
    document: parseDocument(raw.document),
    security: parseSecurity(raw.security),
    build: parseBuild(raw.build),
  };
  const normalizedRecipePath = recipeRel.split(sep).join("/");
  const privateRecipePath = normalizedRecipePath.startsWith(
    ".artifacts/recipes.local/",
  );
  const isPrivate = recipe.artifact.local || recipe.security.encrypted;
  // Shared/private path rules are enforced after fragment resolution below, so
  // a local Recipe whose fragments are also misplaced surfaces BOTH rules in a
  // single error instead of forcing the author through two separate attempts
  // (move the Recipe, re-run, then learn the fragments must also move).
  const watchFiles = resolveWatchFiles(recipe.artifact.watch, projectRoot);

  const descriptors = [];
  const seen = new Set();
  const recipeDir = dirname(recipeReal);
  for (const slot of FRAGMENT_KEYS) {
    for (const fragmentPath of recipe.document.fragments[slot]) {
      const resolved = resolveProjectFile(projectRoot, recipeDir, fragmentPath);
      if (seen.has(resolved.real)) {
        fail(`fragment is included more than once: ${fragmentPath}`);
      }
      seen.add(resolved.real);
      const size = statSync(resolved.real).size;
      if (size > BUILD_LIMITS.maxFragmentBytes) {
        fail(`fragment exceeds 4 MiB: ${fragmentPath}`);
      }
      descriptors.push({ slot, source: fragmentPath, size, ...resolved });
    }
  }
  if (descriptors.length > BUILD_LIMITS.maxFragments) {
    fail(`fragment count exceeds ${BUILD_LIMITS.maxFragments}`);
  }
  // Collect the misplaced fragments so the error names every one and both rules.
  const misplacedPrivate = isPrivate
    ? descriptors
        .filter((descriptor) => {
          const resolvedProjectPath = relative(projectRoot, descriptor.real)
            .split(sep)
            .join("/");
          return !resolvedProjectPath.startsWith(".artifacts/fragments.local/");
        })
        .map((descriptor) => descriptor.source)
    : [];
  const misplacedShared = !isPrivate
    ? descriptors
        .filter((descriptor) => {
          const resolvedProjectPath = relative(projectRoot, descriptor.real)
            .split(sep)
            .join("/");
          return resolvedProjectPath.startsWith(".artifacts/fragments.local/");
        })
        .map((descriptor) => descriptor.source)
    : [];
  if (isPrivate && (!privateRecipePath || misplacedPrivate.length > 0)) {
    const parts = [];
    if (!privateRecipePath) {
      parts.push("the Recipe must live under .artifacts/recipes.local/");
    }
    if (misplacedPrivate.length > 0) {
      parts.push(
        `fragments must live under .artifacts/fragments.local/ (reference them as ../fragments.local/... from the Recipe): ${misplacedPrivate.join(", ")}`,
      );
    }
    fail(`local or encrypted Recipes are private sources: ${parts.join("; ")}`);
  }
  if (!isPrivate && privateRecipePath) {
    fail("shared Recipes cannot live under .artifacts/recipes.local/");
  }
  if (misplacedShared.length > 0) {
    fail(
      `shared Recipes cannot reference private fragments: ${misplacedShared.join(", ")}`,
    );
  }
  const aggregateBytes = descriptors.reduce(
    (total, descriptor) => total + descriptor.size,
    0,
  );
  if (aggregateBytes > BUILD_LIMITS.maxAggregateBytes) {
    fail("aggregate fragment size exceeds 8 MiB");
  }

  return {
    path: absoluteRecipe,
    realPath: recipeReal,
    projectRoot,
    projectPath: recipeRel.split(sep).join("/"),
    rawText,
    recipe,
    watchFiles,
    descriptors,
    aggregateBytes,
    recipeHash: sha256(canonicalJson(recipe)),
  };
}

export function readFragment(descriptor) {
  return readFileSync(descriptor.real, "utf8").replaceAll("\r\n", "\n");
}
