// Pure anchor geometry, shared as the tested spec for the frame-side inline
// scripts in wrap.ts. The frame reimplements the same math in vanilla JS
// (it runs in the sandboxed document and cannot import), so these functions
// are the single source of truth the tests pin the behaviour to.

// Invert the canvas plane transform (translate(tx,ty) scale(k), origin 0 0) to
// map a screen point — relative to the plane's bounding box — to world
// coordinates. World coordinates are zoom/pan-independent, so a pin dropped at
// any zoom re-renders on the same spot.
export function screenToWorld(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  k: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  return {
    x: (clientX - rect.left - tx) / k,
    y: (clientY - rect.top - ty) / k,
  };
}

export interface TextAnchor {
  mode: "text";
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  anchorVersion: number;
}

// Build a W3C-style quote selector from a selection over the document's text.
// Stores the exact quote plus a short context window on each side; no geometry,
// so it is inherently reflow-proof. Self-contained (no external refs) so its
// source can be injected verbatim into the sandboxed frame via .toString().
export function buildTextAnchor(
  fullText: string,
  start: number,
  end: number,
): TextAnchor {
  const MAX_QUOTE = 1000;
  const MAX_CTX = 32;
  const rawQuote = fullText.slice(start, end);
  const quote =
    rawQuote.length > MAX_QUOTE ? rawQuote.slice(0, MAX_QUOTE) : rawQuote;
  const prefix = fullText.slice(Math.max(0, start - MAX_CTX), start);
  const suffix = fullText.slice(end, end + MAX_CTX);
  return { mode: "text", quote, prefix, suffix, start, anchorVersion: 1 };
}

// Re-resolve a text anchor against the current document text: exact match with
// surrounding context first (disambiguating repeats by the stored start hint),
// then the quote alone, else "orphan". Self-contained for .toString() injection.
export function reAnchor(
  fullText: string,
  anchor: { quote: string; prefix: string; suffix: string; start: number },
): { start: number; end: number } | "orphan" {
  const quote = anchor.quote;
  if (!quote) return "orphan";
  const allIndexes = (hay: string, needle: string): number[] => {
    const out: number[] = [];
    if (!needle) return out;
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push(i);
      i = hay.indexOf(needle, i + 1);
    }
    return out;
  };
  const nearest = (cands: number[], hint: number): number => {
    let best = cands[0];
    for (const c of cands) {
      if (Math.abs(c - hint) < Math.abs(best - hint)) best = c;
    }
    return best;
  };
  const withCtx = anchor.prefix + quote + anchor.suffix;
  const ctxHits = allIndexes(fullText, withCtx);
  if (ctxHits.length > 0) {
    const s = nearest(ctxHits, anchor.start) + anchor.prefix.length;
    return { start: s, end: s + quote.length };
  }
  const hits = allIndexes(fullText, quote);
  if (hits.length > 0) {
    const s = nearest(hits, anchor.start);
    return { start: s, end: s + quote.length };
  }
  return "orphan";
}
