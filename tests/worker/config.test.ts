import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/api";
import { createApp } from "../../src/app";
import {
  RuntimeConfigError,
  resolveRuntimePolicy,
  validateRuntimeConfig,
} from "../../src/config";
import { ensureSchemaForTests } from "../../src/store";

describe("runtime configuration policy", () => {
  it("fails a production profile with missing policy and secrets", () => {
    expect(() =>
      validateRuntimeConfig({
        DB: env.DB,
        CONTENT: env.CONTENT,
        ASSETS: env.ASSETS,
        ENVIRONMENT: "production",
      }),
    ).toThrow(RuntimeConfigError);
  });

  it("keeps development/test permissiveness explicit", () => {
    expect(
      resolveRuntimePolicy({
        DB: env.DB,
        CONTENT: env.CONTENT,
        ASSETS: env.ASSETS,
        ENVIRONMENT: "test",
      }),
    ).toMatchObject({
      publicCreate: "open",
      anonymousComments: true,
    });
  });

  it("treats preview and staging as remote fail-closed profiles", () => {
    for (const environment of ["preview", "staging"] as const) {
      expect(() =>
        validateRuntimeConfig({
          DB: env.DB,
          CONTENT: env.CONTENT,
          ASSETS: env.ASSETS,
          ENVIRONMENT: environment,
        }),
      ).toThrow(RuntimeConfigError);
    }
  });

  it("rejects malformed operational kill switches", () => {
    expect(() =>
      validateRuntimeConfig({
        ...(env as AppContext["Bindings"]),
        KILL_SWITCH_WRITES: "yes" as "0",
      }),
    ).toThrow('KILL_SWITCH_WRITES must be "0" or "1"');
  });

  it("denies public create in the production default policy", async () => {
    const app = createApp();
    const production: AppContext["Bindings"] = {
      ...env,
      ENVIRONMENT: "production",
      PUBLIC_CREATE_MODE: "disabled",
      ANONYMOUS_COMMENTS: "disabled",
      IDEMPOTENCY_SECRET: "production-idempotency-secret-at-least-32-bytes",
      RATE_LIMIT_MODE: "local",
    };
    const context = createExecutionContext();
    const response = await app.fetch(
      new Request("http://artifacts.test/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x", favicon: "🔒" }),
      }),
      production,
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(401);
  });

  it("honors write, live, and comment kill switches with structured 503s", async () => {
    const app = createApp();
    const cases = [
      ["/api/artifacts", "KILL_SWITCH_WRITES"],
      ["/api/artifacts/example/live/draft", "KILL_SWITCH_LIVE"],
      ["/api/artifacts/example/comments", "KILL_SWITCH_COMMENTS"],
    ] as const;

    for (const [path, flag] of cases) {
      const context = createExecutionContext();
      const response = await app.fetch(
        new Request(`http://artifacts.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        { ...env, [flag]: "1" },
        context,
      );
      await waitOnExecutionContext(context);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "FEATURE_KILL_SWITCH_ACTIVE",
        flag,
      });
    }
  });

  it("denies anonymous comments in production but accepts an artifact credential", async () => {
    await ensureSchemaForTests(env.DB);
    const app = createApp();
    const createContext = createExecutionContext();
    const createdResponse = await app.fetch(
      new Request("http://artifacts.test/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "<p>comment policy</p>",
          title: "Comment policy",
          favicon: "📊",
        }),
      }),
      env,
      createContext,
    );
    await waitOnExecutionContext(createContext);
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      writeToken: string;
    };
    const production: AppContext["Bindings"] = {
      ...env,
      ENVIRONMENT: "production",
      PUBLIC_CREATE_MODE: "disabled",
      ANONYMOUS_COMMENTS: "disabled",
      IDEMPOTENCY_SECRET: "production-idempotency-secret-at-least-32-bytes",
      RATE_LIMIT_MODE: "local",
    };

    const anonymousContext = createExecutionContext();
    const anonymous = await app.fetch(
      new Request(
        `http://artifacts.test/api/artifacts/${created.id}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "anonymous" }),
        },
      ),
      production,
      anonymousContext,
    );
    await waitOnExecutionContext(anonymousContext);
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toMatchObject({
      code: "ANONYMOUS_COMMENTS_DISABLED",
    });

    const ownerContext = createExecutionContext();
    const owner = await app.fetch(
      new Request(
        `http://artifacts.test/api/artifacts/${created.id}/comments`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${created.writeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ body: "owner" }),
        },
      ),
      production,
      ownerContext,
    );
    await waitOnExecutionContext(ownerContext);
    expect(owner.status).toBe(201);
  });
});
