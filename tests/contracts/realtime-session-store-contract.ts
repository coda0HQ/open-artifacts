import { describe, expect, it } from "vitest";
import type { RealtimeSessionStore } from "../../src/ports/realtime-session-store";

export function realtimeSessionStoreContract(
  name: string,
  runWithStore: (
    test: (store: RealtimeSessionStore) => Promise<void>,
  ) => Promise<void>,
): void {
  describe(`${name} RealtimeSessionStore contract`, () => {
    it("creates and updates drafts with revision compare-and-set", async () => {
      await runWithStore(async (store) => {
        const artifactId = `draft-${name}-${crypto.randomUUID()}`;
        const first = {
          artifactId,
          protocolVersion: 1 as const,
          revision: 1,
          baseVersion: 3,
          state: "active" as const,
          actorId: "actor-one",
          leaseOwner: "actor-one",
          leaseUntil: "2026-08-04T00:01:00.000Z",
          payload: { content: "first" },
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
          expiresAt: "2026-08-05T00:00:00.000Z",
          checkpointVersion: null,
        };
        expect(await store.compareAndSetDraft(null, first)).toBe(true);
        expect(await store.compareAndSetDraft(null, first)).toBe(false);
        expect(
          await store.compareAndSetDraft(1, {
            ...first,
            revision: 2,
            payload: { content: "second" },
          }),
        ).toBe(true);
        expect(
          await store.compareAndSetDraft(1, {
            ...first,
            revision: 2,
            payload: { content: "stale" },
          }),
        ).toBe(false);
        expect(await store.getDraft(artifactId)).toMatchObject({
          revision: 2,
          payload: { content: "second" },
        });
      });
    });
  });
}
