const FRAME_MESSAGE_TYPES = new Set([
  "oa:ready",
  "oa:anchor:new",
  "oa:anchor:open",
  "oa:orphans",
  "oa:element:picked",
  "oa:live:annot:data",
  "oa:live:edit:data",
  "oa:live:edit:none",
  "oa:live:edit:rejected",
  "oa:handoff:event",
  "oa:handoff:record:ready",
]);

export interface FrameMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Opaque frames have no stable origin, so identity is the security boundary.
 * The parser also rejects network-shaped fields to keep the host from becoming
 * a frame-controlled request proxy.
 */
export function frameMessage(
  source: object | null,
  expectedFrame: object | null,
  value: unknown,
): FrameMessage | null {
  if (source !== expectedFrame || !expectedFrame) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const message = value as Record<string, unknown>;
  if (
    typeof message.type !== "string" ||
    !FRAME_MESSAGE_TYPES.has(message.type)
  ) {
    return null;
  }
  if (
    ["url", "path", "endpoint", "method", "headers"].some(
      (key) => key in message,
    )
  ) {
    return null;
  }
  return message as FrameMessage;
}
