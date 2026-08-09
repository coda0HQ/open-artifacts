import type { Context } from "hono";
import { Hono } from "hono";
import {
  createCloudflareArtifactStore,
  featureFlagsFromBindings,
} from "./adapters/cloudflare/composition";
import type { Authorizer } from "./authorizer";
import { validateVisibility } from "./authorizer";
import { resolveRuntimePolicy } from "./config";
import type { CreateInput } from "./domain";
import {
  MAX_COMMENT_BODY_BYTES,
  validateComment,
  validateCreate,
  validateUpdate,
} from "./domain";
import { broadcastVersionIfLive } from "./live-api";
import type { RequestContext } from "./request-context";
import type {
  ArtifactRecord,
  ArtifactStore,
  PublicationContext,
  PublicationResult,
  PublishedArtifact,
} from "./store";
import { IdempotencyConflictError } from "./store";
import type { MetricsDataset, Telemetry } from "./telemetry";
import {
  deriveWriteToken,
  generateId,
  generateWriteToken,
  looksLikeChannelToken,
  sha256Hex,
  timingSafeEqual,
} from "./tokens";
import { generateNonce, userContentHeaders } from "./wrap";

export type Bindings = Env & {
  ENVIRONMENT?: "development" | "test" | "preview" | "staging" | "production";
  IDEMPOTENCY_SECRET?: string;
  REPAIR_TOKEN?: string;
  PUBLIC_CREATE_MODE?: "disabled" | "token" | "open";
  ANONYMOUS_COMMENTS?: "disabled" | "enabled";
  RATE_LIMIT_MODE?: "local" | "cloudflare";
  RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
  QUOTA_STORAGE_BYTES?: string;
  QUOTA_VERSIONS?: string;
  QUOTA_COMMENTS?: string;
  QUOTA_HANDOFF_BYTES?: string;
  QUOTA_DAILY_WRITES?: string;
  QUOTA_LIVE_SESSIONS?: string;
  METRICS?: MetricsDataset;
  TELEMETRY_ENV?: "development" | "test" | "preview" | "staging" | "production";
  TELEMETRY_LOGS?: "enabled" | "disabled";
  CREATE_TOKEN?: string;
  BRAND_URL?: string;
  BRAND_NAME?: string;
  BRAND_WORDMARK?: string;
  BRAND_TAGLINE?: string;
  BRAND_DESCRIPTION?: string;
  BRAND_LEAD?: string;
  BRAND_CHIP?: string;
  PUBLIC_URL?: string;
  // "1" enables the opt-in web-font surface: the /fonts proxy plus a widened
  // font-src/style-src to the CDN allowlist. The sandbox stays opaque either
  // way — the opt-in never grants allow-same-origin (R1). Absent (or any other
  // value) keeps font-src data:-only.
  OPEN_ARTIFACTS_WEB_FONTS?: string;
  // Content cap in MiB. Unset keeps the deliberate 4 MiB free-tier default
  // (docs/architecture.md); a self-hoster on a paid plan raises it to publish
  // larger artifacts. See resolveMaxContentBytes for the parse/fallback rules.
  MAX_CONTENT_MIB?: string;
  // Live editing. Optional: a deploy opts in by binding a Durable
  // Object namespace named LIVE_DO whose class is the engine's LiveObject
  // (see src/live-do.ts). When unset, the /api/artifacts/:id/live* routes 404
  // and the host chrome renders no Live button — today's viewer is unchanged.
  LIVE_DO?: DurableObjectNamespace;
  // Handoff recording. Optional: a deploy opts in by setting this to "1". When
  // unset, the /api/artifacts/:id/handoffs* routes 404 and the host chrome
  // renders no Handoff button - the viewer is unchanged. No DO binding needed
  // (recording is host-side getUserMedia + R2 media/events); the flag only
  // gates the surface, mirroring OPEN_ARTIFACTS_WEB_FONTS.
  OPEN_ARTIFACTS_HANDOFF?: string;
  // Operational fail-safe controls. Remote configs pin each switch to "0";
  // setting one to "1" disables the named write surface without a code deploy.
  KILL_SWITCH_WRITES?: "0" | "1";
  KILL_SWITCH_LIVE?: "0" | "1";
  KILL_SWITCH_COMMENTS?: "0" | "1";
};
export type AppContext = {
  Bindings: Bindings;
  Variables: {
    authorizer: Authorizer;
    requestContext: RequestContext;
    telemetry: Telemetry;
  };
};

// The content cap defaults to 4 MiB — a deliberate free-tier envelope — and is
// overridable per instance via MAX_CONTENT_MIB. Unset, non-numeric, or <= 0
// falls back to 4 so the default stays byte-for-byte unchanged. Raising it far
// past a few MiB risks the Cloudflare Worker request-body / memory limit (the
// body is buffered by c.req.json() and held as a JS string), so a large cap is
// at the operator's own risk; keep this in lockstep with resolveMaxContentBytes
// in skills/using-open-artifacts/scripts/lib/limits.mjs.
export function resolveMaxContentBytes(env: Bindings): number {
  const raw = env.MAX_CONTENT_MIB ?? "";
  // Full-string digits only — parseInt("12abc") === 12 would silently raise
  // the cap contrary to the documented "non-numeric falls back" contract.
  if (!/^\d+$/.test(raw)) {
    return 4 * 1024 * 1024;
  }
  const mib = Number.parseInt(raw, 10);
  return (mib > 0 ? mib : 4) * 1024 * 1024;
}

// JSON escaping and encryption metadata inflate the body beyond the content
// cap; anything past this is rejected before parsing.
export const bodyCapFor = (maxContentBytes: number): number =>
  maxContentBytes * 1.5 + 16 * 1024;

export const storeFrom = (c: Context<AppContext>): ArtifactStore => {
  return createCloudflareArtifactStore(c.env, c.get("telemetry"));
};

// Canonical origin for every generated link. A non-empty PUBLIC_URL pins
// links to the SaaS domain no matter which host the request arrived on (so
// workers.dev fallbacks and crawlers still get the canonical URL); unset (or
// empty, matching the CREATE_TOKEN convention) links follow the request
// origin so self-hosted instances stay on their own domain. The trailing
// slash is trimmed so PUBLIC_URL="https://x/" never yields "//a/".
export const baseUrl = (c: Context<AppContext>): string =>
  (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/+$/, "");

export const artifactUrl = (c: Context<AppContext>, id: string): string =>
  `${baseUrl(c)}/a/${id}`;

export const ogImageUrl = (c: Context<AppContext>, id: string): string =>
  `${baseUrl(c)}/og/${id}`;

// WebSocket URL for the live channel on a given artifact. baseUrl is an
// absolute http(s) origin; swap the scheme to ws/wss for the WS upgrade route.
export const liveWsUrl = (c: Context<AppContext>, id: string): string =>
  `${baseUrl(c).replace(/^http/, "ws")}/api/artifacts/${id}/live`;

// Handoff recording is opt-in per deploy (OPEN_ARTIFACTS_HANDOFF=1). The host
// chrome inlines these same-origin URLs so the play UI can fetch media/events
// (connect-src 'self') and object-URL them into a <video> overlay.
export const handoffEnabled = (c: Context<AppContext>): boolean =>
  featureFlagsFromBindings(c.env).handoff;

function bearerToken(c: Context<AppContext>): string | null {
  const header = c.req.header("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export { bearerToken };

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

export function publicationContextFrom(
  c: Context<AppContext>,
  artifactId: string,
  operation: PublicationContext["operation"] = "update",
): PublicationContext | undefined {
  const key = c.req.header("idempotency-key");
  return key
    ? { actorScope: `artifact:${artifactId}`, idempotencyKey: key, operation }
    : undefined;
}

export function idempotencyKeyError(c: Context<AppContext>): Response | null {
  const key = c.req.header("idempotency-key");
  if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
    return c.json(
      {
        error:
          "Idempotency-Key must be 8-200 URL-safe characters (letters, digits, dot, underscore, colon, or hyphen)",
        code: "INVALID_IDEMPOTENCY_KEY",
      },
      400,
    );
  }
  return null;
}

type AuthResult =
  | { ok: true; record: ArtifactRecord }
  | { ok: false; response: Response };

export async function authorizeWrite(
  c: Context<AppContext>,
  store: ArtifactStore,
  id: string,
): Promise<AuthResult> {
  const record = await store.get(id);
  if (record === null) {
    return {
      ok: false,
      response: c.json({ error: "artifact not found" }, 404),
    };
  }

  const token = bearerToken(c);
  if (token !== null) {
    const tokenHash = await sha256Hex(token);
    const authorized = looksLikeChannelToken(token)
      ? record.channelHash !== null &&
        timingSafeEqual(tokenHash, record.channelHash)
      : store.isWriteCredentialAuthorized
        ? await store.isWriteCredentialAuthorized(record, tokenHash)
        : timingSafeEqual(tokenHash, record.tokenHash);
    if (authorized) {
      return { ok: true, record };
    }
  }

  if (await c.get("authorizer").authorizeWrite(c, record)) {
    return { ok: true, record };
  }

  if (token === null) {
    return {
      ok: false,
      response: c.json({ error: "missing bearer write token" }, 401),
    };
  }
  return {
    ok: false,
    response: c.json({ error: "invalid write token" }, 403),
  };
}

export function parseVersionParam(
  raw: string | undefined,
  currentVersion: number,
): number | { error: string; status: 400 | 404 } {
  if (raw === undefined) return currentVersion;
  if (!/^\d+$/.test(raw))
    return { error: "v must be a positive integer", status: 400 };
  const version = Number(raw);
  if (version < 1 || version > currentVersion) {
    return { error: "version not found", status: 404 };
  }
  return version;
}

export const api = new Hono<AppContext>();

// Publish a create payload as a new version of the channel's artifact. A
// channel publish carries no baseVersion, so losing the compare-and-swap only
// means another publish landed first — retry on a fresh snapshot instead of
// surfacing a 409 the caller can do nothing about.
async function publishToChannel(
  c: Context<AppContext>,
  store: ArtifactStore,
  record: ArtifactRecord,
  input: CreateInput,
  channel: string,
  publication?: PublicationContext,
): Promise<Response> {
  let snapshot: ArtifactRecord | null = record;
  let currentVersion = record.currentVersion;
  for (let attempt = 0; attempt < 3 && snapshot !== null; attempt += 1) {
    let result: PublicationResult;
    try {
      result = await store.update(
        snapshot,
        {
          content: input.content,
          format: input.format,
          title: input.title,
          description: input.description,
          favicon: input.favicon,
          label: input.label,
          encrypted: input.encrypted,
          baseVersion: null,
          force: false,
        },
        publication,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return c.json({ error: error.message, code: error.code }, 409);
      }
      throw error;
    }
    if (!("conflict" in result)) {
      await broadcastVersionIfLive(c, snapshot.id, result.version);
      return c.json({
        id: snapshot.id,
        url: artifactUrl(c, snapshot.id),
        version: result.version,
        publicationId: result.publicationId,
        idempotentReplay: result.replayed,
        channel,
      });
    }
    currentVersion = result.currentVersion;
    snapshot = await store.get(snapshot.id);
  }
  return c.json({ error: "version conflict", currentVersion }, 409);
}

const isChannelBindingConflict = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes("UNIQUE constraint failed") &&
  error.message.includes("channel_hash");

api.post("/artifacts", async (c) => {
  const invalidIdempotencyKey = idempotencyKeyError(c);
  if (invalidIdempotencyKey) return invalidIdempotencyKey;
  const maxContentBytes = resolveMaxContentBytes(c.env);
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > bodyCapFor(maxContentBytes)) {
    return c.json({ error: "request body too large" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  // Authorize after the body is buffered so SaaS authorizers can read
  // visibility/orgId from the same JSON the engine validates (Hono caches
  // c.req.json()). defaultAuthorizer still stamps public/anonymous ownership.
  const grant = await c.get("authorizer").authorizeCreate(c);
  if (!grant) return c.json({ error: "unauthorized" }, 401);

  const parsed = validateCreate(body, maxContentBytes);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const store = storeFrom(c);

  // Channel binding: a POST carrying a channel token (ch_) targets the
  // artifact already bound to that channel — creating a new version at the
  // same URL instead of minting a new artifact. First use of a channel
  // creates the artifact and binds the channel to it, so every future POST
  // with the same channel lands on the same link.
  const channelRaw = typeof body.channel === "string" ? body.channel : null;
  if (channelRaw !== null && !looksLikeChannelToken(channelRaw)) {
    return c.json({ error: "channel must be a channel token (ch_...)" }, 400);
  }

  const channelHash = channelRaw !== null ? await sha256Hex(channelRaw) : null;
  const idempotencyKey = c.req.header("idempotency-key");
  const createPublication: PublicationContext | undefined = idempotencyKey
    ? {
        actorScope:
          channelHash !== null
            ? `channel:${channelHash}`
            : `create:${grant.ownerId || "open-instance"}`,
        idempotencyKey,
        operation: channelHash !== null ? "channel" : "create",
      }
    : undefined;
  if (channelRaw !== null && channelHash !== null) {
    const existing = await store.findByChannel(channelHash);
    if (existing !== null) {
      return publishToChannel(
        c,
        store,
        existing,
        parsed.value,
        channelRaw,
        createPublication,
      );
    }
  }

  const id = generateId();
  const idempotencySecret = c.env.IDEMPOTENCY_SECRET;
  if (createPublication && !idempotencySecret) {
    return c.json(
      {
        error:
          "IDEMPOTENCY_SECRET must be configured before idempotent creation is enabled",
        code: "IDEMPOTENCY_SECRET_MISSING",
      },
      503,
    );
  }
  let writeToken = generateWriteToken();
  if (createPublication) {
    if (!idempotencySecret) {
      throw new Error("idempotency secret guard was bypassed");
    }
    writeToken = await deriveWriteToken(
      idempotencySecret,
      createPublication.actorScope,
      createPublication.idempotencyKey,
    );
  }
  let created: PublishedArtifact;
  try {
    created = await store.create(
      id,
      await sha256Hex(writeToken),
      parsed.value,
      channelHash,
      grant,
      createPublication,
    );
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    // Two concurrent first publishes to one channel: the unique index lets
    // exactly one create win; the loser lands here and becomes a version
    // update on the winner's artifact, keeping the channel's URL stable.
    if (channelRaw === null || channelHash === null) throw error;
    if (!isChannelBindingConflict(error)) throw error;
    const winner = await store.findByChannel(channelHash);
    if (winner === null) throw error;
    return publishToChannel(
      c,
      store,
      winner,
      parsed.value,
      channelRaw,
      createPublication,
    );
  }

  // Indirect access so TS does not statically resolve the check to always-true
  // when the deploy's generated Env types LIVE_DO as required (coda0). The
  // engine itself declares LIVE_DO optional — a self-host without the binding
  // reports liveSupported false and the CLI skips the watcher tip.
  const liveSupported = Boolean(
    (c.env as unknown as Record<string, unknown>).LIVE_DO,
  );
  return c.json(
    {
      id: created.id,
      url: artifactUrl(c, created.id),
      writeToken,
      version: 1,
      publicationId: created.publication.publicationId,
      idempotentReplay: created.publication.replayed,
      liveSupported,
      ...(channelRaw ? { channel: channelRaw } : {}),
    },
    201,
  );
});

api.put("/artifacts/:id", async (c) => {
  const invalidIdempotencyKey = idempotencyKeyError(c);
  if (invalidIdempotencyKey) return invalidIdempotencyKey;
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;

  // Same pre-parse body cap as POST: reject an oversized declared body before
  // c.req.json() buffers it into worker memory. PUT lacked this guard, so an
  // over-cap update was only caught after the whole body was parsed.
  const maxContentBytes = resolveMaxContentBytes(c.env);
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > bodyCapFor(maxContentBytes)) {
    return c.json({ error: "request body too large" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const parsed = validateUpdate(body, maxContentBytes);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  let result: PublicationResult;
  try {
    result = await store.update(
      auth.record,
      parsed.value,
      publicationContextFrom(c, auth.record.id),
    );
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }
  if ("conflict" in result) {
    return c.json(
      {
        error: `version conflict: artifact is at version ${result.currentVersion}`,
        currentVersion: result.currentVersion,
      },
      409,
    );
  }
  // Tell staying viewers a new version landed so the host reloads in place.
  // No-ops when the deploy did not bind LIVE_DO.
  await broadcastVersionIfLive(c, auth.record.id, result.version);
  return c.json({
    id: auth.record.id,
    url: artifactUrl(c, auth.record.id),
    version: result.version,
    publicationId: result.publicationId,
    idempotentReplay: result.replayed,
  });
});

api.delete("/artifacts/:id", async (c) => {
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  await store.delete(auth.record.id);
  return c.json({ ok: true });
});

api.get("/artifacts/:id", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) return c.json({ error: "artifact not found" }, 404);
  if (!(await c.get("authorizer").authorizeView(c, record))) {
    return c.json({ error: "artifact not found" }, 404);
  }
  const versions = await store.listVersions(record.id);
  return c.json({
    id: record.id,
    url: artifactUrl(c, record.id),
    title: record.title,
    description: record.description,
    favicon: record.favicon,
    format: record.format,
    encrypted: record.encrypted,
    version: record.currentVersion,
    versions,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
});

api.get("/artifacts/:id/raw", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) return c.json({ error: "artifact not found" }, 404);
  if (!(await c.get("authorizer").authorizeView(c, record))) {
    return c.json({ error: "artifact not found" }, 404);
  }

  const version = parseVersionParam(c.req.query("v"), record.currentVersion);
  if (typeof version !== "number") {
    return c.json({ error: version.error }, version.status);
  }

  const content = await store.getContent(record.id, version);
  if (content === null) return c.json({ error: "content not found" }, 404);

  if (content.encrypted !== null) {
    const headers = userContentHeaders({
      sandbox: true,
      contentType: "application/json",
      nonce: generateNonce(),
    });
    return new Response(
      JSON.stringify({
        alg: "AES-GCM",
        kdf: "PBKDF2-SHA256",
        iterations: content.encrypted.iterations,
        salt: content.encrypted.salt,
        iv: content.encrypted.iv,
        ciphertext: content.body,
      }),
      { headers },
    );
  }

  const headers = userContentHeaders({
    sandbox: true,
    contentType: "text/plain; charset=utf-8",
    nonce: generateNonce(),
  });
  return new Response(content.body, { headers });
});

// Comment thread on an artifact. The thread lives in the surrounding chrome
// (not the sandboxed iframe body), so the host page POSTs and renders the list.
// Phase 1: posting is open (not token-gated) and reads are open — the issue
// lists the auth model as an open question. A persisted comment reaches every
// future viewer because the host fetches the thread on page load. Live
// (no-reload) fan-out across concurrent viewers is Phase 2 (Durable Object).
// Headroom over the body cap for everything else a comment may legitimately
// carry: an anchor (≤2 KiB), an author (≤200 chars), and JSON braces/escaping.
// Too tight and a comment validateComment would accept is 413'd before it is
// read; validateComment stays the authoritative per-field gate.
const COMMENT_BODY_BYTES = MAX_COMMENT_BODY_BYTES + 4 * 1024;

api.get("/artifacts/:id/comments", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) return c.json({ error: "artifact not found" }, 404);
  if (!(await c.get("authorizer").authorizeView(c, record))) {
    return c.json({ error: "artifact not found" }, 404);
  }
  const comments = await store.listComments(record.id);
  return c.json({ comments });
});

api.post("/artifacts/:id/comments", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) return c.json({ error: "artifact not found" }, 404);
  if (!(await c.get("authorizer").authorizeView(c, record))) {
    return c.json({ error: "artifact not found" }, 404);
  }
  if (!resolveRuntimePolicy(c.env).anonymousComments) {
    const auth = await authorizeWrite(c, store, record.id);
    if (!auth.ok) {
      return c.json(
        {
          error: "anonymous comments are disabled",
          code: "ANONYMOUS_COMMENTS_DISABLED",
        },
        403,
      );
    }
  }

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > COMMENT_BODY_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const parsed = validateComment(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  // Stamp/clamp anchorVersion to the artifact's version space so a client
  // cannot forge a future version that hides markers for every real viewer
  // (anchorVersion > viewedVersion filters them out). Keep an in-range claim;
  // otherwise stamp currentVersion.
  //
  // The raw body is consulted because validateAnchor fills a missing
  // anchorVersion with a placeholder the domain layer cannot know is right —
  // it has no artifact. Trusting that value would record every version-less
  // API post as v1: a false drift tag, and a marker on versions where the
  // comment never existed.
  //
  // This runs before the encryption guard below because the guard must check
  // the version the anchor actually lands on — the stamped value, not the raw
  // claim — so a forged out-of-range anchorVersion cannot route around it.
  let input = parsed.value;
  if (input.anchor) {
    const rawAnchor = body.anchor as Record<string, unknown> | null | undefined;
    const claimed = input.anchor.anchorVersion;
    const stamped =
      typeof rawAnchor?.anchorVersion === "number" &&
      claimed <= record.currentVersion
        ? claimed
        : record.currentVersion;
    input = {
      ...input,
      anchor: { ...input.anchor, anchorVersion: stamped },
    };
  }

  // A text anchor stores a verbatim quote of the artifact body. On an encrypted
  // version the server never holds plaintext, so accepting one would copy
  // plaintext into D1 and break the zero-knowledge guarantee. Point anchors
  // (world coordinates) and unanchored comments leak nothing and are allowed.
  //
  // Check the ANCHORED version's own encryption state, not record.encrypted:
  // that flag is artifact-level (the current version), so on a mixed-encryption
  // artifact — v1 encrypted, v2 plaintext — it reads plaintext and would wave
  // through a quote of v1's still-secret body. getContentMeta reads the R2
  // object's per-version flag, the authoritative source /raw and the viewer
  // already use. A missing version fails closed (treated as encrypted).
  if (input.anchor?.mode === "text") {
    const meta = await store.getContentMeta(
      record.id,
      input.anchor.anchorVersion,
    );
    if (meta === null || meta.encrypted) {
      return c.json(
        { error: "text anchors are not allowed on encrypted artifacts" },
        400,
      );
    }
  }

  // Per-comment delete token, mirroring the artifact write-token idiom: only the
  // SHA-256 hash is stored; the plaintext is returned once so the poster can
  // delete their own comment later.
  const deleteToken = generateWriteToken();
  const comment = await store.addComment(
    record.id,
    input,
    await sha256Hex(deleteToken),
  );
  return c.json({ ...comment, deleteToken }, 201);
});

// Authorizes a mutation of an existing comment: the comment's own delete token
// (the author, from this browser) or the artifact's write/channel token (owner
// moderation). Legacy Phase-1 rows have a null delete-token hash and so are
// owner-only. Shared by PATCH and DELETE — resolving a comment hides it from
// the drawer's default view, so it is gated exactly like removing it.
async function authorizeCommentMutation(
  c: Context<AppContext>,
  store: ArtifactStore,
  artifactId: string,
  deleteTokenHash: string | null,
): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
  const token = bearerToken(c);
  if (token === null) {
    return { ok: false, status: 401, error: "missing bearer token" };
  }
  const tokenHash = await sha256Hex(token);
  const authorMatch =
    deleteTokenHash !== null && timingSafeEqual(tokenHash, deleteTokenHash);
  if (authorMatch) return { ok: true };
  if ((await authorizeWrite(c, store, artifactId)).ok) return { ok: true };
  return { ok: false, status: 403, error: "not authorized for this comment" };
}

// Mark done / undone. Not open like create: done removes a comment from the
// drawer's default "open" view, so an unauthenticated toggle would let any
// passer-by silently suppress a whole thread.
api.patch("/artifacts/:id/comments/:commentId", async (c) => {
  const store = storeFrom(c);
  const id = c.req.param("id");
  const commentId = c.req.param("commentId");

  const comment = await store.getComment(commentId);
  if (comment === null || comment.artifactId !== id) {
    return c.json({ error: "comment not found" }, 404);
  }

  const auth = await authorizeCommentMutation(
    c,
    store,
    id,
    comment.deleteTokenHash,
  );
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }
  if (typeof body.done !== "boolean") {
    return c.json({ error: "done must be a boolean" }, 400);
  }

  const ok = await store.setCommentDone(commentId, body.done);
  if (!ok) return c.json({ error: "comment not found" }, 404);
  return c.json({ ok: true, done: body.done });
});

api.delete("/artifacts/:id/comments/:commentId", async (c) => {
  const store = storeFrom(c);
  const id = c.req.param("id");
  const commentId = c.req.param("commentId");

  const comment = await store.getComment(commentId);
  if (comment === null || comment.artifactId !== id) {
    return c.json({ error: "comment not found" }, 404);
  }

  const auth = await authorizeCommentMutation(
    c,
    store,
    id,
    comment.deleteTokenHash,
  );
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  await store.deleteComment(commentId);
  return c.json({ ok: true });
});

api.patch("/artifacts/:id", async (c) => {
  const store = storeFrom(c);
  const id = c.req.param("id");
  const record = await store.get(id);
  // Collapse missing and not-manageable to the same 404 so PATCH cannot
  // probe private artifact existence (matches GET/raw/frame unauthorized).
  if (record === null || !(await c.get("authorizer").canManage(c, record))) {
    return c.json({ error: "artifact not found" }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const v = validateVisibility(body.visibility);
  if (!v) {
    return c.json({ error: "visibility must be private, org, or public" }, 400);
  }

  await store.updateVisibility(id, v);
  return c.json({ id, visibility: v });
});
