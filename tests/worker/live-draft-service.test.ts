import { describe, expect, it } from "vitest";
import { MemoryRealtimeSessionStore } from "../../src/adapters/memory/realtime-session-store";
import { DraftService } from "../../src/live/draft-service";
import { FixedClock } from "../../src/ports/clock";

const payload = { content: "<p>draft</p>", format: "html" as const };

describe("DraftService", () => {
  it("increments revisions and rejects a stale editor without overwriting", async () => {
    const service = new DraftService(
      new MemoryRealtimeSessionStore(),
      new FixedClock("2026-08-04T00:00:00.000Z"),
    );
    const first = await service.save({
      artifactId: "artifact-one",
      actorId: "actor-one",
      expectedRevision: 0,
      baseVersion: 4,
      payload,
    });
    expect(first).toMatchObject({ ok: true, draft: { revision: 1 } });

    const stale = await service.save({
      artifactId: "artifact-one",
      actorId: "actor-one",
      expectedRevision: 0,
      baseVersion: 4,
      payload: { ...payload, content: "stale overwrite" },
    });
    expect(stale).toMatchObject({
      ok: false,
      code: "REVISION_CONFLICT",
      currentRevision: 1,
    });
    expect(await service.get("artifact-one")).toMatchObject({
      revision: 1,
      payload,
    });
  });

  it("uses a bounded actor lease and reports its owner", async () => {
    const service = new DraftService(
      new MemoryRealtimeSessionStore(),
      new FixedClock("2026-08-04T00:00:00.000Z"),
    );
    await service.save({
      artifactId: "artifact-lease",
      actorId: "actor-one",
      expectedRevision: 0,
      baseVersion: 1,
      payload,
      leaseSeconds: 30,
    });
    const blocked = await service.save({
      artifactId: "artifact-lease",
      actorId: "actor-two",
      expectedRevision: 1,
      baseVersion: 1,
      payload,
    });
    expect(blocked).toMatchObject({
      ok: false,
      code: "LEASE_HELD",
      leaseOwner: "actor-one",
    });
  });

  it("marks a matching revision checkpointed and keeps content recoverable", async () => {
    const service = new DraftService(new MemoryRealtimeSessionStore());
    const saved = await service.save({
      artifactId: "artifact-checkpoint",
      actorId: "actor-one",
      expectedRevision: 0,
      baseVersion: 2,
      payload,
    });
    if (!saved.ok) throw new Error("draft save unexpectedly failed");
    expect(await service.markCheckpointed("artifact-checkpoint", 1, 3)).toBe(
      true,
    );
    expect(await service.get("artifact-checkpoint")).toMatchObject({
      state: "checkpointed",
      revision: 1,
      checkpointVersion: 3,
      payload,
    });
  });
});
