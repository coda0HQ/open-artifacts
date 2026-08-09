import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/ports/clock";

export function clockContract(name: string, createClock: () => Clock): void {
  describe(`${name} Clock contract`, () => {
    it("returns an unambiguous parseable UTC instant", () => {
      const value = createClock().now();
      expect(Number.isNaN(Date.parse(value))).toBe(false);
      expect(value).toMatch(/Z$/);
      expect(new Date(value).toISOString()).toBe(value);
    });
  });
}
