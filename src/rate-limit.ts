import type { Context } from "hono";
import { createCloudflareRateLimiter } from "./adapters/cloudflare/composition";
import type { AppContext } from "./api";
import { actorIdForRequest } from "./request-context";
import { sha256Hex } from "./tokens";

interface RoutePolicy {
  route: string;
  resource: string;
  limit: number;
  windowSeconds: number;
}

function policyFor(request: Request): RoutePolicy | null {
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname;
  if (method === "POST" && path === "/api/artifacts") {
    return {
      route: "create",
      resource: "global",
      limit: 60,
      windowSeconds: 60,
    };
  }
  const artifact = path.match(/^\/api\/artifacts\/([^/]+)/)?.[1];
  if (!artifact) return null;
  if (path.includes("/live")) {
    return { route: "live", resource: artifact, limit: 180, windowSeconds: 60 };
  }
  if (method === "POST" && path.endsWith("/comments")) {
    return {
      route: "comment",
      resource: artifact,
      limit: 30,
      windowSeconds: 60,
    };
  }
  if (method === "POST" && path.endsWith("/handoffs")) {
    return {
      route: "handoff",
      resource: artifact,
      limit: 10,
      windowSeconds: 60,
    };
  }
  if (["PUT", "PATCH", "DELETE"].includes(method)) {
    return {
      route: "mutation",
      resource: artifact,
      limit: 120,
      windowSeconds: 60,
    };
  }
  return null;
}

export const actorKeyForRequest = actorIdForRequest;

export async function enforceRateLimit(
  c: Context<AppContext>,
): Promise<Response | null> {
  const policy = policyFor(c.req.raw);
  if (!policy) return null;
  const limiter = createCloudflareRateLimiter(c.env);
  const actor = await actorKeyForRequest(c.req.raw);
  const scoped = await sha256Hex(`${actor}\u0000${policy.resource}`);
  const result = await limiter.consume({
    key: `rl:v1:${policy.route}:${scoped}`,
    limit: policy.limit,
    windowSeconds: policy.windowSeconds,
  });
  if (result.allowed) return null;
  c.get("telemetry").warn("rate_limit.rejected", {
    policy: policy.route,
    retryAfterSeconds: result.retryAfterSeconds,
  });
  c.get("telemetry").metric("rate_limited", {
    value: 1,
    route: c.get("requestContext").route,
    operation: "other",
    result: "limited",
    status: 429,
  });
  return c.json({ error: "rate limit exceeded", code: "RATE_LIMITED" }, 429, {
    "Retry-After": String(result.retryAfterSeconds),
  });
}
