import type { Context } from "hono";
import { Hono } from "hono";
import type { CreateInput } from "./domain";
import {
  MAX_COMMENT_BODY_BYTES,
  validateComment,
  validateCreate,
  validateUpdate,
} from "./domain";
import type { ArtifactRecord, ArtifactStore } from "./store";
import { D1R2Store } from "./store";
import {
  generateId,
  generateWriteToken,
  looksLikeChannelToken,
  sha256Hex,
  timingSafeEqual,
} from "./tokens";
import { generateNonce, userContentHeaders } from "./wrap";

export type Bindings = Env & {
  CREATE_TOKEN?: string;
  BRAND_URL?: string;
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
};
export type AppContext = { Bindings: Bindings };

// The content cap defaults to 4 MiB — a deliberate free-tier envelope — and is
// overridable per instance via MAX_CONTENT_MIB. Unset, non-numeric, or <= 0
// falls back to 4 so the default stays byte-for-byte unchanged. Raising it far
// past a few MiB risks the Cloudflare Worker request-body / memory limit (the
// body is buffered by c.req.json() and held as a JS string), so a large cap is
// at the operator's own risk; keep this in lockstep with resolveMaxContentBytes
// in skills/using-open-artifacts/scripts/lib/limits.mjs.
export function resolveMaxContentBytes(env: Bindings): number {
  const mib = Number.parseInt(env.MAX_CONTENT_MIB ?? "", 10);
  return (mib > 0 ? mib : 4) * 1024 * 1024;
}

// JSON escaping and encryption metadata inflate the body beyond the content
// cap; anything past this is rejected before parsing.
const bodyCapFor = (maxContentBytes: number): number =>
  maxContentBytes * 1.5 + 16 * 1024;

export const storeFrom = (c: Context<AppContext>): ArtifactStore =>
  new D1R2Store(c.env.DB, c.env.CONTENT);

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

function bearerToken(c: Context<AppContext>): string | null {
  const header = c.req.header("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

type AuthResult =
  | { ok: true; record: ArtifactRecord }
  | { ok: false; response: Response };

async function authorizeWrite(
  c: Context<AppContext>,
  store: ArtifactStore,
  id: string,
): Promise<AuthResult> {
  const token = bearerToken(c);
  if (token === null) {
    return {
      ok: false,
      response: c.json({ error: "missing bearer write token" }, 401),
    };
  }
  const record = await store.get(id);
  if (record === null) {
    return {
      ok: false,
      response: c.json({ error: "artifact not found" }, 404),
    };
  }
  const tokenHash = await sha256Hex(token);
  // A write token (wt_) authorizes by matching the artifact's token_hash.
  // A channel token (ch_) authorizes by matching the artifact's channel_hash,
  // so the channel holder can update the bound artifact without the wt_.
  const authorized = looksLikeChannelToken(token)
    ? record.channelHash !== null &&
      timingSafeEqual(tokenHash, record.channelHash)
    : timingSafeEqual(tokenHash, record.tokenHash);
  if (!authorized) {
    return {
      ok: false,
      response: c.json({ error: "invalid write token" }, 403),
    };
  }
  return { ok: true, record };
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
): Promise<Response> {
  let snapshot: ArtifactRecord | null = record;
  let currentVersion = record.currentVersion;
  for (let attempt = 0; attempt < 3 && snapshot !== null; attempt += 1) {
    const result = await store.update(snapshot, {
      content: input.content,
      format: input.format,
      title: input.title,
      description: input.description,
      favicon: input.favicon,
      label: input.label,
      encrypted: input.encrypted,
      baseVersion: null,
      force: false,
    });
    if (typeof result === "number") {
      return c.json({
        id: snapshot.id,
        url: artifactUrl(c, snapshot.id),
        version: result,
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
  const createToken = c.env.CREATE_TOKEN;
  if (createToken !== undefined && createToken !== "") {
    const token = bearerToken(c);
    // Compare SHA-256 hashes so both sides are a fixed-length hex string,
    // avoiding the length oracle of a raw timingSafeEqual on the secret.
    const presented = token === null ? "" : token;
    if (
      token === null ||
      !timingSafeEqual(await sha256Hex(presented), await sha256Hex(createToken))
    ) {
      return c.json({ error: "this instance requires a create token" }, 401);
    }
  }

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
  if (channelRaw !== null && channelHash !== null) {
    const existing = await store.findByChannel(channelHash);
    if (existing !== null) {
      return publishToChannel(c, store, existing, parsed.value, channelRaw);
    }
  }

  const id = generateId();
  const writeToken = generateWriteToken();
  try {
    await store.create(
      id,
      await sha256Hex(writeToken),
      parsed.value,
      channelHash,
    );
  } catch (error) {
    // Two concurrent first publishes to one channel: the unique index lets
    // exactly one create win; the loser lands here and becomes a version
    // update on the winner's artifact, keeping the channel's URL stable.
    if (channelRaw === null || channelHash === null) throw error;
    if (!isChannelBindingConflict(error)) throw error;
    const winner = await store.findByChannel(channelHash);
    if (winner === null) throw error;
    return publishToChannel(c, store, winner, parsed.value, channelRaw);
  }

  return c.json(
    {
      id,
      url: artifactUrl(c, id),
      writeToken,
      version: 1,
      ...(channelRaw ? { channel: channelRaw } : {}),
    },
    201,
  );
});

api.put("/artifacts/:id", async (c) => {
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

  const { baseVersion, force } = parsed.value;
  if (
    baseVersion !== null &&
    baseVersion !== auth.record.currentVersion &&
    !force
  ) {
    return c.json(
      {
        error: `baseVersion ${baseVersion} does not match current version ${auth.record.currentVersion}`,
        currentVersion: auth.record.currentVersion,
      },
      409,
    );
  }

  const result = await store.update(auth.record, parsed.value);
  if (typeof result !== "number") {
    return c.json(
      {
        error: `version conflict: artifact is at version ${result.currentVersion}`,
        currentVersion: result.currentVersion,
      },
      409,
    );
  }
  return c.json({
    id: auth.record.id,
    url: artifactUrl(c, auth.record.id),
    version: result,
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
  const comments = await store.listComments(record.id);
  return c.json({ comments });
});

api.post("/artifacts/:id/comments", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) return c.json({ error: "artifact not found" }, 404);

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
  c: Context<{ Bindings: Env }>,
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
