import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBrokenMarkdownLinks } from "../../scripts/lib/docs-links.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("documentation link checker", () => {
  it("checks local files while ignoring anchors, routes, and external URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "oa-doc-links-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "target.md"), "# Target\n");
    await writeFile(
      join(root, "docs/readme.md"),
      "[ok](../target.md) [anchor](#local) [route](/a/id) [web](https://example.com) [bad](missing.md)\n",
    );
    expect(findBrokenMarkdownLinks(root)).toEqual([
      expect.objectContaining({ line: 1, target: "missing.md" }),
    ]);
  });
});
