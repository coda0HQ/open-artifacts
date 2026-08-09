import { sha256Hex } from "../tokens";
import type { Publication } from "./model";

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("idempotency key was already used for a different request");
    this.name = "IdempotencyConflictError";
  }
}

function canonicalJson(value: unknown, seen: Set<object>): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("cannot fingerprint a cyclic request");
    seen.add(value);
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, seen)}`,
      );
    seen.delete(value);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`cannot fingerprint request value of type ${typeof value}`);
}

export async function fingerprintRequest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value, new Set()));
}

export function assertIdempotentRequest(
  publication: Publication,
  artifactId: string,
  requestFingerprint: string,
  artifactIdMode: "exact" | "allocate" = "exact",
): void {
  if (
    (artifactIdMode === "exact" && publication.artifactId !== artifactId) ||
    publication.requestFingerprint !== requestFingerprint
  ) {
    throw new IdempotencyConflictError();
  }
}
