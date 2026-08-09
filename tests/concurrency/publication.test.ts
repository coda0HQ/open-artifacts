import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CreateInput, UpdateInput } from "../../src/domain";
import { D1R2Store } from "../../src/store";

const createInput: CreateInput = {
  content: "version one",
  format: "html",
  title: "Concurrent publication",
  description: "",
  favicon: "🏁",
  label: null,
  encrypted: null,
};

const updateInput: UpdateInput = {
  ...createInput,
  content: "version two",
  baseVersion: 1,
  force: false,
};

describe("publication concurrency", () => {
  it("replays identical concurrent keys without duplicate visible versions", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "concurrent01";
    await store.create(id, "token-hash", createInput, null);
    const snapshot = await store.get(id);
    if (snapshot === null) throw new Error("missing fixture artifact");
    const context = {
      actorScope: `artifact:${id}`,
      idempotencyKey: "concurrent-same-0001",
    };

    const results = await Promise.all([
      store.update(snapshot, updateInput, context),
      store.update(snapshot, updateInput, context),
    ]);
    expect(results.every((result) => !("conflict" in result))).toBe(true);
    expect(new Set(results.map((result) => result.publicationId))).toHaveLength(
      1,
    );
    expect(
      (await store.listVersions(id)).map(({ version }) => version),
    ).toEqual([1, 2]);
  });

  it("selects one winner for different keys at the same baseVersion", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "concurrent02";
    await store.create(id, "token-hash", createInput, null);
    const snapshot = await store.get(id);
    if (snapshot === null) throw new Error("missing fixture artifact");

    const results = await Promise.all([
      store.update(snapshot, updateInput, {
        actorScope: `artifact:${id}`,
        idempotencyKey: "concurrent-a-0001",
      }),
      store.update(
        snapshot,
        { ...updateInput, content: "competing version" },
        {
          actorScope: `artifact:${id}`,
          idempotencyKey: "concurrent-b-0001",
        },
      ),
    ]);
    expect(results.filter((result) => "conflict" in result)).toHaveLength(1);
    expect(results.filter((result) => !("conflict" in result))).toHaveLength(1);
    expect(
      (await store.listVersions(id)).map(({ version }) => version),
    ).toEqual([1, 2]);
  });
});
