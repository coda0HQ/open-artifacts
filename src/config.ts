export type EnvironmentName =
  | "development"
  | "test"
  | "preview"
  | "staging"
  | "production";
export type PublicCreateMode = "disabled" | "token" | "open";

export interface RuntimePolicy {
  environment: EnvironmentName;
  publicCreate: PublicCreateMode;
  anonymousComments: boolean;
  rateLimitMode: "local" | "cloudflare";
}

export interface RuntimeEnv {
  DB?: unknown;
  CONTENT?: unknown;
  ASSETS?: unknown;
  ENVIRONMENT?: EnvironmentName;
  PUBLIC_CREATE_MODE?: PublicCreateMode;
  ANONYMOUS_COMMENTS?: "disabled" | "enabled";
  IDEMPOTENCY_SECRET?: string;
  CREATE_TOKEN?: string;
  RATE_LIMIT_MODE?: "local" | "cloudflare";
  RATE_LIMITER?: unknown;
  KILL_SWITCH_WRITES?: "0" | "1";
  KILL_SWITCH_LIVE?: "0" | "1";
  KILL_SWITCH_COMMENTS?: "0" | "1";
}

export class RuntimeConfigError extends Error {
  readonly code = "RUNTIME_CONFIG_INVALID";

  constructor(readonly issues: readonly string[]) {
    super(`runtime configuration is invalid: ${issues.join("; ")}`);
    this.name = "RuntimeConfigError";
  }
}

export function resolveRuntimePolicy(env: RuntimeEnv): RuntimePolicy {
  const environment = env.ENVIRONMENT ?? "production";
  const nonProduction = environment === "development" || environment === "test";
  return {
    environment,
    publicCreate:
      env.PUBLIC_CREATE_MODE ?? (nonProduction ? "open" : "disabled"),
    anonymousComments:
      env.ANONYMOUS_COMMENTS !== undefined
        ? env.ANONYMOUS_COMMENTS === "enabled"
        : nonProduction,
    rateLimitMode: env.RATE_LIMIT_MODE ?? "local",
  };
}

export function validateRuntimeConfig(env: RuntimeEnv): RuntimePolicy {
  const policy = resolveRuntimePolicy(env);
  const issues: string[] = [];
  if (!env.DB) issues.push("DB binding is required");
  if (!env.CONTENT) issues.push("CONTENT binding is required");
  if (!env.ASSETS) issues.push("ASSETS binding is required");
  const remoteEnvironment =
    policy.environment !== "development" && policy.environment !== "test";
  if (remoteEnvironment) {
    if (env.PUBLIC_CREATE_MODE === undefined) {
      issues.push("PUBLIC_CREATE_MODE must be explicit in remote environments");
    }
    if (policy.publicCreate === "open") {
      issues.push(
        "PUBLIC_CREATE_MODE=open is forbidden in remote environments",
      );
    }
    if (env.ANONYMOUS_COMMENTS === undefined) {
      issues.push("ANONYMOUS_COMMENTS must be explicit in remote environments");
    }
    if (!env.IDEMPOTENCY_SECRET || env.IDEMPOTENCY_SECRET.length < 32) {
      issues.push("IDEMPOTENCY_SECRET must contain at least 32 characters");
    }
    if (env.RATE_LIMIT_MODE === undefined) {
      issues.push("RATE_LIMIT_MODE must be explicit in remote environments");
    }
  }
  for (const [name, value] of [
    ["KILL_SWITCH_WRITES", env.KILL_SWITCH_WRITES],
    ["KILL_SWITCH_LIVE", env.KILL_SWITCH_LIVE],
    ["KILL_SWITCH_COMMENTS", env.KILL_SWITCH_COMMENTS],
  ] as const) {
    if (value !== undefined && value !== "0" && value !== "1") {
      issues.push(`${name} must be "0" or "1"`);
    }
  }
  if (policy.publicCreate === "token" && !env.CREATE_TOKEN) {
    issues.push("CREATE_TOKEN is required when PUBLIC_CREATE_MODE=token");
  }
  if (policy.rateLimitMode === "cloudflare" && !env.RATE_LIMITER) {
    issues.push("RATE_LIMITER binding is required in cloudflare mode");
  }
  if (issues.length > 0) throw new RuntimeConfigError(issues);
  return policy;
}
