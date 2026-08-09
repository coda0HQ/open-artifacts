#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWritePrivate } from "./lib/backup-manifest.mjs";

const REQUIRED_STAGES = [
  "migration",
  "application-rollback-rollforward",
  "d1-backup-restore",
  "r2-repair",
  "token-rotation",
];

/** @param {string} root */
export function loadRehearsalPlan(root) {
  const plan = JSON.parse(
    readFileSync(join(root, "config/release-rehearsal.json"), "utf8"),
  );
  const ids = plan.stages?.map((stage) => stage.id) ?? [];
  if (JSON.stringify(ids) !== JSON.stringify(REQUIRED_STAGES)) {
    throw new Error("release rehearsal stages are missing or out of order");
  }
  return plan;
}

/** @param {string} command @param {string[]} arguments_ @param {string} root */
function defaultRunner(command, arguments_, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: { ...process.env, CI: "1" },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

/**
 * @param {{
 *   root: string,
 *   commit: string,
 *   receiptPath?: string,
 *   runner?: (command: string, arguments_: string[], root: string) => Promise<number>,
 *   now?: () => Date
 * }} input
 */
export async function runReleaseRehearsal(input) {
  if (!/^[0-9a-f]{40}$/i.test(input.commit)) {
    throw new Error("rehearsal requires a full 40-character commit SHA");
  }
  const plan = loadRehearsalPlan(input.root);
  const now = input.now ?? (() => new Date());
  const runner = input.runner ?? defaultRunner;
  const startedAt = now();
  const stageReceipts = [];
  for (const stage of plan.stages) {
    const stageStartedAt = now();
    for (const command of stage.commands) {
      const [executable, ...arguments_] = command;
      const status = await runner(executable, arguments_, input.root);
      if (status !== 0) {
        throw new Error(
          `release rehearsal stage ${stage.id} failed with exit code ${status}`,
        );
      }
    }
    const stageFinishedAt = now();
    stageReceipts.push({
      id: stage.id,
      status: "passed",
      startedAt: stageStartedAt.toISOString(),
      finishedAt: stageFinishedAt.toISOString(),
      durationMs: stageFinishedAt.getTime() - stageStartedAt.getTime(),
      validation: stage.validation,
      decisionPoint: stage.decisionPoint,
    });
  }
  const finishedAt = now();
  const receipt = {
    schemaVersion: 1,
    environment: plan.environment,
    commit: input.commit.toLowerCase(),
    status: "passed",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    stages: stageReceipts,
  };
  if (input.receiptPath) {
    await atomicWritePrivate(
      input.receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }
  return receipt;
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) {
      throw new Error(`invalid rehearsal argument near ${flag ?? "end"}`);
    }
    values[flag.slice(2)] = value;
  }
  if (!values.commit) throw new Error("--commit is required");
  if (!values.receipt) throw new Error("--receipt is required");
  return values;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const values = parseArguments(process.argv.slice(2));
    const receipt = await runReleaseRehearsal({
      root: process.cwd(),
      commit: String(values.commit),
      receiptPath: String(values.receipt),
    });
    process.stdout.write(
      `Release rehearsal: ${receipt.stages.length} stages passed in ${receipt.durationMs} ms.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
