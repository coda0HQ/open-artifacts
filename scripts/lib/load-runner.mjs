/** @typedef {"publish" | "read" | "comment" | "live"} LoadOperation */
/** @typedef {{status: number, durationMs: number, controlled: boolean, serverError: boolean, networkError: boolean, unexpected: boolean}} LoadSample */

const operations = /** @type {LoadOperation[]} */ ([
  "publish",
  "read",
  "comment",
  "live",
]);
const controlledStatuses = new Set([401, 403, 404, 409, 413, 429]);

/** @param {number[]} values @param {number} quantile */
function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
    ] ?? 0
  );
}

/**
 * @param {{
 *   baseUrl: string,
 *   artifactId: string,
 *   operation: LoadOperation,
 *   iteration: number,
 *   authorization?: string
 * }} input
 */
function requestFor(input) {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const id = encodeURIComponent(input.artifactId);
  const headers = {
    ...(input.authorization
      ? { authorization: `Bearer ${input.authorization}` }
      : {}),
  };
  if (input.operation === "read") {
    return new Request(`${baseUrl}/a/${id}`);
  }
  if (input.operation === "live") {
    return new Request(`${baseUrl}/api/artifacts/${id}/live/draft`, {
      headers,
    });
  }
  if (input.operation === "comment") {
    return new Request(`${baseUrl}/api/artifacts/${id}/comments`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        author: "capacity-probe",
        body: `synthetic comment ${input.iteration}`,
      }),
    });
  }
  return new Request(`${baseUrl}/api/artifacts/${id}`, {
    method: "PUT",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": `load-publish-${input.iteration}`,
    },
    body: JSON.stringify({
      title: "Synthetic capacity probe",
      content: `<main>synthetic load iteration ${input.iteration}</main>`,
    }),
  });
}

/**
 * @param {{
 *   baseUrl: string,
 *   artifactId: string,
 *   iterations: number,
 *   concurrency: number,
 *   authorization?: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   timeoutMs?: number
 * }} input
 */
export async function runLoadPlan(input) {
  if (!/^https?:\/\//.test(input.baseUrl))
    throw new Error("load base URL is invalid");
  if (!input.artifactId) throw new Error("load artifact ID is required");
  if (
    !Number.isInteger(input.iterations) ||
    input.iterations < 1 ||
    input.iterations > 10_000
  ) {
    throw new Error("load iterations must be an integer from 1 to 10000");
  }
  if (
    !Number.isInteger(input.concurrency) ||
    input.concurrency < 1 ||
    input.concurrency > 20
  ) {
    throw new Error("load concurrency must be an integer from 1 to 20");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => performance.now());
  const timeoutMs = input.timeoutMs ?? 10_000;
  const tasks = Array.from({ length: input.iterations }, (_, iteration) =>
    operations.map((operation) => ({ operation, iteration })),
  ).flat();
  /** @type {Record<LoadOperation, LoadSample[]>} */
  const samples = { publish: [], read: [], comment: [], live: [] };
  let nextTask = 0;
  const worker = async () => {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask++];
      if (!task) return;
      const started = now();
      /** @type {LoadSample} */
      let sample;
      try {
        const response = await fetchImpl(
          requestFor({
            baseUrl: input.baseUrl,
            artifactId: input.artifactId,
            authorization: input.authorization,
            ...task,
          }),
          { signal: AbortSignal.timeout(timeoutMs) },
        );
        const status = response.status;
        response.body?.cancel().catch(() => {});
        sample = {
          status,
          durationMs: Math.max(0, now() - started),
          controlled: controlledStatuses.has(status),
          serverError: status >= 500,
          networkError: false,
          unexpected:
            status < 200 ||
            status >= 500 ||
            (status >= 400 && !controlledStatuses.has(status)),
        };
      } catch {
        sample = {
          status: 0,
          durationMs: Math.max(0, now() - started),
          controlled: false,
          serverError: false,
          networkError: true,
          unexpected: true,
        };
      }
      samples[task.operation].push(sample);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(input.concurrency, tasks.length) }, () =>
      worker(),
    ),
  );
  const operationReports = Object.fromEntries(
    operations.map((operation) => {
      const values = samples[operation];
      const durations = values.map((sample) => sample.durationMs);
      return [
        operation,
        {
          requests: values.length,
          success: values.filter(
            (sample) => sample.status >= 200 && sample.status < 400,
          ).length,
          controlledRejections: values.filter((sample) => sample.controlled)
            .length,
          serverErrors: values.filter((sample) => sample.serverError).length,
          networkErrors: values.filter((sample) => sample.networkError).length,
          unexpected: values.filter((sample) => sample.unexpected).length,
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
          p99Ms: percentile(durations, 0.99),
          statuses: Object.fromEntries(
            [...new Set(values.map((sample) => sample.status))]
              .sort((left, right) => left - right)
              .map((status) => [
                String(status),
                values.filter((sample) => sample.status === status).length,
              ]),
          ),
        },
      ];
    }),
  );
  const allSamples = operations.flatMap((operation) => samples[operation]);
  return {
    schemaVersion: 1,
    environment: "staging",
    iterations: input.iterations,
    concurrency: input.concurrency,
    operations: operationReports,
    summary: {
      requests: allSamples.length,
      controlledRejections: allSamples.filter((sample) => sample.controlled)
        .length,
      serverErrors: allSamples.filter((sample) => sample.serverError).length,
      networkErrors: allSamples.filter((sample) => sample.networkError).length,
      unexpected: allSamples.filter((sample) => sample.unexpected).length,
    },
  };
}

/** @param {Awaited<ReturnType<typeof runLoadPlan>>} report */
export function assertLoadGate(report) {
  if (report.summary.serverErrors > 0) {
    throw new Error(
      `load gate observed ${report.summary.serverErrors} server errors`,
    );
  }
  if (report.summary.networkErrors > 0) {
    throw new Error(
      `load gate observed ${report.summary.networkErrors} network errors`,
    );
  }
  if (report.summary.unexpected > 0) {
    throw new Error(
      `load gate observed ${report.summary.unexpected} unexpected statuses`,
    );
  }
  return true;
}
