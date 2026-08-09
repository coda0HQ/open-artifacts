import type { Clock } from "../ports/clock";
import { SystemClock } from "../ports/clock";
import type {
  LiveDraft,
  LiveDraftPayload,
  RealtimeSessionStore,
} from "../ports/realtime-session-store";

const DEFAULT_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 300;
const DRAFT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type DraftSaveResult =
  | { ok: true; draft: LiveDraft }
  | {
      ok: false;
      code: "REVISION_CONFLICT" | "BASE_VERSION_CONFLICT";
      currentRevision: number;
      currentBaseVersion: number | null;
    }
  | {
      ok: false;
      code: "LEASE_HELD";
      currentRevision: number;
      leaseOwner: string;
      leaseUntil: string;
    };

export interface SaveDraftInput {
  artifactId: string;
  actorId: string;
  expectedRevision: number;
  baseVersion: number;
  payload: LiveDraftPayload;
  leaseSeconds?: number;
}

const isoAfter = (iso: string, milliseconds: number): string =>
  new Date(Date.parse(iso) + milliseconds).toISOString();

export class DraftService {
  constructor(
    private readonly store: RealtimeSessionStore,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  get(artifactId: string): Promise<LiveDraft | null> {
    return this.store.getDraft(artifactId);
  }

  async save(input: SaveDraftInput): Promise<DraftSaveResult> {
    const now = this.clock.now();
    const current = await this.store.getDraft(input.artifactId);
    const currentRevision = current?.revision ?? 0;
    if (input.expectedRevision !== currentRevision) {
      return {
        ok: false,
        code: "REVISION_CONFLICT",
        currentRevision,
        currentBaseVersion: current?.baseVersion ?? null,
      };
    }
    if (
      current?.state === "active" &&
      current.baseVersion !== input.baseVersion
    ) {
      return {
        ok: false,
        code: "BASE_VERSION_CONFLICT",
        currentRevision,
        currentBaseVersion: current.baseVersion,
      };
    }
    if (
      current?.leaseOwner &&
      current.leaseOwner !== input.actorId &&
      current.leaseUntil &&
      Date.parse(current.leaseUntil) > Date.parse(now)
    ) {
      return {
        ok: false,
        code: "LEASE_HELD",
        currentRevision,
        leaseOwner: current.leaseOwner,
        leaseUntil: current.leaseUntil,
      };
    }
    const leaseSeconds = Math.min(
      MAX_LEASE_SECONDS,
      Math.max(1, input.leaseSeconds ?? DEFAULT_LEASE_SECONDS),
    );
    const next: LiveDraft = {
      artifactId: input.artifactId,
      protocolVersion: 1,
      revision: currentRevision + 1,
      baseVersion: input.baseVersion,
      state: "active",
      actorId: input.actorId,
      leaseOwner: input.actorId,
      leaseUntil: isoAfter(now, leaseSeconds * 1_000),
      payload: structuredClone(input.payload),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      expiresAt: isoAfter(now, DRAFT_RETENTION_MS),
      checkpointVersion: null,
    };
    if (
      !(await this.store.compareAndSetDraft(
        current ? current.revision : null,
        next,
      ))
    ) {
      const raced = await this.store.getDraft(input.artifactId);
      return {
        ok: false,
        code: "REVISION_CONFLICT",
        currentRevision: raced?.revision ?? currentRevision,
        currentBaseVersion: raced?.baseVersion ?? current?.baseVersion ?? null,
      };
    }
    return { ok: true, draft: next };
  }

  async markCheckpointed(
    artifactId: string,
    revision: number,
    checkpointVersion: number,
  ): Promise<boolean> {
    const current = await this.store.getDraft(artifactId);
    if (!current || current.revision !== revision) return false;
    return this.store.compareAndSetDraft(revision, {
      ...current,
      state: "checkpointed",
      checkpointVersion,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: this.clock.now(),
    });
  }

  async markConflict(artifactId: string, revision: number): Promise<boolean> {
    const current = await this.store.getDraft(artifactId);
    if (!current || current.revision !== revision) return false;
    return this.store.compareAndSetDraft(revision, {
      ...current,
      state: "conflict",
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: this.clock.now(),
    });
  }
}
