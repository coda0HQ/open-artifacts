// Server-side branding for the static landing page. On the hosted host the
// page must read as "coda0" in the HTML source itself — title, meta, and the
// visible hero — so crawlers and no-JS visitors see the SaaS identity, not the
// neutral "Open Artifacts" markup shipped in public/index.html. A self-hosted
// deploy never runs this, so its landing page stays "Open Artifacts".

const CODA0_DESCRIPTION =
  "coda0 — the hosted home for Open Artifacts. Publish self-contained HTML and Markdown pages from any coding agent, share by URL, protect with a password, and keep them in sync as your project evolves.";

const CODA0_LEAD =
  'The hosted home for <a href="https://github.com/coda0HQ/open-artifacts" target="_blank" rel="noopener noreferrer">Open Artifacts</a> — publish self-contained HTML and Markdown pages from any coding agent, share by URL, protect with a password, and keep them in sync as your project evolves.';

// True only for the hosted SaaS host. Keyed on the request host (mirroring the
// landing page's own rule) so the coda0 brand appears on coda0.com and never on
// a self-hoster's deploy — even one that sets PUBLIC_URL to its own domain.
export function isCoda0Host(hostname: string): boolean {
  return hostname === "coda0.com" || hostname === "www.coda0.com";
}

const setText = (text: string): HTMLRewriterElementContentHandlers => ({
  element(el: Element) {
    el.setInnerContent(text);
  },
});

// Stream the neutral landing markup through HTMLRewriter, rewriting the brand
// tokens to coda0. Streaming (no buffering) keeps content-length correct and
// avoids re-encoding; the hooks (.brand-name, .chip-text, #hero-title,
// #hero-lead) are the stable anchors added to public/index.html.
export function brandHomepageForCoda0(response: Response): Response {
  return new HTMLRewriter()
    .on("title", setText("coda0"))
    .on("meta[name=description]", {
      element(el: Element) {
        el.setAttribute("content", CODA0_DESCRIPTION);
      },
    })
    .on(".brand-name", setText("coda0"))
    .on(".chip-text", setText("hosted instance"))
    .on("#hero-title", setText("coda0"))
    .on("#hero-lead", {
      element(el: Element) {
        el.setInnerContent(CODA0_LEAD, { html: true });
      },
    })
    .transform(response);
}
