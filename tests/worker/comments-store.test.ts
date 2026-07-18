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
    // Posting order, asserted directly. These two land in the same millisecond,
    // so created_at ties and the tiebreak alone decides the answer — which is
    // the case worth pinning, not one to assert around.
    expect(list.map((c) => c.body)).toEqual(["first", "second"]);
    expect(list[0]?.author).toBe("A");
    expect(list[1]?.author).toBeNull();
    expect(list.every((c) => c.artifactId === id)).toBe(true);
    expect(list.every((c) => c.id.length > 0)).toBe(true);
  });

  // Real ids are random, so a same-millisecond thread can come back in any
  // order — which makes addComment useless for pinning this: the clock usually
  // ticks mid-loop and hides the tie. These write created_at by hand so every
  // row shares one, and hand out ids that run *opposite* to insertion, which is
  // simply the worst of the orders a random id could have produced. Insertion
  // order must survive that, so the tiebreak cannot be the id.
  async function seedSameMillisecond(
    id: string,
    count: number,
  ): Promise<string[]> {
    const stamp = "2020-01-01T00:00:00.000Z";
    for (let i = 0; i < count; i++) {
      const descending = String(count - 1 - i).padStart(4, "0");
      // Namespace the comment id by artifact: this file's per-file storage
      // isolation keeps earlier tests' rows, so a bare "z0000" would collide.
      await env.DB.prepare(
        `INSERT INTO comments (id, artifact_id, author, body, anchor, delete_token_hash, created_at)
         VALUES (?, ?, null, ?, null, null, ?)`,
      )
        .bind(`${id}-z${descending}`, id, `b${i}`, stamp)
        .run();
    }
    return Array.from({ length: count }, (_, i) => `b${i}`);
  }

  it("keeps posting order for a burst written inside one millisecond", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    // Storage isolation in this pool is per file, not per test, so every test
    // here needs its own artifact id or its rows bleed into the next one's.
    const id = "cmstore0010";
    await store.create(id, "hash", artifact, null);
    const expected = await seedSameMillisecond(id, 20);
    const list = await store.listComments(id);
    expect(list.map((c) => c.body)).toEqual(expected);
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

  it("round-trips the done flag", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "cmstore0008";
    await store.create(id, "hash", artifact, null);
    const created = await store.addComment(id, {
      author: null,
      body: "todo",
      anchor: null,
    });
    expect(created.done).toBe(false);
    expect((await store.listComments(id))[0]?.done).toBe(false);
    expect(await store.setCommentDone(created.id, true)).toBe(true);
    expect((await store.listComments(id))[0]?.done).toBe(true);
    expect(await store.setCommentDone(created.id, false)).toBe(true);
    expect((await store.listComments(id))[0]?.done).toBe(false);
    expect(await store.setCommentDone("missing-id", true)).toBe(false);
  });

  it("drops the oldest when a same-millisecond burst overflows the cap", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "cmstore0011";
    await store.create(id, "hash", artifact, null);
    // 105 rows in one millisecond, ids running opposite to posting order. The
    // cap claims to keep the *newest* 100; under a random tiebreak "newest" is
    // whatever the ids happen to sort to, so the 5 dropped would be arbitrary.
    // With rowid it must be exactly the 5 oldest.
    const bodies = await seedSameMillisecond(id, 105);
    const list = await store.listComments(id);
    expect(list.length).toBe(100);
    expect(list.map((c) => c.body)).toEqual(bodies.slice(5));
    for (const dropped of bodies.slice(0, 5)) {
      expect(list.map((c) => c.body)).not.toContain(dropped);
    }
  });

  it("keeps the newest 100 comments, still ordered oldest-first", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "cmstore0007";
    await store.create(id, "hash", artifact, null);
    // Distinct timestamps here — this pins the LIMIT window itself. The
    // same-millisecond case, where the tiebreak is what answers, is above.
    for (let i = 0; i < 105; i++) {
      const ts = new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString();
      await env.DB.prepare(
        `INSERT INTO comments (id, artifact_id, author, body, anchor, delete_token_hash, created_at)
         VALUES (?, ?, null, ?, null, null, ?)`,
      )
        .bind(`c${String(i).padStart(3, "0")}`, id, `body-${i}`, ts)
        .run();
    }
    const list = await store.listComments(id);
    expect(list.length).toBe(100);
    // Newest window is body-5 … body-104; display order is chronological.
    expect(list[0]?.body).toBe("body-5");
    expect(list[99]?.body).toBe("body-104");
    expect(list.map((c) => c.body)).not.toContain("body-0");
  });
});
