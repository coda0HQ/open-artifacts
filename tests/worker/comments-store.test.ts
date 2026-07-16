import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1R2Store } from "../../src/store";

const artifact = {
  content: "<h1>x</h1>",
  format: "html" as const,
  title: "T",
  description: "",
  favicon: "📦",
  label: null,
  encrypted: null,
};

describe("D1R2Store comments", () => {
  it("persists and lists comments oldest-first", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "cmstore0001";
    // Create the artifact so listComments has a parent row.
    await store.create(id, "hash", artifact, null);
    await store.addComment(id, { author: "A", body: "first", anchor: null });
    await store.addComment(id, { author: null, body: "second", anchor: null });
    const list = await store.listComments(id);
    // Assert membership + fields, not exact order: two comments written in the
    // same millisecond tie-break on the random id (ORDER BY created_at, id), so
    // sub-millisecond ordering is not a testable guarantee.
    const byBody = new Map(list.map((c) => [c.body, c]));
    expect([...byBody.keys()].sort()).toEqual(["first", "second"]);
    expect(byBody.get("first")?.author).toBe("A");
    expect(byBody.get("second")?.author).toBeNull();
    expect(list.every((c) => c.artifactId === id)).toBe(true);
    expect(list.every((c) => c.id.length > 0)).toBe(true);
  });

  it("keeps separate threads per artifact", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const a = "cmstore0002";
    const b = "cmstore0003";
    for (const id of [a, b]) {
      await store.create(id, "hash", artifact, null);
    }
    await store.addComment(a, { author: null, body: "on A", anchor: null });
    await store.addComment(b, { author: null, body: "on B", anchor: null });
    expect((await store.listComments(a)).map((c) => c.body)).toEqual(["on A"]);
    expect((await store.listComments(b)).map((c) => c.body)).toEqual(["on B"]);
  });

  it("round-trips a point anchor as a parsed object", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "cmstore0004";
    await store.create(id, "hash", artifact, null);
    await store.addComment(
      id,
      {
        author: "Dana",
        body: "off-center",
        anchor: { mode: "point", x: 100, y: 100, anchorVersion: 1 },
      },
      null,
    );
    const [comment] = await store.listComments(id);
    expect(comment?.anchor).toEqual({
      mode: "point",
      x: 100,
      y: 100,
      anchorVersion: 1,
    });
  });

  it("reads a legacy unanchored comment as anchor null", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "cmstore0005";
    await store.create(id, "hash", artifact, null);
    await store.addComment(id, { author: null, body: "plain", anchor: null });
    const [comment] = await store.listComments(id);
    expect(comment?.anchor).toBeNull();
  });

  it("stores a delete-token hash and deletes by comment id", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "cmstore0006";
    await store.create(id, "hash", artifact, null);
    const created = await store.addComment(
      id,
      { author: null, body: "deletable", anchor: null },
      "hashed-delete-token",
    );
    const got = await store.getComment(created.id);
    expect(got?.artifactId).toBe(id);
    expect(got?.deleteTokenHash).toBe("hashed-delete-token");
    await store.deleteComment(created.id);
    expect((await store.listComments(id)).length).toBe(0);
    expect(await store.getComment(created.id)).toBeNull();
  });
});
