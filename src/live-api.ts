import type { Context } from "hono";
import { Hono } from "hono";
import { featureFlagsFromBindings } from "./adapters/cloudflare/composition";
import { D1QuotaLedger } from "./adapters/cloudflare/d1-quota-ledger";
import {
  type AppContext,
  artifactUrl,
  authorizeWrite,
  bodyCapFor,
  idempotencyKeyError,
  publicationContextFrom,
  resolveMaxContentBytes,
  storeFrom,
} from "./api";
import { validateUpdate } from "./domain";
import { CheckpointService } from "./live/checkpoint-service";
import { LiveDraftIndex } from "./live/draft-index";
import { rollbackAsCheckpoint } from "./live/rollback";
import type { LiveEvent, LiveObject, LiveTrace } from "./live-do";
import type { LiveDraftPayload } from "./ports/realtime-session-store";
import { QuotaService, quotaLimitsFromEnv } from "./quota/service";
import { actorKeyForRequest } from "./rate-limit";
import { IdempotencyConflictError } from "./store";
import { generateId, sha256Hex } from "./tokens";

// Live edit routes. All 404 when the deploy did not bind a
// LIVE_DO Durable Object namespace — the engine stays usable without it.
//
//   GET  /api/artifacts/:id/live        WebSocket upgrade (browser host chrome)
//   GET  /api/artifacts/:id/live/poll   agent long-poll (sk_ bearer)
//   POST /api/artifacts/:id/live/reply  agent reply -> broadcast to browsers
//   GET  /api/artifacts/:id/live/status agent ack-status poll (pending events + presence)
//   POST /api/artifacts/:id/live/heartbeat agent watcher presence (sk_)
//   POST /api/artifacts/:id/live/consume-exit agent drops observed exit rows
//   GET/PUT /api/artifacts/:id/live/draft recover/save a revisioned Draft
//   POST /api/artifacts/:id/live/checkpoint publish the Draft immutably
//   POST /api/artifacts/:id/live/rollback copy history into a new version
//   POST /api/artifacts/:id/live/edit-stash stage inline copy edits (owner)
//   GET  /api/artifacts/:id/live/edit-stash restore the staged-edits pill (owner)
//   DELETE /api/artifacts/:id/live/edit-stash discard staged edits (owner)
//   POST /api/artifacts/:id/live/edit-commit bundle staged edits into one edit event (owner)
//
// Auth: coordination routes require authorizeView on the artifact (so
// private/org artifacts only expose live to the owner / org members, just like
// reads). The Live update route additionally requires authorizeWrite and uses
// the artifact's wt_/ch_ capability. The browser carries a session cookie; the
// watcher carries a Bearer sk_ for coordination and a write token for edits.

export const liveApi = new Hono<AppContext>();

function liveEnabled(c: Context<AppContext>): boolean {
  // Indirect access so TS does not statically resolve the check to always-true
  // when the deploy's generated Env types LIVE_DO as required (coda0). The
  // engine itself declares LIVE_DO optional, so a self-host without the binding
  // 404s here at runtime.
  return featureFlagsFromBindings(c.env).live;
}

async function authorizeLive(c: Context<AppContext>, id: string) {
  const store = storeFrom(c);
  const record = await store.get(id);
  if (record === null) return null;
  // Live routes use the artifact's view gate so a hosted `sk_` watcher can
  // receive comment/generate notifications. The watcher publishes edits with
  // its artifact `wt_`/`ch_` capability through the normal update route; Live
  // only coordinates the browser channel and must not make the watcher's API
  // key look like an artifact write token.
  if (!(await c.get("authorizer").authorizeView(c, record))) return null;
  return record;
}

function stubFor(
  c: Context<AppContext>,
  id: string,
): DurableObjectStub<LiveObject> {
  const ns = c.env.LIVE_DO;
  if (!ns) throw new Error("LIVE_DO not bound");
  type LiveNs = {
    idFromName(name: string): DurableObjectId;
    get(name: string | DurableObjectId): DurableObjectStub;
    getByName?: (name: string) => DurableObjectStub;
  };
  const liveNs = ns as unknown as LiveNs;
  if (typeof liveNs.getByName === "function") {
    return liveNs.getByName(id) as unknown as DurableObjectStub<LiveObject>;
  }
  return liveNs.get(
    liveNs.idFromName(id),
  ) as unknown as DurableObjectStub<LiveObject>;
}

function liveTrace(c: Context<AppContext>): LiveTrace {
  const context = c.get("requestContext");
  return {
    requestId: context.requestId,
    traceId: context.traceId,
    actorId: context.actorId,
    startedAt: context.startedAt,
  };
}

// Publish signal for staying viewers: after a successful publish, tell the
// LiveObject to broadcast {type:'version'} so open viewers reload in place.
// Best-effort — a missed broadcast must never fail the publish, and a deploy
// without LIVE_DO no-ops. Reused by the ordinary update route in api.ts.
export async function broadcastVersionIfLive(
  c: Context<AppContext>,
  id: string,
  version: number,
): Promise<void> {
  if (!liveEnabled(c)) return;
  try {
    await stubFor(c, id).rpcBroadcastVersion(version);
  } catch {
    // transient DO hiccup; the viewer can still manual-reload
  }
}

liveApi.get("/artifacts/:id/live", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }
  const id = c.req.param("id") ?? "";
  if (!(await authorizeLive(c, id))) return c.text("not found", 404);
  const sessionId = await sha256Hex(
    c.req.header("sec-websocket-key") ?? generateId(),
  );
  const quota = new QuotaService(
    new D1QuotaLedger(c.env.DB),
    quotaLimitsFromEnv(c.env),
  );
  const lease = await quota.reserve([
    {
      scopeKey: `artifact:${id}`,
      resource: "live_sessions",
      entityKey: `live:${sessionId}`,
      amount: 1,
    },
  ]);
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-oa-artifact-id", id);
  headers.set("x-oa-live-session", sessionId);
  try {
    const response = await stubFor(c, id).fetch(
      new Request(c.req.raw, { headers }),
    );
    if (response.status === 101) await lease.commit();
    else await lease.release();
    return response;
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }
});

liveApi.get("/artifacts/:id/live/poll", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const id = c.req.param("id") ?? "";
  if (!(await authorizeLive(c, id))) return c.text("not found", 404);
  const typesRaw = c.req.query("types");
  const types = typesRaw
    ? (typesRaw.split(",").filter(Boolean) as LiveEvent["type"][])
    : null;
  const excludeRaw = c.req.query("exclude");
  const exclude = excludeRaw ? excludeRaw.split(",").filter(Boolean) : [];
  const timeout = Math.min(
    Math.max(Number(c.req.query("timeout") ?? 0) || 270_000, 1000),
    270_000,
  );
  const event = await stubFor(c, id).rpcPoll(types, timeout, exclude);
  return c.json(event);
});

liveApi.get("/artifacts/:id/live/status", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const id = c.req.param("id") ?? "";
  if (!(await authorizeLive(c, id))) return c.text("not found", 404);
  const status = await stubFor(c, id).rpcStatus();
  return c.json(status);
});

liveApi.post("/artifacts/:id/live/heartbeat", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const id = c.req.param("id") ?? "";
  if (!(await authorizeLive(c, id))) return c.text("not found", 404);
  await stubFor(c, id).rpcHeartbeat();
  return c.json({ ok: true });
});

liveApi.post("/artifacts/:id/live/consume-exit", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const id = c.req.param("id") ?? "";
  if (!(await authorizeLive(c, id))) return c.text("not found", 404);
  await stubFor(c, id).rpcConsumeExit();
  return c.json({ ok: true });
});

liveApi.get("/artifacts/:id/live/draft", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  const draft = await stubFor(c, auth.record.id).rpcGetDraft(
    auth.record.id,
    liveTrace(c),
  );
  if (!draft) return c.json({ error: "draft not found" }, 404);
  return c.json({ draft });
});

liveApi.put("/artifacts/:id/live/draft", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;

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
  if (body.protocolVersion !== 1) {
    return c.json(
      {
        error: "Live protocol v1 is required",
        code: "LIVE_PROTOCOL_UPGRADE_REQUIRED",
        supportedVersions: [1],
      },
      426,
    );
  }
  const expectedRevision = body.expectedRevision;
  const baseVersion = body.baseVersion;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return c.json(
      { error: "expectedRevision must be a non-negative integer" },
      400,
    );
  }
  if (
    typeof baseVersion !== "number" ||
    !Number.isInteger(baseVersion) ||
    baseVersion < 1
  ) {
    return c.json({ error: "baseVersion must be a positive integer" }, 400);
  }
  const updateBody = { ...body };
  delete updateBody.protocolVersion;
  delete updateBody.expectedRevision;
  delete updateBody.leaseSeconds;
  const parsed = validateUpdate(updateBody, maxContentBytes);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  if (parsed.value.force) {
    return c.json({ error: "force is not valid for a Live draft" }, 400);
  }
  const payload: LiveDraftPayload = { content: parsed.value.content };
  if (parsed.value.format) payload.format = parsed.value.format;
  if (parsed.value.title) payload.title = parsed.value.title;
  if (parsed.value.description) payload.description = parsed.value.description;
  if (parsed.value.favicon) payload.favicon = parsed.value.favicon;
  if (parsed.value.label !== null) payload.label = parsed.value.label;
  payload.encrypted = parsed.value.encrypted;
  const result = await stubFor(c, auth.record.id).rpcSaveDraft(
    {
      artifactId: auth.record.id,
      actorId: await actorKeyForRequest(c.req.raw),
      expectedRevision,
      baseVersion,
      payload,
      leaseSeconds:
        typeof body.leaseSeconds === "number" ? body.leaseSeconds : undefined,
    },
    liveTrace(c),
  );
  if (!result.ok) {
    return c.json(
      {
        error:
          result.code === "LEASE_HELD"
            ? "draft lease is held by another editor"
            : "draft revision conflict",
        ...result,
      },
      409,
    );
  }
  await new LiveDraftIndex(c.env.DB).upsert(result.draft);
  return c.json({ draft: result.draft });
});

liveApi.post("/artifacts/:id/live/checkpoint", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const invalidIdempotencyKey = idempotencyKeyError(c);
  if (invalidIdempotencyKey) return invalidIdempotencyKey;
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }
  if (body.protocolVersion !== 1) {
    return c.json(
      {
        error: "Live protocol v1 is required",
        code: "LIVE_PROTOCOL_UPGRADE_REQUIRED",
        supportedVersions: [1],
      },
      426,
    );
  }
  const draft = await stubFor(c, auth.record.id).rpcGetDraft(
    auth.record.id,
    liveTrace(c),
  );
  if (!draft) return c.json({ error: "draft not found" }, 404);
  if (body.expectedRevision !== draft.revision) {
    return c.json(
      {
        error: "draft revision conflict",
        code: "REVISION_CONFLICT",
        currentRevision: draft.revision,
      },
      409,
    );
  }
  try {
    const actorId = await actorKeyForRequest(c.req.raw);
    const publication = publicationContextFrom(
      c,
      auth.record.id,
      "checkpoint",
    ) ?? {
      actorScope: `artifact:${auth.record.id}`,
      idempotencyKey: `auto:${generateId()}`,
      operation: "checkpoint" as const,
    };
    const result = await new CheckpointService(store).checkpoint(
      auth.record,
      draft,
      {
        ...publication,
        audit: {
          action: "checkpoint",
          draftRevision: draft.revision,
          baseVersion: draft.baseVersion,
          selectedVersion: null,
          actorId,
        },
      },
    );
    if (!result.ok) {
      await stubFor(c, auth.record.id).rpcMarkDraftConflict(
        auth.record.id,
        draft.revision,
        liveTrace(c),
      );
      const conflicted = await stubFor(c, auth.record.id).rpcGetDraft(
        auth.record.id,
        liveTrace(c),
      );
      if (conflicted) await new LiveDraftIndex(c.env.DB).upsert(conflicted);
      return c.json(
        {
          error: "checkpoint base version conflict",
          code: "CHECKPOINT_CONFLICT",
          currentVersion: result.currentVersion,
        },
        409,
      );
    }
    await stubFor(c, auth.record.id).rpcMarkDraftCheckpointed(
      auth.record.id,
      draft.revision,
      result.publication.version,
      liveTrace(c),
    );
    const checkpointed = await stubFor(c, auth.record.id).rpcGetDraft(
      auth.record.id,
      liveTrace(c),
    );
    if (checkpointed) await new LiveDraftIndex(c.env.DB).upsert(checkpointed);
    await broadcastVersionIfLive(c, auth.record.id, result.publication.version);
    return c.json({
      id: auth.record.id,
      url: artifactUrl(c, auth.record.id),
      version: result.publication.version,
      draftRevision: draft.revision,
      publicationId: result.publication.publicationId,
      idempotentReplay: result.publication.replayed,
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }
});

liveApi.post("/artifacts/:id/live/rollback", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const invalidIdempotencyKey = idempotencyKeyError(c);
  if (invalidIdempotencyKey) return invalidIdempotencyKey;
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }
  const selectedVersion = body.version;
  if (
    typeof selectedVersion !== "number" ||
    !Number.isInteger(selectedVersion) ||
    selectedVersion < 1
  ) {
    return c.json({ error: "version must be a positive integer" }, 400);
  }
  const result = await rollbackAsCheckpoint(
    store,
    auth.record,
    selectedVersion,
    {
      ...(publicationContextFrom(c, auth.record.id, "rollback") ?? {
        actorScope: `artifact:${auth.record.id}`,
        idempotencyKey: `auto:${generateId()}`,
        operation: "rollback" as const,
      }),
      audit: {
        action: "rollback",
        draftRevision: null,
        baseVersion: auth.record.currentVersion,
        selectedVersion,
        actorId: await actorKeyForRequest(c.req.raw),
      },
    },
  );
  if (!result.ok) {
    return c.json(
      {
        error:
          result.code === "VERSION_NOT_FOUND"
            ? "version not found"
            : "version conflict",
        code: result.code,
        currentVersion: result.currentVersion,
      },
      result.code === "VERSION_NOT_FOUND" ? 404 : 409,
    );
  }
  await broadcastVersionIfLive(c, auth.record.id, result.publication.version);
  return c.json({
    id: auth.record.id,
    url: artifactUrl(c, auth.record.id),
    version: result.publication.version,
    rolledBackFrom: selectedVersion,
    publicationId: result.publication.publicationId,
    idempotentReplay: result.publication.replayed,
  });
});

// Removed v0 wire behavior. It used to publish directly and was described as
// "replace current"; v1 requires PUT /live/draft then POST /live/checkpoint.
liveApi.put("/artifacts/:id/live", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  return c.json(
    {
      error: "legacy Live updates are no longer accepted; save a v1 draft",
      code: "LIVE_PROTOCOL_UPGRADE_REQUIRED",
      supportedVersions: [1],
    },
    426,
  );
});

// Inline copy edits are staged in the LiveObject's stashed_edits table and
// committed as ONE `edit` event per Apply. These routes are WRITE-gated
// (authorizeWrite, like PUT /live) — staging leads to source edits — while the
// coordination routes above stay on the view gate so any viewer can observe
// agent presence. A staged body is a handful of text ops; 256KiB is far above
// a legit batch and below the D1/R2 content caps, checked in bytes so
// multibyte CJK text is counted correctly.
const MAX_STASH_BODY_BYTES = 262_144;

function isStashOp(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const op = value as Record<string, unknown>;
  return (
    typeof op.ref === "string" &&
    typeof op.originalText === "string" &&
    typeof op.newText === "string"
  );
}

liveApi.post("/artifacts/:id/live/edit-stash", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;

  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > MAX_STASH_BODY_BYTES) {
    return c.json({ error: "stash body too large" }, 413);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }
  const { pageUrl, ref, element, ops } = body;
  if (
    typeof pageUrl !== "string" ||
    typeof ref !== "string" ||
    typeof element !== "object" ||
    element === null ||
    !Array.isArray(ops) ||
    !ops.every(isStashOp)
  ) {
    return c.json(
      {
        error:
          "pageUrl, ref, element, and ops (each with ref/originalText/newText) are required",
      },
      400,
    );
  }
  const result = await stubFor(c, c.req.param("id") ?? "").rpcStashEdit({
    pageUrl,
    ref,
    element: element as Record<string, unknown>,
    ops: ops as Record<string, unknown>[],
  });
  return c.json({ ok: true, ...result });
});

liveApi.get("/artifacts/:id/live/edit-stash", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  const pageUrl = c.req.query("pageUrl") ?? null;
  return c.json(
    await stubFor(c, c.req.param("id") ?? "").rpcListStash(pageUrl),
  );
});

liveApi.delete("/artifacts/:id/live/edit-stash", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  const pageUrl = c.req.query("pageUrl") ?? null;
  await stubFor(c, c.req.param("id") ?? "").rpcClearStash(pageUrl);
  return c.json({ ok: true });
});

liveApi.post("/artifacts/:id/live/edit-commit", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }
  const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl : null;
  if (!pageUrl) return c.json({ error: "pageUrl required" }, 400);
  const result = await stubFor(c, c.req.param("id") ?? "").rpcCommitEdit(
    pageUrl,
  );
  if (!result.ok) return c.json({ error: result.error }, 409);
  return c.json({ ok: true, eventId: result.eventId });
});

liveApi.delete("/artifacts/:id/live/events/:eid", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  const eid = c.req.param("eid") ?? "";
  const result = (await stubFor(c, c.req.param("id") ?? "").rpcCancelEvent(
    eid,
  )) as { ok: true } | { ok: false; error: string };
  if (!result.ok) {
    return c.json(
      { error: result.error },
      result.error === "already picked up" ? 409 : 404,
    );
  }
  return c.json({ ok: true });
});

liveApi.post("/artifacts/:id/live/reply", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const id = c.req.param("id") ?? "";
  if (!(await authorizeLive(c, id))) return c.text("not found", 404);
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }
  const eventId = typeof body.id === "string" ? body.id : null;
  // Agent-reply types only. Any other type would broadcast a fake signal to
  // every staying viewer — version force-reloads the page, and done/error
  // even drop pending events via acknowledge — the same injection the
  // browser WS channel's allowlist rejects (LiveObject.webSocketMessage).
  const type =
    typeof body.type === "string" &&
    (body.type === "ack" || body.type === "done" || body.type === "error")
      ? (body.type as LiveEvent["type"])
      : null;
  if (!eventId || !type) {
    return c.json({ error: "id and type required" }, 400);
  }
  const payload: Record<string, unknown> = { ...body };
  delete payload.id;
  delete payload.type;
  await stubFor(c, id).rpcReply(eventId, type, payload);
  return c.json({ ok: true });
});
