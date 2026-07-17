import { describe, expect, it } from "vitest";
import {
  CURRENT_ANCHOR_VERSION,
  validateAnchor,
  validateComment,
} from "../../src/domain";

describe("validateAnchor — point mode", () => {
  it("accepts finite integer world coordinates", () => {
    const r = validateAnchor({ mode: "point", x: 100, y: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mode).toBe("point");
      expect(r.value.anchorVersion).toBe(CURRENT_ANCHOR_VERSION);
    }
  });

  it("accepts negative and large world coordinates (unbounded)", () => {
    expect(validateAnchor({ mode: "point", x: -5000, y: 999999 }).ok).toBe(
      true,
    );
  });

  it("rejects a string coordinate", () => {
    const r = validateAnchor({ mode: "point", x: "Infinity", y: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects a non-finite numeric coordinate", () => {
    expect(
      validateAnchor({ mode: "point", x: Number.POSITIVE_INFINITY, y: 0 }).ok,
    ).toBe(false);
    expect(validateAnchor({ mode: "point", x: Number.NaN, y: 0 }).ok).toBe(
      false,
    );
  });
});

describe("validateAnchor — text mode", () => {
  it("accepts a quote with bounded context", () => {
    const r = validateAnchor({
      mode: "text",
      quote: "quarterly revenue grew 12%",
      prefix: "…",
      suffix: " in Q3",
      start: 40,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a quote longer than 1000 characters", () => {
    const r = validateAnchor({
      mode: "text",
      quote: "a".repeat(1001),
      prefix: "",
      suffix: "",
      start: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects a prefix longer than 32 characters", () => {
    expect(
      validateAnchor({
        mode: "text",
        quote: "x",
        prefix: "p".repeat(33),
        suffix: "",
        start: 0,
      }).ok,
    ).toBe(false);
  });

  it("rejects an anchor whose serialized byte length exceeds 2 KiB", () => {
    // 700 four-byte emoji = ~2800 UTF-8 bytes but only 700 code points,
    // so it passes the 1000-char quote cap yet fails the 2 KiB byte cap.
    const r = validateAnchor({
      mode: "text",
      quote: "😀".repeat(700),
      prefix: "",
      suffix: "",
      start: 0,
    });
    expect(r.ok).toBe(false);
  });
});

describe("validateComment — anchor integration", () => {
  it("defaults a comment with no anchor to unanchored", () => {
    const r = validateComment({ body: "hi" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.anchor).toBeNull();
  });

  it("carries a valid point anchor and defaults its version", () => {
    const r = validateComment({
      body: "hi",
      anchor: { mode: "point", x: 1, y: 2 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.anchor?.mode).toBe("point");
      expect(r.value.anchor?.anchorVersion).toBe(CURRENT_ANCHOR_VERSION);
    }
  });

  it("rejects a comment carrying an invalid anchor", () => {
    const r = validateComment({
      body: "hi",
      anchor: { mode: "point", x: "nope", y: 0 },
    });
    expect(r.ok).toBe(false);
  });
});
