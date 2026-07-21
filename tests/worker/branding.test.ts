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

const BRANDED_ENV = {
  BRAND_NAME: "coda0",
  BRAND_WORDMARK: "CODA0",
  BRAND_TAGLINE: "share self-contained pages",
} as const;

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
  it("identifies as the configured brand when BRAND_NAME is set", () => {
    expect(brandFor(BRANDED_ENV)).toEqual({
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

describe("viewer header brand chip", () => {
  it("shows a configured brand chip linking home when BRAND_NAME is set", async () => {
    const branded = { ...env, ...BRANDED_ENV };
    const created = await create(BASE, branded);
    const html = await (
      await fetchWith(new Request(`${BASE}/a/${created.id}`), branded)
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

  it("ignores a stray BRAND_URL when BRAND_NAME is set and still links home", async () => {
    const strayEnv = {
      ...env,
      ...BRANDED_ENV,
      BRAND_URL: "https://example.org/about",
    };
    const created = await create(BASE, strayEnv);
    const html = await (
      await fetchWith(new Request(`${BASE}/a/${created.id}`), strayEnv)
    ).text();
    expect(html).toContain('class="oa-brand" href="/"');
    expect(html).not.toContain("example.org");
    expect(html).toContain('<span class="oa-brand-text">coda0</span>');
  });
});

describe("status pages", () => {
  it("links 'Go to' the configured brand on a 404", async () => {
    const branded = { ...env, ...BRANDED_ENV };
    const res = await fetchWith(
      new Request(`${BASE}/a/nonexistent00`),
      branded,
    );
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(">Go to coda0<");
  });

  it("links 'Go to Open Artifacts' on a 404 without brand env", async () => {
    const res = await fetchWith(new Request(`${BASE}/a/nonexistent00`), env);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(">Go to Open Artifacts<");
  });

  it("links 'Go to' the configured brand on an invalid ?v=", async () => {
    const branded = { ...env, ...BRANDED_ENV };
    const created = await create(BASE, branded);
    const res = await fetchWith(
      new Request(`${BASE}/a/${created.id}?v=notanumber`),
      branded,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(">Go to coda0<");
  });
});

describe("OG card wordmark", () => {
  const branded = brandFor(BRANDED_ENV);
  const neutral = brandFor({});

  it("reads the configured wordmark when branded", () => {
    const svg = ogCardSvg({
      title: "x",
      description: "y",
      brand: branded,
    });
    expect(svg).toContain(">CODA0<");
    expect(svg).not.toContain("OPEN ARTIFACTS");
  });

  it("reads OPEN ARTIFACTS without brand env", () => {
    const svg = ogCardSvg({
      title: "x",
      description: "y",
      brand: neutral,
    });
    expect(svg).toContain(">OPEN ARTIFACTS<");
  });

  it("carries a call-to-action pill on the real card", () => {
    const svg = ogCardSvg({
      title: "x",
      description: "y",
      brand: branded,
    });
    expect(svg).toContain(">Open →<");
  });

  it("carries the call-to-action on the fallback card too", () => {
    const svg = ogCardSvg({
      title: "Пример",
      description: "",
      brand: branded,
    });
    expect(svg).toContain(">Open →<");
  });

  it("draws CJK titles on the real card via the Noto Sans SC face", () => {
    const svg = ogCardSvg({
      title: "开源自托管",
      description: "任意编码 agent 都能发布可分享的页面",
      brand: branded,
    });
    expect(svg).toContain("开源自托管");
    expect(svg).toContain("任意编码 agent");
    expect(svg).toContain(">CODA0<");
  });

  it("brands the fallback card for scripts with no embedded glyphs", () => {
    const svg = ogCardSvg({
      title: "Пример заголовка",
      description: "",
      brand: branded,
    });
    expect(svg).toContain(">CODA0<");
    expect(svg).not.toContain("Пример");
  });
});
