import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/api";
import { brandFor } from "../../src/home";
import app from "../../src/index";
import { ogCardSvg } from "../../src/wrap";

const BASE = "http://artifacts.test";
const CODA0 = "https://coda0.com";

interface CreateResult {
  id: string;
  url: string;
  writeToken: string;
  version: number;
}

async function fetchWith(
  request: Request,
  environment: Bindings,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function create(
  base: string,
  environment: Bindings,
): Promise<CreateResult> {
  const res = await fetchWith(
    new Request(`${base}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Branding Test",
        favicon: "🏷️",
        content: "<h1>x</h1>",
      }),
    }),
    environment,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResult;
}

describe("brandFor", () => {
  it("identifies as coda0 on the hosted host", () => {
    expect(brandFor("coda0.com")).toEqual({
      name: "coda0",
      wordmark: "CODA0",
      tagline: "share self-contained pages",
    });
    expect(brandFor("www.coda0.com").name).toBe("coda0");
  });

  it("keeps the neutral Open Artifacts identity everywhere else", () => {
    expect(brandFor("example.com")).toEqual({
      name: "Open Artifacts",
      wordmark: "OPEN ARTIFACTS",
      tagline: "self-hosted artifact viewer",
    });
    expect(brandFor("open-artifacts.frad.workers.dev").name).toBe(
      "Open Artifacts",
    );
  });
});

describe("viewer header brand chip", () => {
  it("shows a coda0 chip linking home on the hosted host", async () => {
    const created = await create(CODA0, env);
    const html = await (
      await fetchWith(new Request(`${CODA0}/a/${created.id}`), env)
    ).text();
    expect(html).toContain('class="oa-brand" href="/"');
    expect(html).toContain('<span class="oa-brand-text">coda0</span>');
  });

  it("shows no brand chip on a self-hosted deploy without BRAND_URL", async () => {
    const created = await create(BASE, env);
    const html = await (
      await fetchWith(new Request(`${BASE}/a/${created.id}`), env)
    ).text();
    expect(html).not.toContain('<a class="oa-brand"');
  });

  it("shows the neutral Open Artifacts credit when a self-host sets BRAND_URL", async () => {
    const brandedEnv = { ...env, BRAND_URL: "https://example.org/about" };
    const created = await create(BASE, brandedEnv);
    const html = await (
      await fetchWith(new Request(`${BASE}/a/${created.id}`), brandedEnv)
    ).text();
    expect(html).toContain('href="https://example.org/about"');
    expect(html).toContain('<span class="oa-brand-text">Open Artifacts</span>');
  });

  it("ignores a stray BRAND_URL on the hosted host and still identifies as coda0", async () => {
    const strayEnv = { ...env, BRAND_URL: "https://example.org/about" };
    const created = await create(CODA0, strayEnv);
    const html = await (
      await fetchWith(new Request(`${CODA0}/a/${created.id}`), strayEnv)
    ).text();
    expect(html).toContain('class="oa-brand" href="/"');
    expect(html).not.toContain("example.org");
    expect(html).toContain('<span class="oa-brand-text">coda0</span>');
  });
});

describe("status pages", () => {
  it("links 'Go to coda0' on a 404 from the hosted host", async () => {
    const res = await fetchWith(new Request(`${CODA0}/a/nonexistent00`), env);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(">Go to coda0<");
  });

  it("links 'Go to Open Artifacts' on a 404 from any other host", async () => {
    const res = await fetchWith(new Request(`${BASE}/a/nonexistent00`), env);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(">Go to Open Artifacts<");
  });

  it("links 'Go to coda0' on an invalid ?v= from the hosted host", async () => {
    const created = await create(CODA0, env);
    const res = await fetchWith(
      new Request(`${CODA0}/a/${created.id}?v=notanumber`),
      env,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(">Go to coda0<");
  });
});

describe("OG card wordmark", () => {
  it("reads CODA0 on the hosted host", () => {
    const svg = ogCardSvg({
      title: "x",
      description: "y",
      hostname: "coda0.com",
    });
    expect(svg).toContain(">CODA0<");
    expect(svg).not.toContain("OPEN ARTIFACTS");
  });

  it("reads OPEN ARTIFACTS everywhere else", () => {
    const svg = ogCardSvg({
      title: "x",
      description: "y",
      hostname: "example.com",
    });
    expect(svg).toContain(">OPEN ARTIFACTS<");
  });

  it("carries a call-to-action pill on the real card", () => {
    const svg = ogCardSvg({
      title: "x",
      description: "y",
      hostname: "coda0.com",
    });
    expect(svg).toContain(">Open →<");
  });

  it("carries the call-to-action on the fallback card too", () => {
    const svg = ogCardSvg({
      title: "Пример",
      description: "",
      hostname: "coda0.com",
    });
    expect(svg).toContain(">Open →<");
  });

  it("draws CJK titles on the real card via the Noto Sans SC face", () => {
    const svg = ogCardSvg({
      title: "开源自托管",
      description: "任意编码 agent 都能发布可分享的页面",
      hostname: "coda0.com",
    });
    // The title and description are laid out as text (not the wordmark-only
    // fallback), and the brand footer is still present.
    expect(svg).toContain("开源自托管");
    expect(svg).toContain("任意编码 agent");
    expect(svg).toContain(">CODA0<");
  });

  it("brands the fallback card for scripts with no embedded glyphs", () => {
    // Cyrillic is covered by neither Inter nor the Noto Sans SC subset, so the
    // card drops to the brand lockup and the title text is omitted.
    const svg = ogCardSvg({
      title: "Пример заголовка",
      description: "",
      hostname: "coda0.com",
    });
    expect(svg).toContain(">CODA0<");
    expect(svg).not.toContain("Пример");
  });
});
