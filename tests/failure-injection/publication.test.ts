import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CreateInput, UpdateInput } from "../../src/domain";
import { D1R2Store } from "../../src/store";

const createInput: CreateInput = {
  content: "version one",
  format: "html",
  title: "Commit failure",
  description: "",
  favicon: "🧯",
  label: null,
  encrypted: null,
};

const updateInput: UpdateInput = {
  ...createInput,
  content: "version two",
  baseVersion: 1,
  force: false,
};

function databaseFailingBatch(database: D1Database): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async () => {
          throw new Error("injected D1 commit failure");
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("publication commit failure injection", () => {
  it("keeps Latest readable when D1 fails after a verified R2 write", async () => {
    const healthy = new D1R2Store(env.DB, env.CONTENT);
    const id = "d1commitfail";
    await healthy.create(id, "token-hash", createInput, null);
    const snapshot = await healthy.get(id);
    if (snapshot === null) throw new Error("missing fixture artifact");

    const failing = new D1R2Store(databaseFailingBatch(env.DB), env.CONTENT, {
      schemaPolicy: "validate",
    });
    await expect(
      failing.update(snapshot, updateInput, {
        actorScope: `artifact:${id}`,
        idempotencyKey: "d1-failure-0001",
      }),
    ).rejects.toThrow("injected D1 commit failure");

    expect((await healthy.get(id))?.currentVersion).toBe(1);
    expect(
      (await healthy.listVersions(id)).map(({ version }) => version),
    ).toEqual([1]);
    expect((await healthy.getContent(id, 1))?.body).toBe("version one");
    expect(
      await env.DB.prepare(
        "SELECT state FROM publications WHERE actor_scope = ? AND idempotency_key = ?",
      )
        .bind(`artifact:${id}`, "d1-failure-0001")
        .first(),
    ).toEqual({ state: "blob_ready" });
  });
});
