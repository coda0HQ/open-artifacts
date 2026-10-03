import type { Context } from "hono";
import { Hono } from "hono";
import {
  type AppContext,
  artifactUrl,
  authorizeWrite,
  bodyCapFor,
  parseVersionParam,
  resolveMaxContentBytes,
  storeFrom,
} from "./api";
import { validateUpdate } from "./domain";
import { type LiveEvent, type LiveObject, MAX_LIVE_POLL_MS } from "./live-do";

// Live edit routes. All 404 when the deploy did not bind a
// LIVE_DO Durable Object namespace — the engine stays usable without it.
//
//   GET  /api/artifacts/:id/live        WebSocket upgrade (browser host chrome)
//   GET  /api/artifacts/:id/live/poll   agent long-poll (sk_ bearer)
//   POST /api/artifacts/:id/live/reply  agent reply -> broadcast to browsers
//   GET  /api/artifacts/:id/live/status agent ack-status poll (pending events + presence)
//   POST /api/artifacts/:id/live/heartbeat agent watcher presence (sk_)
//   POST /api/artifacts/:id/live/consume-exit agent drops observed exit rows
//   PUT  /api/artifacts/:id/live agent Live edit -> replace current version
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

// Poll timeout, clamped to the ceiling the edge will hold (see
// MAX_LIVE_POLL_MS in live-do.ts). An absent/zero/garbage value falls back to
// the ceiling; anything above it is cut back so a long-poll always completes
// before the edge drops the idle connection. 1000ms floor keeps the DO from
// thundering-herding on sub-second polls.
export function clampLivePollTimeout(
  raw: string | null | undefined,
  def = MAX_LIVE_POLL_MS,
): number {
  const requested = Number(raw ?? 0);
  const base = Number.isFinite(requested) && requested > 0 ? requested : def;
  return Math.min(Math.max(base, 1000), MAX_LIVE_POLL_MS);
}

function liveEnabled(c: Context<AppContext>): boolean {
  // Indirect access so TS does not statically resolve the check to always-true
  // when the deploy's generated Env types LIVE_DO as required (coda0). The
  // engine itself declares LIVE_DO optional, so a self-host without the binding
  // 404s here at runtime.
  return Boolean((c.env as unknown as Record<string, unknown>).LIVE_DO);
}

async function authorizeLive(c: Context<AppContext>, id: string) {
  const store = storeFrom(c);
  const record = await store.get(id);
  if (record === null) return null;
  // Keep the unpinned coordination path identical to the historical behavior:
  // authorizeView receives only the record. A pinned view must carry its
  // version through the same gate used by /a, /frame, and /raw, otherwise a
  // watcher could coordinate against a version the viewer cannot access.
  const rawVersion = c.req.query("v");
  const version =
    rawVersion === undefined
      ? undefined
      : parseVersionParam(rawVersion, record.currentVersion);
  if (rawVersion !== undefined && typeof version !== "number") return null;
  // Live routes use the artifact's view gate so a hosted `sk_` watcher can
  // receive comment/generate notifications. The watcher publishes edits with
  // its artifact `wt_`/`ch_` capability through the normal update route; Live
  // only coordinates the browser channel and must not make the watcher's API
  // key look like an artifact write token.
  const authorizer = c.get("authorizer");
  const authorized =
    typeof version === "number"
      ? await authorizer.authorizeView(c, record, version)
      : await authorizer.authorizeView(c, record);
  if (!authorized) return null;
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
  return stubFor(c, id).fetch(c.req.raw);
});

// Single-use ticket minting for agent CLI WebSocket connections. Requires
// authorizeLive with sk_ bearer token.
liveApi.post("/artifacts/:id/live/ticket", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  const id = c.req.param("id") ?? "";
  if (!(await authorizeLive(c, id))) return c.text("not found", 404);
  const ticket = await stubFor(c, id).rpcMintTicket();
  return c.json(ticket);
});

// Agent CLI WebSocket channel. Forwarded to the DO stub, which verifies the
// single-use ticket in DO storage. Ticket check happens atomically in the DO.
liveApi.get("/artifacts/:id/live/ws", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }
  const id = c.req.param("id") ?? "";
  return stubFor(c, id).fetch(c.req.raw);
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
  // Clamp the requested timeout to MAX_LIVE_POLL_MS: a poll must complete
  // before the edge drops an idle long-poll (~127s, cf. live-do.ts), or the
  // watcher sees "other side closed" and retries instead of a clean timeout.
  const timeout = clampLivePollTimeout(c.req.query("timeout"));
  // watcher = the CLI's per-process session id (v4): the DO uses it to
  // supersede a dead in-flight poll when the watch loop re-polls.
  const watcher = c.req.query("watcher") ?? "";
  const event = await stubFor(c, id).rpcPoll(types, timeout, exclude, watcher);
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

liveApi.put("/artifacts/:id/live", async (c) => {
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

  const result = await store.replaceCurrent(auth.record, parsed.value);
  if (typeof result !== "number") {
    return c.json(
      {
        error: `version conflict: artifact is at version ${result.currentVersion}`,
        currentVersion: result.currentVersion,
      },
      409,
    );
  }
  await broadcastVersionIfLive(c, auth.record.id, result);
  return c.json({
    id: auth.record.id,
    url: artifactUrl(c, auth.record.id),
    version: result,
  });
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
