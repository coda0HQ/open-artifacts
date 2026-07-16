import type { Context } from "hono";
import { Hono } from "hono";
import type { CreateInput } from "./domain";
import {
  type FEEDBACK_STATUSES,
  MAX_CONTENT_BYTES,
  validateCreate,
  validateFeedback,
  validateFeedbackStatus,
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
  // "1" enables the opt-in web-font surface: the /fonts proxy + an
  // allow-same-origin sandbox so the browser can cache same-origin fonts.
  // Absent (or any other value) keeps the strict opaque-origin sandbox.
  OPEN_ARTIFACTS_WEB_FONTS?: string;
};
export type AppContext = { Bindings: Bindings };

// JSON escaping and encryption metadata inflate the body beyond the content
// cap; anything past this is rejected before parsing.
const MAX_BODY_BYTES = MAX_CONTENT_BYTES * 1.5 + 16 * 1024;

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
      projectRef: input.projectRef,
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

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const parsed = validateCreate(body);
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

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const parsed = validateUpdate(body);
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

// Project-change (type 2) feedback channel. A viewer submits a note about the
// source project behind an artifact; it is stored as an independent record,
// NOT a new artifact version. The owning agent polls pending feedback via the
// skill CLI, edits the project, then either regenerates (reusing the existing
// channel/update path) or closes the feedback as "done".
//
// Auth tradeoff: feedback submission is intentionally permissive. A write
// token (wt_/ch_) presented via Bearer is honored (so a creator's host chrome
// authenticates); when NO token is presented, the route falls back to the
// CREATE_TOKEN gate — anonymous submission is allowed only on an open
// instance (no CREATE_TOKEN), and gated instances require either a write
// token or the create token. This prevents unauthenticated abuse on locked
// deployments while keeping the channel usable by viewers, who never hold a
// write token, on self-hosted open instances.
api.post("/artifacts/:id/feedback", async (c) => {
  const store = storeFrom(c);
  const id = c.req.param("id");
  const record = await store.get(id);
  if (record === null) return c.json({ error: "artifact not found" }, 404);

  const token = bearerToken(c);
  const createToken = c.env.CREATE_TOKEN;
  if (token !== null) {
    // A presented token must authorize against this artifact; the create token
    // is NOT a write token (it cannot mutate an artifact), so reject it here.
    if (looksLikeChannelToken(token)) {
      return c.json({ error: "invalid write token" }, 403);
    }
    const tokenHash = await sha256Hex(token);
    if (!timingSafeEqual(tokenHash, record.tokenHash)) {
      return c.json({ error: "invalid write token" }, 403);
    }
  } else if (createToken !== undefined && createToken !== "") {
    return c.json({ error: "this instance requires authentication" }, 401);
  }

  // Reject oversized bodies before parsing — mirrors the artifact create
  // endpoint's pre-parse content-length guard so an attacker can't force the
  // Worker to buffer/parse an arbitrarily large payload before validateFeedback
  // rejects it.
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const parsed = validateFeedback(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const feedback = await store.addFeedback(id, parsed.value);
  return c.json(
    {
      id: feedback.id,
      artifactId: feedback.artifactId,
      status: feedback.status,
    },
    201,
  );
});

// Owner-only pending-list poll. Returns feedback records for an artifact,
// optionally filtered by status; defaults to pending (the agent's poll loop).
api.get("/artifacts/:id/feedback", async (c) => {
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;

  const statusParam = c.req.query("status");
  let status: undefined | (typeof FEEDBACK_STATUSES)[number] = "pending";
  if (statusParam !== undefined) {
    const parsed = validateFeedbackStatus(statusParam);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    status = parsed.value;
  }
  const items = await store.listFeedback(auth.record.id, status);
  return c.json({ artifactId: auth.record.id, feedback: items });
});

// Advance a feedback record's status through pending -> in_review ->
// in_progress -> done. Owner-only. The transition itself is not enforced
// in-order (the agent may jump straight to done); keep simple.
api.post("/artifacts/:id/feedback/:fid/ack", async (c) => {
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;

  const fid = c.req.param("fid");
  const existing = await store.getFeedback(fid);
  if (existing === null || existing.artifactId !== auth.record.id) {
    return c.json({ error: "feedback not found" }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }
  const parsed = validateFeedbackStatus(body.status);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const updated = await store.updateFeedbackStatus(fid, parsed.value);
  return c.json({ id: fid, status: updated?.status ?? parsed.value });
});
