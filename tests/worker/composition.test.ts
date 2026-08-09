import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  composeCloudflare,
  createCloudflareRateLimiter,
  featureFlagsFromBindings,
  killSwitchesFromBindings,
  validateCloudflareComposition,
} from "../../src/adapters/cloudflare/composition";
import type { Bindings } from "../../src/api";
import { RuntimeConfigError } from "../../src/config";

describe("Cloudflare composition root", () => {
  it("centralizes feature flags without consulting globals", () => {
    const bindings = env as unknown as Bindings;
    const features = featureFlagsFromBindings({
      LIVE_DO: bindings.LIVE_DO,
      OPEN_ARTIFACTS_HANDOFF: "1",
    });
    expect(features).toEqual({ live: true, handoff: true, webFonts: false });
    expect(
      killSwitchesFromBindings({
        KILL_SWITCH_WRITES: "1",
        KILL_SWITCH_LIVE: "0",
      }),
    ).toEqual({ writes: true, live: false, comments: false });
  });

  it("constructs store, rate, policy, and flags from one binding object", () => {
    const composition = composeCloudflare(env as Bindings);
    expect(composition.runtime.environment).toBe("test");
    expect(composition.features.live).toBe(true);
    expect(composition.store).toBeDefined();
    expect(composition.rateLimiter).toBeDefined();
  });

  it("memoizes the local limiter per environment", () => {
    expect(createCloudflareRateLimiter(env as Bindings)).toBe(
      createCloudflareRateLimiter(env as Bindings),
    );
  });

  it("fails closed on invalid production bindings and feature flags", () => {
    expect(() =>
      validateCloudflareComposition({
        ...(env as Bindings),
        ENVIRONMENT: "production",
        PUBLIC_CREATE_MODE: undefined,
      }),
    ).toThrow(RuntimeConfigError);
    expect(() =>
      validateCloudflareComposition({
        ...(env as Bindings),
        OPEN_ARTIFACTS_HANDOFF: "enabled" as "1",
      }),
    ).toThrow('OPEN_ARTIFACTS_HANDOFF must be "1" or unset');
    expect(() =>
      validateCloudflareComposition({
        ...(env as Bindings),
        OPEN_ARTIFACTS_HANDOFF: "",
      }),
    ).not.toThrow();
  });
});
