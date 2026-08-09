import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseArtifacts } from "../../scripts/build-release-artifacts.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";

async function readOutputs(directory: string) {
  const files = (await readdir(directory)).sort();
  return Promise.all(
    files.map(async (file) => [
      file,
      await readFile(join(directory, file), "utf8"),
    ]),
  );
}

describe("immutable release artifacts", () => {
  it("rebuilds metadata byte-for-byte for the same commit and bundle", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "oa-release-test-"));
    const bundle = join(temporary, "worker");
    const first = join(temporary, "first");
    const second = join(temporary, "second");
    try {
      await writeFile(join(temporary, "placeholder"), "unused");
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(bundle, { recursive: true }),
      );
      await writeFile(
        join(bundle, "index.js"),
        "export default {fetch(){}};\n",
      );
      await writeFile(
        join(bundle, "module.wasm"),
        Buffer.from([0, 97, 115, 109]),
      );

      for (const outputDirectory of [first, second]) {
        await buildReleaseArtifacts({
          root: process.cwd(),
          bundleDirectory: bundle,
          outputDirectory,
          commit,
          sourceDateEpoch: 1_786_000_000,
        });
      }

      expect(await readOutputs(second)).toEqual(await readOutputs(first));
      const manifest = JSON.parse(
        await readFile(join(first, "release-manifest.json"), "utf8"),
      );
      expect(manifest).toMatchObject({
        commit,
        schemaVersion: 5,
        reproducible: true,
      });
      expect(manifest.bundle.files).toHaveLength(2);

      const sbom = JSON.parse(
        await readFile(join(first, "sbom.cdx.json"), "utf8"),
      );
      expect(sbom).toMatchObject({
        bomFormat: "CycloneDX",
        specVersion: "1.5",
      });
      expect(sbom.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "hono", type: "library" }),
          expect.objectContaining({ name: "index.js", type: "file" }),
        ]),
      );
      expect(await readFile(join(first, "SHA256SUMS"), "utf8")).toContain(
        "release-manifest.json",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects a mutable ref instead of a full commit SHA", async () => {
    await expect(
      buildReleaseArtifacts({
        root: process.cwd(),
        bundleDirectory: process.cwd(),
        outputDirectory: join(tmpdir(), "must-not-build"),
        commit: "main",
        sourceDateEpoch: 1,
      }),
    ).rejects.toThrow(/full 40-character commit SHA/);
  });
});
