import { Hono } from "hono";
import {
  killSwitchesFromBindings,
  validateCloudflareComposition,
} from "./adapters/cloudflare/composition";
import {
  type AppContext,
  api,
  artifactUrl,
  handoffEnabled,
  liveWsUrl,
  ogImageUrl,
  parseVersionParam,
  storeFrom,
} from "./api";
import { credentialsApi } from "./api/credentials";
import type { Authorizer } from "./authorizer";
import { defaultAuthorizer } from "./authorizer";
import { RuntimeConfigError } from "./config";
import type { VersionMeta } from "./domain";
import { fontFaceCss, materializeFont, parseSlug } from "./fonts";
import { handoffApi } from "./handoff-api";
import { brandFor, brandHomepage, hasBrandConfig } from "./home";
import { liveApi } from "./live-api";
import { renderOgCardPng } from "./og";
import {
  negotiateProtocolVersion,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  protocolUpgradeBody,
} from "./protocol";
import { QuotaExceededError } from "./quota/service";
import { enforceRateLimit } from "./rate-limit";
import { reconcileApi } from "./reconcile-api";
import { createRequestContext } from "./request-context";
import type { ArtifactRecord, ArtifactStore } from "./store";
import { Telemetry } from "./telemetry";
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

  app.onError((error, c) => {
    const telemetry = c.get("telemetry");
    if (error instanceof QuotaExceededError) {
      telemetry?.warn("quota.exhausted", {
        resource: error.resource,
        usage: error.usage,
        limit: error.limit,
      });
      telemetry?.metric("quota_exhausted", {
        value: 1,
        route: telemetry.context.route,
        operation: "other",
        result: "exhausted",
        status: 429,
      });
      return c.json(
        {
          error: "quota exceeded",
          code: error.code,
          resource: error.resource,
          usage: error.usage,
          limit: error.limit,
        },
        429,
      );
    }
    telemetry?.error("request.unhandled_error", { error });
    if (error.name === "SchemaCompatibilityError") {
      telemetry?.metric("migration_incompatible", {
        value: 1,
        route: telemetry.context.route,
        operation: "d1",
        result: "failure",
        status: 503,
      });
    }
    return c.json({ error: "internal server error" }, 500);
  });

  app.use("*", async (c, next) => {
    const requestContext = await createRequestContext(c.req.raw);
    const telemetry = new Telemetry(
      requestContext,
      c.env.TELEMETRY_ENV ?? c.env.ENVIRONMENT ?? "production",
      c.env.METRICS,
      c.env.TELEMETRY_LOGS === "disabled" ||
        (c.env.ENVIRONMENT === "test" && c.env.TELEMETRY_LOGS !== "enabled")
        ? () => {}
        : undefined,
    );
    c.set("authorizer", authorizer);
    c.set("requestContext", requestContext);
    c.set("telemetry", telemetry);
    const startedAt = Date.now();
    let failed = false;
    telemetry.info("request.started");
    try {
      await next();
    } catch (error) {
      failed = true;
      telemetry.error("request.failed", { error });
      throw error;
    } finally {
      const status = failed ? 500 : c.res.status;
      const result =
        status === 409
          ? "conflict"
          : status >= 500
            ? "failure"
            : status >= 400
              ? "other"
              : "success";
      const durationMs = Date.now() - startedAt;
      telemetry.info("request.completed", { status, result, durationMs });
      telemetry.metric("http_request", {
        value: 1,
        durationMs,
        route: requestContext.route,
        operation: "other",
        result,
        status,
      });
      if (status === 401 || status === 403) {
        telemetry.metric("auth_failure", {
          value: 1,
          route: requestContext.route,
          operation: "other",
          result: "failure",
          status,
        });
      }
      if (
        requestContext.route === "live_connect" ||
        requestContext.route === "live_draft" ||
        requestContext.route === "live_coordination" ||
        requestContext.route === "checkpoint" ||
        requestContext.route === "rollback"
      ) {
        telemetry.metric("live_operation", {
          value: 1,
          durationMs,
          route: requestContext.route,
          operation:
            requestContext.route === "live_draft"
              ? "draft_save"
              : requestContext.route === "live_connect"
                ? "live_connect"
                : requestContext.route === "checkpoint"
                  ? "checkpoint"
                  : requestContext.route === "rollback"
                    ? "rollback"
                    : "other",
          result,
          status,
        });
      }
      try {
        c.header("X-Request-Id", requestContext.requestId);
      } catch {
        // A WebSocket upgrade can expose immutable response headers. Logging
        // must never turn a successful upgrade into a failed request.
      }
    }
  });

  app.get("/health/live", (c) => c.json({ status: "live" }));
  app.get("/health/ready", async (c) => {
    try {
      validateCloudflareComposition(c.env);
      await storeFrom(c).get("__readiness_schema_probe__");
      return c.json({ status: "ready" });
    } catch (error) {
      c.get("telemetry").warn("readiness.failed", { error });
      if (error instanceof Error && error.name === "SchemaCompatibilityError") {
        c.get("telemetry").metric("migration_incompatible", {
          value: 1,
          route: "health",
          operation: "d1",
          result: "failure",
          status: 503,
        });
      }
      return c.json(
        {
          status: "not_ready",
          code:
            error instanceof RuntimeConfigError
              ? error.code
              : "SCHEMA_OR_BINDING_NOT_READY",
        },
        503,
      );
    }
  });

  app.use("/api/*", async (c, next) => {
    const negotiation = negotiateProtocolVersion(c.req.header(PROTOCOL_HEADER));
    c.header(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    if (!negotiation.ok) {
      return c.json(protocolUpgradeBody(negotiation.requestedVersion), 426);
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const switches = killSwitchesFromBindings(c.env);
    const path = new URL(c.req.url).pathname;
    const method = c.req.method.toUpperCase();
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(method);
    const activeFlag =
      isWrite && /\/live(?:\/|$)/.test(path) && switches.live
        ? "KILL_SWITCH_LIVE"
        : isWrite && /\/comments(?:\/|$)/.test(path) && switches.comments
          ? "KILL_SWITCH_COMMENTS"
          : isWrite && switches.writes
            ? "KILL_SWITCH_WRITES"
            : null;
    if (activeFlag) {
      c.get("telemetry").warn("kill_switch.blocked", { flag: activeFlag });
      return c.json(
        {
          error: "this write surface is temporarily disabled",
          code: "FEATURE_KILL_SWITCH_ACTIVE",
          flag: activeFlag,
        },
        503,
      );
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    try {
      validateCloudflareComposition(c.env);
    } catch (error) {
      if (error instanceof RuntimeConfigError) {
        c.get("telemetry").warn("runtime_config.invalid", {
          issueCount: error.issues.length,
        });
        return c.json({ error: "service is not ready", code: error.code }, 503);
      }
      throw error;
    }
    const limited = await enforceRateLimit(c);
    if (limited) return limited;
    await next();
  });

  // Live edit routes (WS upgrade + agent poll/reply). 404 when the
  // deploy did not bind LIVE_DO; otherwise self-contained under /api/artifacts/:id/live*.
  app.route("/api", liveApi);
  // Handoff recording routes (list/create/media/events/delete). 404 when the
  // deploy did not set OPEN_ARTIFACTS_HANDOFF=1; otherwise under /api/artifacts/:id/handoffs*.
  app.route("/api", handoffApi);
  app.route("/api", credentialsApi);
  app.route("/api", reconcileApi);
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

  // Self-hosted MediaPipe Selfie Segmentation assets for the handoff webcam
  // portrait-blur (scripts/vendor-mediapipe.mjs -> public/vendor/mediapipe/*).
  // Served same-origin so the host CSP (script-src 'self', connect-src 'self')
  // covers the JS + WASM loads with no CDN allowlist. The .wasm needs
  // application/wasm + nosniff or the browser refuses to instantiate it.
  app.get("/vendor/mediapipe/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    const asset = await c.env.ASSETS.fetch(
      new Request(`${new URL(c.req.url).origin}${path}`),
    );
    if (!asset.ok) {
      return new Response("not found", { status: 404 });
    }
    const mime = path.endsWith(".wasm")
      ? "application/wasm"
      : path.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : path.endsWith(".data")
          ? "application/octet-stream"
          : path.endsWith(".tflite")
            ? "application/octet-stream"
            : path.endsWith(".binarypb")
              ? "application/octet-stream"
              : "application/octet-stream";
    return new Response(asset.body, {
      headers: {
        "content-type": mime,
        "cache-control":
          "public, max-age=86400, must-revalidate, stale-while-revalidate=604800",
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
      liveEnabled: c.env.LIVE_DO !== undefined,
      liveWsUrl: liveWsUrl(c, record.id),
      handoffEnabled: handoffEnabled(c),
      handoffs: handoffEnabled(c) ? await store.listHandoffs(record.id) : [],
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
      title: record.title,
      nonce,
      handoffEnabled: handoffEnabled(c),
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
      c.get("telemetry").error("og.render_failed", { error });
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
