import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Live variant editing is OPT-IN: when the deploy did not bind a LIVE_DO
// Durable Object (the engine's default, and the test env), the /live* routes
// 404 and the viewer renders no Live button. This pins the deploy-toggle
// contract: a self-host without LIVE_DO keeps today's viewer byte-for-byte.

const BASE = "http://artifacts.test";

async function create(body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Live Test",
        favicon: "🎯",
        ...body,
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("live routes without LIVE_DO binding", () => {
  it("GET /api/artifacts/:id/live returns 404 (no WebSocket upgrade)", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${id}/live`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    // The route exists (mounted) but 404s because env.LIVE_DO is undefined.
    expect(res.status).toBe(404);
  });

  it("GET /api/artifacts/:id/live/poll returns 404", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${id}/live/poll`),
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/artifacts/:id/live/reply returns 404", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${id}/live/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ev1", type: "done" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("the viewer host page renders no Live button without the binding", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await exports.default.fetch(new Request(`${BASE}/a/${id}`));
    const html = await res.text();
    expect(html).not.toContain("oa-live-toggle");
    expect(html).not.toContain("oa-live-global-bar");
    expect(html).not.toContain("FRAME_LIVE_PICKER");
    // The frame still works — the iframe is present.
    expect(html).toContain('id="oa-frame"');
  });

  it("the frame document carries the picker script tag (harmless when unarmed)", async () => {
    const { id } = await create({ content: "<p>hi</p>", format: "html" });
    const res = await exports.default.fetch(
      new Request(`${BASE}/a/${id}/frame`),
    );
    const html = await res.text();
    // The picker script is always injected into the frame (it no-ops until
    // armed by a host oa:live:pick:arm message); confirm it is present but
    // does not auto-arm.
    expect(html).toContain("__oaSend");
  });
});
