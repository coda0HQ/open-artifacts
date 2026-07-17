import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ensureSchemaForTests, resetSchemaMemoForTests } from "../../src/store";

const BASE = "http://artifacts.test";

async function dropAllTables(): Promise<void> {
  // Order: dependents first. IF EXISTS so a blank isolate is fine.
  for (const table of ["comments", "feedback", "versions", "artifacts"]) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await env.DB.prepare("DROP INDEX IF EXISTS idx_artifacts_channel_hash").run();
  await env.DB.prepare(
    "DROP INDEX IF EXISTS idx_comments_artifact_created",
  ).run();
  await env.DB.prepare(
    "DROP INDEX IF EXISTS idx_feedback_artifact_status",
  ).run();
  resetSchemaMemoForTests(env.DB);
}

async function columnNames(table: string): Promise<string[]> {
  const rows = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
  }>();
  return (rows.results ?? []).map((row) => row.name);
}

// Seed the pre-migration schema directly: artifacts without channel_hash,
// versions without per-version metadata columns. ensureSchema must then add
// the missing columns and backfill them from the parent artifact.
async function seedLegacyVersionsDatabase(id: string): Promise<void> {
  await dropAllTables();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      favicon TEXT NOT NULL,
      format TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      current_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE versions (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      label TEXT,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, version)
    )`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO artifacts (id, token_hash, title, description, favicon, format, encrypted, current_version, created_at, updated_at)
     VALUES (?, 'hash', 'Legacy Title', 'Legacy description', '📜', 'html', 0, 2, ?, ?)`,
  )
    .bind(id, now, now)
    .run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO versions (artifact_id, version, label, size, created_at) VALUES (?, 1, NULL, 10, ?)`,
    ).bind(id, now),
    env.DB.prepare(
      `INSERT INTO versions (artifact_id, version, label, size, created_at) VALUES (?, 2, 'v2', 12, ?)`,
    ).bind(id, now),
  ]);
}

// v1 comments shape — the three anchored-comments columns lived only in
// MIGRATIONS before #33, so a fresh-install suite never caught a SCHEMA/MIGRATIONS
// desync for this table.
async function seedLegacyCommentsDatabase(): Promise<void> {
  await dropAllTables();
  await env.DB.prepare(
    `CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      favicon TEXT NOT NULL,
      format TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      current_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      author TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  ).run();
}

describe("in-place schema migration", () => {
  it("backfills per-version metadata from the parent artifact", async () => {
    const id = "legacyid0001";
    await seedLegacyVersionsDatabase(id);

    const res = await exports.default.fetch(`${BASE}/api/artifacts/${id}`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      title: string;
      versions: Array<{
        version: number;
        title: string;
        favicon: string;
        format: string;
        encrypted: boolean;
      }>;
    };
    expect(meta.title).toBe("Legacy Title");
    expect(meta.versions).toHaveLength(2);
    for (const version of meta.versions) {
      expect(version.title).toBe("Legacy Title");
      expect(version.favicon).toBe("📜");
      expect(version.format).toBe("html");
      expect(version.encrypted).toBe(false);
    }
  });

  it("adds every SCHEMA/MIGRATIONS comments column to a v1 database", async () => {
    await seedLegacyCommentsDatabase();
    expect(await columnNames("comments")).toEqual([
      "id",
      "artifact_id",
      "author",
      "body",
      "created_at",
    ]);

    await ensureSchemaForTests(env.DB);

    const columns = await columnNames("comments");
    for (const required of ["anchor", "delete_token_hash", "done"]) {
      expect(columns).toContain(required);
    }
  });

  it("retries after an unexpected migration failure instead of memoizing success", async () => {
    await dropAllTables();
    const bad = [
      "ALTER TABLE this_table_does_not_exist ADD COLUMN x TEXT",
    ] as const;

    await expect(
      ensureSchemaForTests(env.DB, { migrations: bad }),
    ).rejects.toThrow();

    // If the rejected attempt stayed memoized, this would return the same
    // rejection and never recover. Clearing the memo lets a later call succeed.
    await ensureSchemaForTests(env.DB);
    const columns = await columnNames("comments");
    for (const required of ["anchor", "delete_token_hash", "done"]) {
      expect(columns).toContain(required);
    }
  });
});
