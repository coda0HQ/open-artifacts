import { sha256Hex } from "./tokens";

export type TelemetryRoute =
  | "health"
  | "create"
  | "artifact_read"
  | "artifact_update"
  | "artifact_delete"
  | "comment"
  | "handoff"
  | "credential"
  | "live_connect"
  | "live_draft"
  | "checkpoint"
  | "rollback"
  | "live_coordination"
  | "reconcile"
  | "viewer"
  | "og"
  | "asset"
  | "other";

export interface RequestContext {
  requestId: string;
  traceId: string;
  actorId: string;
  artifactId: string | null;
  route: TelemetryRoute;
  method: string;
  startedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i;

function artifactIdFrom(pathname: string): string | null {
  const raw = pathname.match(/^\/(?:api\/artifacts|a|og)\/([^/]+)/)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).slice(0, 128);
  } catch {
    return raw.slice(0, 128);
  }
}

export function telemetryRouteFor(request: Request): TelemetryRoute {
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname;
  if (path.startsWith("/health")) return "health";
  if (path === "/api/artifacts" && method === "POST") return "create";
  if (path.includes("/live/draft")) return "live_draft";
  if (path.endsWith("/live/checkpoint")) return "checkpoint";
  if (path.endsWith("/live/rollback")) return "rollback";
  if (/\/live(?:\/|$)/.test(path)) {
    return path.match(/\/live$/) && method === "GET"
      ? "live_connect"
      : "live_coordination";
  }
  if (path.includes("/comments")) return "comment";
  if (path.includes("/handoffs")) return "handoff";
  if (path.includes("/credentials")) return "credential";
  if (
    path.startsWith("/api/ops/reconcile") ||
    path.startsWith("/api/internal/reconcile")
  )
    return "reconcile";
  if (/^\/api\/artifacts\/[^/]+(?:\/raw)?$/.test(path)) {
    if (method === "GET") return "artifact_read";
    if (method === "DELETE") return "artifact_delete";
    return "artifact_update";
  }
  if (path.startsWith("/a/")) return "viewer";
  if (path.startsWith("/og/")) return "og";
  if (path.startsWith("/fonts/") || path.startsWith("/vendor/")) return "asset";
  return "other";
}

export async function actorIdForRequest(request: Request): Promise<string> {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const source = bearer
    ? `credential:${bearer}`
    : `network:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
  return `actor_${await sha256Hex(source)}`;
}

export async function createRequestContext(
  request: Request,
): Promise<RequestContext> {
  const cfRay = request.headers.get("cf-ray") ?? "";
  const callerId = request.headers.get("x-request-id") ?? "";
  const requestId = SAFE_ID.test(cfRay)
    ? cfRay
    : SAFE_ID.test(callerId)
      ? callerId
      : crypto.randomUUID();
  const traceparent = request.headers.get("traceparent") ?? "";
  const traceId =
    traceparent.match(TRACEPARENT)?.[1]?.toLowerCase() ??
    crypto.randomUUID().replaceAll("-", "");
  const url = new URL(request.url);
  return {
    requestId,
    traceId,
    actorId: await actorIdForRequest(request),
    artifactId: artifactIdFrom(url.pathname),
    route: telemetryRouteFor(request),
    method: request.method.toUpperCase(),
    startedAt: new Date().toISOString(),
  };
}
