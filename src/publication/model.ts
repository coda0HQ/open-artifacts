export type PublicationState =
  | "pending"
  | "blob_ready"
  | "committed"
  | "conflict"
  | "failed"
  | "expired";

const transitions: Readonly<
  Record<PublicationState, readonly PublicationState[]>
> = {
  pending: ["blob_ready", "conflict", "failed", "expired"],
  blob_ready: ["committed", "conflict", "failed", "expired"],
  committed: [],
  conflict: [],
  failed: [],
  expired: [],
};

export function canTransitionPublication(
  from: PublicationState,
  to: PublicationState,
): boolean {
  return transitions[from].includes(to);
}

export function transitionPublication(
  from: PublicationState,
  to: PublicationState,
): PublicationState {
  if (!canTransitionPublication(from, to)) {
    throw new Error(`cannot transition publication from ${from} to ${to}`);
  }
  return to;
}

export interface Publication {
  id: string;
  artifactId: string;
  actorScope: string;
  idempotencyKey: string;
  requestFingerprint: string;
  expectedVersion: number | null;
  targetVersion: number;
  blobKey: string;
  contentHash: string;
  state: PublicationState;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
