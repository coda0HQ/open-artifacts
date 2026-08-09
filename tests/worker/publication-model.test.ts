import { describe, expect, it } from "vitest";
import {
  canTransitionPublication,
  type PublicationState,
  transitionPublication,
} from "../../src/publication/model";

describe("publication state model", () => {
  it("allows only the documented forward transitions", () => {
    const allowed: Array<[PublicationState, PublicationState]> = [
      ["pending", "blob_ready"],
      ["pending", "conflict"],
      ["pending", "failed"],
      ["pending", "expired"],
      ["blob_ready", "committed"],
      ["blob_ready", "conflict"],
      ["blob_ready", "failed"],
      ["blob_ready", "expired"],
    ];
    for (const [from, to] of allowed) {
      expect(canTransitionPublication(from, to)).toBe(true);
      expect(transitionPublication(from, to)).toBe(to);
    }
  });

  it("keeps every terminal state irreversible", () => {
    for (const terminal of [
      "committed",
      "conflict",
      "failed",
      "expired",
    ] as const) {
      expect(canTransitionPublication(terminal, "pending")).toBe(false);
      expect(() => transitionPublication(terminal, "pending")).toThrow(
        `cannot transition publication from ${terminal} to pending`,
      );
    }
  });
});
