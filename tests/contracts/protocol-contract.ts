import { describe, expect, it } from "vitest";
import { validateProtocolValue } from "../../protocol/validate.mjs";

export interface ProtocolCase {
  name: string;
  fixture: unknown;
  schema: Record<string, unknown>;
}

export function protocolContract(
  implementation: string,
  cases: readonly ProtocolCase[],
): void {
  describe(`${implementation} Protocol contract`, () => {
    for (const protocolCase of cases) {
      it(`accepts v1 ${protocolCase.name}`, () => {
        expect(
          validateProtocolValue(protocolCase.fixture, protocolCase.schema),
        ).toEqual({ ok: true, errors: [] });
      });
    }
    it("rejects a closed-shape extension", () => {
      const first = cases[0];
      expect(first).toBeDefined();
      expect(
        validateProtocolValue(
          { ...(first.fixture as object), unversionedExtension: true },
          first.schema,
        ).ok,
      ).toBe(false);
    });
  });
}
