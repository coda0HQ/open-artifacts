#!/usr/bin/env node
import {
  parseReconcileArgs,
  runReconcileLoop,
} from "./lib/reconcile-client.mjs";

try {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const report = await runReconcileLoop({
    options: parseReconcileArgs(process.argv.slice(2)),
    signal: controller.signal,
    write: (chunk) => process.stdout.write(chunk),
  });
  if (!report.complete) process.exitCode = 2;
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`repair-publications: ${message}\n`);
  process.exitCode = 1;
}
