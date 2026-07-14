import { checkContrast } from "./contrast.mjs";
import { readFragment } from "./recipe.mjs";

const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

const externalChecks = [
  [/<script\b[^>]*\bsrc\s*=/i, "external script src"],
  [/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i, "external stylesheet"],
  [
    /<(?:img|video|audio|source|iframe)\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\//i,
    "remote media source",
  ],
  [/@import\b/i, "CSS @import"],
  [/url\(\s*["']?(?:https?:)?\/\//i, "remote CSS url()"],
  [/<base\b/i, "base element"],
  [/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, "meta refresh"],
  [/<form\b[^>]*\baction\s*=\s*["'](?:https?:)?\/\//i, "external form action"],
  [/\bfetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bnew\s+WebSocket\s*\(/, "WebSocket"],
  [/\bnew\s+EventSource\s*\(/, "EventSource"],
  [/\bimport\s*\(/, "dynamic import()"],
  [/\bimport\s+[^;]*\sfrom\s+["']/, "module import"],
];

const fail = (message) => {
  throw new Error(`build validation failed: ${message}`);
};

function extractTitle(content, format) {
  if (format === "markdown") {
    return content.match(/^#\s+(.+)$/m)?.[1].trim() ?? null;
  }
  return content.match(/<title\b[^>]*>([^<]+)<\/title>/i)?.[1].trim() ?? null;
}

function elementRange(content, id) {
  const open = new RegExp(
    `<([a-z][\\w-]*)\\b(?=[^>]*\\bid=["']${id}["'])[^>]*>`,
    "i",
  ).exec(content);
  if (!open || open.index === undefined) return null;
  const tags = new RegExp(`</?${open[1]}\\b[^>]*>`, "gi");
  tags.lastIndex = open.index;
  let depth = 0;
  for (let tag = tags.exec(content); tag; tag = tags.exec(content)) {
    if (tag[0].startsWith("</")) depth -= 1;
    else if (!tag[0].endsWith("/>")) depth += 1;
    if (depth === 0) {
      return { start: open.index, end: tags.lastIndex };
    }
  }
  return null;
}

function validateCanvas(content) {
  if (/<template\b/i.test(content)) {
    fail("canvas body cannot contain template elements");
  }
  const canvasCount = (content.match(/\bid=["']canvas["']/gi) ?? []).length;
  const planeCount = (content.match(/\bid=["']plane["']/gi) ?? []).length;
  if (canvasCount !== 1 || planeCount !== 1) {
    fail("canvas recipes require exactly one #canvas and one #plane");
  }
  const canvasRange = elementRange(content, "canvas");
  const planeRange = elementRange(content, "plane");
  if (
    !canvasRange ||
    !planeRange ||
    planeRange.start <= canvasRange.start ||
    planeRange.end >= canvasRange.end
  ) {
    fail("#plane must be nested inside #canvas");
  }
  const frames = [...content.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi)].filter(
    (match) => {
      const classes = match[0].match(/\bclass=["']([^"']+)["']/i)?.[1] ?? "";
      return classes.split(/\s+/).includes("oa-frame");
    },
  );
  if (frames.length === 0) fail("canvas recipes require at least one frame");
  if (
    frames.some(
      (frame) =>
        (frame.index ?? -1) <= planeRange.start ||
        (frame.index ?? Number.POSITIVE_INFINITY) >= planeRange.end,
    )
  ) {
    fail("every canvas frame must be nested inside #plane");
  }
  const ids = [];
  const tours = [];
  for (const match of frames) {
    const tag = match[0];
    if (match[1].toLowerCase() !== "section") {
      fail("every canvas frame must use a section element");
    }
    const id = tag.match(/\bid=["']([^"']+)["']/i)?.[1];
    if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      fail("every canvas frame needs a human-readable kebab-case id");
    }
    if (ids.includes(id)) fail(`duplicate canvas frame id: ${id}`);
    ids.push(id);
    for (const property of ["--x", "--y", "--w", "--h"]) {
      if (!new RegExp(`${property}\\s*:\\s*-?\\d+(?:\\.\\d+)?`).test(tag)) {
        fail(`canvas frame ${id} is missing ${property}`);
      }
    }
    const tour = tag.match(/\bdata-tour=["'](\d+)["']/i)?.[1];
    if (tour) tours.push(Number(tour));

    const range = elementRange(content, id);
    const frameContent = range ? content.slice(range.start, range.end) : "";
    const frameTags = [...frameContent.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi)];
    const labels = frameTags.filter((candidate) => {
      const classes =
        candidate[0].match(/\bclass=["']([^"']+)["']/i)?.[1] ?? "";
      return classes.split(/\s+/).includes("oa-frame-label");
    });
    if (
      labels.length !== 1 ||
      labels[0][1].toLowerCase() !== "button" ||
      !/\btype=["']button["']/i.test(labels[0][0])
    ) {
      fail(
        `canvas frame ${id} requires one button.oa-frame-label with type="button"`,
      );
    }
    const bodies = frameTags.filter((candidate) => {
      const classes =
        candidate[0].match(/\bclass=["']([^"']+)["']/i)?.[1] ?? "";
      return classes.split(/\s+/).includes("oa-frame-body");
    });
    if (
      bodies.length !== 1 ||
      bodies[0][1].toLowerCase() !== "div" ||
      !/\binert(?:\s|=|>)/i.test(bodies[0][0])
    ) {
      fail(`canvas frame ${id} requires one inert div.oa-frame-body`);
    }
  }
  if (tours.length > 0) {
    const sorted = [...tours].sort((a, b) => a - b);
    if (
      new Set(sorted).size !== sorted.length ||
      sorted.some((value, index) => value !== index + 1)
    ) {
      fail("canvas data-tour values must be unique and contiguous from 1");
    }
  }
  const connectorSvgs = [
    ...content.matchAll(/<svg\b[^>]*\bclass=["']([^"']+)["'][^>]*>/gi),
  ].filter((match) => match[1].split(/\s+/).includes("oa-connectors"));
  for (const svg of connectorSvgs) {
    const end = content.indexOf("</svg>", svg.index);
    const connectorContent =
      end === -1 ? "" : content.slice(svg.index, end + "</svg>".length);
    for (const path of connectorContent.matchAll(/<path\b[^>]*>/gi)) {
      const from = path[0].match(/\bdata-from=["']([^"']+)["']/i)?.[1];
      const to = path[0].match(/\bdata-to=["']([^"']+)["']/i)?.[1];
      if (!from || !to) {
        fail("every connector path requires data-from and data-to");
      }
      if (!ids.includes(from) || !ids.includes(to)) {
        fail(`connector references unknown frame: ${from} -> ${to}`);
      }
    }
  }
  if (
    /\bclass=["'][^"']*\boa-zoom\b/i.test(content) ||
    /\bid=["'](?:zoom-(?:in|out|fit)|tour-(?:prev|next|status))["']/i.test(
      content,
    )
  ) {
    fail("canvas controls are injected by the builder and cannot be authored");
  }
}

// A "container" rule caps the content measure (max-width) so it does not span
// the full viewport. This catches the silent defect where CSS defines such a
// class but the body fragment never applies it — the page then ships at 100%
// width with no error, exactly the bug that hit the Hydra artifact (.shell was
// defined, never used). Only max-width is tracked, not margin:auto, because
// centering a button is a common non-container use of auto margins and would
// false-positive. Only plain single-class selectors (.foo) are considered;
// compound selectors, ids, and element/attribute selectors are left alone.
// Comments are stripped first so a max-width inside a /* */ block does not
// produce a false positive.
const CONTAINER_SELECTOR = /(^|[^-\w])\.([A-Za-z_][\w-]*)\s*\{/g;
const MEASURE_PATTERN = /max-width\s*:/i;

function validateContainer(authoredStyles, authoredBody, authoredScripts) {
  const stripped = authoredStyles.replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set();
  for (const match of stripped.matchAll(CONTAINER_SELECTOR)) {
    const className = match[2];
    // Inspect the rule block that opens at this match: from the { to the next
    // unescaped ; or }. A measure cap anywhere in that declaration set counts.
    const blockStart = match.index + match[0].length;
    const blockEnd = stripped.indexOf("}", blockStart);
    const block =
      blockEnd === -1
        ? stripped.slice(blockStart)
        : stripped.slice(blockStart, blockEnd);
    if (MEASURE_PATTERN.test(block)) defined.add(className);
  }
  // Strip comments from the scripts before scanning for class references, so a
  // `// no .duration-bar` comment does not count as applying the class. Only
  // live code is searched.
  const liveScripts = authoredScripts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
  for (const className of defined) {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The body applies a class via class="a b c". A class is "applied" if it
    // appears as a whole token in some class attribute, anchored on word
    // boundaries so .foo does not match .foo-bar.
    const appliedInBody = new RegExp(
      `class\\s*=\\s*["'][^"']*\\b${escaped}\\b`,
      "i",
    ).test(authoredBody);
    // An L2/L3 page may render its body via JS, applying classes through
    // classList.add / className = / innerHTML templates rather than static
    // class="..." attributes. A class that appears as a quoted string token in
    // the authored scripts counts as applied — the JS owns that surface, and
    // the cap is real at runtime. Match the bare name as a quoted token
    // ("duration-bar", 'duration-bar', `duration-bar`).
    const appliedInScript = new RegExp(`["'\`]${escaped}["'\`]`, "i").test(
      liveScripts,
    );
    if (!appliedInBody && !appliedInScript) {
      fail(
        `CSS defines a container class ".${className}" with max-width, but the body fragment never applies it; move the constraint onto an element that exists in the body (or body itself), wrap the body in <div class="${className}">, or apply the class via JS (reference it as a quoted string in a script fragment)`,
      );
    }
  }
}

// Level 1 non-canvas HTML documents must constrain body width somewhere —
// either a `max-width` on body/html in the theme/styles, or the opt-in
// `.oa-prose` baseline (which carries the cap). Without it, a doc that
// defines tokens but forgets structure ships at 100% width with browser-
// default spacing: exactly the bare, unpadded artifact this guard was added
// to catch. Canvas mode and L2/L3 are exempt — canvas frames position
// themselves spatially, and interactive/rich pages may be full-bleed by
// design. Markdown is exempt too: the viewer wraps it in .oa-md, which caps
// the measure. Markdown never reaches this path (format check above).
const MEASURE_CAP_PATTERN = /max-width\s*:/i;
const OA_PROSE_PATTERN = /\boa-prose\b/;

function validateMeasureCap(loaded, composed) {
  const { artifact } = loaded.recipe;
  if (artifact.format === "markdown") return;
  if (artifact.canvas) return;
  if (artifact.level !== 1) return;
  if (OA_PROSE_PATTERN.test(composed.authoredBody)) return;
  if (MEASURE_CAP_PATTERN.test(composed.authoredStyles)) return;
  fail(
    'level 1 HTML documents must constrain body width — wrap the body in <main class="oa-prose"> (the token contract\'s prose baseline), or set a max-width on body/html in the theme fragment; without it the page ships at 100% width with browser-default spacing',
  );
}

function validateTheme(loaded) {
  if (loaded.recipe.artifact.format !== "html") return;
  const themeFragments = loaded.descriptors.filter(
    (descriptor) => descriptor.slot === "theme",
  );
  if (themeFragments.length === 0) {
    fail("HTML recipes require at least one theme fragment");
  }
  const theme = themeFragments
    .map((descriptor) => readFragment(descriptor))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@layer\b/i.test(theme)) {
    fail("theme fragments must be unlayered");
  }
  if (!/:root\s*\{/i.test(theme)) {
    fail("theme fragments require an unlayered :root block");
  }
  if (!/:root\s*\[\s*data-theme\s*=\s*["']dark["']\s*\]\s*\{/i.test(theme)) {
    fail('theme fragments require an unlayered :root[data-theme="dark"] block');
  }
  // design.md P0 mandates body text ≥ 4.5:1 in BOTH themes, but the ship-gate
  // was manual — a too-similar --muted/--surface pair could publish unless the
  // author computed ratios by hand. Resolve the authored overrides (concrete
  // hex/oklch/rgb/hsl only; var()/color-mix() can't be checked statically) and
  // fail any pair under 4.5:1. Contract defaults already pass, so only tokens
  // the author overrode are checked.
  const { failures } = checkContrast(theme);
  for (const failure of failures) {
    fail(
      `contrast P0: ${failure.pair} in ${failure.theme} theme is ${failure.ratio}:1, below the 4.5:1 minimum — ${failure.hint}`,
    );
  }
}

export function validateBuild(loaded, composed) {
  const { artifact } = loaded.recipe;
  validateTheme(loaded);
  const content = composed.publishContent;
  const bytes = Buffer.byteLength(content);
  if (content.trim() === "") fail("output must not be empty");
  if (bytes > MAX_CONTENT_BYTES) {
    fail(`output is ${bytes} bytes; service limit is ${MAX_CONTENT_BYTES}`);
  }
  if (artifact.format === "markdown") {
    if (
      loaded.recipe.document.fragments.theme.length > 0 ||
      loaded.recipe.document.fragments.styles.length > 0 ||
      loaded.recipe.document.fragments.scripts.length > 0
    ) {
      fail("Markdown recipes only support body fragments");
    }
  } else {
    if (/<\/style/i.test(composed.authoredStyles)) {
      fail("style fragments cannot contain a closing style tag");
    }
    if (
      /<!doctype\b|<\/?(?:html|head|body)\b|<(?:style|script)\b/i.test(
        composed.authoredBody,
      )
    ) {
      fail(
        "HTML body fragments cannot contain document wrappers, <style>, or <script> elements — put CSS in document.fragments.styles and JS in document.fragments.scripts, not inline in the body",
      );
    }
    // A repeated attribute on one start tag is silent data loss: HTML parsers
    // keep only the first occurrence, so the second value is dropped without an
    // error. `style` is the common casualty (e.g. `style="--i:1"` authored next
    // to a later `style="margin-top:..."`), and the loss is invisible until a
    // reviewer re-reads the source. Fail any start tag carrying `style=` twice
    // and echo the offending tag so the author can find it without a grep.
    const dupStyleRe =
      /<[a-z][\w-]*\b[^>]*\bstyle\s*=\s*["'][^"']*["'][^>]*\bstyle\s*=[^>]*>/i;
    const dupStyleMatch = composed.authoredBody.match(dupStyleRe);
    if (dupStyleMatch) {
      const tag = dupStyleMatch[0].slice(0, 80);
      fail(
        `a start tag may carry style= only once — HTML parsers keep only the first when it repeats, silently dropping the later value. Merge both into one style="..." attribute. Offending tag: ${tag}`,
      );
    }
    // The CSP external-request scan matches tokens (fetch(, WebSocket, module
    // import, etc.) against the composed content. A token that appears only in
    // a comment or a string literal inside a <script> is not executable, so
    // scanning the raw content false-positives on prose like `// no fetch`,
    // `<!-- uses @import -->`, or `const note = "fetch('/refresh')"` displayed
    // as documentation. Strategy: strip comments from the whole content, then
    // for each <script> body additionally strip quoted string literals (the
    // only place string-quoted API names cause false positives). HTML text and
    // event-handler attributes (on*="...") are scanned verbatim so a real
    // `onclick="fetch('/x')"` is still caught.
    const stripComments = (s) =>
      s
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
    const stripStrings = (s) =>
      s
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    const scanned = stripComments(content).replace(
      /<script\b[^>]*>([\s\S]*?)<\/script>/gi,
      (_m, body) => `<script>${stripStrings(stripComments(body))}</script>`,
    );
    for (const [pattern, label] of externalChecks) {
      if (pattern.test(scanned)) fail(`${label} is incompatible with the CSP`);
    }
    try {
      const scripts = [
        ...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
      ];
      for (const script of scripts) {
        Function(script[1]);
      }
    } catch (error) {
      fail(`inline JavaScript syntax error: ${error.message}`);
    }
    validateContainer(
      composed.authoredStyles,
      composed.authoredBody,
      composed.authoredScripts,
    );
    validateMeasureCap(loaded, composed);
  }
  if (artifact.canvas) validateCanvas(composed.authoredBody);
  const title = artifact.title ?? extractTitle(content, artifact.format);
  if (!title)
    fail("artifact.title or an extractable document title is required");
  if (title.length > 200) fail("artifact title must not exceed 200 characters");
  return {
    title,
    bytes,
    encryptedMaxPlaintextBytes: Math.floor(MAX_CONTENT_BYTES * 0.74),
  };
}

export { MAX_CONTENT_BYTES };
