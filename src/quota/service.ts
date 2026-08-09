import type { Clock } from "../ports/clock";
import { SystemClock } from "../ports/clock";
import type {
  QuotaLedger,
  QuotaReservation,
  QuotaResource,
  ReserveQuotaResult,
} from "../ports/quota-ledger";

export interface QuotaLimits {
  storageBytes: number;
  versions: number;
  comments: number;
  handoffBytes: number;
  dailyWrites: number;
  liveSessions: number;
}

export const DEFAULT_QUOTA_LIMITS: Readonly<QuotaLimits> = {
  storageBytes: 256 * 1024 * 1024,
  versions: 1_000,
  comments: 500,
  handoffBytes: 72 * 1024 * 1024,
  dailyWrites: 10_000,
  liveSessions: 20,
};

export interface QuotaLimitEnv {
  QUOTA_STORAGE_BYTES?: string;
  QUOTA_VERSIONS?: string;
  QUOTA_COMMENTS?: string;
  QUOTA_HANDOFF_BYTES?: string;
  QUOTA_DAILY_WRITES?: string;
  QUOTA_LIVE_SESSIONS?: string;
}

function configuredLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function quotaLimitsFromEnv(env: QuotaLimitEnv): QuotaLimits {
  return {
    storageBytes: configuredLimit(
      env.QUOTA_STORAGE_BYTES,
      DEFAULT_QUOTA_LIMITS.storageBytes,
    ),
    versions: configuredLimit(
      env.QUOTA_VERSIONS,
      DEFAULT_QUOTA_LIMITS.versions,
    ),
    comments: configuredLimit(
      env.QUOTA_COMMENTS,
      DEFAULT_QUOTA_LIMITS.comments,
    ),
    handoffBytes: configuredLimit(
      env.QUOTA_HANDOFF_BYTES,
      DEFAULT_QUOTA_LIMITS.handoffBytes,
    ),
    dailyWrites: configuredLimit(
      env.QUOTA_DAILY_WRITES,
      DEFAULT_QUOTA_LIMITS.dailyWrites,
    ),
    liveSessions: configuredLimit(
      env.QUOTA_LIVE_SESSIONS,
      DEFAULT_QUOTA_LIMITS.liveSessions,
    ),
  };
}

const resourceLimit = (
  resource: QuotaResource,
  limits: QuotaLimits,
): number => {
  switch (resource) {
    case "storage_bytes":
      return limits.storageBytes;
    case "versions":
      return limits.versions;
    case "comments":
      return limits.comments;
    case "handoff_bytes":
      return limits.handoffBytes;
    case "daily_writes":
      return limits.dailyWrites;
    case "live_sessions":
      return limits.liveSessions;
  }
};

export class QuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED";

  constructor(
    readonly resource: QuotaResource,
    readonly usage: number,
    readonly limit: number,
  ) {
    super(`${resource} quota exceeded (${usage}/${limit})`);
    this.name = "QuotaExceededError";
  }
}

export interface QuotaClaim {
  scopeKey: string;
  resource: QuotaResource;
  entityKey: string;
  amount: number;
}

interface AppliedClaim {
  claim: QuotaClaim;
  result: ReserveQuotaResult;
}

export class QuotaLease {
  constructor(
    private readonly ledger: QuotaLedger,
    private readonly applied: readonly AppliedClaim[],
    private readonly clock: Clock,
  ) {}

  async commit(): Promise<void> {
    const now = this.clock.now();
    await Promise.all(
      this.applied.map(({ claim }) =>
        this.ledger.commit(
          claim.scopeKey,
          claim.resource,
          claim.entityKey,
          now,
        ),
      ),
    );
  }

  async release(): Promise<void> {
    const now = this.clock.now();
    for (const { claim, result } of [...this.applied].reverse()) {
      await this.restorePrevious(claim, result.previous, now);
    }
  }

  private async restorePrevious(
    claim: QuotaClaim,
    previous: QuotaReservation | null,
    now: string,
  ): Promise<void> {
    if (!previous || previous.status === "released") {
      await this.ledger.release(
        claim.scopeKey,
        claim.resource,
        claim.entityKey,
        now,
      );
      return;
    }
    await this.ledger.reserve({
      scopeKey: previous.scopeKey,
      resource: previous.resource,
      entityKey: previous.entityKey,
      amount: previous.amount,
      limit: previous.limit,
      now,
    });
    if (previous.status === "committed") {
      await this.ledger.commit(
        previous.scopeKey,
        previous.resource,
        previous.entityKey,
        now,
      );
    }
  }
}

export class QuotaService {
  constructor(
    private readonly ledger: QuotaLedger,
    private readonly limits: QuotaLimits = { ...DEFAULT_QUOTA_LIMITS },
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async reserve(claims: readonly QuotaClaim[]): Promise<QuotaLease> {
    const applied: AppliedClaim[] = [];
    for (const claim of claims) {
      const result = await this.ledger.reserve({
        ...claim,
        limit: resourceLimit(claim.resource, this.limits),
        now: this.clock.now(),
      });
      if (result.outcome === "exceeded") {
        const lease = new QuotaLease(this.ledger, applied, this.clock);
        await lease.release();
        throw new QuotaExceededError(
          claim.resource,
          result.usage,
          result.limit,
        );
      }
      applied.push({ claim, result });
    }
    return new QuotaLease(this.ledger, applied, this.clock);
  }

  async releaseScope(scopeKey: string): Promise<number> {
    return this.ledger.releaseScope(scopeKey, this.clock.now());
  }

  async releaseEntity(
    scopeKey: string,
    resource: QuotaResource,
    entityKey: string,
  ): Promise<boolean> {
    return this.ledger.release(scopeKey, resource, entityKey, this.clock.now());
  }
}
