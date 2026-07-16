import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://artifacts.test";

async function createArtifact(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "<h1>Hello</h1>",
        title: "Bridge Test",
        favicon: "📊",
        ...overrides,
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("the frame's comment list has a single owner", () => {
  it("sends the live host state on oa:ready, not the serve-time seed", async () => {
    const { id } = await createArtifact();
    const host = await (await exports.default.fetch(`${BASE}/a/${id}`)).text();
    // On the encrypted path the bridge runs long before the frame exists (the
    // srcdoc lands only after decrypt), so oa:ready can arrive after the thread
    // has already changed. Posting inlined() there would resurrect deleted
    // comments as markers. The seed stays as the pre-init fallback.
    expect(host).toContain("window.__oaLiveComments=function(){return state}");
    expect(host).toContain(
      "list:(window.__oaLiveComments?window.__oaLiveComments():inlined())",
    );
  });
});

describe("the frame cannot drive a host request", () => {
  it("builds every request URL from the serve-time id, never from a message", async () => {
    const { id } = await createArtifact();
    const host = await (await exports.default.fetch(`${BASE}/a/${id}`)).text();
    // The host's only comment endpoints are literals built from its own ID.
    expect(host).toContain('"/api/artifacts/"+ID+"/comments"');
    expect(host).toContain('"/api/artifacts/"+ID+"/comments/"+id');
    // No message field ever reaches fetch — no url, method, path, or endpoint
    // is read off msg, so the bridge cannot be turned into an open proxy.
    for (const field of ["url", "method", "path", "endpoint", "headers"]) {
      expect(host).not.toContain(`msg.${field}`);
    }
  });
});

describe("bridge scripts are injected with identity guards", () => {
  it("the artifact frame announces readiness and guards on window.parent", async () => {
    const { id } = await createArtifact();
    const html = await (
      await exports.default.fetch(`${BASE}/a/${id}/frame`)
    ).text();
    // The ready message carries the detected mode (canvas vs document) so the
    // host can swap the pin tool in and out.
    expect(html).toContain('send({type:"oa:ready",mode:window.__oaMode})');
    expect(html).toContain("e.source!==window.parent");
  });

  it("detects canvas mode in the frame and swaps the host pin tool", async () => {
    const { id } = await createArtifact();
    const host = await (await exports.default.fetch(`${BASE}/a/${id}`)).text();
    const frame = await (
      await exports.default.fetch(`${BASE}/a/${id}/frame`)
    ).text();
    // Frame derives its mode from the transformed plane of a canvas artifact.
    expect(frame).toContain("querySelector('.oa-plane')");
    // Host: canvas → show pin tool; document → hide it. The drawer toggle stays
    // in both modes, so the whole thread is always reachable.
    expect(host).toContain('msg.mode==="canvas"');
    expect(host).toContain('querySelector(".oa-cm-tool")');
    expect(host).toContain('tool.style.display="none"');
    expect(host).not.toContain('tg.style.display="none"');
    // Plain documents start with the pin tool hidden (selection chip only).
    expect(host).toContain('if(!encrypted)arm.style.display="none"');
  });

  it("the host page guards on the frame window and inlines only public comment fields", async () => {
    const { id } = await createArtifact();
    await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "on the board", author: "Dana" }),
      }),
    );
    const html = await (await exports.default.fetch(`${BASE}/a/${id}`)).text();
    // Source-identity guard, not origin.
    expect(html).toContain("e.source!==frame.contentWindow");
    // The public list is inlined for the host to forward to the frame.
    expect(html).toContain('id="oa-cm-data"');
    expect(html).toContain("on the board");
    // The relay never interpolates a frame-supplied URL into fetch.
    expect(html).not.toContain("fetch(msg.url");
    expect(html).not.toContain("fetch(e.data.url");
  });

  it("tells the frame whether the artifact is encrypted (REQ-017)", async () => {
    const { id } = await createArtifact();
    const host = await (await exports.default.fetch(`${BASE}/a/${id}`)).text();
    const frame = await (
      await exports.default.fetch(`${BASE}/a/${id}/frame`)
    ).text();
    expect(host).toContain('type:"oa:config"');
    expect(host).toContain("encrypted:");
    expect(frame).toContain('msg.type==="oa:config"');
    expect(frame).toContain("__oaEncrypted");
  });
});
