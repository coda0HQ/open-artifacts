export type QuotaResource =
  | "storage_bytes"
  | "versions"
  | "comments"
  | "handoff_bytes"
  | "daily_writes"
  | "live_sessions";

export type QuotaReservationStatus = "reserved" | "committed" | "released";

export interface QuotaReservation {
  scopeKey: string;
  resource: QuotaResource;
  entityKey: string;
  amount: number;
  limit: number;
  status: QuotaReservationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveQuotaInput {
  scopeKey: string;
  resource: QuotaResource;
  entityKey: string;
  amount: number;
  limit: number;
  now: string;
}

export interface ReserveQuotaResult {
  outcome: "reserved" | "adjusted" | "replayed" | "exceeded";
  usage: number;
  limit: number;
  reservation: QuotaReservation | null;
  previous: QuotaReservation | null;
}

/** Exact, strongly serialized resource accounting. */
export interface QuotaLedger {
  reserve(input: ReserveQuotaInput): Promise<ReserveQuotaResult>;
  commit(
    scopeKey: string,
    resource: QuotaResource,
    entityKey: string,
    now: string,
  ): Promise<boolean>;
  release(
    scopeKey: string,
    resource: QuotaResource,
    entityKey: string,
    now: string,
  ): Promise<boolean>;
  releaseScope(scopeKey: string, now: string): Promise<number>;
  usage(scopeKey: string, resource: QuotaResource): Promise<number>;
}
