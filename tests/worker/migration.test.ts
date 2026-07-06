import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://artifacts.test";

// Seed the pre-migration schema directly: artifacts without channel_hash,
// versions without per-version metadata columns. ensureSchema must then add
// the missing columns and backfill them from the parent artifact.
async function seedLegacyDatabase(id: string): Promise<void> {
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

describe("in-place schema migration", () => {
  it("backfills per-version metadata from the parent artifact", async () => {
    const id = "legacyid0001";
    await seedLegacyDatabase(id);

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
});
