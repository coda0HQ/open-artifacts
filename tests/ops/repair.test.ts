import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseReconcileArgs,
  runReconcileLoop,
} from "../../scripts/lib/reconcile-client.mjs";
import { withStorageKinds } from "../../scripts/repair-storage.mjs";

const baseOptions = {
  auditId: "repair-resume-test",
  dryRun: true,
  limit: 2,
  staleAfterMs: 60_000,
  delayMs: 0,
  maxPages: 100,
  resume: false,
};

describe("resumable repair runner", () => {
  it("persists cursor checkpoints, resumes, and appends an audit event per page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oa-repair-test-"));
    const checkpointPath = join(directory, "checkpoint.json");
    const auditPath = join(directory, "audit.jsonl");
    const page = vi.fn(async (cursor?: { publications?: string }) => ({
      auditId: "repair-resume-test",
      dryRun: true,
      startedAt: "2026-08-04T00:00:00.000Z",
      completedAt: "2026-08-04T00:00:00.010Z",
      findings: [],
      results: [],
      cursor: cursor ? null : { publications: "page-2" },
    }));
    try {
      const first = await runReconcileLoop({
        options: {
          ...baseOptions,
          checkpointPath,
          auditPath,
          maxPages: 1,
        },
        requestPage: page,
        now: () => new Date("2026-08-04T00:00:01.000Z"),
      });
      expect(first).toMatchObject({ complete: false, pages: 1 });
      expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({
        cursor: { publications: "page-2" },
        complete: false,
      });

      const second = await runReconcileLoop({
        options: {
          ...baseOptions,
          checkpointPath,
          auditPath,
          resume: true,
        },
        requestPage: page,
        now: () => new Date("2026-08-04T00:00:02.000Z"),
      });
      expect(second).toMatchObject({ complete: true, pages: 2 });
      expect(page.mock.calls[1]?.[0]).toEqual({ publications: "page-2" });
      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual([
        "repair.page",
        "repair.paused",
        "repair.page",
        "repair.completed",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors cancellation before mutation and records a resumable checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oa-repair-cancel-"));
    const controller = new AbortController();
    controller.abort();
    const requestPage = vi.fn();
    try {
      const report = await runReconcileLoop({
        options: {
          ...baseOptions,
          checkpointPath: join(directory, "checkpoint.json"),
          auditPath: join(directory, "audit.jsonl"),
        },
        requestPage,
        signal: controller.signal,
      });
      expect(report).toMatchObject({
        complete: false,
        cancelled: true,
        pages: 0,
      });
      expect(requestPage).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires execution confirmation and constrains storage repair kinds", () => {
    expect(() =>
      parseReconcileArgs([
        "--execute",
        "--audit-id",
        "repair-1",
        "--confirm",
        "different",
      ]),
    ).toThrow(/confirmation/i);
    expect(
      withStorageKinds(
        parseReconcileArgs([
          "--audit-id",
          "repair-storage-1",
          "--kinds",
          "stale_publication,missing_blob",
        ]),
      ).kinds,
    ).toEqual(["missing_blob", "orphan_blob"]);
  });
});
