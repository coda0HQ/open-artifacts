import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleReactComponent } from "./react-build.mjs";
import { BUILD_LIMITS, readFragment, sha256 } from "./recipe.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(SCRIPT_DIR, "..", "..");
const REFERENCES_DIR = join(SKILL_DIR, "references");

export const CANVAS_MARKERS = Object.freeze({
  cssStart: "/* open-artifacts:canvas-css:start */",
  cssEnd: "/* open-artifacts:canvas-css:end */",
  jsStart: "/* open-artifacts:canvas-js:start */",
  jsEnd: "/* open-artifacts:canvas-js:end */",
  controlsStart: "<!-- open-artifacts:canvas-controls:start -->",
  controlsEnd: "<!-- open-artifacts:canvas-controls:end -->",
});

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const escapeInlineScript = (value) =>
  value.replace(/<\/script/gi, "<\\/script");

function extractFencedBlock(markdown, heading, language) {
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(`canvas runtime heading not found: ${heading}`);
  }
  const nextHeading = markdown.indexOf("\n## ", headingIndex + heading.length);
  const section = markdown.slice(
    headingIndex,
    nextHeading === -1 ? markdown.length : nextHeading,
  );
  const fence = `\`\`\`${language}\n`;
  const start = section.indexOf(fence);
  if (start === -1) {
    throw new Error(`${heading} must contain one ${language} code block`);
  }
  const contentStart = start + fence.length;
  const end = section.indexOf("\n```", contentStart);
  if (end === -1) throw new Error(`${heading} code block is not closed`);
  if (section.indexOf(fence, end + 4) !== -1) {
    throw new Error(`${heading} must contain exactly one ${language} block`);
  }
  return section.slice(contentStart, end).trimEnd();
}

export function loadCanvasRuntime() {
  const markdown = readFileSync(
    join(REFERENCES_DIR, "canvas.md"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  return {
    css: extractFencedBlock(markdown, "## The vendored runtime — CSS", "css"),
    js: extractFencedBlock(markdown, "## The vendored runtime — JS", "js"),
  };
}

function canvasControls(hasTour) {
  const tour = hasTour
    ? `<div class="oa-tour" role="group" aria-label="Guided tour">
  <button id="tour-prev" type="button" aria-label="Previous step">Prev</button>
  <output id="tour-status" aria-label="Tour progress">- / 0</output>
  <button id="tour-next" type="button" aria-label="Next step">Next</button>
  <div class="oa-tour-sep" aria-hidden="true"></div>
</div>
`
    : "";
  return `${CANVAS_MARKERS.controlsStart}
<div class="oa-zoom" role="group" aria-label="${hasTour ? "Zoom and tour controls" : "Zoom controls"}">
${tour}  <button id="zoom-out" type="button" aria-label="Zoom out">&minus;</button>
  <output id="zoom-pct" aria-label="Current zoom">100%</output>
  <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
  <button id="zoom-fit" type="button" aria-label="Fit all to view">⤢</button>
</div>
${CANVAS_MARKERS.controlsEnd}`;
}

function joinParts(parts) {
  return parts.filter((part) => part !== "").join("\n\n");
}

function escapeHtmlComment(value) {
  return String(value).replaceAll("--", "- -").replace(/\s+/g, " ").trim();
}

function directionComment(artifact, document) {
  const direction = document.theme ?? "unspecified";
  return `<!--
  Open Artifacts recipe
  Direction: ${escapeHtmlComment(direction)}
  Level: ${artifact.level ?? "unspecified"}
  Canvas: ${artifact.canvas ? "yes" : "no"}
-->`;
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function countClassTokens(value, className) {
  return [...value.matchAll(/<[^>]+\bclass=["']([^"']+)["'][^>]*>/gi)].filter(
    (match) => match[1].split(/\s+/).includes(className),
  ).length;
}

function standaloneHtml(content, language, title) {
  const titlePattern = /<title\b[^>]*>[\s\S]*?<\/title>/i;
  const body = content.replace(titlePattern, "");
  return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>
`;
}

export function composeRecipe(loaded, options = {}) {
  const { artifact, document } = loaded.recipe;
  if (options.standalone && artifact.format !== "html") {
    throw new Error("standalone preview is only available for HTML Recipes");
  }
  const slots = { theme: [], styles: [], body: [], scripts: [] };
  const inputs = [];
  for (const descriptor of loaded.descriptors) {
    const content = readFragment(descriptor);
    slots[descriptor.slot].push(content);
    inputs.push({
      path: descriptor.projectPath,
      slot: descriptor.slot,
      size: Buffer.byteLength(content),
      hash: sha256(content),
    });
  }

  const bodySource = joinParts(slots.body);
  const authoredStyles = joinParts([...slots.theme, ...slots.styles]);
  const authoredScripts = joinParts(slots.scripts);
  const frameCount = countClassTokens(bodySource, "oa-frame");
  const sectionCount = countMatches(bodySource, /<section\b/gi);
  const staged =
    loaded.descriptors.length > BUILD_LIMITS.stagedFragments ||
    loaded.aggregateBytes > BUILD_LIMITS.stagedAggregateBytes ||
    loaded.descriptors.some(
      (descriptor) => descriptor.size > BUILD_LIMITS.stagedSingleFragmentBytes,
    ) ||
    frameCount > BUILD_LIMITS.stagedFrames ||
    sectionCount > BUILD_LIMITS.stagedSections;

  let content;
  if (artifact.format === "markdown") {
    content = `${bodySource.trimEnd()}\n`;
  } else if (artifact.format === "react") {
    // The body slot holds one JSX/TSX entry (the default-export component).
    // esbuild precompiles + bundles it into a self-contained IIFE; validate.mjs
    // enforces the single-entry, body-only shape. bodySource is the raw source,
    // used both to reject in-browser transforms and as the input hash.
    const entry = loaded.descriptors.find(
      (descriptor) => descriptor.slot === "body",
    );
    content = bundleReactComponent(entry.real, bodySource);
  } else {
    const title = artifact.title ?? "";
    const tokens = readFileSync(
      join(REFERENCES_DIR, "tokens.css"),
      "utf8",
    ).replaceAll("\r\n", "\n");
    const styles = [tokens, ...slots.theme, ...slots.styles];
    const scripts = [...slots.scripts];
    let controls = "";
    if (artifact.canvas) {
      const runtime = loadCanvasRuntime();
      styles.push(
        `${CANVAS_MARKERS.cssStart}\n${runtime.css}\n${CANVAS_MARKERS.cssEnd}`,
      );
      scripts.push(
        `${CANVAS_MARKERS.jsStart}\n${runtime.js}\n${CANVAS_MARKERS.jsEnd}`,
      );
      controls = canvasControls(/\bdata-tour\s*=/.test(bodySource));
    }
    content = joinParts([
      title ? `<title>${escapeHtml(title)}</title>` : "",
      directionComment(artifact, document),
      `<style>\n${joinParts(styles)}\n</style>`,
      bodySource,
      controls,
      scripts.length
        ? `<script>\n${escapeInlineScript(joinParts(scripts))}\n</script>`
        : "",
    ]);
    content = `${content.trimEnd()}\n`;
  }

  return {
    content: options.standalone
      ? standaloneHtml(content, document.language, artifact.title ?? "Artifact")
      : content,
    publishContent: content,
    authoredBody: bodySource,
    authoredStyles,
    authoredScripts,
    plan: {
      strategy: staged ? "staged" : "direct",
      fragments: inputs,
      aggregateBytes: loaded.aggregateBytes,
      frameCount,
      sectionCount,
    },
    inputHash: sha256(
      inputs
        .map((input) => `${input.slot}\0${input.path}\0${input.hash}`)
        .join("\n"),
    ),
    outputHash: sha256(content),
  };
}
