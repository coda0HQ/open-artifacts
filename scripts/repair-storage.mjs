#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  parseReconcileArgs,
  runReconcileLoop,
} from "./lib/reconcile-client.mjs";

/**
 * @param {ReturnType<typeof parseReconcileArgs>} options
 * @returns {ReturnType<typeof parseReconcileArgs>}
 */
export function withStorageKinds(options) {
  return {
    ...options,
    kinds: /** @type {("missing_blob" | "orphan_blob")[]} */ ([
      "missing_blob",
      "orphan_blob",
    ]),
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const report = await runReconcileLoop({
      options: withStorageKinds(parseReconcileArgs(process.argv.slice(2))),
      signal: controller.signal,
      write: (chunk) => process.stdout.write(chunk),
    });
    if (!report.complete) process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`repair-storage: ${message}\n`);
    process.exitCode = 1;
  }
}
