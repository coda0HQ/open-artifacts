import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/api";
import { createApp } from "../../src/app";
import { ensureSchemaForTests } from "../../src/store";

const app = createApp();
const url = "http://artifacts.test/api/internal/reconcile";

async function request(
  environment: AppContext["Bindings"],
  token?: string,
  body: Record<string, unknown> = {},
  confirmation?: string,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(confirmation ? { "x-open-artifacts-confirm": confirmation } : {}),
      },
      body: JSON.stringify(body),
    }),
    environment,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("reconciliation operator API", () => {
  it("is undiscoverable unless a repair secret is configured and presented", async () => {
    expect(await request({ ...env })).toMatchObject({ status: 404 });
    expect(
      await request({ ...env, REPAIR_TOKEN: "repair-secret" }, "wrong-secret"),
    ).toMatchObject({ status: 404 });
  });

  it("defaults to dry-run and returns an auditable report", async () => {
    await ensureSchemaForTests(env.DB);
    const response = await request(
      { ...env, ENVIRONMENT: "test", REPAIR_TOKEN: "repair-secret" },
      "repair-secret",
      {
        auditId: "api-dry-run",
        limit: 10,
        staleAfterMs: 60 * 60 * 1000,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      auditId: "api-dry-run",
      dryRun: true,
      findings: expect.any(Array),
      results: expect.any(Array),
    });
  });

  it("requires an audit-id confirmation before execution", async () => {
    await ensureSchemaForTests(env.DB);
    const environment = {
      ...env,
      ENVIRONMENT: "test" as const,
      REPAIR_TOKEN: "repair-secret",
    };
    expect(
      await request(environment, "repair-secret", {
        auditId: "api-execute",
        dryRun: false,
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await request(
        environment,
        "repair-secret",
        { auditId: "api-execute", dryRun: false },
        "different-audit-id",
      ),
    ).toMatchObject({ status: 400 });
  });
});
