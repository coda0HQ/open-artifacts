const HOST_MESSAGE_TYPES = new Set([
  "oa:theme",
  "oa:config",
  "oa:arm",
  "oa:comments",
  "oa:live:pick:arm",
  "oa:live:pick:disarm",
  "oa:live:pick:lock",
  "oa:live:annot:enable",
  "oa:live:annot:collect",
  "oa:live:edit:arm",
  "oa:live:edit:cancel",
  "oa:live:edit:save",
  "oa:handoff:record:arm",
  "oa:handoff:record:disarm",
  "oa:handoff:play",
  "oa:handoff:pause",
  "oa:handoff:resume",
  "oa:handoff:seek",
  "oa:handoff:stop",
]);

export interface HostMessage {
  type: string;
  [key: string]: unknown;
}

export function hostMessage(
  source: object | null,
  expectedParent: object | null,
  value: unknown,
): HostMessage | null {
  if (source !== expectedParent || !expectedParent) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const message = value as Record<string, unknown>;
  return typeof message.type === "string" &&
    HOST_MESSAGE_TYPES.has(message.type)
    ? (message as HostMessage)
    : null;
}
