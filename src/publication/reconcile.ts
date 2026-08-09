import type { BlobStore } from "../ports/blob-store";
import type { Clock } from "../ports/clock";
import type { MetadataStore } from "../ports/metadata-store";
import type { Telemetry } from "../telemetry";
import type { PublicationState } from "./model";

export interface ReconcileCursor {
  publications?: string;
  blobs?: string;
}

export type ReconcileFinding =
  | {
      kind: "stale_publication";
      publicationId: string;
      state: "pending" | "blob_ready";
      blobKey: string;
    }
  | {
      kind: "missing_blob";
      publicationId: string;
      state: "committed";
      blobKey: string;
    }
  | {
      kind: "orphan_blob";
      publicationId: string;
      blobKey: string;
    };

export interface ReconcileResult {
  finding: ReconcileFinding;
  action:
    | "would_expire"
    | "would_delete"
    | "expired"
    | "deleted"
    | "manual"
    | "skipped";
  mutated: boolean;
}

export interface ReconcileReport {
  auditId: string;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  findings: ReconcileFinding[];
  results: ReconcileResult[];
  cursor: ReconcileCursor | null;
}

export interface ReconcileOptions {
  auditId: string;
  dryRun: boolean;
  limit: number;
  staleAfterMs: number;
  cursor?: ReconcileCursor;
  kinds?: ReconcileFinding["kind"][];
}

const repairableState = (
  state: PublicationState,
): state is "pending" | "blob_ready" =>
  state === "pending" || state === "blob_ready";

export class PublicationReconciler {
  constructor(
    private readonly metadata: MetadataStore,
    private readonly blobs: BlobStore,
    private readonly clock: Clock,
    private readonly telemetry?: Telemetry,
  ) {}

  async run(options: ReconcileOptions): Promise<ReconcileReport> {
    if (!/^[A-Za-z0-9._:-]{3,200}$/.test(options.auditId)) {
      throw new Error("auditId must be 3-200 URL-safe characters");
    }
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 500
    ) {
      throw new Error("reconciliation limit must be an integer from 1 to 500");
    }
    if (
      !Number.isFinite(options.staleAfterMs) ||
      options.staleAfterMs < 60_000
    ) {
      throw new Error("staleAfterMs must be at least 60000");
    }
    const startedAt = this.clock.now();
    const staleBefore = new Date(
      Date.parse(startedAt) - options.staleAfterMs,
    ).toISOString();
    const publicationPage = await this.metadata.listPublications({
      olderThan: undefined,
      limit: options.limit,
      cursor: options.cursor?.publications,
    });
    const blobPage = await this.blobs.list({
      prefix: "content/",
      limit: options.limit,
      cursor: options.cursor?.blobs,
    });
    const detectedFindings: ReconcileFinding[] = [];

    for (const publication of publicationPage.items) {
      if (
        repairableState(publication.state) &&
        (publication.updatedAt < staleBefore ||
          publication.expiresAt <= startedAt)
      ) {
        detectedFindings.push({
          kind: "stale_publication",
          publicationId: publication.id,
          state: publication.state,
          blobKey: publication.blobKey,
        });
      }
      if (
        publication.state === "committed" &&
        (await this.blobs.head(publication.blobKey)) === null
      ) {
        detectedFindings.push({
          kind: "missing_blob",
          publicationId: publication.id,
          state: "committed",
          blobKey: publication.blobKey,
        });
      }
    }

    for (const blob of blobPage.items) {
      const publication = await this.metadata.findPublicationById(
        blob.metadata.publicationId,
      );
      if (publication === null || publication.blobKey !== blob.key) {
        detectedFindings.push({
          kind: "orphan_blob",
          publicationId: blob.metadata.publicationId,
          blobKey: blob.key,
        });
      }
    }

    const kinds = options.kinds ? new Set(options.kinds) : null;
    const findings = kinds
      ? detectedFindings.filter((finding) => kinds.has(finding.kind))
      : detectedFindings;
    const results: ReconcileResult[] = [];
    for (const finding of findings) {
      results.push(await this.repairFinding(finding, options.dryRun));
    }
    for (const finding of findings) {
      this.telemetry?.warn("reconcile.finding", {
        auditId: options.auditId,
        findingKind: finding.kind,
        publicationId: finding.publicationId,
        publicationState: finding.kind === "orphan_blob" ? null : finding.state,
        dryRun: options.dryRun,
      });
      if (!this.telemetry) continue;
      if (finding.kind === "stale_publication") {
        this.telemetry.metric("stale_publication", {
          value: 1,
          route: "reconcile",
          operation: "reconcile",
          result: "stale",
        });
      } else if (finding.kind === "missing_blob") {
        this.telemetry.metric("missing_blob", {
          value: 1,
          route: "reconcile",
          operation: "reconcile",
          result: "missing",
        });
      }
    }
    const cursor: ReconcileCursor | null =
      publicationPage.cursor || blobPage.cursor
        ? {
            ...(publicationPage.cursor
              ? { publications: publicationPage.cursor }
              : {}),
            ...(blobPage.cursor ? { blobs: blobPage.cursor } : {}),
          }
        : null;
    return {
      auditId: options.auditId,
      dryRun: options.dryRun,
      startedAt,
      completedAt: this.clock.now(),
      findings,
      results,
      cursor,
    };
  }

  private async repairFinding(
    finding: ReconcileFinding,
    dryRun: boolean,
  ): Promise<ReconcileResult> {
    if (finding.kind === "missing_blob") {
      return { finding, action: "manual", mutated: false };
    }
    if (dryRun) {
      return {
        finding,
        action:
          finding.kind === "stale_publication"
            ? "would_expire"
            : "would_delete",
        mutated: false,
      };
    }
    if (finding.kind === "orphan_blob") {
      const deleted = await this.blobs.delete(finding.blobKey);
      return {
        finding,
        action: deleted ? "deleted" : "skipped",
        mutated: deleted,
      };
    }

    const expired = await this.metadata.transitionPublication({
      id: finding.publicationId,
      expectedState: finding.state,
      nextState: "expired",
      errorCode: "RECONCILED_STALE",
      updatedAt: this.clock.now(),
    });
    if (expired === null) {
      return { finding, action: "skipped", mutated: false };
    }
    if (finding.state === "blob_ready") {
      await this.blobs.delete(finding.blobKey);
    }
    return { finding, action: "expired", mutated: true };
  }
}
