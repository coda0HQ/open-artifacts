import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readStateJsonSync,
  StateFileError,
  writeStateJsonSync,
} from "../../skills/using-open-artifacts/scripts/lib/state-files.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function targetFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "open-artifacts-corrupt-"));
  temporaryDirectories.push(directory);
  return join(directory, "manifest.json");
}

describe("state corruption handling", () => {
  it("accepts a legacy file and upgrades it on the next write", async () => {
    const target = await targetFile();
    await writeFile(target, '{"manifestVersion":2,"artifacts":[]}\n');
    const legacy = readStateJsonSync(
      target,
      { artifacts: [] },
      { kind: "manifest" },
    );
    expect(legacy).toMatchObject({ manifestVersion: 2, artifacts: [] });
    writeStateJsonSync(target, legacy, { kind: "manifest" });
    expect(await readFile(target, "utf8")).toContain('"checksum"');
  });

  it("quarantines truncated JSON and gives an actionable recovery path", async () => {
    const target = await targetFile();
    await writeFile(target, '{"manifestVersion":2,"artifacts":[');

    expect(() =>
      readStateJsonSync(target, { artifacts: [] }, { kind: "manifest" }),
    ).toThrow(StateFileError);
    expect(await readdir(join(target, ".."))).toEqual([
      expect.stringMatching(/^manifest\.json\.corrupt-/),
    ]);
  });

  it("rejects checksum drift without silently replacing the file", async () => {
    const target = await targetFile();
    writeStateJsonSync(
      target,
      { manifestVersion: 2, artifacts: [] },
      { kind: "manifest" },
    );
    const contents = await readFile(target, "utf8");
    await writeFile(
      target,
      contents.replace('"manifestVersion": 2', '"manifestVersion": 3'),
    );

    expect(() =>
      readStateJsonSync(target, { artifacts: [] }, { kind: "manifest" }),
    ).toThrow(/checksum mismatch/);
    expect(
      (await readdir(join(target, ".."))).some((name) =>
        name.includes(".corrupt-"),
      ),
    ).toBe(true);
  });
});
