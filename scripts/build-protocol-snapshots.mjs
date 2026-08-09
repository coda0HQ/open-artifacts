import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "tests/snapshots/protocol/v1/catalog.json");
const inputs = [
  "protocol/v1/create-request.schema.json",
  "protocol/v1/error.schema.json",
  "protocol/v1/live-checkpoint-response.schema.json",
  "protocol/v1/live-checkpoint.schema.json",
  "protocol/v1/live-draft-response.schema.json",
  "protocol/v1/live-draft.schema.json",
  "protocol/v1/live-error.schema.json",
  "protocol/v1/manifest.schema.json",
  "protocol/v1/publish-request.schema.json",
  "protocol/v1/update-request.schema.json",
  "tests/fixtures/protocol/v1/create.json",
  "tests/fixtures/protocol/v1/error.json",
  "tests/fixtures/protocol/v1/live-checkpoint-response.json",
  "tests/fixtures/protocol/v1/live-checkpoint.json",
  "tests/fixtures/protocol/v1/live-draft-response.json",
  "tests/fixtures/protocol/v1/live-draft.json",
  "tests/fixtures/protocol/v1/live-error.json",
  "tests/fixtures/protocol/v1/manifest.json",
  "tests/fixtures/protocol/v1/update.json",
].sort();

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const files = Object.fromEntries(
  inputs.map((name) => {
    const bytes = readFileSync(resolve(root, name));
    return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
  }),
);
const catalogHash = sha256(JSON.stringify(files));
const serialized = `${JSON.stringify(
  {
    protocolVersion: 1,
    generatedBy: relative(root, fileURLToPath(import.meta.url)),
    catalogHash,
    files,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--stdout")) {
  process.stdout.write(serialized);
} else if (process.argv.includes("--check")) {
  if (
    !existsSync(outputPath) ||
    readFileSync(outputPath, "utf8") !== serialized
  ) {
    console.error(
      "protocol snapshot drifted; run `node scripts/build-protocol-snapshots.mjs` and review the versioned change",
    );
    process.exitCode = 1;
  } else {
    console.log(`protocol v1 snapshot verified (${catalogHash})`);
  }
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, { mode: 0o644 });
  console.log(`wrote ${relative(root, outputPath)} (${catalogHash})`);
}
