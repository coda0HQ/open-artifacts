import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bridgeRoute } from "../../src/wrap";

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

describe("bridgeRoute — fixed route table", () => {
  it("maps list and create to the artifact comments path", () => {
    expect(bridgeRoute("comments:list", "art_1")).toEqual({
      method: "GET",
      path: "/api/artifacts/art_1/comments",
    });
    expect(bridgeRoute("comments:create", "art_1")).toEqual({
      method: "POST",
      path: "/api/artifacts/art_1/comments",
    });
  });

  it("maps delete only with an id-shaped commentId", () => {
    expect(bridgeRoute("comments:delete", "art_1", "abc123")).toEqual({
      method: "DELETE",
      path: "/api/artifacts/art_1/comments/abc123",
    });
    expect(bridgeRoute("comments:delete", "art_1", "../../evil")).toBeNull();
    expect(bridgeRoute("comments:delete", "art_1")).toBeNull();
  });

  it("returns null for unknown or empty types", () => {
    expect(bridgeRoute("evil:exfiltrate", "art_1")).toBeNull();
    expect(bridgeRoute("", "art_1")).toBeNull();
  });

  it("never yields a path outside the artifact's own comments", () => {
    for (const type of [
      "comments:list",
      "comments:create",
      "comments:delete",
      "anything",
    ]) {
      const r = bridgeRoute(type, "art_1", "c1");
      if (r !== null) {
        expect(r.path.startsWith("/api/artifacts/art_1/comments")).toBe(true);
      }
    }
  });
});

describe("bridge scripts are injected with identity guards", () => {
  it("the artifact frame announces readiness and guards on window.parent", async () => {
    const { id } = await createArtifact();
    const html = await (
      await exports.default.fetch(`${BASE}/a/${id}/frame`)
    ).text();
    expect(html).toContain('send({type:"oa:ready"})');
    expect(html).toContain("e.source!==window.parent");
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
});
