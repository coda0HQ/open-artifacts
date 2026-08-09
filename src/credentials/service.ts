import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import { generateWriteToken, sha256Hex } from "../tokens";

export type CredentialStatus = "active" | "grace" | "revoked" | "expired";

export interface CredentialSummary {
  id: string;
  status: CredentialStatus;
  primary: boolean;
  createdAt: string;
  expiresAt: string | null;
  graceUntil: string | null;
  revokedAt: string | null;
  replacedBy: string | null;
  actorId: string;
}

interface CredentialRow {
  id: string;
  status: "active" | "grace" | "revoked";
  created_at: string;
  expires_at: string | null;
  grace_until: string | null;
  revoked_at: string | null;
  replaced_by: string | null;
  actor_id: string;
  primary_credential: number;
}

export class CredentialRotationConflictError extends Error {
  readonly code = "CREDENTIAL_ROTATION_CONFLICT";

  constructor() {
    super("the primary credential changed before rotation committed");
    this.name = "CredentialRotationConflictError";
  }
}

export class CredentialService {
  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async isAuthorized(
    artifactId: string,
    tokenHash: string,
    primaryTokenHash: string,
  ): Promise<boolean> {
    const now = this.clock.now();
    const matching = await this.db
      .prepare(
        `SELECT status, expires_at, grace_until
         FROM credentials
         WHERE artifact_id = ? AND token_hash = ?`,
      )
      .bind(artifactId, tokenHash)
      .first<{
        status: "active" | "grace" | "revoked";
        expires_at: string | null;
        grace_until: string | null;
      }>();
    if (matching) {
      if (matching.status === "active") {
        return matching.expires_at === null || matching.expires_at > now;
      }
      if (matching.status === "grace") {
        return matching.grace_until !== null && matching.grace_until > now;
      }
      return false;
    }

    const count = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM credentials WHERE artifact_id = ?",
      )
      .bind(artifactId)
      .first<{ count: number }>();
    // Compatibility for an installation between application deploy and the
    // v3 backfill. Once any lifecycle row exists, the ledger is authoritative.
    return (count?.count ?? 0) === 0 && tokenHash === primaryTokenHash;
  }

  async rotate(input: {
    artifactId: string;
    currentTokenHash: string;
    actorId: string;
    graceSeconds: number;
  }): Promise<{
    credentialId: string;
    token: string;
    graceUntil: string | null;
  }> {
    if (
      !Number.isInteger(input.graceSeconds) ||
      input.graceSeconds < 0 ||
      input.graceSeconds > 300
    ) {
      throw new Error("graceSeconds must be an integer from 0 to 300");
    }
    const now = this.clock.now();
    const graceUntil =
      input.graceSeconds > 0
        ? new Date(Date.parse(now) + input.graceSeconds * 1000).toISOString()
        : null;
    const token = generateWriteToken();
    const tokenHash = await sha256Hex(token);
    const credentialId = this.ids.next("cred");
    const oldStatus = graceUntil ? "grace" : "revoked";
    const oldCredentialId = `cred_legacy_${input.artifactId}`;
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO credentials (
             id, artifact_id, token_hash, status, created_at, actor_id
           )
           SELECT ?, id, token_hash, 'active', created_at, 'legacy-adoption'
           FROM artifacts WHERE id = ? AND token_hash = ?`,
        )
        .bind(oldCredentialId, input.artifactId, input.currentTokenHash),
      this.db
        .prepare(
          `UPDATE credentials
           SET status = ?, grace_until = ?, revoked_at = ?, replaced_by = ?
           WHERE artifact_id = ? AND token_hash = ? AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM artifacts WHERE id = ? AND token_hash = ?
             )`,
        )
        .bind(
          oldStatus,
          graceUntil,
          graceUntil ? null : now,
          credentialId,
          input.artifactId,
          input.currentTokenHash,
          input.artifactId,
          input.currentTokenHash,
        ),
      this.db
        .prepare(
          `INSERT INTO credentials (
             id, artifact_id, token_hash, status, created_at, actor_id
           )
           SELECT ?, id, ?, 'active', ?, ? FROM artifacts
           WHERE id = ? AND token_hash = ?`,
        )
        .bind(
          credentialId,
          tokenHash,
          now,
          input.actorId,
          input.artifactId,
          input.currentTokenHash,
        ),
      this.db
        .prepare(
          `UPDATE artifacts SET token_hash = ?, updated_at = ?
           WHERE id = ? AND token_hash = ?`,
        )
        .bind(tokenHash, now, input.artifactId, input.currentTokenHash),
    ]);
    if ((results[3].meta.changes ?? 0) !== 1) {
      throw new CredentialRotationConflictError();
    }
    return { credentialId, token, graceUntil };
  }

  async revoke(
    artifactId: string,
    credentialId: string,
  ): Promise<{ revoked: boolean; primary: boolean }> {
    const existing = await this.db
      .prepare(
        `SELECT CASE WHEN c.token_hash = a.token_hash THEN 1 ELSE 0 END AS primary_credential
         FROM credentials c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE c.id = ? AND c.artifact_id = ?`,
      )
      .bind(credentialId, artifactId)
      .first<{ primary_credential: number }>();
    const result = await this.db
      .prepare(
        `UPDATE credentials
         SET status = 'revoked', revoked_at = ?, grace_until = NULL
         WHERE id = ? AND artifact_id = ? AND status != 'revoked'`,
      )
      .bind(this.clock.now(), credentialId, artifactId)
      .run();
    return {
      revoked: (result.meta.changes ?? 0) === 1,
      primary: existing?.primary_credential === 1,
    };
  }

  async recover(input: {
    artifactId: string;
    actorId: string;
  }): Promise<{ credentialId: string; token: string }> {
    const now = this.clock.now();
    const token = generateWriteToken();
    const tokenHash = await sha256Hex(token);
    const credentialId = this.ids.next("cred");
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE credentials
           SET status = 'revoked', revoked_at = ?, grace_until = NULL
           WHERE artifact_id = ? AND status != 'revoked'`,
        )
        .bind(now, input.artifactId),
      this.db
        .prepare(
          `INSERT INTO credentials (
             id, artifact_id, token_hash, status, created_at, actor_id
           )
           SELECT ?, id, ?, 'active', ?, ? FROM artifacts WHERE id = ?`,
        )
        .bind(credentialId, tokenHash, now, input.actorId, input.artifactId),
      this.db
        .prepare(
          "UPDATE artifacts SET token_hash = ?, updated_at = ? WHERE id = ?",
        )
        .bind(tokenHash, now, input.artifactId),
    ]);
    if ((results[2].meta.changes ?? 0) !== 1) {
      throw new Error("artifact disappeared during credential recovery");
    }
    return { credentialId, token };
  }

  async list(artifactId: string): Promise<CredentialSummary[]> {
    const rows = await this.db
      .prepare(
        `SELECT c.id, c.status, c.created_at, c.expires_at, c.grace_until,
                c.revoked_at, c.replaced_by, c.actor_id,
                CASE WHEN c.token_hash = a.token_hash THEN 1 ELSE 0 END
                  AS primary_credential
         FROM credentials c
         JOIN artifacts a ON a.id = c.artifact_id
         WHERE c.artifact_id = ? ORDER BY c.created_at, c.id`,
      )
      .bind(artifactId)
      .all<CredentialRow>();
    const now = this.clock.now();
    return rows.results.map((row) => ({
      id: row.id,
      primary: row.primary_credential === 1,
      status:
        (row.status === "active" &&
          row.expires_at !== null &&
          row.expires_at <= now) ||
        (row.status === "grace" &&
          row.grace_until !== null &&
          row.grace_until <= now)
          ? "expired"
          : row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      graceUntil: row.grace_until,
      revokedAt: row.revoked_at,
      replacedBy: row.replaced_by,
      actorId: row.actor_id,
    }));
  }
}
