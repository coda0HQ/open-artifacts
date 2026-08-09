import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateViewerRuntime } from "../../scripts/build-viewer-runtime.mjs";

describe("deterministic inline viewer runtime", () => {
  it("rebuilds byte-identically from reviewed source modules", async () => {
    const [first, second, committed] = await Promise.all([
      generateViewerRuntime(),
      generateViewerRuntime(),
      readFile("src/generated/viewer-runtime.ts", "utf8"),
    ]);
    expect(first).toBe(second);
    expect(first).toBe(committed);
    expect(first).toContain("DO NOT EDIT");
    expect(first).toMatch(/VIEWER_RUNTIME_SHA256 = "[a-f0-9]{64}"/);
  });

  it("keeps frame code offline and forbids dynamic evaluation/external requests", async () => {
    const generated = await generateViewerRuntime();
    expect(generated).not.toMatch(/\beval\s*\(|\bnew\s+Function\s*\(/);
    const frameSources = [
      "src/viewer/runtime/frame/bridge.js",
      "src/viewer/runtime/frame/live-picker.js",
      "src/viewer/runtime/frame/handoff-record.js",
      "src/viewer/runtime/frame/handoff-play.js",
      "src/viewer/runtime/frame/anchor.js",
    ];
    for (const path of frameSources) {
      const source = await readFile(path, "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(|\bWebSocket\s*\(/);
    }
  });

  it("leaves wrap.ts as server assembly instead of an embedded runtime monolith", async () => {
    const wrap = await readFile("src/wrap.ts", "utf8");
    expect(wrap.split("\n").length).toBeLessThan(2_000);
    expect(wrap).not.toMatch(
      /const (?:HOST_UI|FRAME_LIVE_PICKER|DOCK)_SCRIPT\s*=/,
    );
    expect(wrap).toContain('from "./generated/viewer-runtime"');
    expect(wrap).toContain('from "./viewer/host/live-runtime"');
  });
});
