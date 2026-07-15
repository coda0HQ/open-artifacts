import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CreateInput } from "../../src/domain";
import { D1R2Store } from "../../src/store";

const INPUT: CreateInput = {
  content: "<h1>store test</h1>",
  format: "html",
  title: "Store Test",
  description: "",
  favicon: "📦",
  label: null,
  encrypted: null,
  projectRef: null,
};

describe("D1R2Store.delete", () => {
  it("removes every version object even past one R2 list page", {
    timeout: 60_000,
  }, async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "manyversions";
    await store.create(id, "hash", INPUT, null);

    // R2 list returns at most 1000 keys per page; exceed that.
    const keys = Array.from(
      { length: 1050 },
      (_, i) => `content/${id}/${i + 2}`,
    );
    for (let i = 0; i < keys.length; i += 50) {
      await Promise.all(
        keys.slice(i, i + 50).map((key) => env.CONTENT.put(key, "x")),
      );
    }

    await store.delete(id);

    const remaining = await env.CONTENT.list({ prefix: `content/${id}/` });
    expect(remaining.objects).toHaveLength(0);
    expect(remaining.truncated).toBe(false);
    expect(await store.get(id)).toBeNull();
  });
});

describe("channel uniqueness", () => {
  it("rejects a second artifact binding to an already-bound channel", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    await store.create("chanuniq0001", "hash1", INPUT, "channelhash-x");
    // The message shape is what api.ts keys its race fallback on — pin it.
    await expect(
      store.create("chanuniq0002", "hash2", INPUT, "channelhash-x"),
    ).rejects.toThrow(/UNIQUE constraint failed.*channel_hash/);
    // The loser's already-written content object is swept, not orphaned.
    expect(await env.CONTENT.get("content/chanuniq0002/1")).toBeNull();
  });

  it("still allows any number of channel-less artifacts", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    await store.create("nochannel001", "hash1", INPUT, null);
    await store.create("nochannel002", "hash2", INPUT, null);
    expect(await store.get("nochannel001")).not.toBeNull();
    expect(await store.get("nochannel002")).not.toBeNull();
  });
});

describe("feedback store round-trip", () => {
  it("stores feedback independently and lists pending oldest-first", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "fb-roundtrip1";
    await store.create(id, "hash", INPUT, null);

    const first = await store.addFeedback(id, {
      projectRef: "src/dashboard",
      body: "Add a dark chart variant",
    });
    expect(first.status).toBe("pending");
    expect(first.artifactId).toBe(id);
    // Ensure createdAt spacing so ordering is deterministic, not same-ms.
    await new Promise((r) => setTimeout(r, 10));
    const second = await store.addFeedback(id, {
      projectRef: null,
      body: "Rename the project",
    });

    const pending = await store.listFeedback(id, "pending");
    expect(pending).toHaveLength(2);
    expect(pending[0].id).toBe(first.id);
    expect(pending[1].id).toBe(second.id);
    expect(pending.map((f) => f.projectRef)).toEqual(["src/dashboard", null]);

    // Status transitions; done records drop out of pending.
    const reviewed = await store.updateFeedbackStatus(first.id, "in_review");
    expect(reviewed?.status).toBe("in_review");
    const afterProgress = await store.updateFeedbackStatus(
      first.id,
      "in_progress",
    );
    expect(afterProgress?.status).toBe("in_progress");
    const closed = await store.updateFeedbackStatus(first.id, "done");
    expect(closed?.status).toBe("done");
    const remainingPending = await store.listFeedback(id, "pending");
    expect(remainingPending).toHaveLength(1);
    expect(remainingPending[0].id).toBe(second.id);

    // Feedback is independent of artifact version: no version row was added.
    const versions = await store.listVersions(id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
  });

  it("getFeedback returns null for an unknown id", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    expect(await store.getFeedback("no-such-feedback-id")).toBeNull();
  });
});
