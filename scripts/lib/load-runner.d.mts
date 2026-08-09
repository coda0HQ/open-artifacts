export type LoadOperation = "publish" | "read" | "comment" | "live";

export interface LoadOperationReport {
  requests: number;
  success: number;
  controlledRejections: number;
  serverErrors: number;
  networkErrors: number;
  unexpected: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  statuses: Record<string, number>;
}

export interface LoadReport {
  schemaVersion: 1;
  environment: "staging";
  iterations: number;
  concurrency: number;
  operations: Record<LoadOperation, LoadOperationReport>;
  summary: {
    requests: number;
    controlledRejections: number;
    serverErrors: number;
    networkErrors: number;
    unexpected: number;
  };
}

export function runLoadPlan(input: {
  baseUrl: string;
  artifactId: string;
  iterations: number;
  concurrency: number;
  authorization?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): Promise<LoadReport>;

export function assertLoadGate(report: LoadReport): true;
