import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireFileLockSync,
  FileLockTimeoutError,
} from "../../skills/using-open-artifacts/scripts/lib/file-lock.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function targetFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "open-artifacts-lock-"));
  temporaryDirectories.push(directory);
  return join(directory, "manifest.json");
}

describe("state file locks", () => {
  it("does not steal a live lock", async () => {
    const target = await targetFile();
    const first = acquireFileLockSync(target, { timeoutMs: 50 });
    expect(() => acquireFileLockSync(target, { timeoutMs: 25 })).toThrow(
      FileLockTimeoutError,
    );
    expect(JSON.parse(await readFile(`${target}.lock`, "utf8"))).toMatchObject({
      pid: process.pid,
      hostname: hostname(),
    });
    first.release();
  });

  it("recovers a bounded stale lock whose local owner is dead", async () => {
    const target = await targetFile();
    await writeFile(
      `${target}.lock`,
      JSON.stringify({
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAt: "2000-01-01T00:00:00.000Z",
        nonce: "dead-owner",
      }),
    );
    const lock = acquireFileLockSync(target, {
      timeoutMs: 100,
      staleMs: 1,
    });
    expect(lock.recoveredStaleLock).toBe(true);
    lock.release();
  });
});
