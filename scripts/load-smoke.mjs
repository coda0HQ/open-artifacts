#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assertLoadGate, runLoadPlan } from "./lib/load-runner.mjs";

/** @param {string[]} argv */
export function parseLoadArgs(argv) {
  /** @type {Record<string, string>} */
  const values = { profile: "config/load-profile.json" };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        `invalid or missing value near ${flag ?? "end of arguments"}`,
      );
    }
    values[flag.slice(2)] = value;
  }
  for (const required of ["base-url", "artifact-id"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  return values;
}

/**
 * @param {{args: Record<string, string>, environment?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch}} input
 */
export async function runLoadSmoke(input) {
  const profile = JSON.parse(await readFile(input.args.profile, "utf8"));
  const report = await runLoadPlan({
    baseUrl: input.args["base-url"],
    artifactId: input.args["artifact-id"],
    iterations: profile.iterations,
    concurrency: profile.concurrency,
    timeoutMs: profile.timeoutMs,
    authorization: (input.environment ?? process.env).OPEN_ARTIFACTS_LOAD_TOKEN,
    fetchImpl: input.fetchImpl,
  });
  assertLoadGate(report);
  return report;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.stdout.write(
      `${JSON.stringify(
        await runLoadSmoke({ args: parseLoadArgs(process.argv.slice(2)) }),
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`load-smoke: ${message}\n`);
    process.exitCode = 1;
  }
}
