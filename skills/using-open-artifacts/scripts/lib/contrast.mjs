// WCAG contrast validation for authored theme tokens.
//
// The token contract ships safe default pairs in both themes; the contract's
// own values are pre-checked and pass. What can ship a P0 contrast failure is
// a direction override that redefines --fg/--bg/--muted/--surface/--accent to
// a too-similar lightness. design.md's ship-gate P0 mandates body text ≥ 4.5:1
// in BOTH themes, but the gate is manual — a 2.3:1 --muted can publish unless
// the author computes ratios by hand. This makes it a build-time check.
//
// The check only fires on tokens the author actually overrode. It parses the
// unlayered :root (light) and :root[data-theme="dark"] (dark) blocks of the
// joined theme fragments, resolves each override, and compares the listed
// pairs. Values the author left at the contract default are skipped (they
// already pass). color-mix() and var() references can't be resolved to a
// single color statically, so only concrete hex/oklch/oklab/rgb/hsl literals
// are checked; unresolved values are skipped with a note, never failed —
// better a missed check than a false positive that blocks a valid direction.

const CONTRACT_DEFAULTS = {
  light: {
    "--bg": "#ffffff",
    "--surface": "#f8f8f8",
    "--fg": "#18181b",
    "--muted": "#71717a",
    "--accent": "#6457f0",
    "--accent-on": "#ffffff",
  },
  dark: {
    "--bg": "#131316",
    "--surface": "#1c1c21",
    "--fg": "#e7e7ea",
    "--muted": "#9a9aa2",
    "--accent": "#8d82f5",
    "--accent-on": "#15131f",
  },
};

// Pairs to check: foreground on background. --accent is used as link/accent
// text, so it is checked against --bg; --accent-on is checked against
// --accent (button label on accent fill). --muted is body-secondary text on
// --surface (cards/tiles) and on --bg.
const PAIRS = [
  ["--fg", "--bg"],
  ["--muted", "--bg"],
  ["--muted", "--surface"],
  ["--accent", "--bg"],
  ["--accent-on", "--accent"],
];

const MIN_CONTRAST = 4.5;

function parseBlockDeclarations(block) {
  // Strip comments, then collect `--name: value;` pairs into a map. Only the
  // last occurrence wins, matching CSS cascade within one declaration block.
  // The terminator is `;` or end-of-string: the last declaration in a block
  // has no trailing `;` (the closing `}` is not part of the extracted body).
  const stripped = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const decls = {};
  const re = /(--[A-Za-z][\w-]*)\s*:\s*([^;}]+?)\s*(?:;|$)/g;
  for (const m of stripped.matchAll(re)) {
    decls[m[1]] = m[2].trim();
  }
  return decls;
}

// Extract the declaration body of :root { ... } (light) and
// :root[data-theme="dark"] { ... } (dark) from the joined theme source.
export function parseThemeBlocks(themeSource) {
  const stripped = themeSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = matchBlock(stripped, /:root\s*\{/, true);
  const dark = matchBlock(
    stripped,
    /:root\s*\[\s*data-theme\s*=\s*["']dark["']\s*\]\s*\{/,
    false,
  );
  return {
    light: light ? parseBlockDeclarations(light) : {},
    dark: dark ? parseBlockDeclarations(dark) : {},
  };
}

// Find the matching `}` for the brace opening at the regex match. If
// `bareRootOnly`, skip :root blocks that carry a selector qualifier (the dark
// block `:root[data-theme=...]` is NOT a bare root).
function matchBlock(source, openRe, bareRootOnly) {
  let cursor = 0;
  while (true) {
    const m = openRe.exec(source.slice(cursor));
    if (!m) return null;
    const openIndex = cursor + m.index + m[0].length;
    // For bare-root matching, ensure the char right after `:root` (before `{`)
    // was whitespace — i.e. no `[data-theme=...]` qualifier. m[0] already
    // includes the `{`, so look at the char before it in the full match.
    const fullMatch = m[0];
    if (bareRootOnly && !/:root\s*\{/.test(fullMatch)) {
      cursor = openIndex;
      continue;
    }
    const body = readBalancedBraces(source, openIndex);
    if (body !== null) return body;
    cursor = openIndex;
  }
}

function readBalancedBraces(source, openIndex) {
  let depth = 1;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i);
    }
  }
  return null;
}

// --- Color parsing to linear sRGB for WCAG relative luminance ---

function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]) {
  return (
    0.2126 * srgbToLinear(r) +
    0.7152 * srgbToLinear(g) +
    0.0722 * srgbToLinear(b)
  );
}

function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function hexToRgb(hex) {
  let h = hex.replace(/^#/, "").trim();
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  if (h.length === 4)
    h = h
      .slice(1)
      .split("")
      .map((c) => c + c)
      .join("");
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbFnToRgb(value) {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

function hslFnToRgb(value) {
  const m = /hsla?\(\s*([\d.]+)[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?/i.exec(value);
  if (!m) return null;
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

// oklch / oklab → 8-bit sRGB. L is [0,1] (or 0-100 with %), C is [0,~0.4]
// (or 0-100 with %), H is degrees. The matrices below are the standard
// OKLab → linear sRGB transform.
function linearTo8bit(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function oklabToLinearSrgb(L, a, b) {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l_ = l ** 3;
  const m_ = m ** 3;
  const s_ = s ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380041 * l_ + 2.6097573491 * m_ - 0.3413193965 * s_,
    -0.0040528998 * l_ - 0.7034849556 * m_ + 1.7074596317 * s_,
  ];
}

function oklabToRgb(L, a, b) {
  const [r, g, b_] = oklabToLinearSrgb(L, a, b);
  return [linearTo8bit(r), linearTo8bit(g), linearTo8bit(b_)];
}

function oklchToRgb(value) {
  // Match L, C, H with optional % on L and C, optional deg on H.
  const m = /oklcha?\(\s*([\d.]+)(%)?\s+([\d.]+)(%)?\s+([\d.]+)(?:deg)?/i.exec(
    value,
  );
  if (!m) return null;
  const L = m[2] === "%" ? Number(m[1]) / 100 : Number(m[1]);
  const C = m[4] === "%" ? Number(m[3]) / 100 : Number(m[3]);
  const H = Number(m[5]);
  const hr = (H * Math.PI) / 180;
  const a = Math.cos(hr) * C;
  const b = Math.sin(hr) * C;
  return oklabToRgb(L, a, b);
}

function oklabFnToRgb(value) {
  const m = /oklab\(\s*([\d.]+)(%)?\s+([\d.]+)(%)?\s+([\d.]+)(%)?/i.exec(value);
  if (!m) return null;
  const L = m[2] === "%" ? Number(m[1]) / 100 : Number(m[1]);
  const a = m[4] === "%" ? Number(m[3]) / 100 : Number(m[3]);
  const b = m[6] === "%" ? Number(m[5]) / 100 : Number(m[5]);
  return oklabToRgb(L, a, b);
}

function resolveColor(value) {
  if (!value) return null;
  const v = value.trim();
  if (v.startsWith("#")) return hexToRgb(v);
  if (/^rgba?\(/i.test(v)) return rgbFnToRgb(v);
  if (/^hsla?\(/i.test(v)) return hslFnToRgb(v);
  if (/^oklcha?\(/i.test(v)) return oklchToRgb(v);
  if (/^oklab\(/i.test(v)) return oklabFnToRgb(v);
  // Named colors and unresolved var()/color-mix() can't be checked statically.
  return null;
}

export function checkContrast(themeSource) {
  const blocks = parseThemeBlocks(themeSource);
  const failures = [];
  const skipped = [];
  for (const themeName of ["light", "dark"]) {
    const overrides = blocks[themeName];
    for (const [fgName, bgName] of PAIRS) {
      const fgValue = overrides[fgName] ?? CONTRACT_DEFAULTS[themeName][fgName];
      const bgValue = overrides[bgName] ?? CONTRACT_DEFAULTS[themeName][bgName];
      // If the author overrode neither in this theme, the contract default
      // already passes — skip silently.
      const authorTouched = fgName in overrides || bgName in overrides;
      if (!authorTouched) continue;
      const fg = resolveColor(fgValue);
      const bg = resolveColor(bgValue);
      if (!fg || !bg) {
        // Only note a skip if the author actually touched one of the pair;
        // unresolved color-mix()/var()/named values can't be checked statically.
        if (fgName in overrides || bgName in overrides) {
          skipped.push(`${themeName} ${fgName}/${bgName}`);
        }
        continue;
      }
      const ratio = contrastRatio(fg, bg);
      if (ratio < MIN_CONTRAST) {
        failures.push({
          theme: themeName,
          pair: `${fgName} (${fgValue}) on ${bgName} (${bgValue})`,
          ratio: Number(ratio.toFixed(2)),
        });
      }
    }
  }
  return { failures, skipped };
}
