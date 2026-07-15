import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildTextAnchor, reAnchor } from "../../src/anchor";

const DOC = "The quarterly revenue grew 12% in Q3 and total costs fell.";

describe("buildTextAnchor", () => {
  it("captures the quote with bounded context", () => {
    const start = DOC.indexOf("quarterly revenue grew 12%");
    const end = start + "quarterly revenue grew 12%".length;
    const a = buildTextAnchor(DOC, start, end);
    expect(a.mode).toBe("text");
    expect(a.quote).toBe("quarterly revenue grew 12%");
    expect(a.prefix.length).toBeLessThanOrEqual(32);
    expect(a.suffix.length).toBeLessThanOrEqual(32);
    expect(a.start).toBe(start);
  });

  it("truncates a quote longer than 1000 characters", () => {
    const big = `x${"y".repeat(1500)}`;
    const a = buildTextAnchor(big, 0, big.length);
    expect(a.quote.length).toBe(1000);
  });
});

describe("reAnchor", () => {
  it("resolves an exact quote to its character range", () => {
    const start = DOC.indexOf("quarterly revenue grew 12%");
    const a = buildTextAnchor(DOC, start, start + 26);
    expect(reAnchor(DOC, a)).toEqual({ start, end: start + 26 });
  });

  it("disambiguates a repeated quote by surrounding context", () => {
    const doc = "Total apples. Then later: Total oranges here.";
    // Anchor the SECOND "Total" (before " oranges").
    const second = doc.lastIndexOf("Total");
    const a = buildTextAnchor(doc, second, second + 5);
    const r = reAnchor(doc, a);
    expect(r).toEqual({ start: second, end: second + 5 });
    expect(r).not.toEqual({ start: doc.indexOf("Total"), end: 5 });
  });

  it("falls back to the quote alone when context has changed", () => {
    const start = DOC.indexOf("total costs");
    const a = buildTextAnchor(DOC, start, start + 11);
    // Re-anchor against a doc where the surrounding words differ but the quote survives.
    const edited = `Meanwhile the total costs were reviewed.`;
    const es = edited.indexOf("total costs");
    expect(reAnchor(edited, a)).toEqual({ start: es, end: es + 11 });
  });

  it("orphans a quote that no longer exists", () => {
    const a = buildTextAnchor(DOC, 4, 13);
    expect(reAnchor("a completely different document", a)).toBe("orphan");
  });
});

describe("frame document carries the text-highlight runtime", () => {
  it("includes the highlight CSS and the injected matcher", async () => {
    const created = await exports.default.fetch(
      new Request("http://artifacts.test/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "<p>quarterly revenue grew 12%</p>",
          title: "Doc",
          favicon: "📊",
        }),
      }),
    );
    const { id } = (await created.json()) as { id: string };
    const html = await (
      await exports.default.fetch(`http://artifacts.test/a/${id}/frame`)
    ).text();
    expect(html).toContain("::highlight(oa-cm)");
    expect(html).toContain("CSS.highlights.set('oa-cm'");
    // The matcher source was injected verbatim.
    expect(html).toContain("function reAnchor");
  });
});
