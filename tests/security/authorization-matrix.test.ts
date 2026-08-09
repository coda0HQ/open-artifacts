import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_MATRIX,
  authorizationRuleFor,
} from "../../src/authorization-matrix";

describe("authorization matrix", () => {
  it("has no duplicate verb/route decisions", () => {
    const keys = AUTHORIZATION_MATRIX.map(
      (rule) => `${rule.method} ${rule.route}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("defaults an unknown route combination to deny", () => {
    expect(authorizationRuleFor("POST", "/api/unknown")).toBeNull();
    expect(authorizationRuleFor("TRACE", "/api/artifacts/:id")).toBeNull();
  });

  it("requires explicit authority for every mutating family", () => {
    const mutations = AUTHORIZATION_MATRIX.filter((rule) =>
      ["POST", "PUT", "PATCH", "DELETE"].includes(rule.method),
    );
    expect(mutations).not.toHaveLength(0);
    expect(mutations.every((rule) => rule.requirement !== "public")).toBe(true);
  });
});
