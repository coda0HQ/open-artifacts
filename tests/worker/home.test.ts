import { describe, expect, it } from "vitest";
import { brandFor, brandHomepage, hasBrandConfig } from "../../src/home";

// Mirrors the branding hooks in public/index.html.
const SAMPLE = `<!doctype html><html><head>
<title>Open Artifacts</title>
<meta name="description" content="Publish self-contained HTML and Markdown pages.">
</head><body>
<span class="brand-name">Open Artifacts</span>
<span class="chip"><span class="chip-text">self-hosted instance</span></span>
<h1 id="hero-title">Open Artifacts</h1>
<p id="hero-lead">Publish self-contained HTML and Markdown pages from any coding agent.</p>
</body></html>`;

const BRANDED = {
  BRAND_NAME: "coda0",
  BRAND_WORDMARK: "CODA0",
  BRAND_TAGLINE: "share self-contained pages",
  BRAND_DESCRIPTION:
    "coda0 — the managed, hosted home for the open-source Open Artifacts engine.",
  BRAND_LEAD:
    'The managed home for <a href="https://github.com/coda0HQ/open-artifacts" target="_blank" rel="noopener noreferrer">Open Artifacts</a>.',
  BRAND_CHIP: "hosted instance",
};

function brand(html: string): Promise<string> {
  return brandHomepage(
    new Response(html, { headers: { "content-type": "text/html" } }),
    BRANDED,
  ).text();
}

describe("hasBrandConfig", () => {
  it("is true only when BRAND_NAME is set", () => {
    expect(hasBrandConfig({ BRAND_NAME: "coda0" })).toBe(true);
    expect(hasBrandConfig({})).toBe(false);
    expect(hasBrandConfig({ BRAND_NAME: "  " })).toBe(false);
  });
});

describe("brandFor", () => {
  it("uses BRAND_* when configured", () => {
    expect(brandFor(BRANDED)).toEqual({
      name: "coda0",
      wordmark: "CODA0",
      tagline: "share self-contained pages",
    });
  });

  it("keeps the neutral Open Artifacts identity without brand env", () => {
    expect(brandFor({})).toEqual({
      name: "Open Artifacts",
      wordmark: "OPEN ARTIFACTS",
      tagline: "self-hosted artifact viewer",
    });
  });
});

describe("brandHomepage", () => {
  it("rewrites the title, meta description, and visible hero from env", async () => {
    const html = await brand(SAMPLE);
    expect(html).toContain("<title>coda0</title>");
    expect(html).not.toContain("<title>Open Artifacts</title>");
    expect(html).toContain('content="coda0');
    expect(html).toContain('<span class="brand-name">coda0</span>');
    expect(html).toContain('<span class="chip-text">hosted instance</span>');
    expect(html).toContain('<h1 id="hero-title">coda0</h1>');
  });

  it("leaves the asset untouched without brand env", async () => {
    const html = await brandHomepage(
      new Response(SAMPLE, { headers: { "content-type": "text/html" } }),
      {},
    ).text();
    expect(html).toContain("<title>Open Artifacts</title>");
    expect(html).toContain('<span class="brand-name">Open Artifacts</span>');
  });

  it("uses BRAND_LEAD when provided", async () => {
    const html = await brand(SAMPLE);
    expect(html).toContain("The managed home for");
    expect(html).toContain('href="https://github.com/coda0HQ/open-artifacts"');
  });
});
