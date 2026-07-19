// Single source for the skill-side content cap. The cap defaults to 4 MiB — a
// deliberate free-tier envelope (docs/architecture.md) — and is overridable per
// instance via MAX_CONTENT_MIB. Unset, non-numeric, or <= 0 falls back to 4 so
// the default is byte-for-byte unchanged. Kept in lockstep with
// resolveMaxContentBytes in src/api.ts (the Worker enforces the same cap);
// raising it far past a few MiB risks the Worker request-body / memory limit.
export function resolveMaxContentBytes() {
  const mib = Number.parseInt(process.env.MAX_CONTENT_MIB ?? "", 10);
  return (mib > 0 ? mib : 4) * 1024 * 1024;
}

// Read once at load: a CLI invocation is a single short-lived process, mirroring
// how the Worker resolves the cap once per request.
export const MAX_CONTENT_BYTES = resolveMaxContentBytes();
