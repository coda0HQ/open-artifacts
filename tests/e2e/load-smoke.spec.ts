import { expect, test } from "@playwright/test";
import { assertLoadGate, runLoadPlan } from "../../scripts/lib/load-runner.mjs";

test("bounded publish/read/comment/live load returns success or controlled 4xx", async ({
  baseURL,
  request,
}) => {
  const authorization = { authorization: "Bearer sk_e2e" };
  const created = await request.post("/api/artifacts", {
    headers: authorization,
    data: {
      title: "Load smoke artifact",
      favicon: "📈",
      format: "html",
      content: "<main>load baseline</main>",
    },
  });
  expect(created.status()).toBe(201);
  const artifact = (await created.json()) as { id: string };

  const report = await runLoadPlan({
    baseUrl: baseURL ?? "http://127.0.0.1:8788",
    artifactId: artifact.id,
    authorization: "sk_e2e",
    iterations: 3,
    concurrency: 4,
  });

  expect(() => assertLoadGate(report)).not.toThrow();
  expect(report.summary).toMatchObject({
    requests: 12,
    serverErrors: 0,
    networkErrors: 0,
    unexpected: 0,
  });
  expect(report.operations).toMatchObject({
    publish: { requests: 3 },
    read: { requests: 3 },
    comment: { requests: 3 },
    live: { requests: 3 },
  });
});
