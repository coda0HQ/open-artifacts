import { describe, expect, it } from "vitest";
import {
  assertSchemaCompatibility,
  CURRENT_SCHEMA_VERSION,
  SchemaCompatibilityError,
} from "../../src/migrations/compatibility";

describe("schema compatibility policy", () => {
  it("accepts only the exact application schema version", () => {
    expect(() =>
      assertSchemaCompatibility(CURRENT_SCHEMA_VERSION),
    ).not.toThrow();
    for (const actual of [
      0,
      CURRENT_SCHEMA_VERSION - 1,
      CURRENT_SCHEMA_VERSION + 1,
    ]) {
      expect(() => assertSchemaCompatibility(actual)).toThrow(
        SchemaCompatibilityError,
      );
    }
  });

  it("returns an operator-safe error without SQL or secrets", () => {
    try {
      assertSchemaCompatibility(0);
      throw new Error("expected schema validation to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SCHEMA_INCOMPATIBLE",
        actualVersion: 0,
        expectedVersion: CURRENT_SCHEMA_VERSION,
      });
      expect(String(error)).toContain(
        "apply migrations before serving traffic",
      );
      expect(String(error)).not.toMatch(/SELECT|token|secret/i);
    }
  });
});
