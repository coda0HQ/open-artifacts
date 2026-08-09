import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HELP,
  parseCliArguments,
} from "../../skills/using-open-artifacts/scripts/artifact.mjs";
import {
  deepestCause,
  request,
} from "../../skills/using-open-artifacts/scripts/lib/transport.mjs";
import {
  requireRecipePath,
  validateLabel,
} from "../../skills/using-open-artifacts/scripts/lib/validation.mjs";
import { diffSnapshot } from "../../skills/using-open-artifacts/scripts/lib/watch.mjs";

describe("decomposed CLI modules", () => {
  it("keeps parsing and help in the composition root", () => {
    const parsed = parseCliArguments([
      "update",
      "artifact-id",
      "recipe.json",
      "--live",
      "--label",
      "review",
    ]);
    expect(parsed.positionals).toEqual([
      "update",
      "artifact-id",
      "recipe.json",
    ]);
    expect(parsed.values).toMatchObject({ live: true, label: "review" });
    expect(HELP).toContain("live checkpoint <id>");
  });

  it("owns protocol/auth headers and raw-body handling in Transport", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          "Open-Artifacts-Protocol": "1",
          authorization: "Bearer token",
        });
        expect(init?.body).toBe('{"hello":"world"}');
        return new Response("not-json", { status: 200 });
      },
    );
    const response = await request(
      "POST",
      "https://example.test/api",
      { hello: "world" },
      "token",
      {},
      fetchImpl,
    );
    expect(response.text).toBe("not-json");
    expect(response.json).toEqual({ error: "not-json" });
  });

  it("surfaces the deepest network cause", () => {
    const leaf = new Error("ECONNRESET");
    const wrapped = new Error("fetch failed", { cause: leaf });
    expect(deepestCause(wrapped)).toBe("ECONNRESET");
  });

  it("keeps validation and watch diff independent of command dispatch", () => {
    expect(requireRecipePath("artifact.recipe.json")).toBe(
      "artifact.recipe.json",
    );
    expect(() => requireRecipePath("artifact.html")).toThrow(
      "direct HTML/Markdown publishing",
    );
    expect(() => validateLabel("界".repeat(21))).toThrow("at most 60 bytes");
    expect(diffSnapshot({ a: "1", old: "2" }, { a: "2", next: "3" })).toEqual([
      "a",
      "next",
      "old (deleted)",
    ]);
  });

  it("keeps artifact.mjs a small composition/dispatch root", async () => {
    const root = resolve(
      import.meta.dirname,
      "../../skills/using-open-artifacts/scripts/artifact.mjs",
    );
    const source = await readFile(root, "utf8");
    expect(source.split("\n").length).toBeLessThan(400);
    expect(source).toContain("export async function dispatch");
    expect(source).not.toContain("writeFileSync");
    expect(source).not.toContain("await fetch(");
    expect(source).not.toContain("buildArtifactRecipe(");
  });
});
