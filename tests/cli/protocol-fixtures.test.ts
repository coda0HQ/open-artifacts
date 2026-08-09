import * as fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateProtocolValue } from "../../protocol/validate.mjs";
import {
  readStateJsonSync,
  writeStateJsonSync,
} from "../../skills/using-open-artifacts/scripts/lib/state-files.mjs";

const root = resolve(import.meta.dirname, "../..");
const fixtureDirectory = join(root, "tests/fixtures/protocol/v1");
const schemaDirectory = join(root, "protocol/v1");
const temporaryDirectories: string[] = [];

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("CLI v1 protocol contract", () => {
  for (const name of [
    "create",
    "update",
    "manifest",
    "error",
    "live-draft",
    "live-checkpoint",
    "live-error",
    "live-draft-response",
    "live-checkpoint-response",
  ]) {
    it(`accepts the shared ${name} Golden Fixture`, async () => {
      const fixture = await json(join(fixtureDirectory, `${name}.json`));
      const schemaName =
        name === "create" || name === "update" ? `${name}-request` : name;
      const schema = await json(
        join(schemaDirectory, `${schemaName}.schema.json`),
      );
      expect(validateProtocolValue(fixture, schema)).toEqual({
        ok: true,
        errors: [],
      });
    });
  }

  it("round-trips the shared Manifest through crash-safe CLI state", async () => {
    const fixture = await json(join(fixtureDirectory, "manifest.json"));
    const directory = await mkdtemp(join(tmpdir(), "oa-protocol-manifest-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "manifest.json");
    writeStateJsonSync(path, fixture, { kind: "manifest" });
    expect(readStateJsonSync(path, {}, { kind: "manifest" })).toEqual(fixture);
    expect(fs.statSync(path).mode & 0o777).toBe(0o644);
  });
});
