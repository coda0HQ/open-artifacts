export type ToolbarNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

/** Returns the next enabled roving-tabindex item, wrapping at both edges. */
export function nextToolbarIndex(
  currentIndex: number,
  enabled: readonly boolean[],
  key: ToolbarNavigationKey,
): number {
  if (enabled.length === 0 || !enabled.some(Boolean)) return -1;
  if (key === "Home") return enabled.findIndex(Boolean);
  if (key === "End") {
    for (let index = enabled.length - 1; index >= 0; index -= 1) {
      if (enabled[index]) return index;
    }
    return -1;
  }
  const direction = key === "ArrowRight" ? 1 : -1;
  let candidate = currentIndex;
  for (let offset = 0; offset < enabled.length; offset += 1) {
    candidate = (candidate + direction + enabled.length) % enabled.length;
    if (enabled[candidate]) return candidate;
  }
  return currentIndex;
}
