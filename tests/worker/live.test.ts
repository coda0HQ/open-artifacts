import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/api";
import { createApp } from "../../src/app";
import type { Authorizer, OwnershipGrant } from "../../src/authorizer";
import app from "../../src/index";

// Live editing is OPT-IN: when the deploy did not bind a LIVE_DO Durable
// Object (the engine's default), the /live* routes 404 and the viewer renders
// no Live button. The pool binds LIVE_DO (vitest.config.ts miniflare option,
// mirroring wrangler.dev.jsonc), so the no-binding contract is pinned here by
// passing an explicit { ...env, LIVE_DO: undefined } env — the same way
// handoff.test.ts pins OPEN_ARTIFACTS_HANDOFF off. A self-host without LIVE_DO
// keeps today's viewer byte-for-byte.

// A canManage=true authorizer so owner-only surfaces (the Live toggle) render
// in tests. The default app (defaultAuthorizer) returns canManage=false,
// exercising the viewer (no-button) path.
function ownerAuthorizer(): Authorizer {
  const grant: OwnershipGrant = {
    ownerId: "u1",
    orgId: null,
    visibility: "public",
  };
  return {
    authorizeCreate: async () => grant,
    authorizeView: async () => true,
    authorizeWrite: async () => true,
    canManage: async () => true,
  };
}
const ownerApp = createApp(ownerAuthorizer());

const BASE = "http://artifacts.test";

const ON: Bindings = { ...env };
const OFF: Bindings = { ...env, LIVE_DO: undefined };

async function fetchWith(
  request: Request,
  environment: Bindings,
  useOwner = false,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = (useOwner ? ownerApp : app).fetch(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function create(
  body: Record<string, unknown>,
  environment: Bindings = ON,
): Promise<{ id: string; liveSupported?: boolean }> {
  const res = await fetchWith(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Live Test",
        favicon: "🎯",
        ...body,
      }),
    }),
    environment,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; liveSupported?: boolean };
}

function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// DO stub for an artifact id (mirrors live-api.ts stubFor). Indirect access:
// worker-configuration.d.ts derives from wrangler.jsonc, which has no LIVE_DO
// (the pool binding is a test-time addition), so the type lacks the key.
function liveStub(id: string): DurableObjectStub {
  const ns = (env as unknown as { LIVE_DO: DurableObjectNamespace }).LIVE_DO;
  type LiveNs = {
    idFromName(name: string): DurableObjectId;
    get(name: string | DurableObjectId): DurableObjectStub;
  };
  const liveNs = ns as unknown as LiveNs;
  return liveNs.get(liveNs.idFromName(id));
}

// Insert a pending event row directly into the DO's SQLite (deterministic
// version of the browser-WS enqueue path; avoids the message round-trip race).
// The DO creates the table lazily on first use, so warm the schema first —
// the same CREATE TABLE IF NOT EXISTS the DO's ensureSchema runs.
async function enqueueRaw(
  id: string,
  evt: Record<string, unknown>,
): Promise<void> {
  const stub = liveStub(id);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS pending (
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        leased_until INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (id, type)
      )`,
    );
    await state.storage.sql.exec(
      `INSERT INTO pending (id, type, payload, seq, leased_until, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
      evt.id,
      evt.type,
      JSON.stringify(evt),
      Date.now(),
      Date.now(),
    );
  });
}

const SK_BEARER = { authorization: `Bearer sk_${"a".repeat(40)}` };

describe("live routes without LIVE_DO binding", () => {
  it("GET /api/artifacts/:id/live returns 404 (no WebSocket upgrade)", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live`, {
        headers: { Upgrade: "websocket" },
      }),
      OFF,
    );
    // The route exists (mounted) but 404s because env.LIVE_DO is undefined.
    expect(res.status).toBe(404);
  });

  it("GET /api/artifacts/:id/live/poll returns 404", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll`),
      OFF,
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/artifacts/:id/live/reply returns 404", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/reply`, {
        id: "ev1",
        type: "done",
      }),
      OFF,
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/artifacts/:id/live/status returns 404", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`),
      OFF,
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/artifacts/:id/live/heartbeat returns 404", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/heartbeat`),
      OFF,
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/artifacts/:id/live/consume-exit returns 404", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/consume-exit`),
      OFF,
    );
    expect(res.status).toBe(404);
  });

  it("PUT /api/artifacts/:id/live returns 404 without LIVE_DO", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}/live`, {
        content: "<p>live</p>",
        baseVersion: 1,
      }),
      OFF,
      true,
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/artifacts/:id/live/edit-stash returns 404 without LIVE_DO", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/edit-stash`, {
        pageUrl: `/a/${id}`,
        ref: "h1",
        element: { tagName: "h1" },
        ops: [],
      }),
      OFF,
      true,
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/artifacts/:id/live/edit-stash returns 404 without LIVE_DO", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/edit-stash`),
      OFF,
      true,
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /api/artifacts/:id/live/edit-stash returns 404 without LIVE_DO", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      jsonRequest("DELETE", `/api/artifacts/${id}/live/edit-stash`),
      OFF,
      true,
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/artifacts/:id/live/edit-commit returns 404 without LIVE_DO", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/edit-commit`, {
        pageUrl: `/a/${id}`,
      }),
      OFF,
      true,
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /api/artifacts/:id/live/events/:eid returns 404 without LIVE_DO", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(
      jsonRequest("DELETE", `/api/artifacts/${id}/live/events/ev_x`),
      OFF,
      true,
    );
    expect(res.status).toBe(404);
  });

  it("the viewer host page renders no Live button without the binding", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(new Request(`${BASE}/a/${id}`), OFF, true);
    const html = await res.text();
    expect(html).not.toContain("oa-live-toggle");
    expect(html).not.toContain("oa-live-root");
    // The frame still works — the iframe is present.
    expect(html).toContain('id="oa-frame"');
  });

  it("the frame document carries the picker script tag (harmless when unarmed)", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    const res = await fetchWith(new Request(`${BASE}/a/${id}/frame`), OFF);
    const html = await res.text();
    // The picker script is always injected into the frame (it no-ops until
    // armed by a host oa:live:pick:arm message); confirm it is present but
    // does not auto-arm.
    expect(html).toContain("__oaSend");
  });
});

describe("live routes with LIVE_DO bound", () => {
  it("an owner sees the Live toggle button, live chrome, and the annot bridge", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(new Request(`${BASE}/a/${id}`), ON, true);
    const html = await res.text();
    expect(html).toContain("oa-live-toggle");
    expect(html).toContain("oa-live-root");
    expect(html).toContain("oa-live-config");
    expect(html).toContain("oa-live-connection");
    expect(html).toContain("Copy start prompt");
    expect(html).toContain("navigator.clipboard.writeText");
    // Offline guidance must not block the Live toggle from opening the picker,
    // and the guide banner auto-shows only once per session.
    expect(html).toContain("guideAutoShown=true");
    expect(html).toContain("agentOnline===false&&!guideAutoShown");
    // If the first arm message races the iframe load, oa:ready re-arms it
    // while the newly opened dock is still in PICKING.
    expect(html).toContain(
      "else if(!root.hidden&&state==='PICKING'&&!draft){ toFrame({type:'oa:live:pick:arm'});",
    );
    // The annotation pipeline: the host arms the frame picker AND enables the
    // annot overlay, and collects the frame's annotations before submit.
    expect(html).toContain("oa:live:annot:enable");
    expect(html).toContain("oa:live:annot:collect");
    // Regression: the exit event gets its own id — send() would otherwise
    // stamp the last generate's sessionId, and the watcher's exclude set
    // would hide the exit row forever (the watcher would never exit).
    expect(html).toContain("{type:'exit', id:genId()");
    // The comments chrome bridges posted comments onto the live channel: the
    // live script exposes the push hook, and the comments submit calls it.
    expect(html).toContain("__oaLivePush");
    expect(html).toContain('__oaLivePush({type:"comment"');
  });

  it("keeps the offline startup prompt and copy button inside the Live dock", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(new Request(`${BASE}/a/${id}`), ON, true);
    const html = await res.text();
    const dockStart = html.indexOf('<div id="oa-live-dock">');
    const guideStart = html.indexOf('<div id="oa-live-guide"');
    const copyButtonStart = html.indexOf('id="oa-live-guide-copy"');
    const actionBarStart = html.indexOf('<div id="oa-live-action-bar"');

    expect(dockStart).toBeGreaterThanOrEqual(0);
    expect(html).toMatch(/<div id="oa-live-dock">\s*<div id="oa-live-guide"/);
    expect(html.slice(0, dockStart)).not.toContain('id="oa-live-guide"');
    expect(copyButtonStart).toBeGreaterThan(guideStart);
    expect(html.slice(dockStart, actionBarStart)).toContain(
      'id="oa-live-guide-copy"',
    );
  });

  it("locks element picking while the selected element prompt is open", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(new Request(`${BASE}/a/${id}`), ON, true);
    const html = await res.text();

    const hostPickStart = html.indexOf("if(d.type==='oa:element:picked')");
    expect(hostPickStart).toBeGreaterThanOrEqual(0);
    expect(html.slice(hostPickStart, hostPickStart + 300)).toContain(
      "oa:live:pick:lock",
    );

    const frameRes = await fetchWith(new Request(`${BASE}/a/${id}/frame`), ON);
    const frameHtml = await frameRes.text();
    const framePickStart = frameHtml.indexOf("function pickAt(");
    expect(framePickStart).toBeGreaterThanOrEqual(0);
    expect(frameHtml.slice(framePickStart, framePickStart + 300)).toContain(
      "lock();",
    );
  });

  it("checkpoints a Live edit as an immutable new version", async () => {
    const { id } = await create({ content: "<p>v1</p>", format: "html" });
    let res = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}`, { content: "<p>v2</p>" }),
      ON,
      true,
    );
    expect(res.status).toBe(200);

    res = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}/live/draft`, {
        protocolVersion: 1,
        expectedRevision: 0,
        content: "<p>live v2</p>",
        baseVersion: 2,
      }),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ draft: { revision: 1 } });

    res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/checkpoint`, {
        protocolVersion: 1,
        expectedRevision: 1,
      }),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, version: 3 });

    const metaRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}`),
      ON,
      true,
    );
    const meta = (await metaRes.json()) as {
      version: number;
      versions: { version: number }[];
    };
    expect(meta.version).toBe(3);
    expect(meta.versions.map((item) => item.version)).toEqual([1, 2, 3]);

    const prior = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/raw?v=2`),
      ON,
      true,
    );
    expect(await prior.text()).toContain("v2");

    const frame = await fetchWith(
      new Request(`${BASE}/a/${id}/frame`),
      ON,
      true,
    );
    expect(await frame.text()).toContain("live v2");

    res = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}`, {
        content: "<p>v4</p>",
        baseVersion: 3,
      }),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, version: 4 });

    const latestMetaRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}`),
      ON,
      true,
    );
    const latestMeta = (await latestMetaRes.json()) as {
      version: number;
      versions: { version: number }[];
    };
    expect(latestMeta.version).toBe(4);
    expect(latestMeta.versions.map((item) => item.version)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("a non-owner viewer sees no Live toggle even when LIVE_DO is bound", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(new Request(`${BASE}/a/${id}`), ON, false);
    const html = await res.text();
    expect(html).not.toContain('class="oa-live-toggle"');
    expect(html).not.toContain('id="oa-live-guide"');
  });

  it("the frame document carries the annot data reply handler", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(new Request(`${BASE}/a/${id}/frame`), ON);
    const html = await res.text();
    expect(html).toContain("oa:live:annot:data");
  });

  it("POST /live/heartbeat records presence and GET /live/status reports it", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    // Before any heartbeat: not active.
    let res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    let status = (await res.json()) as {
      pendingEvents: unknown[];
      agentActive: boolean;
      lastAgentSeen: number | null;
    };
    expect(status.agentActive).toBe(false);
    expect(status.lastAgentSeen).toBe(null);
    expect(Array.isArray(status.pendingEvents)).toBe(true);

    // After a heartbeat: active with a timestamp.
    res = await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/heartbeat`,
        undefined,
        SK_BEARER,
      ),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    status = (await res.json()) as {
      pendingEvents: unknown[];
      agentActive: boolean;
      lastAgentSeen: number | null;
    };
    expect(status.agentActive).toBe(true);
    expect(typeof status.lastAgentSeen).toBe("number");
  });

  it("GET /live/status and POST /live/heartbeat use the artifact view gate", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/heartbeat`,
        undefined,
        SK_BEARER,
      ),
      ON,
      false,
    );
    expect(res.status).toBe(200);
    const res2 = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      false,
    );
    expect(res2.status).toBe(200);
  });

  it("agentActive goes false once lastAgentSeen falls outside the window", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/heartbeat`,
        undefined,
        SK_BEARER,
      ),
      ON,
      true,
    );
    // Backdate presence past the 60s window.
    await runInDurableObject(liveStub(id), async (_instance, state) => {
      await state.storage.put("lastAgentSeen", Date.now() - 120_000);
    });
    const res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    const status = (await res.json()) as { agentActive: boolean };
    expect(status.agentActive).toBe(false);
  });

  it("GET /live/status reports queued generate events in pendingEvents", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    await enqueueRaw(id, { type: "generate", id: "ev1", items: [] });
    const res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    const status = (await res.json()) as {
      pendingEvents: { id: string; type: string }[];
    };
    expect(status.pendingEvents.some((e) => e.id === "ev1")).toBe(true);
  });

  it("a hosted sk watcher can poll through the artifact view gate", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    await enqueueRaw(id, {
      type: "comment",
      id: "c_sk_view1",
      body: "hosted watcher can receive this",
    });

    const res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll?timeout=1000`, {
        headers: SK_BEARER,
      }),
      ON,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      type: "comment",
      id: "c_sk_view1",
    });
  });

  it("browser WebSocket generate and comment events reach pendingEvents (the real enqueue path)", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await liveStub(id).fetch(
      new Request(`${BASE}/api/artifacts/${id}/live`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no websocket in upgrade response");
    ws.accept();
    ws.send(JSON.stringify({ type: "generate", id: "ev_ws1", items: [] }));
    ws.send(
      JSON.stringify({
        type: "comment",
        id: "c_ws1",
        body: "make the header sticky",
        anchor: { mode: "point", x: 10, y: 20 },
      }),
    );
    // The DO processes the WS messages asynchronously; poll status until both
    // events land (bounded — the DO enqueue is fast, this is just a guard).
    let seen = 0;
    for (let i = 0; i < 20 && seen < 2; i++) {
      const statusRes = await fetchWith(
        new Request(`${BASE}/api/artifacts/${id}/live/status`, {
          headers: SK_BEARER,
        }),
        ON,
        true,
      );
      const status = (await statusRes.json()) as {
        pendingEvents: { id: string }[];
      };
      seen = status.pendingEvents.filter(
        (e) => e.id === "ev_ws1" || e.id === "c_ws1",
      ).length;
      if (seen < 2) await new Promise((r) => setTimeout(r, 100));
    }
    ws.close();
    expect(seen).toBe(2);
  });

  it("polling a comment returns its payload and consumes the queued event", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await liveStub(id).fetch(
      new Request(`${BASE}/api/artifacts/${id}/live`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no websocket in upgrade response");
    ws.accept();
    ws.send(
      JSON.stringify({
        type: "comment",
        id: "c_consume1",
        body: "remove the stale comment",
        author: "reviewer",
        createdAt: "2026-08-02T10:00:00.000Z",
      }),
    );

    const pollRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll?timeout=1000`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    expect(await pollRes.json()).toMatchObject({
      type: "comment",
      id: "c_consume1",
      body: "remove the stale comment",
    });

    const statusRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    const status = (await statusRes.json()) as {
      pendingEvents: { id: string }[];
    };
    expect(
      status.pendingEvents.some((event) => event.id === "c_consume1"),
    ).toBe(false);
    ws.close();
  });

  it("GET /live/poll honors exclude so in-flight events are never re-delivered", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    // Warm the schema, then queue two events with ev1's lease expired.
    await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    await enqueueRaw(id, { type: "generate", id: "ev1", items: [] });
    await enqueueRaw(id, { type: "generate", id: "ev2", items: [] });
    await runInDurableObject(liveStub(id), async (_instance, state) => {
      await state.storage.sql.exec(
        `UPDATE pending SET leased_until = 0 WHERE id = 'ev1'`,
      );
    });

    // Without exclude the oldest eligible event is delivered.
    let res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll?timeout=1000`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    let evt = (await res.json()) as { type: string; id: string };
    expect(evt.id).toBe("ev1");

    // With exclude=ev1 the next poll must skip it (not re-deliver).
    res = await fetchWith(
      new Request(
        `${BASE}/api/artifacts/${id}/live/poll?timeout=1000&exclude=ev1`,
        { headers: SK_BEARER },
      ),
      ON,
      true,
    );
    evt = (await res.json()) as { type: string; id: string };
    expect(evt.id).toBe("ev2");
  });

  it("POST /api/artifacts returns liveSupported true when LIVE_DO is bound and false when not", async () => {
    const on = await create({ content: "<p>hi</p>", format: "html" }, ON);
    const off = await create({ content: "<p>hi</p>", format: "html" }, OFF);
    expect(on.liveSupported).toBe(true);
    expect(off.liveSupported).toBe(false);
  });
});

describe("version broadcast on publish (staying-viewer auto-refresh)", () => {
  // Connect the browser-side WebSocket for an artifact (the live channel the
  // host page holds) and collect every message the DO sends.
  async function connectLive(id: string): Promise<{
    ws: WebSocket;
    messages: { type: string; [key: string]: unknown }[];
  }> {
    const res = await liveStub(id).fetch(
      new Request(`${BASE}/api/artifacts/${id}/live`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no websocket in upgrade response");
    const messages: { type: string; [key: string]: unknown }[] = [];
    ws.addEventListener("message", (e) => {
      messages.push(JSON.parse(e.data as string));
    });
    ws.accept();
    return { ws, messages };
  }

  // Broadcast delivery is async (DO -> WS); wait bounded, like the enqueue
  // assertions above.
  async function waitForMessage(
    messages: { type: string }[],
    type: string,
  ): Promise<{ type: string; [key: string]: unknown }> {
    for (let i = 0; i < 50; i++) {
      const found = messages.find((m) => m.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no ${type} broadcast within the wait window`);
  }

  it("an ordinary update broadcasts {type:'version', version} to staying viewers", async () => {
    const { id } = await create({ content: "<p>v1</p>", format: "html" });
    const { ws, messages } = await connectLive(id);

    const res = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}`, { content: "<p>v2</p>" }),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2 });

    const msg = await waitForMessage(messages, "version");
    expect(msg).toMatchObject({ type: "version", version: 2 });
    ws.close();
  });

  it("a Live checkpoint broadcasts its new immutable version", async () => {
    const { id } = await create({ content: "<p>v1</p>", format: "html" });
    const { ws, messages } = await connectLive(id);

    let res = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}/live/draft`, {
        protocolVersion: 1,
        expectedRevision: 0,
        baseVersion: 1,
        content: "<p>r1</p>",
      }),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/checkpoint`, {
        protocolVersion: 1,
        expectedRevision: 1,
      }),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2 });

    const msg = await waitForMessage(messages, "version");
    expect(msg).toMatchObject({ type: "version", version: 2 });
    ws.close();
  });

  it("the version broadcast is never enqueued - poll times out and status stays empty", async () => {
    const { id } = await create({ content: "<p>v1</p>", format: "html" });
    const { ws } = await connectLive(id);

    const putRes = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}`, { content: "<p>v2</p>" }),
      ON,
      true,
    );
    expect(putRes.status).toBe(200);

    const pollRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll?timeout=1000`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    expect(await pollRes.json()).toMatchObject({ type: "timeout" });

    const statusRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    const status = (await statusRes.json()) as {
      pendingEvents: { type: string }[];
    };
    expect(status.pendingEvents.length).toBe(0);
    ws.close();
  });

  it("a deploy without LIVE_DO publishes normally with no broadcast step", async () => {
    const { id } = await create({ content: "<p>v1</p>", format: "html" }, OFF);
    const res = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}`, { content: "<p>v2</p>" }),
      OFF,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2 });
  });

  it("the host page carries the version-broadcast handler with its guards inlined", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(new Request(`${BASE}/a/${id}`), ON, true);
    const html = await res.text();
    // The live script handles the version broadcast.
    expect(html).toContain("msg.type==='version'");
    // A version-pinned view (?v=) never auto-reloads.
    expect(html).toContain("[?&]v=");
    // Mid-work (compose prompt open or inline text editing) the host toasts
    // instead of reloading, so no unsaved work is destroyed.
    expect(html).toContain("New version published");
    // The version branch arms a done-window fallback instead of reloading
    // immediately, so the interactive flow keeps exactly one reload per
    // edit (owned by the done-driven restartAfterEdit, as before).
    expect(html).toContain("VERSION_DONE_WINDOW_MS");
  });

  it("WS clients cannot inject reply or publish types into the agent poll queue", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const { ws } = await connectLive(id);
    ws.send(JSON.stringify({ type: "version", id: "inj_v1", version: 99 }));
    ws.send(JSON.stringify({ type: "done", id: "inj_d1" }));
    ws.send(JSON.stringify({ type: "ack", id: "inj_a1" }));

    // Nothing is queued: the poll times out and the status stays empty.
    const pollRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll?timeout=1000`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    expect(await pollRes.json()).toMatchObject({ type: "timeout" });
    const statusRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    const status = (await statusRes.json()) as {
      pendingEvents: { id: string }[];
    };
    expect(status.pendingEvents.length).toBe(0);

    // Control: user-action types still enqueue, so the drops above are the
    // allowlist working — not a dead WebSocket.
    ws.send(JSON.stringify({ type: "generate", id: "inj_g1", items: [] }));
    let seen = false;
    for (let i = 0; i < 20 && !seen; i++) {
      const s = await fetchWith(
        new Request(`${BASE}/api/artifacts/${id}/live/status`, {
          headers: SK_BEARER,
        }),
        ON,
        true,
      );
      const st = (await s.json()) as { pendingEvents: { id: string }[] };
      seen = st.pendingEvents.some((e) => e.id === "inj_g1");
      if (!seen) await new Promise((r) => setTimeout(r, 100));
    }
    ws.close();
    expect(seen).toBe(true);
  });

  it("POST /live/reply rejects non-agent-reply types before they broadcast", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const { ws, messages } = await connectLive(id);

    // Only ack/done/error are agent replies. Everything else must be
    // rejected: version force-reloads every staying viewer; done/error drop
    // pending events via acknowledge; generate/comment/exit are browser- or
    // server-originated types no agent ever replies with.
    for (const type of ["version", "generate", "comment", "exit", "edit"]) {
      const res = await fetchWith(
        jsonRequest("POST", `/api/artifacts/${id}/live/reply`, {
          id: "ev_x",
          type,
        }),
        ON,
        true,
      );
      expect(res.status).toBe(400);
    }

    // No broadcast reached the viewer.
    await new Promise((r) => setTimeout(r, 250));
    expect(messages.find((m) => m.type === "version")).toBeUndefined();

    // Control: the legitimate agent-reply types still pass.
    const okRes = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/reply`, {
        id: "ev_x",
        type: "done",
        status: "done",
      }),
      ON,
      true,
    );
    expect(okRes.status).toBe(200);
    const done = await waitForMessage(messages, "done");
    expect(done).toMatchObject({ type: "done", id: "ev_x" });
    ws.close();
  });
});

describe("live edit stash, commit, and inline-edit chrome", () => {
  const op = { ref: "h1", originalText: "Old", newText: "New" };
  const stashBody = (pageUrl: string, ops: unknown[]) => ({
    pageUrl,
    ref: "h1",
    element: { tagName: "h1" },
    ops,
  });

  it("stages ops and merges by (pageUrl, ref): a re-save replaces newText but keeps originalText", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const pageUrl = `/a/${id}`;

    let res = await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(pageUrl, [op]),
      ),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pendingCount: 1 });

    // Re-saving the same (pageUrl, ref) replaces newText but keeps originalText.
    res = await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(pageUrl, [{ ...op, newText: "Newer" }]),
      ),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pendingCount: 1 });

    res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/edit-stash`),
      ON,
      true,
    );
    const list = (await res.json()) as {
      pendingCount: number;
      entries: {
        pageUrl: string;
        ref: string;
        ops: { originalText: string; newText: string }[];
      }[];
    };
    expect(list.pendingCount).toBe(1);
    expect(list.entries[0]).toMatchObject({
      pageUrl,
      ref: "h1",
      ops: [{ originalText: "Old", newText: "Newer" }],
    });
  });

  it("keeps distinct ops when rows share a ref (merge keys by ref + originalText)", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const pageUrl = `/a/${id}`;
    const ops = [
      { ref: "p", originalText: "First line", newText: "First edited" },
      { ref: "p", originalText: "Second line", newText: "Second edited" },
    ];
    let res = await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(pageUrl, ops),
      ),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pendingCount: 2 });

    // Re-saving only the first row updates it and keeps the second untouched
    // (ref alone cannot distinguish two <p> rows without ids/classes).
    res = await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(pageUrl, [{ ...ops[0], newText: "First newer" }]),
      ),
      ON,
      true,
    );
    expect(await res.json()).toMatchObject({ ok: true, pendingCount: 2 });

    res = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/edit-stash`),
      ON,
      true,
    );
    const list = (await res.json()) as {
      entries: {
        ops: { ref: string; originalText: string; newText: string }[];
      }[];
    };
    expect(list.entries[0].ops).toEqual([
      { ref: "p", originalText: "First line", newText: "First newer" },
      { ref: "p", originalText: "Second line", newText: "Second edited" },
    ]);
  });

  it("rejects a malformed stash body with 400", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/edit-stash`, {
        pageUrl: 7,
      }),
      ON,
      true,
    );
    expect(res.status).toBe(400);
  });

  it("DELETE /live/edit-stash discards the staged ops", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const pageUrl = `/a/${id}`;
    await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(pageUrl, [op]),
      ),
      ON,
      true,
    );
    const res = await fetchWith(
      jsonRequest("DELETE", `/api/artifacts/${id}/live/edit-stash`),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    const list = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/edit-stash`),
      ON,
      true,
    );
    expect(((await list.json()) as { pendingCount: number }).pendingCount).toBe(
      0,
    );
  });

  it("POST /live/edit-commit enqueues one edit event and 409s on an empty stash", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const pageUrl = `/a/${id}`;

    let res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/edit-commit`, { pageUrl }),
      ON,
      true,
    );
    expect(res.status).toBe(409);

    await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(pageUrl, [op]),
      ),
      ON,
      true,
    );
    res = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/edit-commit`, { pageUrl }),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };
    expect(eventId).toMatch(/^ev_/);

    const statusRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    const status = (await statusRes.json()) as {
      pendingEvents: { id: string; type: string }[];
    };
    expect(
      status.pendingEvents.some((e) => e.id === eventId && e.type === "edit"),
    ).toBe(true);
  });

  it("an edit event is polled ahead of a pending generate", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const pageUrl = `/a/${id}`;
    await enqueueRaw(id, { type: "generate", id: "ev_gen1", items: [] });
    await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(pageUrl, [op]),
      ),
      ON,
      true,
    );
    const commitRes = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/edit-commit`, { pageUrl }),
      ON,
      true,
    );
    const { eventId } = (await commitRes.json()) as { eventId: string };

    const pollRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll?timeout=1000`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    const evt = (await pollRes.json()) as { type: string; id: string };
    expect(evt.type).toBe("edit");
    expect(evt.id).toBe(eventId);
  });

  it("a done reply clears the staged edits and an error reply keeps them", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const pageUrl = `/a/${id}`;
    const stash = async () =>
      fetchWith(
        jsonRequest(
          "POST",
          `/api/artifacts/${id}/live/edit-stash`,
          stashBody(pageUrl, [op]),
        ),
        ON,
        true,
      );
    const commit = async () => {
      const res = await fetchWith(
        jsonRequest("POST", `/api/artifacts/${id}/live/edit-commit`, {
          pageUrl,
        }),
        ON,
        true,
      );
      return ((await res.json()) as { eventId: string }).eventId;
    };
    const pendingCount = async () => {
      const res = await fetchWith(
        new Request(`${BASE}/api/artifacts/${id}/live/edit-stash`),
        ON,
        true,
      );
      return ((await res.json()) as { pendingCount: number }).pendingCount;
    };

    // done clears the stash for the page.
    await stash();
    const evtId1 = await commit();
    const pollRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll?timeout=1000`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    expect(((await pollRes.json()) as { id: string }).id).toBe(evtId1);
    const doneRes = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/reply`, {
        id: evtId1,
        type: "done",
        status: "done",
        appliedEntryIds: [],
        failed: [],
        files: ["recipe.html"],
        notes: [],
      }),
      ON,
      true,
    );
    expect(doneRes.status).toBe(200);
    expect(await pendingCount()).toBe(0);

    // error keeps the stash so the user can retry or discard.
    await stash();
    const evtId2 = await commit();
    await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll?timeout=1000`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/reply`, {
        id: evtId2,
        type: "error",
        status: "error",
      }),
      ON,
      true,
    );
    expect(await pendingCount()).toBe(1);
  });

  it("DELETE /live/events/:eid cancels an unleased queued edit and keeps the stash", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const pageUrl = `/a/${id}`;
    await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(pageUrl, [op]),
      ),
      ON,
      true,
    );
    const commitRes = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/edit-commit`, { pageUrl }),
      ON,
      true,
    );
    const { eventId } = (await commitRes.json()) as { eventId: string };

    const res = await fetchWith(
      jsonRequest("DELETE", `/api/artifacts/${id}/live/events/${eventId}`),
      ON,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    // The event left the queue...
    const statusRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    const status = (await statusRes.json()) as {
      pendingEvents: { id: string }[];
    };
    expect(status.pendingEvents.some((e) => e.id === eventId)).toBe(false);
    // ...but the stash is intact, so Apply can run again.
    const list = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/edit-stash`),
      ON,
      true,
    );
    expect(((await list.json()) as { pendingCount: number }).pendingCount).toBe(
      1,
    );
  });

  it("DELETE /live/events/:eid returns 409 once the agent has leased the event", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const pageUrl = `/a/${id}`;
    await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(pageUrl, [op]),
      ),
      ON,
      true,
    );
    const commitRes = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/edit-commit`, { pageUrl }),
      ON,
      true,
    );
    const { eventId } = (await commitRes.json()) as { eventId: string };
    // The watcher polls the event → it is leased for 30s.
    await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/poll?timeout=1000`, {
        headers: SK_BEARER,
      }),
      ON,
      true,
    );
    const res = await fetchWith(
      jsonRequest("DELETE", `/api/artifacts/${id}/live/events/${eventId}`),
      ON,
      true,
    );
    expect(res.status).toBe(409);
  });

  it("DELETE /live/events/:eid returns 404 for unknown or non-edit events", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    let res = await fetchWith(
      jsonRequest("DELETE", `/api/artifacts/${id}/live/events/ev_unknown`),
      ON,
      true,
    );
    expect(res.status).toBe(404);
    await enqueueRaw(id, { type: "generate", id: "ev_gen1", items: [] });
    res = await fetchWith(
      jsonRequest("DELETE", `/api/artifacts/${id}/live/events/ev_gen1`),
      ON,
      true,
    );
    expect(res.status).toBe(404);
  });

  it("a viewer can GET /live/status but cannot POST /live/edit-stash", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const statusRes = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/status`),
      ON,
      false,
    );
    expect(statusRes.status).toBe(200);
    const stashRes = await fetchWith(
      jsonRequest(
        "POST",
        `/api/artifacts/${id}/live/edit-stash`,
        stashBody(`/a/${id}`, [op]),
      ),
      ON,
      false,
    );
    expect(stashRes.status).toBe(401);
  });

  it("the owner host chrome carries the edit chip, Apply/Discard, and the three-state indicator", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(new Request(`${BASE}/a/${id}`), ON, true);
    const html = await res.text();
    // Edit chip + stash plumbing.
    expect(html).toContain("Edit text");
    expect(html).toContain('id="oa-live-apply"');
    expect(html).toContain('id="oa-live-discard"');
    expect(html).toContain("live/edit-stash");
    expect(html).toContain("live/edit-commit");
    // Three-state indicator: off-state amber dot, busy tooltip, disconnected tooltip.
    expect(html).toContain('data-agent="off"]::after');
    expect(html).toContain("oa-live-agent-off-pulse");
    expect(html).toContain(
      "Live agent not connected - run the watcher to connect",
    );
    expect(html).toContain("Agent is working on an edit");
    expect(html).toContain("prefers-reduced-motion");
    // Presence also surfaces in the dock status row (visible without hover).
    expect(html).toContain(
      "Pick an element in the page — live agent not connected",
    );
    // Critique fixes: in-register inline confirm, un-pick, empty-prompt guard,
    // the slim guide banner with its disclosure, and the offline-Apply queue
    // warning with its short ack timeout.
    expect(html).toContain("Confirm apply?");
    expect(html).toContain("Cancel this pick");
    expect(html).toContain("Type a change first");
    expect(html).toContain("Show start prompt");
    expect(html).toContain("oa-live-guide-details");
    expect(html).toContain("the edit will queue until a watcher connects");
    expect(html).toContain("agentOnline===false?20000:ACK_TIMEOUT");
    // Deepening round: queued-edit cancel pill, Send all on the bar, armed
    // Exit, safe-area insets, and the queued stall hint.
    expect(html).toContain("Queued (");
    expect(html).toContain("click to cancel");
    expect(html).toContain("Send all (");
    expect(html).toContain("changes?");
    expect(html).toContain("live/events/");
    expect(html).toContain("env(safe-area-inset-bottom)");
    expect(html).toContain(
      "the edit is queued and will apply when a watcher connects",
    );
    // Touch: coarse pointers get WCAG-friendly targets for the live chrome.
    expect(html).toContain("(pointer:coarse)");
    // done-branch discrimination: the protocol field decides, lastSubmitType backs it up.
    expect(html).toContain("Array.isArray(msg.appliedEntryIds)");
    expect(html).toContain("lastSubmitType==='edit'");
  });

  it("the frame picker carries the inline edit-mode machinery and a single message listener", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await fetchWith(new Request(`${BASE}/a/${id}/frame`), ON);
    const html = await res.text();
    expect(html).toContain("contenteditable");
    expect(html).toContain("data-original-text");
    expect(html).toContain("oa:live:edit:data");
    expect(html).toContain("oa:live:edit:none");
    expect(html).toContain("oa:live:edit:rejected");
    // Editable-row affordance (dashed outline + focus ring) and the plain-text
    // paste strip ship with the edit mode.
    expect(html).toContain("data-oa-editable");
    expect(html).toContain("-edit-style");
    expect(html).toContain("onEditPaste");
    // Touch: a tap selects directly on pointerdown (no mousemove hover needed).
    expect(html).toContain("e.pointerType!=='touch'");
    expect(html).toContain("onPointerDown");
    const pickerStart = html.indexOf("var PREFIX='impeccable-live'");
    expect(pickerStart).toBeGreaterThanOrEqual(0);
    const pickerEnd = html.indexOf("</script>", pickerStart);
    const picker = html.slice(pickerStart, pickerEnd);
    // The duplicate listener was merged into one, and the annotation reply
    // keeps its request token (the second copy dropped it — a real bug).
    expect((picker.match(/addEventListener\('message'/g) ?? []).length).toBe(1);
    expect(picker).toContain("sendAnnots(m.req)");
  });
});
