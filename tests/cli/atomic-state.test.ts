import * as fs from "node:fs";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync } from "../../skills/using-open-artifacts/scripts/lib/atomic-write.mjs";
import {
  readStateJsonSync,
  writeStateJsonSync,
} from "../../skills/using-open-artifacts/scripts/lib/state-files.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "open-artifacts-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

describe("crash-safe state writes", () => {
  it("keeps the old file intact when a pre-commit syscall fails", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "state.json");
    await writeFile(target, "original\n");
    const originals = {
      writeFileSync: fs.writeFileSync,
      fsyncSync: fs.fsyncSync,
      renameSync: fs.renameSync,
    };
    for (const operation of [
      "writeFileSync",
      "fsyncSync",
      "renameSync",
    ] as const) {
      let injected = false;
      const failing = {
        ...fs,
        [operation]: (...arguments_: unknown[]) => {
          if (!injected) {
            injected = true;
            throw new Error(`injected ${operation}`);
          }
          return Reflect.apply(originals[operation], fs, arguments_);
        },
      };
      expect(() =>
        atomicWriteFileSync(target, "replacement\n", {
          fileSystem: failing,
          mode: 0o600,
        }),
      ).toThrow(`injected ${operation}`);
      expect(await readFile(target, "utf8")).toBe("original\n");
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    }
  });

  it("writes secret state with 0600 and an embedded checksum", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "credentials.json");
    writeStateJsonSync(
      target,
      { tokens: { artifact: "wt_secret" } },
      { kind: "credentials", secret: true },
    );

    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({
      tokens: { artifact: "wt_secret" },
      _state: { schemaVersion: 1, checksum: expect.stringMatching(/^sha256:/) },
    });
    expect(
      readStateJsonSync(target, {}, { kind: "credentials" }),
    ).toMatchObject({ tokens: { artifact: "wt_secret" } });
  });
});
