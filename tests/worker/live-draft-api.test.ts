import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/api";
import { createApp } from "../../src/app";
import type { Authorizer } from "../../src/authorizer";

const BASE = "http://artifacts.test";
const owner: Authorizer = {
  authorizeCreate: async () => ({
    ownerId: "live-owner",
    orgId: null,
    visibility: "public",
  }),
  authorizeView: async () => true,
  authorizeWrite: async () => true,
  canManage: async () => true,
};
const app = createApp(owner);

async function fetchWith(
  request: Request,
  environment: Bindings = env,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(request, environment, context);
  await waitOnExecutionContext(context);
  return response;
}

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function create(): Promise<{ id: string }> {
  const response = await fetchWith(
    jsonRequest("POST", "/api/artifacts", {
      content: "<p>published v1</p>",
      title: "Draft API",
      favicon: "🎯",
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function saveDraft(id: string, expectedRevision = 0, baseVersion = 1) {
  return fetchWith(
    jsonRequest("PUT", `/api/artifacts/${id}/live/draft`, {
      protocolVersion: 1,
      expectedRevision,
      baseVersion,
      content: `<p>draft revision ${expectedRevision + 1}</p>`,
      format: "html",
    }),
  );
}

describe("Live draft v1 API", () => {
  it("persists a draft revision without changing the published version", async () => {
    const { id } = await create();
    const saved = await saveDraft(id);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      draft: { revision: 1, baseVersion: 1, state: "active" },
    });
    const metadata = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}`),
    );
    expect(await metadata.json()).toMatchObject({ version: 1 });
    const recovered = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/draft`),
    );
    expect(await recovered.json()).toMatchObject({
      draft: { revision: 1, payload: { content: "<p>draft revision 1</p>" } },
    });
  });

  it("rejects a stale editor and retains the winning revision", async () => {
    const { id } = await create();
    expect((await saveDraft(id)).status).toBe(200);
    const stale = await saveDraft(id);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "REVISION_CONFLICT",
      currentRevision: 1,
    });
    const recovered = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/draft`),
    );
    expect(await recovered.text()).not.toContain("draft revision 2");
  });

  it("preserves a draft when its base checkpoint is stale", async () => {
    const { id } = await create();
    expect((await saveDraft(id)).status).toBe(200);
    const ordinary = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}`, {
        content: "<p>ordinary v2</p>",
        baseVersion: 1,
      }),
    );
    expect(ordinary.status).toBe(200);
    const checkpoint = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/checkpoint`, {
        protocolVersion: 1,
        expectedRevision: 1,
      }),
    );
    expect(checkpoint.status).toBe(409);
    expect(await checkpoint.json()).toMatchObject({
      code: "CHECKPOINT_CONFLICT",
      currentVersion: 2,
    });
    const recovered = await fetchWith(
      new Request(`${BASE}/api/artifacts/${id}/live/draft`),
    );
    expect(await recovered.json()).toMatchObject({
      draft: {
        state: "conflict",
        payload: { content: "<p>draft revision 1</p>" },
      },
    });
  });

  it("rolls historical content forward as a new immutable version", async () => {
    const { id } = await create();
    const before = await (
      await fetchWith(new Request(`${BASE}/api/artifacts/${id}/raw?v=1`))
    ).text();
    expect(
      (
        await fetchWith(
          jsonRequest("PUT", `/api/artifacts/${id}`, {
            content: "<p>published v2</p>",
            baseVersion: 1,
          }),
        )
      ).status,
    ).toBe(200);
    const rollback = await fetchWith(
      jsonRequest("POST", `/api/artifacts/${id}/live/rollback`, { version: 1 }),
    );
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({
      version: 3,
      rolledBackFrom: 1,
    });
    const after = await (
      await fetchWith(new Request(`${BASE}/api/artifacts/${id}/raw?v=1`))
    ).text();
    const latest = await (
      await fetchWith(new Request(`${BASE}/api/artifacts/${id}/raw`))
    ).text();
    expect(after).toBe(before);
    expect(latest).toBe(before);
  });

  it("gives legacy direct-publish clients an explicit upgrade response", async () => {
    const { id } = await create();
    const response = await fetchWith(
      jsonRequest("PUT", `/api/artifacts/${id}/live`, { content: "legacy" }),
    );
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      code: "LIVE_PROTOCOL_UPGRADE_REQUIRED",
      supportedVersions: [1],
    });
  });

  it("enforces and releases the exact concurrent Live session quota", async () => {
    const { id } = await create();
    const limited: Bindings = { ...env, QUOTA_LIVE_SESSIONS: "1" };
    const connect = (key: string) =>
      fetchWith(
        new Request(`${BASE}/api/artifacts/${id}/live`, {
          headers: { Upgrade: "websocket", "sec-websocket-key": key },
        }),
        limited,
      );
    const first = await connect("session-one");
    expect(first.status).toBe(101);
    first.webSocket?.accept();
    const second = await connect("session-two");
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      code: "QUOTA_EXCEEDED",
      resource: "live_sessions",
    });
    first.webSocket?.close(1000, "test complete");

    let reopened: Response | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      reopened = await connect("session-three");
      if (reopened.status === 101) break;
    }
    expect(reopened?.status).toBe(101);
    reopened?.webSocket?.accept();
    reopened?.webSocket?.close(1000, "test complete");
  });
});
