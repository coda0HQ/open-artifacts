export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function faviconDataUri(emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="85">${escapeHtml(emoji)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// JSON embedding plus a less-than escape prevents an authored `</script>`
// sequence from terminating an inline data/script block.
export function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
