import { describe, expect, it, vi } from "vitest";
import {
  assertRestoreTarget,
  buildRestoreValidation,
  validateRestoredArtifact,
} from "../../scripts/restore-staging.mjs";

describe("isolated staging restore", () => {
  it("never permits an in-place or production restore", () => {
    expect(() =>
      assertRestoreTarget({
        targetEnvironment: "production",
        targetDatabaseId: "restore-db",
        sourceDatabaseId: "source-db",
      }),
    ).toThrow(/production/i);
    expect(() =>
      assertRestoreTarget({
        targetEnvironment: "staging",
        targetDatabaseId: "same-db",
        sourceDatabaseId: "same-db",
      }),
    ).toThrow(/source database/i);
    expect(() =>
      assertRestoreTarget({
        targetEnvironment: "staging",
        targetDatabaseId: "isolated-db",
        sourceDatabaseId: "source-db",
      }),
    ).not.toThrow();
  });

  it("checks schema, row counts and every sampled immutable hash", () => {
    const report = buildRestoreValidation(
      {
        schemaVersion: 5,
        rowCounts: { artifacts: 2, versions: 4, comments: 1 },
        samples: [
          { artifactId: "a-1", version: 1, contentHash: "hash-1" },
          { artifactId: "a-2", version: 2, contentHash: "hash-2" },
        ],
      },
      {
        schemaVersion: 5,
        rowCounts: { artifacts: 2, versions: 4, comments: 1 },
        samples: [
          { artifactId: "a-1", version: 1, contentHash: "hash-1" },
          { artifactId: "a-2", version: 2, contentHash: "hash-2" },
        ],
      },
    );
    expect(report).toMatchObject({ ok: true, failures: [] });

    expect(
      buildRestoreValidation(
        {
          schemaVersion: 5,
          rowCounts: { artifacts: 2 },
          samples: [{ artifactId: "a-1", version: 1, contentHash: "old" }],
        },
        {
          schemaVersion: 4,
          rowCounts: { artifacts: 1 },
          samples: [{ artifactId: "a-1", version: 1, contentHash: "changed" }],
        },
      ).failures,
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/schema/i),
        expect.stringMatching(/row count/i),
        expect.stringMatching(/hash/i),
      ]),
    );
  });

  it("probes restored read access and verifies unauthorized writes fail closed", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<main>restored</main>", { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const report = await validateRestoredArtifact({
      baseUrl: "https://restore-staging.example.test",
      sample: { artifactId: "a-1", version: 1, contentHash: "hash-1" },
      fetchImpl,
    });

    expect(report).toEqual({ readable: true, unauthorizedWriteBlocked: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://restore-staging.example.test/a/a-1?v=1",
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/Bearer|token/i);
  });
});
