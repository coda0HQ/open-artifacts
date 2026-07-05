import { describe, expect, it } from "vitest";
import { brandHomepageForCoda0, isCoda0Host } from "../../src/home";

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

function brand(html: string): Promise<string> {
  return brandHomepageForCoda0(
    new Response(html, { headers: { "content-type": "text/html" } }),
  ).text();
}

describe("isCoda0Host", () => {
  it("matches the hosted domain and its www subdomain", () => {
    expect(isCoda0Host("coda0.com")).toBe(true);
    expect(isCoda0Host("www.coda0.com")).toBe(true);
  });

  it("does not match self-hosted, workers.dev, or look-alike hosts", () => {
    expect(isCoda0Host("open-artifacts.frad.workers.dev")).toBe(false);
    expect(isCoda0Host("example.com")).toBe(false);
    expect(isCoda0Host("coda0.com.evil.com")).toBe(false);
  });
});

describe("brandHomepageForCoda0", () => {
  it("rewrites the title, meta description, and visible hero to coda0", async () => {
    const html = await brand(SAMPLE);
    expect(html).toContain("<title>coda0</title>");
    expect(html).not.toContain("<title>Open Artifacts</title>");
    expect(html).toContain('content="coda0');
    expect(html).toContain('<span class="brand-name">coda0</span>');
    expect(html).toContain('<span class="chip-text">hosted instance</span>');
    expect(html).toContain('<h1 id="hero-title">coda0</h1>');
  });

  it("names the open-artifacts repo in the rewritten hero lead", async () => {
    const html = await brand(SAMPLE);
    expect(html).toContain("The hosted home for");
    expect(html).toContain('href="https://github.com/coda0HQ/open-artifacts"');
  });
});
