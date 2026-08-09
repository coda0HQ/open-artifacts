#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryState = mkdtempSync(
  join(tmpdir(), "open-artifacts-migrations-"),
);
const wrangler = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

/** @param {string[]} arguments_ */
function run(arguments_) {
  const result = spawnSync(wrangler, arguments_, {
    cwd: process.cwd(),
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write(result.stdout);
    throw new Error(`wrangler exited with status ${result.status}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

try {
  const common = [
    "open-artifacts",
    "--local",
    "--persist-to",
    temporaryState,
    "-c",
    "wrangler.jsonc",
  ];
  const first = run(["d1", "migrations", "apply", ...common]);
  if (
    !first.includes("0001_baseline.sql") ||
    !first.includes("0002_publications.sql") ||
    !first.includes("0003_credential_lifecycle.sql") ||
    !first.includes("0004_quotas.sql") ||
    !first.includes("0005_live_drafts.sql")
  ) {
    throw new Error(
      "fresh migration run did not apply every numbered migration",
    );
  }
  const repeated = run(["d1", "migrations", "apply", ...common]);
  if (!repeated.includes("No migrations to apply")) {
    throw new Error("repeated migration run was not idempotent");
  }
  const schema = run([
    "d1",
    "execute",
    ...common,
    "--command",
    "SELECT version FROM schema_meta WHERE singleton = 1;",
  ]);
  if (!/"version"\s*:\s*5/.test(schema)) {
    throw new Error("fresh database did not reach schema version 5");
  }
  process.stdout.write(
    "Numbered migrations: fresh apply, repeat apply, and schema version verification passed.\n",
  );
} finally {
  rmSync(temporaryState, { recursive: true, force: true });
}
