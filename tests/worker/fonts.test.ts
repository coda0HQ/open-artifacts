import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://artifacts.test";

interface CreateResult {
  id: string;
  url: string;
  writeToken: string;
  version: number;
}

async function create(body: Record<string, unknown>): Promise<CreateResult> {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Font Test",
        favicon: "🔤",
        ...body,
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResult;
}

describe("web-font surface — opt-in flag is set in wrangler.jsonc", () => {
  it("serves a derived @font-face from /fonts/:slug.css", async () => {
    const res = await exports.default.fetch(
      `${BASE}/fonts/general-sans--400.css`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const css = await res.text();
    expect(css).toContain("@font-face");
    expect(css).toContain("/fonts/general-sans--400.woff2");
    expect(css).toContain("font-weight:400");
  });

  it("serves italic variant with font-style:italic", async () => {
    const res = await exports.default.fetch(
      `${BASE}/fonts/general-sans--400--italic.css`,
    );
    expect(res.status).toBe(200);
    const css = await res.text();
    expect(css).toContain("font-style:italic");
  });

  it("404s a malformed slug", async () => {
    const res = await exports.default.fetch(`${BASE}/fonts/no-weight.woff2`);
    expect(res.status).toBe(404);
  });

  it("serves a cached .woff2 from R2 without re-materializing", async () => {
    const slug = "general-sans--500";
    const key = `fonts/${slug}.woff2`;
    const cached = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    await env.CONTENT.put(key, cached, {
      httpMetadata: { contentType: "font/woff2" },
    });
    const res = await exports.default.fetch(`${BASE}/fonts/${slug}.woff2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(cached));
    await env.CONTENT.delete(key);
  });

  it("stamps the font CDN allowlist and style-src Google Fonts on the frame CSP, without allow-same-origin", async () => {
    const created = await create({ content: "<h1>Fonts</h1>" });
    // The artifact body — and its CSP — now live on the frame sub-route; the
    // host page (/a/:id) never gets the webFonts-widened CSP at all.
    const res = await exports.default.fetch(`${BASE}/a/${created.id}/frame`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    // R1: the artifact frame must never become same-origin with the
    // privileged host page, even with webFonts on — allow-same-origin is
    // deliberately withheld here (frameSandbox), unlike the general
    // contentSecurityPolicy({sandbox:true, webFonts:true}) default.
    expect(csp).not.toContain("allow-same-origin");
    // Opaque frames: 'self' would not match the worker host, so the CSP
    // stamps the real response origin for the same-origin /fonts proxy.
    expect(csp).toMatch(
      /font-src http:\/\/artifacts\.test data: cdn\.fontshare\.com fonts\.gstatic\.com/,
    );
    expect(csp).toMatch(
      /style-src http:\/\/artifacts\.test 'unsafe-inline' fonts\.googleapis\.com/,
    );
    // 'self' alone must not be the only same-host source on an opaque frame.
    expect(csp).not.toMatch(/font-src 'self'/);
  });

  it("never widens the host page CSP when the web-font flag is on", async () => {
    const created = await create({ content: "<h1>Fonts</h1>" });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    // The host is not the artifact: it carries no sandbox directive at all, so
    // the opt-in can never hand the artifact same-origin access to it.
    expect(csp).not.toContain("sandbox");
    expect(csp).not.toContain("allow-same-origin");
    // The flag reaches only the frame — the host keeps its fixed font policy.
    expect(csp).not.toContain("cdn.fontshare.com");
    expect(csp).toContain("connect-src 'self'");
  });
});
