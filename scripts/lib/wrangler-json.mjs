/** @param {unknown} value @returns {Array<Record<string, unknown>>} */
function findResultRows(value) {
  if (Array.isArray(value)) {
    if (value.every((entry) => entry && typeof entry === "object")) {
      const records = /** @type {Array<Record<string, unknown>>} */ (value);
      if (
        records.some(
          (entry) =>
            "schema_version" in entry ||
            "table_name" in entry ||
            "artifact_id" in entry,
        )
      ) {
        return records;
      }
    }
    for (const entry of value) {
      const found = findResultRows(entry);
      if (found.length > 0) return found;
    }
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const found = findResultRows(entry);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/** @param {string} output */
export function parseWranglerRows(output) {
  return findResultRows(JSON.parse(output));
}

/** @param {string} output */
export function parseWranglerBookmark(output) {
  const parsed = JSON.parse(output);
  /** @param {unknown} value @returns {string | undefined} */
  const find = (value) => {
    if (!value || typeof value !== "object") return undefined;
    if (
      "bookmark" in value &&
      typeof (/** @type {{bookmark?: unknown}} */ (value).bookmark) === "string"
    ) {
      return /** @type {{bookmark: string}} */ (value).bookmark;
    }
    for (const entry of Object.values(value)) {
      const found = find(entry);
      if (found) return found;
    }
    return undefined;
  };
  const bookmark = find(parsed);
  if (!bookmark)
    throw new Error("Wrangler did not return a Time Travel bookmark");
  return bookmark;
}
