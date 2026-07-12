import { exports } from "cloudflare:workers";
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
        title: "OG Test",
        favicon: "📊",
        ...body,
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResult;
}

describe("OpenGraph metadata", () => {
  it("emits complete OG + Twitter tags derived from the artifact", async () => {
    const created = await create({
      content: "<h1>x</h1>",
      description: "A shareable report on Q3 metrics.",
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain(
      '<meta property="og:site_name" content="Open Artifacts">',
    );
    expect(html).toContain(
      "<title>OG Test · Open Artifacts — self-hosted artifact viewer</title>",
    );
    expect(html).toContain('<meta property="og:title" content="OG Test">');
    expect(html).toContain(
      '<meta property="og:description" content="A shareable report on Q3 metrics.">',
    );
    expect(html).toContain(
      `<meta property="og:url" content="${BASE}/a/${created.id}">`,
    );
    expect(html).toContain(
      `<meta property="og:image" content="${BASE}/og/${created.id}">`,
    );
    expect(html).toContain(
      '<meta property="og:image:type" content="image/png">',
    );
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
    expect(html).toContain(
      `<meta name="twitter:image" content="${BASE}/og/${created.id}">`,
    );
    expect(html).toContain(
      '<meta name="description" content="A shareable report on Q3 metrics.">',
    );
  });

  it("falls back to the title when no description is set", async () => {
    const created = await create({ content: "<h1>x</h1>" });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain(
      '<meta property="og:description" content="OG Test">',
    );
  });

  it("escapes HTML in OG values", async () => {
    const created = await create({
      content: "<h1>x</h1>",
      title: "OG <script>alert(1)</script>",
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).not.toContain('content="OG <script>alert(1)</script>"');
    expect(html).toContain("&lt;script&gt;");
  });

  it("serves a PNG OG card at /og/:id rendered from the artifact", async () => {
    const created = await create({
      content: "<h1>x</h1>",
      description: "card description",
    });
    const res = await exports.default.fetch(`${BASE}/og/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(bytes.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  const isPng = (bytes: Uint8Array): boolean =>
    bytes.byteLength > 1000 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;

  it("renders a long title that wraps and clips without failing", async () => {
    const created = await create({
      title:
        "A Very Long Artifact Title That Wraps Across Four Full Lines To Exercise Description Clipping",
      content: "<h1>x</h1>",
      description:
        "This description should be clipped so it never collides with the footer wordmark even when the title is very tall on the card.",
    });
    const res = await exports.default.fetch(`${BASE}/og/${created.id}`);
    expect(res.status).toBe(200);
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  it("rasterizes CJK titles as real headlines via the Noto Sans SC face", async () => {
    // The embedded Noto Sans SC subset covers Simplified Chinese, so a CJK
    // title renders as a real card headline (not the brand-only fallback) and
    // still produces a valid PNG.
    const created = await create({
      title: "开源自托管的 Claude Code Artifacts",
      content: "<h1>x</h1>",
      description: "任意编码 agent 都能发布可分享的页面。",
    });
    const res = await exports.default.fetch(`${BASE}/og/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  it("still produces a valid PNG for scripts with no embedded glyphs", async () => {
    // Cyrillic is in neither embedded face; the card drops to the branded
    // fallback rather than throwing or emitting a broken image.
    const created = await create({
      title: "Пример заголовка артефакта",
      content: "<h1>x</h1>",
    });
    const res = await exports.default.fetch(`${BASE}/og/${created.id}`);
    expect(res.status).toBe(200);
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  it("the OG image URL is absolute and points at /og/:id", async () => {
    const created = await create({ content: "<h1>x</h1>" });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    const match = html.match(/<meta property="og:image" content="([^"]+)">/);
    expect(match).not.toBeNull();
    expect(match?.[1] ?? "").toMatch(new RegExp(`^${BASE}/og/${created.id}$`));
  });

  it("encrypted artifacts also carry OG metadata on the unlock shell", async () => {
    // encrypted create: content = base64 ciphertext, title required explicitly
    const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
    const b64 = (bytes: number[]) => pad(btoa(String.fromCharCode(...bytes)));
    const created = await create({
      content: b64([0xe0, 0x00]),
      encrypted: {
        salt: b64(new Array(16).fill(1)),
        iv: b64(new Array(12).fill(1)),
        iterations: 1000,
      },
      description: "encrypted desc",
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain('<meta property="og:title" content="OG Test">');
    expect(html).toContain(
      '<meta property="og:site_name" content="Open Artifacts">',
    );
    expect(html).toContain(
      "<title>OG Test · Open Artifacts — self-hosted artifact viewer</title>",
    );
    expect(html).toContain(
      '<meta property="og:description" content="encrypted desc">',
    );
    expect(html).toContain(
      `<meta property="og:image" content="${BASE}/og/${created.id}">`,
    );
  });

  it("/og/:id 404s for unknown artifacts", async () => {
    const res = await exports.default.fetch(`${BASE}/og/nonexistent00`);
    expect(res.status).toBe(404);
  });
});
