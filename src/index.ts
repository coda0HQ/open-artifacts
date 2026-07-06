import { Hono } from "hono";
import type { AppContext } from "./api";
import {
  api,
  artifactUrl,
  ogImageUrl,
  parseVersionParam,
  storeFrom,
} from "./api";
import { brandHomepageForCoda0, isCoda0Host } from "./home";
import { renderOgCardPng } from "./og";
import {
  badVersionPage,
  notFoundPage,
  unlockShell,
  userContentHeaders,
  wrapDocument,
} from "./wrap";

const app = new Hono<AppContext>();

app.route("/api", api);

// The landing page ships as a neutral "Open Artifacts" static asset. The Worker
// runs first for "/" (wrangler.jsonc run_worker_first) so it can rebrand the
// asset to "coda0" in the HTML itself on the hosted host — for crawlers and
// no-JS visitors, not just after the client script. Every other deploy returns
// the asset untouched, so a self-hoster's page stays "Open Artifacts".
app.get("/", async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (!isCoda0Host(new URL(c.req.url).hostname)) return asset;
  if (!(asset.headers.get("content-type") ?? "").includes("text/html"))
    return asset;
  return brandHomepageForCoda0(asset);
});

app.get("/a/:id", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  const hostname = new URL(c.req.url).hostname;
  const htmlHeaders = (sandbox: boolean) =>
    userContentHeaders({ sandbox, contentType: "text/html; charset=utf-8" });

  if (record === null) {
    return new Response(notFoundPage(hostname), {
      status: 404,
      headers: htmlHeaders(true),
    });
  }

  const version = parseVersionParam(c.req.query("v"), record.currentVersion);
  if (typeof version !== "number") {
    const page =
      version.status === 400
        ? badVersionPage(hostname)
        : notFoundPage(hostname);
    return new Response(page, {
      status: version.status,
      headers: htmlHeaders(true),
    });
  }

  const content = await store.getContent(record.id, version);
  if (content === null) {
    return new Response(notFoundPage(hostname), {
      status: 404,
      headers: htmlHeaders(true),
    });
  }

  const url = artifactUrl(c, record.id);
  const ogImage = ogImageUrl(c, record.id);
  const brandUrl = c.env.BRAND_URL ?? null;

  if (content.encrypted !== null) {
    const page = unlockShell({
      title: record.title,
      description: record.description,
      favicon: record.favicon,
      format: record.format,
      url,
      ogImage,
      hostname,
      brandUrl,
      envelope: { ...content.encrypted, ciphertext: content.body },
    });
    return new Response(page, { headers: htmlHeaders(false) });
  }

  const page = wrapDocument({
    title: record.title,
    description: record.description,
    favicon: record.favicon,
    format: record.format,
    content: content.body,
    url,
    ogImage,
    hostname,
    brandUrl,
  });
  return new Response(page, { headers: htmlHeaders(true) });
});

// OpenGraph card image: a 1200x630 PNG rasterized from a self-contained card
// built from the artifact's title + description. Social crawlers ignore SVG
// og:image, so this returns PNG. It is fetched independently of the artifact
// page (not bound by the page CSP) and makes no external requests itself.
app.get("/og/:id", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) {
    return new Response("not found", { status: 404 });
  }
  let png: Uint8Array;
  try {
    png = await renderOgCardPng({
      title: record.title,
      description: record.description,
      hostname: new URL(c.req.url).hostname,
    });
  } catch (error) {
    // A failed rasterization must not surface Hono's HTML error page to a
    // crawler expecting an image; return a plain error the resets can retry.
    console.error("og render failed", error);
    return new Response("og render failed", { status: 500 });
  }
  return new Response(png, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
