import type { Bindings } from "./api";

// Same-origin web-font proxy. Artifacts name a Fontshare family by a slug of
// the form `<family>--<weight>[--italic]` (e.g. `general-sans--400`,
// `clash-display--600--italic`); the Worker resolves it against the Fontshare
// API, fetches the .woff2 from cdn.fontshare.com *outside the sandbox*, caches
// the bytes in R2 under `fonts/<slug>.woff2`, and serves them same-origin so no
// third-party host ever appears in the artifact CSP. The Fontshare fetch never
// widens the artifact's CSP — it happens Worker-side, gated by the
// OPEN_ARTIFACTS_WEB_FONTS deploy flag.

const FONTSHARE_API = "https://api.fontshare.com/v2/fonts";

export interface FontSlug {
  // Fontshare family name token, e.g. "general-sans" or "clash-display".
  family: string;
  // Numeric CSS font-weight, e.g. 400 / 500 / 600 / 700.
  weight: number;
  // "normal" (default) or "italic".
  style: string;
}

export function parseSlug(slug: string): FontSlug | null {
  const parts = slug.split("--");
  if (parts.length < 2 || parts.length > 3) return null;
  const family = parts[0];
  if (family.length === 0) return null;
  const weight = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(weight) || weight < 1 || weight > 999) return null;
  let style = "normal";
  if (parts.length === 3) {
    if (parts[2] !== "italic") return null;
    style = "italic";
  }
  return { family, weight, style };
}

interface FontshareStyle {
  file: string | null;
  is_italic: boolean;
  is_variable: boolean;
  weight?: { number?: number };
}

interface FontshareFont {
  slug?: string;
  styles?: FontshareStyle[];
}

interface FontshareSearchResponse {
  fonts?: { id?: string; name?: string; slug?: string }[];
}

interface FontshareFontResponse {
  font?: FontshareFont;
}

// Resolves a slug to a Fontshare CDN file path (no extension) for the matching
// weight/style, preferring a static instance over a variable instance. Returns
// null when the family or weight/style is unknown so the route 404s rather than
// proxying an arbitrary host.
async function resolveFontshareFile(
  slug: FontSlug,
): Promise<{ path: string } | null> {
  const search = new URLSearchParams({ search: slug.family });
  const searchRes = await fetch(`${FONTSHARE_API}?${search}`);
  if (!searchRes.ok) return null;
  const searchJson = (await searchRes.json()) as FontshareSearchResponse;
  const match = (searchJson.fonts ?? []).find(
    (f) =>
      (f.slug ?? "").toLowerCase() === slug.family.toLowerCase() ||
      (f.name ?? "").toLowerCase() === slug.family.toLowerCase(),
  );
  if (match?.id === undefined) return null;
  const fontRes = await fetch(`${FONTSHARE_API}/${match.id}`);
  if (!fontRes.ok) return null;
  const fontJson = (await fontRes.json()) as FontshareFontResponse;
  const styles = fontJson.font?.styles ?? [];
  // Prefer a static (non-variable) instance of the requested weight/style.
  const candidates = styles
    .filter((s) => s.is_variable === false)
    .filter((s) => (slug.style === "italic") === s.is_italic)
    .filter((s) => s.weight?.number === slug.weight)
    .filter((s) => typeof s.file === "string" && s.file.length > 0);
  const chosen = candidates[0] ?? null;
  if (chosen?.file === undefined || chosen.file === null) return null;
  // Fontshare file paths are protocol-relative ("//cdn.fontshare.com/wf/...");
  // normalize to an absolute https URL.
  const file = chosen.file.startsWith("//")
    ? `https:${chosen.file}`
    : chosen.file;
  return { path: file };
}

function fontR2Key(slug: string): string {
  return `fonts/${slug}.woff2`;
}

// Returns the cached .woff2 bytes for a slug, materializing from Fontshare on
// first miss. Null means the slug is unknown and the route should 404.
export async function materializeFont(
  slug: string,
  env: Bindings,
): Promise<Uint8Array | null> {
  const cached = await env.CONTENT.get(fontR2Key(slug));
  if (cached !== null) {
    return new Uint8Array(await cached.arrayBuffer());
  }
  const parsed = parseSlug(slug);
  if (parsed === null) return null;
  const resolved = await resolveFontshareFile(parsed);
  if (resolved === null) return null;
  const fontRes = await fetch(`${resolved.path}.woff2`);
  if (!fontRes.ok) return null;
  const bytes = new Uint8Array(await fontRes.arrayBuffer());
  await env.CONTENT.put(fontR2Key(slug), bytes, {
    httpMetadata: { contentType: "font/woff2" },
    customMetadata: {
      family: parsed.family,
      weight: String(parsed.weight),
      style: parsed.style,
    },
  });
  return bytes;
}

// A tiny @font-face stylesheet derived from the slug, so an artifact author
// only needs `<link rel="stylesheet" href="/fonts/<slug>.css">`.
export function fontFaceCss(slug: string): string | null {
  const parsed = parseSlug(slug);
  if (parsed === null) return null;
  const familyDisplay = parsed.family;
  return `@font-face{font-family:${JSON.stringify(familyDisplay)};src:url("/fonts/${slug}.woff2") format("woff2");font-weight:${parsed.weight};font-style:${parsed.style};font-display:swap}`;
}
