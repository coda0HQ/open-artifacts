import { Hono } from "hono";
import type { AppContext } from "./api";
import { api, parseVersionParam, storeFrom } from "./api";
import {
  badVersionPage,
  notFoundPage,
  ogCardSvg,
  unlockShell,
  userContentHeaders,
  wrapDocument,
} from "./wrap";

const app = new Hono<AppContext>();

app.route("/api", api);

const artifactUrl = (c: { req: { url: string } }, id: string): string =>
  `${new URL(c.req.url).origin}/a/${id}`;

const ogImageUrl = (c: { req: { url: string } }, id: string): string =>
  `${new URL(c.req.url).origin}/og/${id}`;

app.get("/a/:id", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  const htmlHeaders = (sandbox: boolean) =>
    userContentHeaders({ sandbox, contentType: "text/html; charset=utf-8" });

  if (record === null) {
    return new Response(notFoundPage(), {
      status: 404,
      headers: htmlHeaders(true),
    });
  }

  const version = parseVersionParam(c.req.query("v"), record.currentVersion);
  if (typeof version !== "number") {
    const page = version.status === 400 ? badVersionPage() : notFoundPage();
    return new Response(page, {
      status: version.status,
      headers: htmlHeaders(true),
    });
  }

  const content = await store.getContent(record.id, version);
  if (content === null) {
    return new Response(notFoundPage(), {
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
    brandUrl,
  });
  return new Response(page, { headers: htmlHeaders(true) });
});

// OpenGraph card image: a self-contained SVG built from the artifact's
// favicon + title + description. Social crawlers fetch this URL independently
// of the artifact page, so it is not bound by the page CSP — but it makes no
// external requests itself.
app.get("/og/:id", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) {
    return new Response("not found", { status: 404 });
  }
  const svg = ogCardSvg({
    title: record.title,
    favicon: record.favicon,
    description: record.description,
  });
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=300",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
