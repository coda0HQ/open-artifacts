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
