import { describe, expect, it } from "vitest";
import type { QuotaLedger } from "../../src/ports/quota-ledger";

let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${crypto.randomUUID()}`;
}

export function quotaLedgerContract(
  name: string,
  createLedger: () => Promise<QuotaLedger> | QuotaLedger,
): void {
  describe(`${name} QuotaLedger contract`, () => {
    it("enforces a total exactly under concurrent reservations", async () => {
      const ledger = await createLedger();
      const scopeKey = unique(`${name}-concurrent`);
      const results = await Promise.all(
        ["one", "two", "three"].map((entityKey) =>
          ledger.reserve({
            scopeKey,
            resource: "comments",
            entityKey,
            amount: 1,
            limit: 2,
            now: "2026-08-04T00:00:00.000Z",
          }),
        ),
      );
      expect(
        results.filter((result) => result.outcome !== "exceeded"),
      ).toHaveLength(2);
      expect(
        results.filter((result) => result.outcome === "exceeded"),
      ).toHaveLength(1);
      expect(await ledger.usage(scopeKey, "comments")).toBe(2);
    });

    it("replays an entity without double charging and atomically adjusts it", async () => {
      const ledger = await createLedger();
      const scopeKey = unique(`${name}-adjust`);
      const request = {
        scopeKey,
        resource: "handoff_bytes" as const,
        entityKey: "handoff-v1",
        amount: 4,
        limit: 10,
        now: "2026-08-04T00:00:00.000Z",
      };
      expect((await ledger.reserve(request)).outcome).toBe("reserved");
      await ledger.commit(
        scopeKey,
        request.resource,
        request.entityKey,
        request.now,
      );
      expect((await ledger.reserve(request)).outcome).toBe("replayed");
      expect(
        (
          await ledger.reserve({
            ...request,
            amount: 9,
            now: "2026-08-04T00:01:00.000Z",
          })
        ).outcome,
      ).toBe("adjusted");
      expect(await ledger.usage(scopeKey, request.resource)).toBe(9);
      expect(
        (
          await ledger.reserve({
            ...request,
            amount: 11,
            now: "2026-08-04T00:02:00.000Z",
          })
        ).outcome,
      ).toBe("exceeded");
      expect(await ledger.usage(scopeKey, request.resource)).toBe(9);
    });

    it("releases failed work and committed entities explicitly", async () => {
      const ledger = await createLedger();
      const scopeKey = unique(`${name}-release`);
      const request = {
        scopeKey,
        resource: "storage_bytes" as const,
        entityKey: "publication-one",
        amount: 8,
        limit: 8,
        now: "2026-08-04T00:00:00.000Z",
      };
      await ledger.reserve(request);
      expect(await ledger.usage(scopeKey, request.resource)).toBe(8);
      await ledger.release(
        scopeKey,
        request.resource,
        request.entityKey,
        request.now,
      );
      expect(await ledger.usage(scopeKey, request.resource)).toBe(0);

      await ledger.reserve({ ...request, entityKey: "publication-two" });
      await ledger.commit(
        scopeKey,
        request.resource,
        "publication-two",
        request.now,
      );
      expect(await ledger.usage(scopeKey, request.resource)).toBe(8);
      await ledger.releaseScope(scopeKey, request.now);
      expect(await ledger.usage(scopeKey, request.resource)).toBe(0);
    });
  });
}
