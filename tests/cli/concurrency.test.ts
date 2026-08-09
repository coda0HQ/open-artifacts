import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readStateJsonSync } from "../../skills/using-open-artifacts/scripts/lib/state-files.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("cross-process state concurrency", () => {
  it("preserves all 100 read-modify-write operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-artifacts-race-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "config.json");
    const helper = join(process.cwd(), "tests/fixtures/state-mutator.mjs");

    await Promise.all(
      Array.from({ length: 4 }, () =>
        execFileAsync(process.execPath, [helper, target, "25"], {
          cwd: process.cwd(),
        }),
      ),
    );

    expect(readStateJsonSync(target, {}, { kind: "config" })).toMatchObject({
      counter: 100,
    });
  });
});
