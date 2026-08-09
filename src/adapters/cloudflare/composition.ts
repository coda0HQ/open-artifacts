import type { Bindings } from "../../api";
import {
  RuntimeConfigError,
  type RuntimePolicy,
  resolveRuntimePolicy,
  validateRuntimeConfig,
} from "../../config";
import type { RateLimiter } from "../../ports/rate-limiter";
import { quotaLimitsFromEnv } from "../../quota/service";
import { type ArtifactStore, D1R2Store } from "../../store";
import type { Telemetry } from "../../telemetry";
import { MemoryRateLimiter } from "../memory/rate-limiter";
import { CloudflareRateLimiter } from "./rate-limiter";

export interface CloudflareFeatures {
  live: boolean;
  handoff: boolean;
  webFonts: boolean;
}

export interface CloudflareKillSwitches {
  writes: boolean;
  live: boolean;
  comments: boolean;
}

export interface CloudflareComposition {
  store: ArtifactStore;
  rateLimiter: RateLimiter;
  runtime: RuntimePolicy;
  features: CloudflareFeatures;
}

const localRateLimiters = new WeakMap<object, RateLimiter>();

export function featureFlagsFromBindings(
  env: Partial<
    Pick<
      Bindings,
      "LIVE_DO" | "OPEN_ARTIFACTS_HANDOFF" | "OPEN_ARTIFACTS_WEB_FONTS"
    >
  >,
): CloudflareFeatures {
  return {
    live: env.LIVE_DO !== undefined,
    handoff: env.OPEN_ARTIFACTS_HANDOFF === "1",
    webFonts: env.OPEN_ARTIFACTS_WEB_FONTS === "1",
  };
}

export function killSwitchesFromBindings(
  env: Partial<
    Pick<
      Bindings,
      "KILL_SWITCH_WRITES" | "KILL_SWITCH_LIVE" | "KILL_SWITCH_COMMENTS"
    >
  >,
): CloudflareKillSwitches {
  return {
    writes: env.KILL_SWITCH_WRITES === "1",
    live: env.KILL_SWITCH_LIVE === "1",
    comments: env.KILL_SWITCH_COMMENTS === "1",
  };
}

export function validateCloudflareComposition(env: Bindings): RuntimePolicy {
  const runtime = validateRuntimeConfig(env);
  const invalidFlags = [
    ["OPEN_ARTIFACTS_HANDOFF", env.OPEN_ARTIFACTS_HANDOFF],
    ["OPEN_ARTIFACTS_WEB_FONTS", env.OPEN_ARTIFACTS_WEB_FONTS],
  ].filter(([, value]) => value !== undefined && value !== "" && value !== "1");
  if (invalidFlags.length > 0) {
    throw new RuntimeConfigError(
      invalidFlags.map(([name]) => `${name} must be "1" or unset`),
    );
  }
  return runtime;
}

export function createCloudflareArtifactStore(
  env: Bindings,
  telemetry?: Telemetry,
): ArtifactStore {
  const schemaPolicy =
    env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test"
      ? "migrate"
      : "validate";
  return new D1R2Store(env.DB, env.CONTENT, {
    schemaPolicy,
    quotaLimits: quotaLimitsFromEnv(env),
    telemetry,
  });
}

export function createCloudflareRateLimiter(env: Bindings): RateLimiter {
  const runtime = resolveRuntimePolicy(env);
  if (runtime.rateLimitMode === "cloudflare" && env.RATE_LIMITER) {
    return new CloudflareRateLimiter(env.RATE_LIMITER);
  }
  const key = env as object;
  const existing = localRateLimiters.get(key);
  if (existing) return existing;
  const limiter = new MemoryRateLimiter();
  localRateLimiters.set(key, limiter);
  return limiter;
}

export function composeCloudflare(
  env: Bindings,
  telemetry?: Telemetry,
): CloudflareComposition {
  return {
    store: createCloudflareArtifactStore(env, telemetry),
    rateLimiter: createCloudflareRateLimiter(env),
    runtime: validateCloudflareComposition(env),
    features: featureFlagsFromBindings(env),
  };
}
