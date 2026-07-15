import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1R2Store } from "../../src/store";

describe("D1R2Store comments", () => {
  it("persists and lists comments oldest-first", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "cmstore0001";
    // Create the artifact so listComments has a parent row for ordering tests.
    await store.create(
      id,
      "hash",
      {
        content: "<h1>x</h1>",
        format: "html",
        title: "T",
        description: "",
        favicon: "📦",
        label: null,
        encrypted: null,
      },
      null,
    );
    await store.addComment(id, { author: "A", body: "first" });
    await store.addComment(id, { author: null, body: "second" });
    const list = await store.listComments(id);
    expect(list.map((c) => c.body)).toEqual(["first", "second"]);
    expect(list[0]?.author).toBe("A");
    expect(list[1]?.author).toBeNull();
    expect(list.every((c) => c.artifactId === id)).toBe(true);
    expect(list.every((c) => c.id.length > 0)).toBe(true);
  });

  it("keeps separate threads per artifact", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const a = "cmstore0002";
    const b = "cmstore0003";
    for (const id of [a, b]) {
      await store.create(
        id,
        "hash",
        {
          content: "<h1>x</h1>",
          format: "html",
          title: "T",
          description: "",
          favicon: "📦",
          label: null,
          encrypted: null,
        },
        null,
      );
    }
    await store.addComment(a, { author: null, body: "on A" });
    await store.addComment(b, { author: null, body: "on B" });
    expect((await store.listComments(a)).map((c) => c.body)).toEqual(["on A"]);
    expect((await store.listComments(b)).map((c) => c.body)).toEqual(["on B"]);
  });
});
