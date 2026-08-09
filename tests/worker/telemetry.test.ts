import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/api";
import { createApp } from "../../src/app";
import { createRequestContext } from "../../src/request-context";
import { StructuredLogger } from "../../src/telemetry/logger";
import { MetricsRecorder } from "../../src/telemetry/metrics";

describe("request telemetry", () => {
  it("derives correlatable IDs while hashing the request actor", async () => {
    const context = await createRequestContext(
      new Request(
        "https://artifacts.test/api/artifacts/artifact-7/live/draft",
        {
          headers: {
            authorization: "Bearer wt_super-secret",
            "cf-ray": "ray-12345678-SJC",
            traceparent:
              "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          },
        },
      ),
    );

    expect(context).toMatchObject({
      requestId: "ray-12345678-SJC",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      artifactId: "artifact-7",
      route: "live_draft",
    });
    expect(context.actorId).toMatch(/^actor_[a-f0-9]{64}$/);
    expect(JSON.stringify(context)).not.toContain("wt_super-secret");
  });

  it("redacts sensitive keys and token-looking values at every nesting level", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger(
      {
        requestId: "request-1",
        traceId: "trace-1",
        actorId: "actor_hash",
        artifactId: "artifact-1",
        route: "artifact_update",
        method: "PUT",
        startedAt: "2026-08-04T00:00:00.000Z",
      },
      "test",
      (line) => lines.push(line),
    );

    logger.info("publication.failed", {
      publicationId: "pub_1",
      authorization: "Bearer wt_header-secret",
      nested: {
        password: "correct horse",
        content: "<main>private body</main>",
        note: "rejected sk_value-that-must-not-leak",
      },
      error: new Error("upstream exposed ch_channel-secret"),
    });

    expect(lines).toHaveLength(1);
    const serialized = lines[0] ?? "";
    expect(serialized).toContain('"event":"publication.failed"');
    expect(serialized).toContain('"requestId":"request-1"');
    expect(serialized).toContain('"publicationId":"pub_1"');
    expect(serialized).toContain("[REDACTED]");
    for (const secret of [
      "wt_header-secret",
      "correct horse",
      "private body",
      "sk_value-that-must-not-leak",
      "ch_channel-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("writes only bounded low-cardinality dimensions to Analytics Engine", () => {
    const writeDataPoint = vi.fn();
    const logger = new StructuredLogger(
      {
        requestId: "request-2",
        traceId: "trace-2",
        actorId: "actor_high-cardinality",
        artifactId: "artifact-high-cardinality",
        route: "checkpoint",
        method: "POST",
        startedAt: "2026-08-04T00:00:00.000Z",
      },
      "staging",
      () => {},
    );
    const metrics = new MetricsRecorder({ writeDataPoint }, logger, "staging");

    metrics.record("publication_operation", {
      value: 1,
      durationMs: 42,
      route: "checkpoint",
      operation: "checkpoint",
      result: "success",
      status: 200,
    });

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point.indexes).toEqual(["staging"]);
    expect(point.blobs).toEqual([
      "publication_operation",
      "checkpoint",
      "checkpoint",
      "success",
      "2xx",
    ]);
    const serialized = JSON.stringify(point);
    expect(serialized).not.toContain("artifact-high-cardinality");
    expect(serialized).not.toContain("actor_high-cardinality");
    expect(serialized).not.toContain("request-2");
  });

  it("normalizes unbounded metric dimensions instead of accepting them", () => {
    const writeDataPoint = vi.fn();
    const logger = new StructuredLogger(
      {
        requestId: "request-3",
        traceId: "trace-3",
        actorId: "actor-3",
        artifactId: null,
        route: "other",
        method: "GET",
        startedAt: "2026-08-04T00:00:00.000Z",
      },
      "test",
      () => {},
    );
    const metrics = new MetricsRecorder({ writeDataPoint }, logger, "test");

    metrics.record("http_request", {
      value: 1,
      route: "artifact-user-controlled-value",
      operation: "not-an-operation",
      result: "customer-specific-result",
      status: 418,
    });

    expect(writeDataPoint.mock.calls[0]?.[0].blobs).toEqual([
      "http_request",
      "other",
      "other",
      "other",
      "4xx",
    ]);
  });

  it("correlates API, R2, and D1 publication boundaries without logging request secrets", async () => {
    const writeDataPoint = vi.fn();
    const output: string[] = [];
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation((line) => output.push(String(line)));
    const testEnv: AppContext["Bindings"] = {
      ...env,
      ENVIRONMENT: "test",
      TELEMETRY_ENV: "staging",
      TELEMETRY_LOGS: "enabled",
      METRICS: { writeDataPoint },
    };
    const app = createApp();
    const context = createExecutionContext();
    const response = await app.fetch(
      new Request("http://artifacts.test/api/artifacts", {
        method: "POST",
        headers: {
          authorization: "Bearer wt_never-log-this",
          "content-type": "application/json",
          "x-request-id": "request-correlation-0001",
          traceparent:
            "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        },
        body: JSON.stringify({
          title: "Telemetry boundary",
          favicon: "📡",
          content: "<main>never log this request body</main>",
        }),
      }),
      testEnv,
      context,
    );
    await waitOnExecutionContext(context);
    consoleLog.mockRestore();

    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe(
      "request-correlation-0001",
    );
    const records = output.map((line) => JSON.parse(line));
    const events = records.map((record) => record.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "request.started",
        "storage.r2.write.started",
        "storage.r2.write.succeeded",
        "storage.d1.commit.succeeded",
        "request.completed",
      ]),
    );
    expect(
      records.every(
        (record) => record.requestId === "request-correlation-0001",
      ),
    ).toBe(true);
    const r2 = records.find(
      (record) => record.event === "storage.r2.write.succeeded",
    );
    const d1 = records.find(
      (record) => record.event === "storage.d1.commit.succeeded",
    );
    expect(r2.publicationId).toBe(d1.publicationId);
    const serialized = output.join("\n");
    expect(serialized).not.toContain("wt_never-log-this");
    expect(serialized).not.toContain("never log this request body");
    expect(writeDataPoint).toHaveBeenCalled();
  });
});
