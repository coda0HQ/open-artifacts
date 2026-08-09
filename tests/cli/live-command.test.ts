import { describe, expect, it, vi } from "vitest";
import {
  checkpointLiveDraft,
  saveLiveDraft,
} from "../../skills/using-open-artifacts/scripts/commands/live.mjs";

describe("Live draft CLI commands", () => {
  it("creates revision one when no draft exists without publishing", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, json: { error: "not found" } })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          draft: {
            revision: 1,
            baseVersion: 4,
            state: "active",
            updatedAt: "2026-08-04T00:00:00.000Z",
          },
        },
      });

    const draft = await saveLiveDraft({
      artifactId: "artifact one",
      apiUrl: "https://artifacts.test/",
      baseVersion: 4,
      payload: { content: "<p>draft</p>", format: "html" },
      capability: "wt_secret",
      request,
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "GET",
      "https://artifacts.test/api/artifacts/artifact%20one/live/draft",
      undefined,
      "wt_secret",
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "PUT",
      "https://artifacts.test/api/artifacts/artifact%20one/live/draft",
      {
        protocolVersion: 1,
        expectedRevision: 0,
        baseVersion: 4,
        content: "<p>draft</p>",
        format: "html",
      },
      "wt_secret",
    );
    expect(draft).toMatchObject({ revision: 1, baseVersion: 4 });
  });

  it("advances the current draft revision with compare-and-set semantics", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: { draft: { revision: 7, baseVersion: 4, state: "active" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { draft: { revision: 8, baseVersion: 4, state: "active" } },
      });

    await saveLiveDraft({
      artifactId: "artifact-1",
      apiUrl: "https://artifacts.test",
      baseVersion: 4,
      payload: { content: "next" },
      capability: "wt_secret",
      request,
    });

    expect(request.mock.calls[1]?.[2]).toMatchObject({ expectedRevision: 7 });
  });

  it("reports a stale draft without hiding the winning revision", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, json: {} })
      .mockResolvedValueOnce({
        status: 409,
        json: {
          code: "REVISION_CONFLICT",
          error: "draft revision conflict",
          currentRevision: 3,
        },
      });

    await expect(
      saveLiveDraft({
        artifactId: "artifact-1",
        apiUrl: "https://artifacts.test",
        baseVersion: 4,
        payload: { content: "stale" },
        capability: "wt_secret",
        request,
      }),
    ).rejects.toThrow("draft revision conflict (current revision 3)");
  });

  it("checkpoints the exact draft revision with a stable idempotency key", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: { draft: { revision: 8, baseVersion: 4, state: "active" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          id: "artifact-1",
          url: "https://artifacts.test/a/artifact-1",
          version: 5,
          draftRevision: 8,
        },
      });

    const publication = await checkpointLiveDraft({
      artifactId: "artifact-1",
      apiUrl: "https://artifacts.test/",
      capability: "wt_secret",
      request,
    });

    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST",
      "https://artifacts.test/api/artifacts/artifact-1/live/checkpoint",
      { protocolVersion: 1, expectedRevision: 8 },
      "wt_secret",
      { "idempotency-key": "cli-live-checkpoint:artifact-1:r8:b4" },
    );
    expect(publication).toMatchObject({ version: 5, draftRevision: 8 });
  });

  it("refuses to checkpoint when no draft exists", async () => {
    await expect(
      checkpointLiveDraft({
        artifactId: "artifact-1",
        apiUrl: "https://artifacts.test",
        capability: "wt_secret",
        request: async () => ({ status: 404, json: { error: "not found" } }),
      }),
    ).rejects.toThrow("no Live draft exists");
  });
});
