import { Hono } from "hono";
import {
  type AppContext,
  api,
  artifactUrl,
  ogImageUrl,
  parseVersionParam,
  storeFrom,
} from "./api";
import type { Authorizer } from "./authorizer";
import { defaultAuthorizer } from "./authorizer";
import type { VersionMeta } from "./domain";
import { fontFaceCss, materializeFont, parseSlug } from "./fonts";
import { brandFor, brandHomepage, hasBrandConfig } from "./home";
import { renderOgCardPng } from "./og";
import type { ArtifactRecord, ArtifactStore } from "./store";
import {
  badVersionPage,
  frameDocument,
  generateNonce,
  hostHeaders,
  hostShell,
  notFoundPage,
  signInToViewPage,
  unlockShell,
  userContentHeaders,
} from "./wrap";

// Content-less resolve for the host page: the host never renders the
// artifact body (the frame sub-route does, and reads it once itself after
// authorizeView), so pulling the ≤4 MiB body into worker memory here only
// to drop it would double the storage read on every plain-artifact view.
// The host needs only the per-version encrypted flag to pick the unlock
// shell vs the frame shell.
type ResolvedRecord =
  | {
      ok: true;
      record: ArtifactRecord;
      version: number;
      encrypted: boolean;
      versions: VersionMeta[];
    }
  | { ok: false; status: 400 | 404; badVersion: boolean };

async function resolveRecord(
  store: ArtifactStore,
  id: string,
  rawVersion: string | undefined,
): Promise<ResolvedRecord> {
  const record = await store.get(id);
  if (record === null) return { ok: false, status: 404, badVersion: false };

  const version = parseVersionParam(rawVersion, record.currentVersion);
  if (typeof version !== "number") {
    return {
      ok: false,
      status: version.status,
      badVersion: version.status === 400,
    };
  }

  const versions = await store.listVersions(record.id);
  const viewed = versions.find((v) => v.version === version);
  if (viewed === undefined) {
    return { ok: false, status: 404, badVersion: false };
  }
  const meta = await store.getContentMeta(record.id, version);
  if (meta === null) {
    return { ok: false, status: 404, badVersion: false };
  }
  return {
    ok: true,
    record,
    version,
    encrypted: meta.encrypted,
    versions,
  };
}

const WEB_FONT_CACHE_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
} as const;

export function createApp(
  authorizer: Authorizer = defaultAuthorizer,
): Hono<AppContext> {
  const app = new Hono<AppContext>();

  app.use("*", async (c, next) => {
    c.set("authorizer", authorizer);
    await next();
  });

  app.route("/api", api);

  app.get("/", async (c) => {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (!hasBrandConfig(c.env)) return asset;
    if (!(asset.headers.get("content-type") ?? "").includes("text/html"))
      return asset;
    return brandHomepage(asset, c.env);
  });

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

  app.get("/vendor/mermaid.runtime.js", async (c) => {
    const asset = await c.env.ASSETS.fetch(
      new Request(`${new URL(c.req.url).origin}/vendor/mermaid.runtime.js`),
    );
    if (!asset.ok) {
      return new Response("not found", { status: 404 });
    }
    return new Response(asset.body, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control":
          "public, max-age=3600, must-revalidate, stale-while-revalidate=86400",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.get("/a/:id", async (c) => {
    const store = storeFrom(c);
    const brand = brandFor(c.env);
    const branded = hasBrandConfig(c.env);
    const rawVersion = c.req.query("v");
    const nonce = generateNonce();
    const resolved = await resolveRecord(store, c.req.param("id"), rawVersion);

    if (!resolved.ok) {
      const page = resolved.badVersion
        ? badVersionPage(brand)
        : notFoundPage(brand);
      return new Response(page, {
        status: resolved.status,
        headers: hostHeaders(nonce),
      });
    }

    if (!(await c.get("authorizer").authorizeView(c, resolved.record))) {
      return new Response(signInToViewPage(brand), {
        status: 401,
        headers: hostHeaders(nonce),
      });
    }

    const { record, version, encrypted, versions } = resolved;
    const authorizer = c.get("authorizer");
    const canManage = await authorizer.canManage(c, record);
    const url = artifactUrl(c, record.id);
    const ogImage = ogImageUrl(c, record.id);
    const brandUrl = c.env.BRAND_URL ?? null;
    const comments = await store.listComments(record.id);
    const frameSrc = `/a/${record.id}/frame${rawVersion !== undefined ? `?v=${encodeURIComponent(rawVersion)}` : ""}`;

    if (encrypted) {
      const content = await store.getContent(record.id, version);
      if (content === null || content.encrypted === null) {
        return new Response(notFoundPage(brand), {
          status: 404,
          headers: hostHeaders(nonce),
        });
      }
      const page = unlockShell({
        title: record.title,
        description: record.description,
        favicon: record.favicon,
        format: record.format,
        url,
        ogImage,
        brand,
        branded,
        brandUrl,
        artifactId: record.id,
        comments,
        envelope: { ...content.encrypted, ciphertext: content.body },
        nonce,
        versions,
        currentVersion: version,
        canManage,
        visibility: record.visibility,
      });
      return new Response(page, { headers: hostHeaders(nonce) });
    }

    const page = hostShell({
      title: record.title,
      description: record.description,
      favicon: record.favicon,
      url,
      ogImage,
      brand,
      branded,
      brandUrl,
      artifactId: record.id,
      comments,
      frameSrc,
      nonce,
      versions,
      currentVersion: version,
      canManage,
      visibility: record.visibility,
    });
    return new Response(page, { headers: hostHeaders(nonce) });
  });

  app.get("/a/:id/frame", async (c) => {
    // Mirror /raw: authorize before reading body so private denials never
    // touch R2 content (resolve-then-auth would still load ciphertext).
    const store = storeFrom(c);
    const webFonts = c.env.OPEN_ARTIFACTS_WEB_FONTS === "1";
    const nonce = generateNonce();
    const record = await store.get(c.req.param("id"));
    if (record === null) {
      return new Response("not found", { status: 404 });
    }
    if (!(await c.get("authorizer").authorizeView(c, record))) {
      return new Response("not found", { status: 404 });
    }

    const version = parseVersionParam(c.req.query("v"), record.currentVersion);
    if (typeof version !== "number") {
      return new Response("not found", { status: version.status });
    }

    const content = await store.getContent(record.id, version);
    if (content === null || content.encrypted !== null) {
      return new Response("not found", { status: 404 });
    }

    const page = frameDocument({
      format: record.format,
      content: content.body,
      nonce,
    });
    return new Response(page, {
      headers: userContentHeaders({
        sandbox: true,
        contentType: "text/html; charset=utf-8",
        webFonts,
        nonce,
        origin: new URL(c.req.url).origin,
      }),
    });
  });

  app.get("/og/:id", async (c) => {
    const store = storeFrom(c);
    const brand = brandFor(c.env);
    const record = await store.get(c.req.param("id"));
    if (record === null) {
      return new Response("not found", { status: 404 });
    }
    // Collapse a denied view to the same 404 as a missing artifact so /og
    // cannot confirm a private artifact's existence (matches /raw, /frame,
    // and the host route). The isPublic gate below still holds: even an
    // authorized non-public view renders a brand-only card, so a private
    // title never lands in the shared OG cache.
    if (!(await c.get("authorizer").authorizeView(c, record))) {
      return new Response("not found", { status: 404 });
    }
    let png: Uint8Array;
    try {
      const isPublic = record.visibility === "public";
      png = await renderOgCardPng({
        title: isPublic ? record.title : brand.name,
        description: isPublic ? record.description : "",
        brand,
      });
    } catch (error) {
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

  return app;
}
