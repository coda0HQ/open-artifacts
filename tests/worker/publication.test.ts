import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CreateInput, UpdateInput } from "../../src/domain";
import { D1R2Store, IdempotencyConflictError } from "../../src/store";

const createInput: CreateInput = {
  content: "<h1>version one</h1>",
  format: "html",
  title: "Atomic publication",
  description: "",
  favicon: "🧱",
  label: null,
  encrypted: null,
};

const updateInput: UpdateInput = {
  content: "<h1>version two</h1>",
  format: "html",
  title: "Atomic publication",
  description: "",
  favicon: "🧱",
  label: null,
  encrypted: null,
  baseVersion: 1,
  force: false,
};

function bucketFailingPuts(bucket: R2Bucket): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "put") {
        return async () => {
          throw new Error("injected R2 put failure");
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function present<T>(value: T | null): T {
  expect(value).not.toBeNull();
  if (value === null) throw new Error("expected test fixture to exist");
  return value;
}

describe("atomic publication visibility", () => {
  it("keeps Latest readable when the blob write fails", async () => {
    const healthy = new D1R2Store(env.DB, env.CONTENT);
    const id = "atomicblob01";
    await healthy.create(id, "token-hash", createInput, null);
    const snapshot = await healthy.get(id);
    expect(snapshot?.currentVersion).toBe(1);

    const failing = new D1R2Store(env.DB, bucketFailingPuts(env.CONTENT), {
      schemaPolicy: "validate",
    });
    await expect(
      failing.update(present(snapshot), updateInput),
    ).rejects.toThrow("injected R2 put failure");

    const after = await healthy.get(id);
    expect(after?.currentVersion).toBe(1);
    expect(await healthy.listVersions(id)).toHaveLength(1);
    expect((await healthy.getContent(id, 1))?.body).toContain("version one");
  });

  it("replays the same publication for an actor-scoped idempotency key", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "idempotent01";
    await store.create(id, "token-hash", createInput, null);
    const context = {
      actorScope: `artifact:${id}`,
      idempotencyKey: "retry-update-0001",
    };

    const first = await store.update(
      present(await store.get(id)),
      updateInput,
      context,
    );
    expect(first).toMatchObject({ version: 2, replayed: false });

    const replay = await store.update(
      present(await store.get(id)),
      updateInput,
      context,
    );
    expect(replay).toMatchObject({
      version: 2,
      publicationId:
        "publicationId" in first ? first.publicationId : "not-a-receipt",
      replayed: true,
    });
    expect(
      (await store.listVersions(id)).map(({ version }) => version),
    ).toEqual([1, 2]);
  });

  it("rejects reuse of an idempotency key for a different payload", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const id = "idemconflict1";
    await store.create(id, "token-hash", createInput, null);
    const context = {
      actorScope: `artifact:${id}`,
      idempotencyKey: "retry-update-0002",
    };
    await store.update(present(await store.get(id)), updateInput, context);

    await expect(
      store.update(
        present(await store.get(id)),
        { ...updateInput, content: "<h1>different payload</h1>" },
        context,
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await store.get(id))?.currentVersion).toBe(2);
    expect(await store.listVersions(id)).toHaveLength(2);
  });
});
