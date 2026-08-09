import type {
  MetadataStore,
  PublicationPage,
  PublicationTransition,
} from "../../ports/metadata-store";
import type { Publication, PublicationState } from "../../publication/model";
import { transitionPublication } from "../../publication/model";

interface PublicationRow {
  id: string;
  artifact_id: string;
  actor_scope: string;
  idempotency_key: string;
  request_fingerprint: string;
  expected_version: number | null;
  target_version: number;
  blob_key: string;
  content_hash: string;
  state: PublicationState;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

const selectColumns = `
  id, artifact_id, actor_scope, idempotency_key, request_fingerprint,
  expected_version, target_version, blob_key, content_hash, state,
  error_code, created_at, updated_at, expires_at
`;

const toPublication = (row: PublicationRow): Publication => ({
  id: row.id,
  artifactId: row.artifact_id,
  actorScope: row.actor_scope,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  expectedVersion: row.expected_version,
  targetVersion: row.target_version,
  blobKey: row.blob_key,
  contentHash: row.content_hash,
  state: row.state,
  errorCode: row.error_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
});

export class D1MetadataStore implements MetadataStore {
  constructor(private readonly db: D1Database) {}

  async createPublication(
    publication: Publication,
  ): Promise<{ publication: Publication; created: boolean }> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO publications (
           id, artifact_id, actor_scope, idempotency_key,
           request_fingerprint, expected_version, target_version,
           blob_key, content_hash, state, error_code,
           created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        publication.id,
        publication.artifactId,
        publication.actorScope,
        publication.idempotencyKey,
        publication.requestFingerprint,
        publication.expectedVersion,
        publication.targetVersion,
        publication.blobKey,
        publication.contentHash,
        publication.state,
        publication.errorCode,
        publication.createdAt,
        publication.updatedAt,
        publication.expiresAt,
      )
      .run();
    const stored = await this.findPublicationByIdempotency(
      publication.actorScope,
      publication.idempotencyKey,
    );
    if (stored === null) {
      throw new Error("publication disappeared after creation");
    }
    return { publication: stored, created: (result.meta.changes ?? 0) === 1 };
  }

  async findPublicationById(id: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(`SELECT ${selectColumns} FROM publications WHERE id = ?`)
      .bind(id)
      .first<PublicationRow>();
    return row ? toPublication(row) : null;
  }

  async findPublicationByIdempotency(
    actorScope: string,
    idempotencyKey: string,
  ): Promise<Publication | null> {
    const row = await this.db
      .prepare(
        `SELECT ${selectColumns} FROM publications
         WHERE actor_scope = ? AND idempotency_key = ?`,
      )
      .bind(actorScope, idempotencyKey)
      .first<PublicationRow>();
    return row ? toPublication(row) : null;
  }

  async transitionPublication(
    input: PublicationTransition,
  ): Promise<Publication | null> {
    transitionPublication(input.expectedState, input.nextState);
    const result = await this.db
      .prepare(
        `UPDATE publications
         SET state = ?, error_code = ?, updated_at = ?
         WHERE id = ? AND state = ?`,
      )
      .bind(
        input.nextState,
        input.errorCode ?? null,
        input.updatedAt,
        input.id,
        input.expectedState,
      )
      .run();
    if ((result.meta.changes ?? 0) === 0) return null;
    return this.findPublicationById(input.id);
  }

  async listPublications(options: {
    state?: PublicationState;
    olderThan?: string;
    limit: number;
    cursor?: string;
  }): Promise<PublicationPage> {
    const clauses: string[] = [];
    const bindings: Array<string | number> = [];
    if (options.state !== undefined) {
      clauses.push("state = ?");
      bindings.push(options.state);
    }
    if (options.olderThan !== undefined) {
      clauses.push("updated_at < ?");
      bindings.push(options.olderThan);
    }
    if (options.cursor !== undefined) {
      clauses.push("id > ?");
      bindings.push(options.cursor);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    bindings.push(options.limit + 1);
    const rows = await this.db
      .prepare(
        `SELECT ${selectColumns} FROM publications
         ${where} ORDER BY id ASC LIMIT ?`,
      )
      .bind(...bindings)
      .all<PublicationRow>();
    const publications = rows.results.map(toPublication);
    const hasMore = publications.length > options.limit;
    const items = publications.slice(0, options.limit);
    return {
      items,
      cursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async deletePublication(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM publications WHERE id = ?")
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}
