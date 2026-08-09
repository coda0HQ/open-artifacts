import type {
  LiveDraft,
  LiveDraftState,
  RealtimeSessionStore,
} from "../../ports/realtime-session-store";

interface DraftRow extends Record<string, string | number | null> {
  artifact_id: string;
  protocol_version: number;
  revision: number;
  base_version: number;
  state: LiveDraftState;
  actor_id: string;
  lease_owner: string | null;
  lease_until: string | null;
  payload: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  checkpoint_version: number | null;
}

const toDraft = (row: DraftRow): LiveDraft => ({
  artifactId: row.artifact_id,
  protocolVersion: 1,
  revision: row.revision,
  baseVersion: row.base_version,
  state: row.state,
  actorId: row.actor_id,
  leaseOwner: row.lease_owner,
  leaseUntil: row.lease_until,
  payload: JSON.parse(row.payload),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
  checkpointVersion: row.checkpoint_version,
});

export class DurableObjectRealtimeStore implements RealtimeSessionStore {
  private schemaReady = false;

  constructor(private readonly storage: DurableObjectStorage) {}

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS live_draft (
        artifact_id TEXT PRIMARY KEY,
        protocol_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        base_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        checkpoint_version INTEGER
      )`,
    );
    this.schemaReady = true;
  }

  async getDraft(artifactId: string): Promise<LiveDraft | null> {
    this.ensureSchema();
    const row = this.storage.sql
      .exec<DraftRow>(
        `SELECT artifact_id, protocol_version, revision, base_version, state,
                actor_id, lease_owner, lease_until, payload, created_at,
                updated_at, expires_at, checkpoint_version
         FROM live_draft WHERE artifact_id = ?`,
        artifactId,
      )
      .toArray()[0];
    return row ? toDraft(row) : null;
  }

  async compareAndSetDraft(
    expectedRevision: number | null,
    draft: LiveDraft,
  ): Promise<boolean> {
    this.ensureSchema();
    return this.storage.transactionSync(() => {
      const current = this.storage.sql
        .exec<{ revision: number }>(
          "SELECT revision FROM live_draft WHERE artifact_id = ?",
          draft.artifactId,
        )
        .toArray()[0];
      if (
        expectedRevision === null
          ? current !== undefined
          : current?.revision !== expectedRevision
      ) {
        return false;
      }
      if (expectedRevision === null) {
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO live_draft (
           artifact_id, protocol_version, revision, base_version, state,
           actor_id, lease_owner, lease_until, payload, created_at,
           updated_at, expires_at, checkpoint_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          draft.artifactId,
          draft.protocolVersion,
          draft.revision,
          draft.baseVersion,
          draft.state,
          draft.actorId,
          draft.leaseOwner,
          draft.leaseUntil,
          JSON.stringify(draft.payload),
          draft.createdAt,
          draft.updatedAt,
          draft.expiresAt,
          draft.checkpointVersion,
        );
      } else {
        this.storage.sql.exec(
          `UPDATE live_draft SET
         protocol_version = ?, revision = ?, base_version = ?, state = ?,
         actor_id = ?, lease_owner = ?, lease_until = ?, payload = ?,
         created_at = ?, updated_at = ?, expires_at = ?, checkpoint_version = ?
       WHERE artifact_id = ? AND revision = ?`,
          draft.protocolVersion,
          draft.revision,
          draft.baseVersion,
          draft.state,
          draft.actorId,
          draft.leaseOwner,
          draft.leaseUntil,
          JSON.stringify(draft.payload),
          draft.createdAt,
          draft.updatedAt,
          draft.expiresAt,
          draft.checkpointVersion,
          draft.artifactId,
          expectedRevision,
        );
      }
      return true;
    });
  }
}
