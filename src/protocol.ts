export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_HEADER = "Open-Artifacts-Protocol";

export type ProtocolNegotiation =
  | { ok: true; version: typeof PROTOCOL_VERSION }
  | {
      ok: false;
      requestedVersion: string;
      supportedVersions: readonly [typeof PROTOCOL_VERSION];
    };

/**
 * An absent header is the v1 compatibility default. Once a client opts into
 * explicit negotiation, an unknown value fails closed instead of silently
 * interpreting an incompatible payload.
 */
export function negotiateProtocolVersion(
  raw: string | null | undefined,
): ProtocolNegotiation {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { ok: true, version: PROTOCOL_VERSION };
  }
  const requestedVersion = raw.trim();
  if (requestedVersion === String(PROTOCOL_VERSION)) {
    return { ok: true, version: PROTOCOL_VERSION };
  }
  return {
    ok: false,
    requestedVersion,
    supportedVersions: [PROTOCOL_VERSION],
  };
}

export function protocolUpgradeBody(requestedVersion: string): {
  error: string;
  code: "LIVE_PROTOCOL_UPGRADE_REQUIRED";
  requestedVersion: string;
  supportedVersions: [typeof PROTOCOL_VERSION];
} {
  return {
    error: `protocol version ${requestedVersion} is not supported`,
    code: "LIVE_PROTOCOL_UPGRADE_REQUIRED",
    requestedVersion,
    supportedVersions: [PROTOCOL_VERSION],
  };
}
