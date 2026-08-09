import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scan(path: string) {
  return spawnSync(process.execPath, ["scripts/scan-secrets.mjs", path], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("secret scanner", () => {
  it("accepts ordinary source and rejects an implanted credential", () => {
    const directory = mkdtempSync(join(tmpdir(), "oa-secret-scan-"));
    temporaryDirectories.push(directory);
    const clean = join(directory, "clean.txt");
    const leaked = join(directory, "leaked.txt");
    writeFileSync(clean, "ordinary configuration\n", "utf8");
    writeFileSync(
      leaked,
      ["sk", "-proj-", "abcdefghijklmnopqrstuvwxyz123456"].join(""),
      "utf8",
    );
    expect(scan(clean).status).toBe(0);
    const result = scan(leaked);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenAI API key");
    expect(result.stderr).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("rejects raw secret fields in a manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "oa-secret-scan-"));
    temporaryDirectories.push(directory);
    const manifest = join(directory, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({ writeToken: "not-printed" }),
      "utf8",
    );
    const result = scan(manifest);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("forbidden secret field writeToken");
    expect(result.stderr).not.toContain("not-printed");
  });
});
