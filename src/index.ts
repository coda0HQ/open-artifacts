import { Hono } from "hono";
import type { AppContext } from "./api";
import {
  api,
  artifactUrl,
  ogImageUrl,
  parseVersionParam,
  storeFrom,
} from "./api";
import { fontFaceCss, materializeFont, parseSlug } from "./fonts";
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

// Opt-in same-origin web-font surface (env flag OPEN_ARTIFACTS_WEB_FONTS="1").
// Artifacts name a Fontshare family by slug `<family>--<weight>[--italic]`;
// the Worker materializes the .woff2 from Fontshare into R2 and serves it
// same-origin so no third-party host appears in the artifact CSP. The `.css`
// shim emits a derived @font-face so authors only write one <link>. Off by
// default — a non-opt-in deploy 404s both routes, preserving the strict CSP.
const WEB_FONT_CACHE_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
} as const;

app.get("/fonts/:slug{[a-z0-9-]+\\.(?:woff2|css)}", async (c) => {
  if (c.env.OPEN_ARTIFACTS_WEB_FONTS !== "1") {
    return new Response("not found", { status: 404 });
  }
  const raw = c.req.param("slug") ?? "";
  if (raw.endsWith(".css")) {
    const slug = raw.slice(0, -".css".length);
    const css = fontFaceCss(slug);
    if (css === null) {
      return new Response("not found", { status: 404 });
    }
    return new Response(css, {
      headers: {
        "content-type": "text/css; charset=utf-8",
        ...WEB_FONT_CACHE_HEADERS,
      },
    });
  }
  const slug = raw.slice(0, -".woff2".length);
  if (parseSlug(slug) === null) {
    return new Response("not found", { status: 404 });
  }
  const bytes = await materializeFont(slug, c.env);
  if (bytes === null) {
    return new Response("not found", { status: 404 });
  }
  return new Response(bytes, {
    headers: {
      "content-type": "font/woff2",
      ...WEB_FONT_CACHE_HEADERS,
    },
  });
});

app.get("/a/:id", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  const hostname = new URL(c.req.url).hostname;
  const webFonts = c.env.OPEN_ARTIFACTS_WEB_FONTS === "1";
  const htmlHeaders = (sandbox: boolean) =>
    userContentHeaders({
      sandbox,
      contentType: "text/html; charset=utf-8",
      webFonts,
    });

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
  // Inline the comment thread at serve time: the viewer page is sandboxed with
  // connect-src 'none', so runtime fetch is impossible. Future viewers still
  // see the persisted thread because it is stamped into the HTML here.
  const comments =
    content.encrypted === null ? await store.listComments(record.id) : [];

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
      webFonts,
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
    artifactId: record.id,
    comments,
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
    // crawler expecting an image; return a plain error the requester can retry.
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
