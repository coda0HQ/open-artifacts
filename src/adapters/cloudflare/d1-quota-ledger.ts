import type {
  QuotaLedger,
  QuotaReservation,
  QuotaReservationStatus,
  QuotaResource,
  ReserveQuotaInput,
  ReserveQuotaResult,
} from "../../ports/quota-ledger";

interface QuotaRow {
  scope_key: string;
  resource: QuotaResource;
  entity_key: string;
  amount: number;
  limit_value: number;
  status: QuotaReservationStatus;
  created_at: string;
  updated_at: string;
}

const toReservation = (row: QuotaRow): QuotaReservation => ({
  scopeKey: row.scope_key,
  resource: row.resource,
  entityKey: row.entity_key,
  amount: row.amount,
  limit: row.limit_value,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const isActive = (row: QuotaRow): boolean => row.status !== "released";

export class D1QuotaLedger implements QuotaLedger {
  constructor(private readonly db: D1Database) {}

  private async find(
    scopeKey: string,
    resource: QuotaResource,
    entityKey: string,
  ): Promise<QuotaRow | null> {
    return this.db
      .prepare(
        `SELECT scope_key, resource, entity_key, amount, limit_value, status,
                created_at, updated_at
         FROM quota_reservations
         WHERE scope_key = ? AND resource = ? AND entity_key = ?`,
      )
      .bind(scopeKey, resource, entityKey)
      .first<QuotaRow>();
  }

  async reserve(input: ReserveQuotaInput): Promise<ReserveQuotaResult> {
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
      throw new Error("quota amount must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
      throw new Error("quota limit must be a non-negative safe integer");
    }
    const existing = await this.find(
      input.scopeKey,
      input.resource,
      input.entityKey,
    );
    if (existing && isActive(existing) && existing.amount === input.amount) {
      return {
        outcome: "replayed",
        usage: await this.usage(input.scopeKey, input.resource),
        limit: input.limit,
        reservation: toReservation(existing),
        previous: toReservation(existing),
      };
    }
    try {
      if (existing) {
        const updated = await this.db
          .prepare(
            `UPDATE quota_reservations
             SET amount = ?, limit_value = ?, status = 'reserved', updated_at = ?
             WHERE scope_key = ? AND resource = ? AND entity_key = ?`,
          )
          .bind(
            input.amount,
            input.limit,
            input.now,
            input.scopeKey,
            input.resource,
            input.entityKey,
          )
          .run();
        if ((updated.meta.changes ?? 0) === 0) return this.reserve(input);
      } else {
        await this.db
          .prepare(
            `INSERT INTO quota_reservations (
               scope_key, resource, entity_key, amount, limit_value, status,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`,
          )
          .bind(
            input.scopeKey,
            input.resource,
            input.entityKey,
            input.amount,
            input.limit,
            input.now,
            input.now,
          )
          .run();
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("QUOTA_EXCEEDED")) {
        const raced = existing
          ? null
          : await this.find(input.scopeKey, input.resource, input.entityKey);
        if (raced) {
          if (isActive(raced) && raced.amount === input.amount) {
            return {
              outcome: "replayed",
              usage: await this.usage(input.scopeKey, input.resource),
              limit: input.limit,
              reservation: toReservation(raced),
              previous: toReservation(raced),
            };
          }
          return this.reserve(input);
        }
        return {
          outcome: "exceeded",
          usage: await this.usage(input.scopeKey, input.resource),
          limit: input.limit,
          reservation: existing ? toReservation(existing) : null,
          previous: existing ? toReservation(existing) : null,
        };
      }
      if (
        !existing &&
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        return this.reserve(input);
      }
      throw error;
    }
    const reservation = await this.find(
      input.scopeKey,
      input.resource,
      input.entityKey,
    );
    if (!reservation) throw new Error("quota reservation disappeared");
    return {
      outcome: existing && isActive(existing) ? "adjusted" : "reserved",
      usage: await this.usage(input.scopeKey, input.resource),
      limit: input.limit,
      reservation: toReservation(reservation),
      previous: existing ? toReservation(existing) : null,
    };
  }

  async commit(
    scopeKey: string,
    resource: QuotaResource,
    entityKey: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE quota_reservations
         SET status = 'committed', updated_at = ?
         WHERE scope_key = ? AND resource = ? AND entity_key = ?
           AND status IN ('reserved', 'committed')`,
      )
      .bind(now, scopeKey, resource, entityKey)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async release(
    scopeKey: string,
    resource: QuotaResource,
    entityKey: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE quota_reservations
         SET status = 'released', updated_at = ?
         WHERE scope_key = ? AND resource = ? AND entity_key = ?
           AND status IN ('reserved', 'committed')`,
      )
      .bind(now, scopeKey, resource, entityKey)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async releaseScope(scopeKey: string, now: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE quota_reservations
         SET status = 'released', updated_at = ?
         WHERE scope_key = ? AND status IN ('reserved', 'committed')`,
      )
      .bind(now, scopeKey)
      .run();
    return result.meta.changes ?? 0;
  }

  async usage(scopeKey: string, resource: QuotaResource): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS used
         FROM quota_reservations
         WHERE scope_key = ? AND resource = ?
           AND status IN ('reserved', 'committed')`,
      )
      .bind(scopeKey, resource)
      .first<{ used: number }>();
    return Number(row?.used ?? 0);
  }
}
