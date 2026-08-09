import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildArtifactRecipe } from "../build-artifact.mjs";
import {
  ensureGitignored,
  findEntry,
  loadConfig,
  loadCredentials,
  loadManifest,
  manifestFileForId,
  mutateCredentials,
  mutateManifest,
  writeJson,
} from "../lib/cli-state.mjs";
import { CANVAS_MARKERS, loadCanvasRuntime } from "../lib/compose.mjs";
import { decryptContent } from "../lib/content-crypto.mjs";
import {
  ARTIFACTS_DIR,
  MANIFEST,
  PROJECT_ROOT,
  SKILL_ROOT,
} from "../lib/paths.mjs";
import { extractTitle, recipeSnapshot } from "../lib/recipe-payload.mjs";
import { request } from "../lib/transport.mjs";

export function migrationSlug(id, title) {
  const base = (title ?? "artifact")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "artifact"}-${id.slice(0, 8)}`;
}

export function stripMarkedBlock(content, startMarker, endMarker) {
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
  if (match?.index !== undefined) result = result.slice(0, match.index);
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

export function migrateHtmlSource(source, canvas) {
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
  if (!canvas && !/max-width\s*:/i.test(styles) && !/\boa-prose\b/.test(body)) {
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

export async function commandMigrate(id, flags) {
  const config = loadConfig(flags);
  const entry = findEntry(loadManifest(), id);
  if (entry.recipe && !flags.force) {
    console.log(entry.recipe);
    console.error("artifact already uses a Recipe");
    return entry.recipe;
  }
  const token = loadCredentials().tokens[id];
  const { status, json, text } = await request(
    "GET",
    `${config.apiUrl}/api/artifacts/${id}/raw`,
    undefined,
    token,
  );
  if (status !== 200) {
    throw new Error(
      `migration fetch failed (${status}): ${json.error ?? "unknown error"}`,
    );
  }
  const encrypted = json.alg === "AES-GCM" && json.ciphertext !== undefined;
  let source = text;
  let password = null;
  if (encrypted) {
    password = flags.password ?? loadCredentials().passwords[id];
    if (!password) {
      throw new Error(
        "encrypted legacy artifact requires --password for migration",
      );
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
    throw new Error(
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
    document: { language: "en", theme: "migrated", fragments },
    security: {
      encrypted,
      passwordCredential: encrypted ? `artifact-${id}` : null,
    },
    build: { strategy: "auto" },
  };
  writeJson(recipePath, recipe);
  const build = buildArtifactRecipe(recipePath, { projectRoot: PROJECT_ROOT });
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
  const otherManifestPath = local ? MANIFEST.shared : MANIFEST.local;
  if (existsSync(otherManifestPath)) {
    mutateManifest(!local, (manifest) => {
      manifest.artifacts = manifest.artifacts.filter(
        (candidate) => candidate.id !== id,
      );
    });
  }
  mutateManifest(local, (manifest) => {
    manifest.artifacts = manifest.artifacts.filter(
      (candidate) => candidate.id !== id,
    );
    manifest.artifacts.push(nextEntry);
  });
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
