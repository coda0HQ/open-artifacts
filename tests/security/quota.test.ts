import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/api";
import { createApp } from "../../src/app";

const BASE = "http://artifacts.test";

async function fetchWith(
  request: Request,
  environment: AppContext["Bindings"],
): Promise<Response> {
  const context = createExecutionContext();
  const response = await createApp().fetch(request, environment, context);
  await waitOnExecutionContext(context);
  return response;
}

async function createArtifact(environment: AppContext["Bindings"]): Promise<{
  id: string;
  writeToken: string;
}> {
  const response = await fetchWith(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "<p>quota v1</p>",
        title: "Quota",
        favicon: "📊",
      }),
    }),
    environment,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; writeToken: string };
}

describe("exact quota enforcement", () => {
  it("returns QUOTA_EXCEEDED separately from the soft rate limit", async () => {
    const quotaEnv: AppContext["Bindings"] = {
      ...env,
      QUOTA_VERSIONS: "1",
    };
    const created = await createArtifact(quotaEnv);
    const response = await fetchWith(
      new Request(`${BASE}/api/artifacts/${created.id}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${created.writeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content: "<p>quota v2</p>",
          baseVersion: 1,
        }),
      }),
      quotaEnv,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toMatchObject({
      code: "QUOTA_EXCEEDED",
      resource: "versions",
      limit: 1,
    });
  });

  it("allows exactly two of three concurrent comments", async () => {
    const quotaEnv: AppContext["Bindings"] = {
      ...env,
      QUOTA_COMMENTS: "2",
    };
    const created = await createArtifact(quotaEnv);
    const responses = await Promise.all(
      ["one", "two", "three"].map((body) =>
        fetchWith(
          new Request(`${BASE}/api/artifacts/${created.id}/comments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body }),
          }),
          quotaEnv,
        ),
      ),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(2);
    const rejected = responses.find((response) => response.status === 429);
    expect(rejected).toBeDefined();
    expect(await rejected?.json()).toMatchObject({
      code: "QUOTA_EXCEEDED",
      resource: "comments",
    });
  });
});
