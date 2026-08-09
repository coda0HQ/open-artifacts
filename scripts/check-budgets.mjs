import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budget = JSON.parse(
  readFileSync(resolve(root, "config/quality-budgets.json"), "utf8"),
);
const loadProfile = JSON.parse(
  readFileSync(resolve(root, "config/load-profile.json"), "utf8"),
);

function fail(message) {
  console.error(`quality budget failed: ${message}`);
  process.exitCode = 1;
}

function checkMaximum(name, actual, maximum) {
  if (!Number.isFinite(maximum) || maximum <= 0) {
    fail(`${name} has no positive configured maximum`);
  } else if (actual > maximum) {
    fail(`${name} is ${actual}, above ${maximum}`);
  }
}

function lineCount(path) {
  return readFileSync(path, "utf8").split("\n").length;
}

const buildDirectory = mkdtempSync(join(tmpdir(), "oa-quality-budget-"));
let workerRawBytes = 0;
let workerGzipBytes = 0;
try {
  const wrangler = resolve(
    root,
    "node_modules/.bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const built = spawnSync(
    wrangler,
    [
      "deploy",
      "--dry-run",
      "--outdir",
      buildDirectory,
      "-c",
      "wrangler.dev.jsonc",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (built.status !== 0) {
    fail(`Wrangler dry-run failed: ${(built.stderr || built.stdout).trim()}`);
  } else {
    for (const name of readdirSync(buildDirectory)) {
      if (!name.endsWith(".js") && !name.endsWith(".wasm")) continue;
      const path = join(buildDirectory, name);
      if (!statSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      workerRawBytes += bytes.length;
      workerGzipBytes += gzipSync(bytes, { level: 9 }).length;
    }
  }
} finally {
  rmSync(buildDirectory, { recursive: true, force: true });
}

const viewerRuntimeBytes = statSync(
  resolve(root, "src/generated/viewer-runtime.ts"),
).size;
const wrapLines = lineCount(resolve(root, "src/wrap.ts"));
const cliCompositionRootLines = lineCount(
  resolve(root, "skills/using-open-artifacts/scripts/artifact.mjs"),
);

checkMaximum(
  "Worker bundle raw bytes",
  workerRawBytes,
  budget.static.workerBundleRawBytes,
);
checkMaximum(
  "Worker bundle gzip bytes",
  workerGzipBytes,
  budget.static.workerBundleGzipBytes,
);
checkMaximum(
  "Viewer runtime bytes",
  viewerRuntimeBytes,
  budget.static.viewerRuntimeBytes,
);
checkMaximum("wrap.ts lines", wrapLines, budget.static.wrapLines);
checkMaximum(
  "CLI composition root lines",
  cliCompositionRootLines,
  budget.static.cliCompositionRootLines,
);

for (const operation of ["publish", "read", "comment", "live"]) {
  if (loadProfile.gates.p95Ms[operation] !== budget.stagingP95Ms[operation]) {
    fail(
      `staging ${operation} p95 differs between quality-budgets.json and load-profile.json`,
    );
  }
}

for (const exception of budget.exceptions) {
  if (!exception.owner || !exception.reason || !exception.expiresAt) {
    fail("every budget exception requires owner, reason, and expiresAt");
    continue;
  }
  if (Date.parse(exception.expiresAt) <= Date.now()) {
    fail(`budget exception ${exception.name ?? "unnamed"} expired`);
  }
}

const report = {
  workerBundle: { rawBytes: workerRawBytes, gzipBytes: workerGzipBytes },
  viewerRuntimeBytes,
  wrapLines,
  cliCompositionRootLines,
  source: basename("config/quality-budgets.json"),
};
console.log(JSON.stringify(report, null, 2));
