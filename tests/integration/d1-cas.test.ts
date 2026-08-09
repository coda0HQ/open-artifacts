import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CreateInput } from "../../src/domain";
import { D1R2Store, ensureSchemaForTests } from "../../src/store";

const input: CreateInput = {
  content: "version one",
  format: "html",
  title: "D1 CAS",
  description: "",
  favicon: "🔒",
  label: null,
  encrypted: null,
};

const suffix = (): string =>
  crypto.randomUUID().replaceAll("-", "").slice(0, 12);

async function seedBlobReadyPublication(
  artifactId: string,
  expectedVersion: number,
): Promise<string> {
  const publicationId = `pub_cas_${suffix()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO publications (
       id, artifact_id, actor_scope, idempotency_key, request_fingerprint,
       expected_version, target_version, blob_key, content_hash, state,
       created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, 'blob_ready', ?, ?, ?)`,
  )
    .bind(
      publicationId,
      artifactId,
      `cas:${artifactId}`,
      `key:${publicationId}`,
      `fingerprint:${publicationId}`,
      expectedVersion,
      `content/${artifactId}/blobs/hash-v2`,
      "hash-v2",
      now,
      now,
      "2026-08-05T00:00:00.000Z",
    )
    .run();
  return publicationId;
}

describe("D1 publication commit primitive", () => {
  it("rolls back every statement when one statement violates a constraint", async () => {
    await ensureSchemaForTests(env.DB);
    const publicationId = `pub_rollback_${suffix()}`;
    const now = new Date().toISOString();
    const insert = () =>
      env.DB.prepare(
        `INSERT INTO publications (
           id, artifact_id, actor_scope, idempotency_key, request_fingerprint,
           expected_version, target_version, blob_key, content_hash, state,
           created_at, updated_at, expires_at
         ) VALUES (?, 'rollback-artifact', ?, ?, 'fingerprint', 1, 2,
                   'blob', 'hash', 'pending', ?, ?, ?)`,
      ).bind(
        publicationId,
        `actor:${publicationId}`,
        `key:${publicationId}`,
        now,
        now,
        "2026-08-05T00:00:00.000Z",
      );

    await expect(env.DB.batch([insert(), insert()])).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT id FROM publications WHERE id = ?")
        .bind(publicationId)
        .first(),
    ).toBeNull();
  });

  it("turns a stale CAS into conflict without exposing a version row", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const artifactId = `casstale${suffix()}`;
    await store.create(artifactId, "hash", input, null);
    const publicationId = await seedBlobReadyPublication(artifactId, 0);
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO versions (
           artifact_id, version, label, title, description, favicon, format,
           encrypted, size, created_at, blob_key, content_hash, publication_id
         )
         SELECT ?, 2, NULL, 'v2', '', '🔒', 'html', 0, 2, ?, 'blob', 'hash-v2', ?
         WHERE EXISTS (
           SELECT 1 FROM artifacts WHERE id = ? AND current_version = 0
         )`,
      ).bind(artifactId, now, publicationId, artifactId),
      env.DB.prepare(
        `UPDATE artifacts SET current_version = 2, updated_at = ?
         WHERE id = ? AND current_version = 0`,
      ).bind(now, artifactId),
      env.DB.prepare(
        `UPDATE publications
         SET state = CASE
           WHEN EXISTS (SELECT 1 FROM versions WHERE publication_id = ?)
             THEN 'committed' ELSE 'conflict' END,
             error_code = CASE
               WHEN EXISTS (SELECT 1 FROM versions WHERE publication_id = ?)
                 THEN NULL ELSE 'VERSION_CONFLICT' END,
             updated_at = ?
         WHERE id = ? AND state = 'blob_ready'`,
      ).bind(publicationId, publicationId, now, publicationId),
    ]);

    expect((await store.get(artifactId))?.currentVersion).toBe(1);
    expect(await store.listVersions(artifactId)).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT state FROM publications WHERE id = ?")
        .bind(publicationId)
        .first(),
    ).toEqual({ state: "conflict" });
  });

  it("commits version row, latest pointer, and publication state together", async () => {
    const store = new D1R2Store(env.DB, env.CONTENT);
    const artifactId = `cassuccess${suffix()}`;
    await store.create(artifactId, "hash", input, null);
    const publicationId = await seedBlobReadyPublication(artifactId, 1);
    const now = new Date().toISOString();

    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO versions (
           artifact_id, version, label, title, description, favicon, format,
           encrypted, size, created_at, blob_key, content_hash, publication_id
         )
         SELECT ?, 2, NULL, 'v2', '', '🔒', 'html', 0, 2, ?, 'blob', 'hash-v2', ?
         WHERE EXISTS (
           SELECT 1 FROM artifacts WHERE id = ? AND current_version = 1
         )`,
      ).bind(artifactId, now, publicationId, artifactId),
      env.DB.prepare(
        `UPDATE artifacts SET current_version = 2, updated_at = ?
         WHERE id = ? AND current_version = 1`,
      ).bind(now, artifactId),
      env.DB.prepare(
        `UPDATE publications SET state = 'committed', updated_at = ?
         WHERE id = ? AND state = 'blob_ready'`,
      ).bind(now, publicationId),
    ]);

    expect(results.map((result) => result.meta.changes)).toEqual([1, 1, 1]);
    expect((await store.get(artifactId))?.currentVersion).toBe(2);
    expect(await store.listVersions(artifactId)).toHaveLength(2);
    expect(
      await env.DB.prepare("SELECT state FROM publications WHERE id = ?")
        .bind(publicationId)
        .first(),
    ).toEqual({ state: "committed" });
  });
});
