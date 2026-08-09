import type {
  QuotaLedger,
  QuotaReservation,
  QuotaResource,
  ReserveQuotaInput,
  ReserveQuotaResult,
} from "../../ports/quota-ledger";

const keyFor = (scopeKey: string, resource: QuotaResource, entityKey: string) =>
  `${scopeKey}\u0000${resource}\u0000${entityKey}`;

const active = (reservation: QuotaReservation): boolean =>
  reservation.status === "reserved" || reservation.status === "committed";

export class MemoryQuotaLedger implements QuotaLedger {
  private readonly reservations = new Map<string, QuotaReservation>();

  private usageNow(scopeKey: string, resource: QuotaResource): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (
        reservation.scopeKey === scopeKey &&
        reservation.resource === resource &&
        active(reservation)
      ) {
        total += reservation.amount;
      }
    }
    return total;
  }

  async reserve(input: ReserveQuotaInput): Promise<ReserveQuotaResult> {
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
      throw new Error("quota amount must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
      throw new Error("quota limit must be a non-negative safe integer");
    }
    const key = keyFor(input.scopeKey, input.resource, input.entityKey);
    const existing = this.reservations.get(key);
    if (existing && active(existing) && existing.amount === input.amount) {
      return {
        outcome: "replayed",
        usage: this.usageNow(input.scopeKey, input.resource),
        limit: input.limit,
        reservation: { ...existing },
        previous: { ...existing },
      };
    }
    const withoutExisting =
      this.usageNow(input.scopeKey, input.resource) -
      (existing && active(existing) ? existing.amount : 0);
    if (withoutExisting + input.amount > input.limit) {
      return {
        outcome: "exceeded",
        usage:
          withoutExisting +
          (existing && active(existing) ? existing.amount : 0),
        limit: input.limit,
        reservation: existing ? { ...existing } : null,
        previous: existing ? { ...existing } : null,
      };
    }
    const reservation: QuotaReservation = {
      scopeKey: input.scopeKey,
      resource: input.resource,
      entityKey: input.entityKey,
      amount: input.amount,
      limit: input.limit,
      status: "reserved",
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.reservations.set(key, reservation);
    return {
      outcome: existing && active(existing) ? "adjusted" : "reserved",
      usage: withoutExisting + input.amount,
      limit: input.limit,
      reservation: { ...reservation },
      previous: existing ? { ...existing } : null,
    };
  }

  async commit(
    scopeKey: string,
    resource: QuotaResource,
    entityKey: string,
    now: string,
  ): Promise<boolean> {
    const reservation = this.reservations.get(
      keyFor(scopeKey, resource, entityKey),
    );
    if (!reservation || reservation.status === "released") return false;
    reservation.status = "committed";
    reservation.updatedAt = now;
    return true;
  }

  async release(
    scopeKey: string,
    resource: QuotaResource,
    entityKey: string,
    now: string,
  ): Promise<boolean> {
    const reservation = this.reservations.get(
      keyFor(scopeKey, resource, entityKey),
    );
    if (!reservation || reservation.status === "released") return false;
    reservation.status = "released";
    reservation.updatedAt = now;
    return true;
  }

  async releaseScope(scopeKey: string, now: string): Promise<number> {
    let changed = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.scopeKey === scopeKey && active(reservation)) {
        reservation.status = "released";
        reservation.updatedAt = now;
        changed += 1;
      }
    }
    return changed;
  }

  async usage(scopeKey: string, resource: QuotaResource): Promise<number> {
    return this.usageNow(scopeKey, resource);
  }
}
