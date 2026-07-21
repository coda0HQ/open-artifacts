// Server-side branding for the static landing page and viewer chrome.
// Brand identity comes from env (BRAND_NAME, …) so the engine stays brand-
// neutral: a self-hosted deploy with no brand env keeps the "Open Artifacts"
// markup; a SaaS deploy sets BRAND_* and gets a rewritten home
// page plus matching header / status / OG chrome.

export interface BrandEnv {
  BRAND_NAME?: string;
  BRAND_WORDMARK?: string;
  BRAND_TAGLINE?: string;
  BRAND_DESCRIPTION?: string;
  BRAND_LEAD?: string;
  BRAND_CHIP?: string;
  BRAND_URL?: string;
}

export interface Brand {
  readonly name: string;
  readonly wordmark: string;
  /** Short service descriptor; suffixes the document <title> for SERP length
   *  and drives the OG card's call-to-action. */
  readonly tagline: string;
}

const DEFAULT_BRAND: Brand = {
  name: "Open Artifacts",
  wordmark: "OPEN ARTIFACTS",
  tagline: "self-hosted artifact viewer",
};

/** True when the operator configured a primary brand via BRAND_NAME. */
export function hasBrandConfig(env: BrandEnv): boolean {
  return Boolean(env.BRAND_NAME?.trim());
}

// The identity presented to a visitor. Every touchpoint that names the service
// — viewer header chip, not-found/invalid-version pages, OG wordmark — reads
// from this one place so brand stays consistent.
export function brandFor(env: BrandEnv): Brand {
  if (!hasBrandConfig(env)) return DEFAULT_BRAND;
  const name = (env.BRAND_NAME ?? "").trim();
  return {
    name,
    wordmark: (env.BRAND_WORDMARK?.trim() || name).toUpperCase(),
    tagline: env.BRAND_TAGLINE?.trim() || "share self-contained pages",
  };
}

const setText = (text: string): HTMLRewriterElementContentHandlers => ({
  element(el: Element) {
    el.setInnerContent(text);
  },
});

// Stream the neutral landing markup through HTMLRewriter, rewriting brand
// tokens from env. Streaming (no buffering) keeps content-length correct and
// avoids re-encoding; the hooks (.brand-name, .chip-text, #hero-title,
// #hero-lead) are the stable anchors in public/index.html.
export function brandHomepage(response: Response, env: BrandEnv): Response {
  if (!hasBrandConfig(env)) return response;
  const brand = brandFor(env);
  const description =
    env.BRAND_DESCRIPTION?.trim() ||
    `${brand.name} — publish self-contained HTML and Markdown pages from any coding agent, share by URL, protect with a password, and keep them in sync as your project evolves.`;
  const lead =
    env.BRAND_LEAD?.trim() ||
    `Publish self-contained HTML and Markdown pages from any coding agent, share by URL, protect with a password, and keep them in sync.`;
  const chip = env.BRAND_CHIP?.trim() || "hosted instance";

  return new HTMLRewriter()
    .on("title", setText(brand.name))
    .on("meta[name=description]", {
      element(el: Element) {
        el.setAttribute("content", description);
      },
    })
    .on(".brand-name", setText(brand.name))
    .on(".chip-text", setText(chip))
    .on("#hero-title", setText(brand.name))
    .on("#hero-lead", {
      element(el: Element) {
        el.setInnerContent(lead, { html: true });
      },
    })
    .transform(response);
}
