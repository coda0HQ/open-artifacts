import type { ArtifactFormat, EncryptionParams } from "../domain";

export interface LiveDraftPayload {
  content: string;
  format?: ArtifactFormat;
  title?: string;
  description?: string;
  favicon?: string;
  label?: string | null;
  encrypted?: EncryptionParams | null;
}

export type LiveDraftState = "active" | "checkpointed" | "conflict" | "expired";

export interface LiveDraft {
  artifactId: string;
  protocolVersion: 1;
  revision: number;
  baseVersion: number;
  state: LiveDraftState;
  actorId: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  payload: LiveDraftPayload;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  checkpointVersion: number | null;
}

export interface RealtimeSessionStore {
  getDraft(artifactId: string): Promise<LiveDraft | null>;
  compareAndSetDraft(
    expectedRevision: number | null,
    draft: LiveDraft,
  ): Promise<boolean>;
}
