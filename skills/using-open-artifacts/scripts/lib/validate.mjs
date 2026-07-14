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
  const rects = [];
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
    // Collect the frame's world-rect for the overlap check below.
    const num = (p) =>
      Number(
        tag.match(new RegExp(`${p}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`))?.[1] ?? 0,
      );
    rects.push({
      id,
      x: num("--x"),
      y: num("--y"),
      w: num("--w"),
      h: num("--h"),
    });
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
  // Two frames whose interiors overlap are an authoring bug: a focused frame
  // would partly occlude its neighbor, and the overview reads as one blob.
  // One frame's box may not enter another's. Frame labels float above their
  // frame and are not part of the rect.
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
      const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlapX && overlapY) {
        fail(
          `canvas frames "${a.id}" and "${b.id}" overlap — keep their --x/--y/--w/--h boxes disjoint (the minimum-gap gate below also applies)`,
        );
      }
    }
  }
  // Two frames that merely touch (0..7px gap) read as one blob: each body's
  // inset hairline + rounded corners merge with no whitespace. Require a
  // minimum inter-frame gap, but ONLY for frames adjacent along an axis
  // (their projections overlap on the perpendicular axis). Diagonally
  // corner-touching frames (no shared axis overlap) and distant frames are
  // not flagged. 8 world px = --space-2, the smallest spacing token: tight
  // grids stay valid (an 8px seam is visibly separated), 0-gap does not.
  const MIN_FRAME_GAP = 8;
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
      const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlapX) {
        const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        if (gapY >= 0 && gapY < MIN_FRAME_GAP) {
          fail(
            `canvas frames "${a.id}" and "${b.id}" are ${gapY}px apart on the Y axis — keep a >= ${MIN_FRAME_GAP} world-px gap between adjacent frames so they don't visually merge (tiled grids need a seam too)`,
          );
        }
      }
      if (overlapY) {
        const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
        if (gapX >= 0 && gapX < MIN_FRAME_GAP) {
          fail(
            `canvas frames "${a.id}" and "${b.id}" are ${gapX}px apart on the X axis — keep a >= ${MIN_FRAME_GAP} world-px gap between adjacent frames so they don't visually merge (tiled grids need a seam too)`,
          );
        }
      }
    }
  }
  // GATE A — bounding rect too large. The overview fit ratio is k ≈
  // viewport / bounding. Below ~0.5x (CHIP_K, where notes collapse to chips)
  // the composition drowns in whitespace and reads as a bug. There is no
  // viewport at build time, so the threshold is a fixed constant derived from
  // the contract's 1280x1024 design-viewport assumption. BOTH width and height
  // are gated: a wide row of frames AND a tall column of frames both drown at
  // overview zoom. A legitimately large canvas stacks frames in a grid that
  // keeps BOTH bounding dims under the cap; the doc's own guidance is to go
  // vertically when wide, and a 20-frame-tall single column is the same
  // whitespace-drowning defect rotated. (2880 ≈ 2.25x the 1280 design width —
  // clears the doc-endorsed "three mobiles + one desktop" row ~2610-2970 while
  // still failing the five-1440-row anti-pattern ~7680.)
  const BOUNDING_W_MAX = 2880;
  const BOUNDING_H_MAX = 2560;
  const minX = Math.min(...rects.map((r) => r.x));
  const maxXEnd = Math.max(...rects.map((r) => r.x + r.w));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxYEnd = Math.max(...rects.map((r) => r.y + r.h));
  const boundingW = maxXEnd - minX;
  const boundingH = maxYEnd - minY;
  if (boundingW > BOUNDING_W_MAX) {
    fail(
      `canvas bounding rect is ${boundingW} world px wide (frames span x=${minX}..${maxXEnd}); keep it under ${BOUNDING_W_MAX} world px (~2.25x a 1280-px viewport) so the overview fit stays >= ~0.5x — stack wide frames vertically or in a grid rather than side-by-side`,
    );
  }
  if (boundingH > BOUNDING_H_MAX) {
    fail(
      `canvas bounding rect is ${boundingH} world px tall (frames span y=${minY}..${maxYEnd}); keep it under ${BOUNDING_H_MAX} world px (~2.5x a 1024-px viewport) so the overview fit stays >= ~0.5x — the same whitespace-drowning defect applies on the vertical axis; break a long column into a grid`,
    );
  }
  // GATE B — a note whose collapsed-chip center lands ON a frame reads as a
  // bug. A note's --x/--y is its top-left while expanded and its CENTER while
  // collapsed; at overview zoom notes collapse to a small chip (the chip is
  // ~24px), so the conservative static check is whether that center point
  // falls inside a frame rect — the real defect (a chip on a frame body). The
  // expanded box is NOT checked: it is a user-initiated transient state shown
  // when the frame is focused at a different zoom, and expanded-box size is
  // content-driven (no static bound), so checking it false-positives every
  // note placed in a 120-px gutter (the expanded box is wider than the gutter).
  const noteMatches = [...content.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi)].filter(
    (match) => {
      const classes = match[0].match(/\bclass=["']([^"']+)["']/i)?.[1] ?? "";
      return classes.split(/\s+/).includes("oa-note");
    },
  );
  for (const match of noteMatches) {
    const tag = match[0];
    const hasProp = (p) =>
      new RegExp(`${p}\\s*:\\s*-?\\d+(?:\\.\\d+)?`).test(tag);
    if (!hasProp("--x") || !hasProp("--y")) {
      fail(
        "every .oa-note requires --x and --y (top-left expanded, center collapsed)",
      );
    }
    const num = (p) =>
      Number(
        tag.match(new RegExp(`${p}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`))?.[1] ?? 0,
      );
    const noteX = num("--x");
    const noteY = num("--y");
    for (const frame of rects) {
      if (
        noteX > frame.x &&
        noteX < frame.x + frame.w &&
        noteY > frame.y &&
        noteY < frame.y + frame.h
      ) {
        fail(
          `a .oa-note at --x:${noteX} --y:${noteY} (collapsed-chip center) lands inside frame "${frame.id}" (x:${frame.x}..${frame.x + frame.w}, y:${frame.y}..${frame.y + frame.h}) — place notes in gutters, not over frame bodies`,
        );
      }
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

// The AI-slop tropes (design.md "Banned tropes") are the tells a model
// hallucinates by default — gradient heroes, glassmorphism cards, side-stripe
// accents. They are banned in prose, but prose is honor-system: this gate
// enforces them structurally on authoredStyles (theme+styles slots only —
// tokens.css and the canvas runtime are structurally excluded by compose.mjs,
// so the contract's own sanctioned uses like .oa-prose blockquote border-left
// and .oa-zoom backdrop-filter are never scanned). Conservative: only the
// clear-tell signatures fail; the sanctioned exceptions (quote-bar on
// blockquote, list-marker on li/ul/ol, hairline <=1px, floating bar via
// position:fixed/sticky or a bar/toolbar/chrome selector name) pass.
const TROPE_SIDE_STRIPE_RE =
  /border-(left|right)\s*:\s*(?!.*\bthin\b)(?:(\d+(?:\.\d+)?)(?:px|rem|em|pt|vw|vh)?|medium|thick)\b[^;}]*/gi;
const TROPE_LONGHAND_WIDTH_RE =
  /border-(left|right)-width\s*:\s*(?!.*\bthin\b)(?:(\d+(?:\.\d+)?)(?:px|rem|em|pt|vw|vh)?|medium|thick)\b[^;}]*/gi;
const TROPE_GRADIENT_CLIP_RE =
  /background-clip\s*:\s*text\b|-webkit-background-clip\s*:\s*text\b/i;
const TROPE_GRADIENT_FN_RE =
  /(?:linear|radial|conic|repeating-linear|repeating-radial|repeating-conic)-gradient\s*\(/i;
const TROPE_BACKDROP_RE = /(?:-webkit-)?backdrop-filter\s*:/i;
const TROPE_FLOATING_POS_RE = /\bposition\s*:\s*(?:fixed|sticky)\b/i;
const TROPE_FLOATING_NAME_RE =
  /\b(?:bar|toolbar|chrome|controls?|zoom|dock|statusbar|status-bar|topbar|navbar|nav-bar|floatingbar|actionbar|action-bar|headerbar|header-bar)\b/i;

function parseRules(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let i = 0;
  while (i < stripped.length) {
    const brace = stripped.indexOf("{", i);
    if (brace === -1) break;
    const selector = stripped.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    for (; j < stripped.length && depth > 0; j += 1) {
      if (stripped[j] === "{") depth += 1;
      else if (stripped[j] === "}") depth -= 1;
    }
    const decls = stripped.slice(brace + 1, j - 1);
    rules.push({ selector, decls });
    i = j;
  }
  return rules;
}

function validateTropes(authoredStyles) {
  for (const { selector, decls } of parseRules(authoredStyles)) {
    // Trope 1 — decorative side-stripe: border-left/right > 1px that is not a
    // blockquote quote-bar or a list-marker surface. Hairlines (<=1px, `thin`)
    // pass; `medium`/`thick` are >1px.
    let stripeHit = null;
    for (const re of [TROPE_SIDE_STRIPE_RE, TROPE_LONGHAND_WIDTH_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(decls)) !== null) {
        const tok = (m[2] ?? "").toString();
        const kw = tok.toLowerCase();
        const widthNum = parseFloat(tok) || 0;
        if (kw === "medium" || kw === "thick" || widthNum > 1) {
          stripeHit = { side: m[1], width: tok };
          break;
        }
      }
      if (stripeHit) break;
    }
    if (stripeHit) {
      const isQuoteBar = /(^|[>\s+~,])blockquote\b/i.test(selector);
      const isListMarker = /(^|[>\s+~,])(?:li|ul|ol)\b/i.test(selector);
      if (!isQuoteBar && !isListMarker) {
        fail(
          `banned trope — side-stripe: border-${stripeHit.side} ${stripeHit.width} on "${selector}" reads as a decorative accent. Rewrite with a full hairline (<=1px) border, a background tint, a leading number/icon, or nothing.`,
        );
      }
    }
    // Trope 2 — gradient text: background-clip:text + a gradient in the same
    // rule. clip:text alone (solid color) is not the tell.
    if (
      TROPE_GRADIENT_CLIP_RE.test(decls) &&
      TROPE_GRADIENT_FN_RE.test(decls)
    ) {
      fail(
        `banned trope — gradient text: background-clip:text combined with a gradient on "${selector}". Use one solid color; emphasize via weight or size.`,
      );
    }
    // Trope 3 — decorative glassmorphism: backdrop-filter not on a sanctioned
    // floating bar (position:fixed/sticky, or a bar/toolbar/chrome selector).
    if (TROPE_BACKDROP_RE.test(decls)) {
      const floatingByPos = TROPE_FLOATING_POS_RE.test(decls);
      const floatingByName = TROPE_FLOATING_NAME_RE.test(selector);
      if (!floatingByPos && !floatingByName) {
        fail(
          `banned trope — glassmorphism: backdrop-filter on "${selector}" is decorative blur. backdrop-filter is sanctioned only for a bar floating over scrolling content (position:fixed/sticky, or a selector named bar/toolbar/controls/chrome); otherwise remove it.`,
        );
      }
    }
  }
}

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

// A scrollspy (IntersectionObserver on nav sections, or a scroll handler
// that toggles aria-current on nav links by section id) can ship a
// last-tab-stays-inactive-at-scroll-bottom bug: the IntersectionObserver's
// rootMargin band is too tight for a short final section (so it never
// intersects at scroll end), AND/OR the active-toggling function calls
// scrollIntoView (re-triggering the observer and jittering), AND there is no
// scroll-boundary fallback to force the last section active. This caught the
// trip-plan v3 bug exactly. The gate is detect-only — if no scrollspy
// signals are present it does nothing — and conservative: it fails ONLY on
// the clear bug signature, never on ambiguous approaches (a different
// active-selection heuristic is silently passed, not failed).
function validateScrollspy(authoredScripts) {
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
  const js = stripComments(authoredScripts);

  // Active-state write: aria-current (setAttribute or assignment) OR a quoted
  // exact 'active'/"active" classList arg. We deliberately do NOT match bare
  // `.active` or `is-active` — those are generic state/animation class names
  // used far beyond nav active-state and would false-positive lazy-reveal
  // artifacts. (Reviewer fix: dropped `is-active` + bare `.active`.)
  const activeWrite =
    /setAttribute\s*\(\s*["']aria-current|aria-current\s*=|classList\.(?:add|remove|toggle)\s*\(\s*["']active["']\s*\)/;

  // Signal A: an IntersectionObserver plus a section-ish collection name
  // (sections|secs|panels|chapters|parts) plus any `.observe(` call. The
  // collection name is what separates a nav scrollspy from a lazy-image
  // reveal (which observes `imgs`/`els`, not `sections`); we don't verify the
  // observe target identifier itself because the common idiom
  // `sections.forEach(s => io.observe(s))` puts the observe inside a callback
  // the regex can't scope to.
  const ioSignal =
    /new\s+IntersectionObserver\b/.test(js) &&
    /\b(?:sections|secs|panels|chapters|parts)\b/.test(js) &&
    /\.observe\s*\(/.test(js);

  // Signal B: a scroll handler that toggles nav-link active state.
  const scrollHandlerSignal =
    /addEventListener\s*\(\s*["']scroll["']/.test(js) && activeWrite.test(js);

  if (!ioSignal && !scrollHandlerSignal) return; // no scrollspy, gate silent

  const errors = [];

  // RULE 1 — bottom-boundary fallback OR a generous IO band. A *boundary
  // expression* compares scroll position against the scrollable range — it must
  // reference scrollHeight (or a maxScroll/atBottom local derived from it) so an
  // unrelated back-to-top button (`if (scrollY > 100)`) does not false-pass.
  // Accept the common shapes: a maxScroll/atBottom local, scrollHeight minus
  // innerHeight, scrollY compared against scrollHeight/maxScroll, AND the
  // additive form `innerHeight + scrollY >= scrollHeight` (functionally
  // identical, used by the project-intro artifact) — so a correct fallback is
  // not rejected just for spelling the comparison additively.
  const boundaryExpr =
    /\b(?:maxScroll|atBottom)\b|\bscrollHeight\s*-\s*(?:window\.)?innerHeight\b|\bscrollY\s*[<>=!]+\s*[^;]{0,60}?scrollHeight\b|\bscrollY\s*[<>=!]+\s*[^;]{0,60}?maxScroll\b|\b(?:window\.)?innerHeight\s*\+\s*(?:window\.)?scrollY\s*[<>=!]+\s*[^;]{0,40}?scrollHeight\b|\b(?:window\.)?scrollY\s*\+\s*(?:window\.)?innerHeight\s*[<>=!]+\s*[^;]{0,40}?scrollHeight\b/.test(
      js,
    );

  // IO band: extract the rootMargin. A bottom margin <= 45% lets a short last
  // section still intersect at scroll end; a tight band (e.g. -55%) does not.
  // Band-alone is fragile — the message says the fallback is preferred.
  const rm = js.match(/rootMargin\s*:\s*["']([^"']+)["']/);
  let tightBand = false;
  if (rm) {
    const parts = rm[1].trim().split(/\s+/);
    let bottomMargin;
    if (parts.length === 1) bottomMargin = parts[0];
    else if (parts.length === 2) bottomMargin = parts[1];
    else bottomMargin = parts[2]; // top right bottom left
    const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(bottomMargin ?? "");
    if (pct && Math.abs(Number(pct[1])) > 45) tightBand = true;
  }
  if (tightBand && !boundaryExpr) {
    errors.push(
      "scrollspy: IntersectionObserver rootMargin bottom margin is too tight for a short last section and no bottom-boundary fallback exists — the last tab stays inactive at scroll bottom. Add a scroll/idle handler that activates the last section when window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 4, or widen the IO band so the bottom margin is <= 45%. The fallback is preferred.",
    );
  }

  // RULE 2 — no scrollIntoView inside the active-toggling scope. A function
  // that writes aria-current/active AND calls scrollIntoView re-triggers the
  // observer and jitters. Extract function bodies with a brace-balanced scan
  // (regex can't handle nested braces, so the common
  // `function setActive(id){ links.forEach(a => { a.scrollIntoView(); }) }`
  // would be truncated mid-body by a `[^}]*` regex).
  const fnBodies = [];
  // Match function-start openers: `function name(...)`, `function(...)`, or
  // `=>` whose next non-space char is `{`. Two separate patterns avoid one
  // giant alternation regex the parser chokes on; we union the matches.
  const namedFn = /function\s+\w+\s*\([^)]*\)\s*\{/g;
  const anonFn = /function\s*\([^)]*\)\s*\{/g;
  const arrowFn = /=>\s*\{/g;
  const starts = [];
  for (const re of [namedFn, anonFn, arrowFn]) {
    re.lastIndex = 0;
    let mm = re.exec(js);
    while (mm) {
      starts.push(mm.index + mm[0].length - 1);
      mm = re.exec(js);
    }
  }
  for (const openIdx of starts) {
    let depth = 1;
    for (let i = openIdx + 1; i < js.length; i += 1) {
      if (js[i] === "{") depth += 1;
      else if (js[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          fnBodies.push(js.slice(openIdx + 1, i));
          break;
        }
      }
    }
  }
  for (const body of fnBodies) {
    // Only flag a LEAF function — one whose body contains no nested function
    // declaration/expression/arrow. A wrapper (IIFE, or a function whose body
    // contains sibling function definitions) would "contain" both signals
    // only because nested siblings define them, not because they co-occur in
    // the same scope. The trip-plan v3 bug co-locates them in the innermost
    // callback; the v4 fix separates them into two leaf functions.
    const isLeaf = !/function\b|=>/.test(body);
    if (!isLeaf) continue;
    if (activeWrite.test(body) && /\.scrollIntoView\s*\(/.test(body)) {
      errors.push(
        "scrollspy: the function that sets aria-current/active also calls scrollIntoView, which re-triggers the IntersectionObserver and jitters — call scrollIntoView only on the nav chip from a separate sync function (or omit it), not from setActive.",
      );
      break; // one hit is enough; the message is the same
    }
  }
  if (errors.length === 1) {
    fail(errors[0]);
  } else if (errors.length > 1) {
    fail(`scrollspy defects (fix all):\n  - ${errors.join("\n  - ")}`);
  }
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
    validateScrollspy(composed.authoredScripts);
    validateTropes(composed.authoredStyles);
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
