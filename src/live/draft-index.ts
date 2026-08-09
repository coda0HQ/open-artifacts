import type { LiveDraft } from "../ports/realtime-session-store";

/** Searchable metadata mirror; Durable Object SQLite remains draft truth. */
export class LiveDraftIndex {
  constructor(private readonly db: D1Database) {}

  async upsert(draft: LiveDraft): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO live_draft_index (
           artifact_id, protocol_version, revision, base_version, state,
           actor_id, updated_at, expires_at, checkpoint_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET
           protocol_version = excluded.protocol_version,
           revision = excluded.revision,
           base_version = excluded.base_version,
           state = excluded.state,
           actor_id = excluded.actor_id,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at,
           checkpoint_version = excluded.checkpoint_version`,
      )
      .bind(
        draft.artifactId,
        draft.protocolVersion,
        draft.revision,
        draft.baseVersion,
        draft.state,
        draft.actorId,
        draft.updatedAt,
        draft.expiresAt,
        draft.checkpointVersion,
      )
      .run();
  }
}
