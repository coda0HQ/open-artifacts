import type { Context } from "hono";
import { Hono } from "hono";
import type { AppContext } from "./api";
import { storeFrom } from "./api";
import type { LiveEvent, LiveObject } from "./live-do";

// Live variant-editing routes. All 404 when the deploy did not bind a
// LIVE_DO Durable Object namespace — the engine stays usable without it.
//
//   GET  /api/artifacts/:id/live        WebSocket upgrade (browser host chrome)
//   GET  /api/artifacts/:id/live/poll   agent long-poll (sk_ bearer)
//   POST /api/artifacts/:id/live/reply  agent reply -> broadcast to browsers
//
// Auth: every route requires authorizeView on the artifact (so private/org
// artifacts only expose live to the owner / org members, just like reads). The
// browser carries a session cookie; the agent carries a Bearer sk_.

export const liveApi = new Hono<AppContext>();

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
  // authorizeView is the read gate; the authorizer (default = always-true for
  // open self-host, coda0 = session/sk_ + visibility) decides who can open a
  // live session. Identical to GET /api/artifacts/:id — no new auth surface.
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

liveApi.get("/artifacts/:id/live", async (c) => {
  if (!liveEnabled(c)) return c.text("not found", 404);
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }
  const id = c.req.param("id") ?? "";
  if (!(await authorizeLive(c, id))) return c.text("not found", 404);
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
  const timeout = Math.min(
    Math.max(Number(c.req.query("timeout") ?? 0) || 270_000, 1000),
    270_000,
  );
  const event = await stubFor(c, id).rpcPoll(types, timeout);
  return c.json(event);
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
  const type =
    typeof body.type === "string" ? (body.type as LiveEvent["type"]) : null;
  if (!eventId || !type) {
    return c.json({ error: "id and type required" }, 400);
  }
  const payload: Record<string, unknown> = { ...body };
  delete payload.id;
  delete payload.type;
  await stubFor(c, id).rpcReply(eventId, type, payload);
  return c.json({ ok: true });
});
