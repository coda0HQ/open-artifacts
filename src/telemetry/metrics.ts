import type { TelemetryRoute } from "../request-context";
import type { StructuredLogger } from "./logger";

export type MetricName =
  | "http_request"
  | "publication_operation"
  | "publication_state_failure"
  | "storage_operation"
  | "stale_publication"
  | "missing_blob"
  | "rate_limited"
  | "quota_exhausted"
  | "auth_failure"
  | "migration_incompatible"
  | "live_operation"
  | "storage_growth";

export interface MetricInput {
  value: number;
  durationMs?: number;
  route?: string;
  operation?: string;
  result?: string;
  status?: number;
}

export interface MetricsDataset {
  writeDataPoint(event?: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

const ROUTES = new Set<TelemetryRoute>([
  "health",
  "create",
  "artifact_read",
  "artifact_update",
  "artifact_delete",
  "comment",
  "handoff",
  "credential",
  "live_connect",
  "live_draft",
  "checkpoint",
  "rollback",
  "live_coordination",
  "reconcile",
  "viewer",
  "og",
  "asset",
  "other",
]);
const OPERATIONS = new Set([
  "create",
  "update",
  "delete",
  "read",
  "comment",
  "channel",
  "handoff",
  "checkpoint",
  "rollback",
  "draft_save",
  "live_connect",
  "reconcile",
  "d1",
  "r2",
  "other",
]);
const RESULTS = new Set([
  "success",
  "failure",
  "conflict",
  "limited",
  "exhausted",
  "missing",
  "stale",
  "replayed",
  "cancelled",
  "other",
]);

const bounded = (value: string | undefined, values: Set<string>): string =>
  value && values.has(value) ? value : "other";

const statusClass = (status: number | undefined): string =>
  status && status >= 100 && status <= 599
    ? `${Math.floor(status / 100)}xx`
    : "none";

const environmentIndex = (environment: string): string =>
  ["development", "test", "preview", "staging", "production"].includes(
    environment,
  )
    ? environment
    : "unknown";

export class MetricsRecorder {
  constructor(
    private readonly dataset: MetricsDataset | undefined,
    private readonly logger: StructuredLogger,
    private readonly environment: string,
  ) {}

  record(name: MetricName, input: MetricInput): void {
    const route = bounded(input.route, ROUTES as Set<string>);
    const operation = bounded(input.operation, OPERATIONS);
    const result = bounded(input.result, RESULTS);
    const status = statusClass(input.status);
    const value = Number.isFinite(input.value) ? input.value : 0;
    const durationMs =
      input.durationMs !== undefined && Number.isFinite(input.durationMs)
        ? Math.max(0, input.durationMs)
        : 0;
    const point = {
      indexes: [environmentIndex(this.environment)],
      blobs: [name, route, operation, result, status],
      doubles: [value, durationMs, input.status ?? 0],
    };
    this.logger.info("metric.recorded", {
      metric: name,
      route,
      operation,
      result,
      status,
      value,
      durationMs,
    });
    if (!this.dataset) return;
    try {
      this.dataset.writeDataPoint(point);
    } catch (error) {
      this.logger.warn("metric.write_failed", { metric: name, error });
    }
  }
}
