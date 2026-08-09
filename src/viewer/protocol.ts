import type { ArtifactFormat, EncryptionParams } from "../domain";
import type {
  LiveDraft,
  LiveDraftPayload,
} from "../ports/realtime-session-store";

export interface LiveDraftResponse {
  draft: LiveDraft;
}

export interface LiveCheckpointResponse {
  id: string;
  url: string;
  version: number;
  publicationId: string;
  draftRevision: number;
  idempotentReplay?: boolean;
}

export interface ProtocolErrorResponse {
  error: string;
  code?: string;
  currentVersion?: number;
  currentRevision?: number;
  supportedVersions?: number[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function artifactFormat(value: unknown): value is ArtifactFormat {
  return value === "html" || value === "markdown" || value === "react";
}

function encryption(value: unknown): value is EncryptionParams | null {
  if (value === null) return true;
  const item = record(value);
  return Boolean(
    item &&
      typeof item.salt === "string" &&
      typeof item.iv === "string" &&
      positiveInteger(item.iterations),
  );
}

function draftPayload(value: unknown): value is LiveDraftPayload {
  const payload = record(value);
  if (!payload || typeof payload.content !== "string") return false;
  if (payload.format !== undefined && !artifactFormat(payload.format)) {
    return false;
  }
  if (!optionalString(payload.title)) return false;
  if (!optionalString(payload.description)) return false;
  if (!optionalString(payload.favicon)) return false;
  if (
    payload.label !== undefined &&
    payload.label !== null &&
    typeof payload.label !== "string"
  ) {
    return false;
  }
  return payload.encrypted === undefined || encryption(payload.encrypted);
}

function liveDraft(value: unknown): value is LiveDraft {
  const draft = record(value);
  if (!draft) return false;
  const validState =
    draft.state === "active" ||
    draft.state === "checkpointed" ||
    draft.state === "conflict" ||
    draft.state === "expired";
  return (
    typeof draft.artifactId === "string" &&
    draft.artifactId.length > 0 &&
    draft.protocolVersion === 1 &&
    positiveInteger(draft.revision) &&
    positiveInteger(draft.baseVersion) &&
    validState &&
    typeof draft.actorId === "string" &&
    nullableString(draft.leaseOwner) &&
    nullableString(draft.leaseUntil) &&
    draftPayload(draft.payload) &&
    typeof draft.createdAt === "string" &&
    typeof draft.updatedAt === "string" &&
    typeof draft.expiresAt === "string" &&
    (draft.checkpointVersion === null ||
      positiveInteger(draft.checkpointVersion))
  );
}

export function parseLiveDraftResponse(
  value: unknown,
): LiveDraftResponse | null {
  const response = record(value);
  return response && liveDraft(response.draft)
    ? { draft: response.draft }
    : null;
}

export function parseLiveCheckpointResponse(
  value: unknown,
): LiveCheckpointResponse | null {
  const response = record(value);
  if (
    !response ||
    typeof response.id !== "string" ||
    typeof response.url !== "string" ||
    !positiveInteger(response.version) ||
    typeof response.publicationId !== "string" ||
    !positiveInteger(response.draftRevision) ||
    (response.idempotentReplay !== undefined &&
      typeof response.idempotentReplay !== "boolean")
  ) {
    return null;
  }
  return response as unknown as LiveCheckpointResponse;
}

export function parseProtocolError(
  value: unknown,
): ProtocolErrorResponse | null {
  const response = record(value);
  if (!response || typeof response.error !== "string") return null;
  if (response.code !== undefined && typeof response.code !== "string") {
    return null;
  }
  if (
    response.currentVersion !== undefined &&
    !positiveInteger(response.currentVersion)
  ) {
    return null;
  }
  if (
    response.currentRevision !== undefined &&
    !nonNegativeInteger(response.currentRevision)
  ) {
    return null;
  }
  if (
    response.supportedVersions !== undefined &&
    (!Array.isArray(response.supportedVersions) ||
      !response.supportedVersions.every(positiveInteger))
  ) {
    return null;
  }
  return response as unknown as ProtocolErrorResponse;
}
