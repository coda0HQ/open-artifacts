import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildTextAnchor, reAnchor } from "../../src/anchor";

const DOC = "The quarterly revenue grew 12% in Q3 and total costs fell.";

describe("buildTextAnchor", () => {
  it("captures the quote with bounded context", () => {
    const start = DOC.indexOf("quarterly revenue grew 12%");
    const end = start + "quarterly revenue grew 12%".length;
    const a = buildTextAnchor(DOC, start, end, 3);
    expect(a.mode).toBe("text");
    expect(a.quote).toBe("quarterly revenue grew 12%");
    expect(a.prefix.length).toBeLessThanOrEqual(32);
    expect(a.suffix.length).toBeLessThanOrEqual(32);
    expect(a.start).toBe(start);
    expect(a.anchorVersion).toBe(3);
  });

  it("truncates a quote longer than 1000 characters", () => {
    const big = `x${"y".repeat(1500)}`;
    const a = buildTextAnchor(big, 0, big.length);
    expect(a.quote.length).toBe(1000);
  });

  it("keeps a truncated quote's context contiguous so it can re-anchor", () => {
    // A >1000-char selection: the suffix must follow the TRUNCATED quote, not
    // the original end, or prefix+quote+suffix is a string the document does
    // not contain and the exact-with-context tier silently never fires.
    const doc = `HEAD${"a".repeat(1200)}TAIL-MARKER`;
    const start = 4;
    const end = start + 1200;
    const a = buildTextAnchor(doc, start, end);
    expect(a.quote.length).toBe(1000);
    expect(doc).toContain(a.prefix + a.quote + a.suffix);
    // And it must actually resolve back to the truncated range.
    expect(reAnchor(doc, a)).toEqual({ start, end: start + 1000 });
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
    // Notion-style selection chip: appear on select, open compose on click.
    expect(html).toContain(".oa-cm-sel");
    expect(html).toContain("Comment on selection");
    expect(html).toContain("showBubble");
    // Chrome typeface — never inherit the artifact's face.
    expect(html).toContain("font-family:var(--oa-font)");
    expect(html).toContain("--oa-font:");
    // Encrypted frames suppress the selection chip (server rejects text anchors).
    expect(html).toContain("window.__oaEncrypted");
    // Orphan ids are reported to the host drawer (REQ-010).
    expect(html).toContain("type:'oa:orphans'");
    // The matcher source was injected verbatim.
    expect(html).toContain("function reAnchor");
    // esbuild's keepNames wraps inner functions in __name(); the frame must
    // ship a passthrough shim or the injected matcher throws at runtime.
    if (html.includes("__name(")) {
      expect(html).toContain("var __name=function(f){return f}");
    }
  });
});
