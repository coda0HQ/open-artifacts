import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWritePrivate } from "./backup-manifest.mjs";

/** @typedef {"stale_publication" | "missing_blob" | "orphan_blob"} ReconcileKind */
/** @typedef {{publications?: string, blobs?: string}} ReconcileCursor */
/**
 * @typedef {{
 *   auditId: string,
 *   dryRun: boolean,
 *   confirm?: string,
 *   limit: number,
 *   staleAfterMs: number,
 *   cursor?: ReconcileCursor,
 *   kinds?: ReconcileKind[],
 *   checkpointPath?: string,
 *   auditPath?: string,
 *   delayMs: number,
 *   maxPages: number,
 *   resume: boolean
 * }} ReconcileOptions
 */
/**
 * @typedef {{
 *   auditId: string,
 *   dryRun: boolean,
 *   startedAt?: string,
 *   completedAt?: string,
 *   findings: unknown[],
 *   results?: unknown[],
 *   cursor?: ReconcileCursor | null
 * }} ReconcilePage
 */
/**
 * @typedef {{
 *   schemaVersion: 1,
 *   auditId: string,
 *   dryRun: boolean,
 *   kinds: ReconcileKind[] | null,
 *   cursor: ReconcileCursor | null,
 *   pages: number,
 *   findings: number,
 *   mutations: number,
 *   complete: boolean,
 *   cancelled: boolean,
 *   updatedAt: string
 * }} RepairCheckpoint
 */

const allowedKinds = new Set([
  "stale_publication",
  "missing_blob",
  "orphan_blob",
]);

/** @param {string | undefined} value @param {string} flag */
function requiredValue(value, flag) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** @param {string[]} argv @returns {ReconcileOptions} */
export function parseReconcileArgs(argv) {
  /** @type {ReconcileOptions} */
  const options = {
    auditId: `reconcile-${new Date().toISOString().replace(/[^0-9]/g, "")}`,
    dryRun: true,
    limit: 100,
    staleAfterMs: 30 * 60 * 1000,
    delayMs: 250,
    maxPages: 10_000,
    resume: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      options.dryRun = false;
    } else if (argument === "--resume") {
      options.resume = true;
    } else if (argument === "--audit-id") {
      options.auditId = requiredValue(argv[++index], argument);
    } else if (argument === "--confirm") {
      options.confirm = requiredValue(argv[++index], argument);
    } else if (argument === "--limit") {
      options.limit = Number(requiredValue(argv[++index], argument));
    } else if (argument === "--stale-minutes") {
      options.staleAfterMs =
        Number(requiredValue(argv[++index], argument)) * 60 * 1000;
    } else if (argument === "--delay-ms") {
      options.delayMs = Number(requiredValue(argv[++index], argument));
    } else if (argument === "--max-pages") {
      options.maxPages = Number(requiredValue(argv[++index], argument));
    } else if (argument === "--checkpoint") {
      options.checkpointPath = requiredValue(argv[++index], argument);
    } else if (argument === "--audit-log") {
      options.auditPath = requiredValue(argv[++index], argument);
    } else if (argument === "--kinds") {
      const kinds = requiredValue(argv[++index], argument).split(",");
      if (kinds.length === 0 || kinds.some((kind) => !allowedKinds.has(kind))) {
        throw new Error("--kinds contains an unsupported repair finding");
      }
      options.kinds = /** @type {ReconcileKind[]} */ ([...new Set(kinds)]);
    } else if (argument === "--cursor") {
      const parsed = JSON.parse(requiredValue(argv[++index], argument));
      if (parsed === null || typeof parsed !== "object") {
        throw new Error("--cursor must be a JSON object");
      }
      options.cursor = parsed;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!/^[A-Za-z0-9._:-]{3,200}$/.test(options.auditId)) {
    throw new Error("--audit-id must be 3-200 URL-safe characters");
  }
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 500
  ) {
    throw new Error("--limit must be an integer from 1 to 500");
  }
  if (!Number.isFinite(options.staleAfterMs) || options.staleAfterMs < 60_000) {
    throw new Error("--stale-minutes must be at least 1");
  }
  if (
    !Number.isInteger(options.delayMs) ||
    options.delayMs < 0 ||
    options.delayMs > 60_000
  ) {
    throw new Error("--delay-ms must be an integer from 0 to 60000");
  }
  if (
    !Number.isInteger(options.maxPages) ||
    options.maxPages < 1 ||
    options.maxPages > 100_000
  ) {
    throw new Error("--max-pages must be an integer from 1 to 100000");
  }
  if (!options.dryRun && options.confirm !== options.auditId) {
    throw new Error(
      `execution confirmation requires --confirm ${options.auditId} after reviewing dry-run output`,
    );
  }
  options.checkpointPath ??= `.artifacts/repair/${options.auditId}.checkpoint.json`;
  options.auditPath ??= `.artifacts/repair/${options.auditId}.audit.jsonl`;
  return options;
}

/**
 * @param {{
 *   options: ReconcileOptions,
 *   environment?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   cursor?: ReconcileCursor,
 *   signal?: AbortSignal
 * }} input
 * @returns {Promise<ReconcilePage>}
 */
export async function requestReconcilePage(input) {
  const environment = input.environment ?? process.env;
  const baseUrl = environment.OPEN_ARTIFACTS_URL?.replace(/\/+$/, "");
  const token = environment.OPEN_ARTIFACTS_REPAIR_TOKEN;
  if (!baseUrl) throw new Error("OPEN_ARTIFACTS_URL is required");
  if (!token) throw new Error("OPEN_ARTIFACTS_REPAIR_TOKEN is required");
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}/api/internal/reconcile`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(input.options.dryRun
        ? {}
        : { "x-open-artifacts-confirm": input.options.auditId }),
    },
    body: JSON.stringify({
      auditId: input.options.auditId,
      dryRun: input.options.dryRun,
      limit: input.options.limit,
      staleAfterMs: input.options.staleAfterMs,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.options.kinds ? { kinds: input.options.kinds } : {}),
    }),
    signal: input.signal,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `reconciliation request failed with HTTP ${response.status}: ${responseText.slice(0, 500)}`,
    );
  }
  const report = JSON.parse(responseText);
  if (
    !report ||
    typeof report !== "object" ||
    !Array.isArray(report.findings)
  ) {
    throw new Error("reconciliation response has an invalid shape");
  }
  return report;
}

/**
 * Backward-compatible single-page client for programmatic callers.
 * @param {{
 *   options: ReconcileOptions,
 *   environment?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   write?: (chunk: string) => void
 * }} input
 */
export async function runReconcile(input) {
  const report = await requestReconcilePage(input);
  (input.write ?? ((chunk) => process.stdout.write(chunk)))(
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

/** @param {string} path @param {Record<string, unknown>} event */
async function appendAudit(path, event) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(event)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** @param {string} path @param {RepairCheckpoint} checkpoint */
async function writeCheckpoint(path, checkpoint) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWritePrivate(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

/** @param {number} milliseconds @param {AbortSignal | undefined} signal */
async function abortableDelay(milliseconds, signal) {
  if (milliseconds === 0 || signal?.aborted) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve(undefined);
      },
      { once: true },
    );
  });
}

/** @param {ReconcileOptions} options */
function initialCheckpoint(options) {
  return /** @type {RepairCheckpoint} */ ({
    schemaVersion: 1,
    auditId: options.auditId,
    dryRun: options.dryRun,
    kinds: options.kinds ?? null,
    cursor: options.cursor ?? null,
    pages: 0,
    findings: 0,
    mutations: 0,
    complete: false,
    cancelled: false,
    updatedAt: new Date(0).toISOString(),
  });
}

/** @param {string} path @param {ReconcileOptions} options */
async function loadCheckpoint(path, options) {
  const checkpoint = /** @type {RepairCheckpoint} */ (
    JSON.parse(await readFile(path, "utf8"))
  );
  if (
    checkpoint.schemaVersion !== 1 ||
    checkpoint.auditId !== options.auditId ||
    checkpoint.dryRun !== options.dryRun ||
    JSON.stringify(checkpoint.kinds) !== JSON.stringify(options.kinds ?? null)
  ) {
    throw new Error(
      "repair checkpoint does not match requested audit/mode/kinds",
    );
  }
  return checkpoint;
}

/**
 * @param {{
 *   options: ReconcileOptions,
 *   environment?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   requestPage?: (cursor?: ReconcileCursor) => Promise<ReconcilePage>,
 *   signal?: AbortSignal,
 *   now?: () => Date,
 *   write?: (chunk: string) => void
 * }} input
 */
export async function runReconcileLoop(input) {
  const options = input.options;
  if (!options.checkpointPath || !options.auditPath) {
    throw new Error("repair loop requires checkpoint and audit paths");
  }
  const now = input.now ?? (() => new Date());
  let checkpoint = options.resume
    ? await loadCheckpoint(options.checkpointPath, options)
    : initialCheckpoint(options);
  if (checkpoint.complete) {
    return checkpoint;
  }
  const requestPage =
    input.requestPage ??
    ((cursor) =>
      requestReconcilePage({
        options,
        environment: input.environment,
        fetchImpl: input.fetchImpl,
        cursor,
        signal: input.signal,
      }));
  let pagesThisRun = 0;
  while (!checkpoint.complete && pagesThisRun < options.maxPages) {
    if (input.signal?.aborted) {
      checkpoint = {
        ...checkpoint,
        cancelled: true,
        updatedAt: now().toISOString(),
      };
      await writeCheckpoint(options.checkpointPath, checkpoint);
      await appendAudit(options.auditPath, {
        event: "repair.cancelled",
        auditId: options.auditId,
        pages: checkpoint.pages,
        cursor: checkpoint.cursor,
        at: checkpoint.updatedAt,
      });
      return checkpoint;
    }
    const page = await requestPage(checkpoint.cursor ?? undefined);
    const mutations = (page.results ?? []).filter(
      (result) =>
        result &&
        typeof result === "object" &&
        "mutated" in result &&
        /** @type {{mutated?: unknown}} */ (result).mutated === true,
    ).length;
    checkpoint = {
      ...checkpoint,
      cursor: page.cursor ?? null,
      pages: checkpoint.pages + 1,
      findings: checkpoint.findings + page.findings.length,
      mutations: checkpoint.mutations + mutations,
      complete: !page.cursor,
      cancelled: false,
      updatedAt: now().toISOString(),
    };
    pagesThisRun += 1;
    await writeCheckpoint(options.checkpointPath, checkpoint);
    await appendAudit(options.auditPath, {
      event: "repair.page",
      auditId: options.auditId,
      dryRun: options.dryRun,
      page: checkpoint.pages,
      findings: page.findings.length,
      mutations,
      cursor: checkpoint.cursor,
      at: checkpoint.updatedAt,
    });
    if (!checkpoint.complete && pagesThisRun < options.maxPages) {
      await abortableDelay(options.delayMs, input.signal);
    }
  }
  const finalEvent = checkpoint.complete ? "repair.completed" : "repair.paused";
  await appendAudit(options.auditPath, {
    event: finalEvent,
    auditId: options.auditId,
    dryRun: options.dryRun,
    pages: checkpoint.pages,
    findings: checkpoint.findings,
    mutations: checkpoint.mutations,
    cursor: checkpoint.cursor,
    at: checkpoint.updatedAt,
  });
  input.write?.(`${JSON.stringify(checkpoint, null, 2)}\n`);
  return checkpoint;
}
