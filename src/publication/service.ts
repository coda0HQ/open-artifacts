import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { MetadataStore } from "../ports/metadata-store";
import type { Telemetry } from "../telemetry";
import { sha256Hex } from "../tokens";
import type { BlobWriter } from "./blob-writer";
import { assertIdempotentRequest } from "./idempotency";
import type { Publication } from "./model";

export interface PreparePublicationInput {
  artifactId: string;
  actorScope: string;
  idempotencyKey: string;
  requestFingerprint: string;
  expectedVersion: number | null;
  targetVersion: number;
  body: string;
  encrypted: boolean;
  artifactIdMode?: "exact" | "allocate";
  requestedBaseVersion?: number | null;
  force?: boolean;
  expiresInMs?: number;
}

export type PreparedPublication =
  | { kind: "ready"; publication: Publication; replayed: boolean }
  | { kind: "committed"; publication: Publication; replayed: true }
  | { kind: "conflict"; publication: Publication; replayed: boolean };

export class PublicationTerminalError extends Error {
  constructor(readonly publication: Publication) {
    super(
      `publication ${publication.id} is ${publication.state}: ${publication.errorCode ?? "unknown"}`,
    );
    this.name = "PublicationTerminalError";
  }
}

export class PublicationService {
  constructor(
    private readonly metadata: MetadataStore,
    private readonly blobWriter: BlobWriter,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry?: Telemetry,
  ) {}

  async prepare(input: PreparePublicationInput): Promise<PreparedPublication> {
    const startedAt = Date.now();
    this.telemetry?.info("publication.prepare.started", {
      artifactId: input.artifactId,
      operation: this.telemetry.context.route,
      expectedVersion: input.expectedVersion,
      targetVersion: input.targetVersion,
    });
    const existing = await this.metadata.findPublicationByIdempotency(
      input.actorScope,
      input.idempotencyKey,
    );
    if (existing) {
      assertIdempotentRequest(
        existing,
        input.artifactId,
        input.requestFingerprint,
        input.artifactIdMode,
      );
      const resumed = await this.resume(existing, input, true);
      this.telemetry?.info("publication.prepare.completed", {
        artifactId: resumed.publication.artifactId,
        publicationId: resumed.publication.id,
        publicationState: resumed.publication.state,
        result: resumed.kind,
        replayed: true,
        durationMs: Date.now() - startedAt,
      });
      return resumed;
    }

    const createdAt = this.clock.now();
    const id = this.ids.next("pub");
    const contentHash = await sha256Hex(input.body);
    const publication: Publication = {
      id,
      artifactId: input.artifactId,
      actorScope: input.actorScope,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      expectedVersion: input.expectedVersion,
      targetVersion: input.targetVersion,
      blobKey: `content/${input.artifactId}/blobs/${contentHash}/${id}`,
      contentHash,
      state: "pending",
      errorCode: null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(
        Date.parse(createdAt) + (input.expiresInMs ?? 24 * 60 * 60 * 1000),
      ).toISOString(),
    };
    const stored = await this.metadata.createPublication(publication);
    assertIdempotentRequest(
      stored.publication,
      input.artifactId,
      input.requestFingerprint,
      input.artifactIdMode,
    );
    const resumed = await this.resume(
      stored.publication,
      input,
      !stored.created,
    );
    this.telemetry?.info("publication.prepare.completed", {
      artifactId: resumed.publication.artifactId,
      publicationId: resumed.publication.id,
      publicationState: resumed.publication.state,
      result: resumed.kind,
      replayed: resumed.replayed,
      durationMs: Date.now() - startedAt,
    });
    return resumed;
  }

  private async resume(
    publication: Publication,
    input: PreparePublicationInput,
    replayed: boolean,
  ): Promise<PreparedPublication> {
    if (publication.state === "committed") {
      return { kind: "committed", publication, replayed: true };
    }
    if (publication.state === "conflict") {
      return { kind: "conflict", publication, replayed: true };
    }
    if (publication.state === "failed" || publication.state === "expired") {
      throw new PublicationTerminalError(publication);
    }
    if (
      publication.state === "pending" &&
      input.requestedBaseVersion != null &&
      input.requestedBaseVersion !== publication.expectedVersion &&
      !input.force
    ) {
      const conflict = await this.metadata.transitionPublication({
        id: publication.id,
        expectedState: "pending",
        nextState: "conflict",
        errorCode: "STALE_BASE_VERSION",
        updatedAt: this.clock.now(),
      });
      if (conflict) {
        return { kind: "conflict", publication: conflict, replayed };
      }
      const raced = await this.metadata.findPublicationById(publication.id);
      if (raced === null) {
        throw new Error("publication disappeared during conflict transition");
      }
      return this.resume(raced, input, true);
    }

    const blobStartedAt = Date.now();
    this.telemetry?.info("storage.r2.write.started", {
      artifactId: publication.artifactId,
      publicationId: publication.id,
      targetVersion: publication.targetVersion,
    });
    try {
      await this.blobWriter.writeAndVerify(
        publication,
        input.body,
        input.encrypted,
      );
    } catch (error) {
      if (publication.state === "pending") {
        await this.metadata.transitionPublication({
          id: publication.id,
          expectedState: "pending",
          nextState: "failed",
          errorCode: "BLOB_WRITE_FAILED",
          updatedAt: this.clock.now(),
        });
      }
      this.telemetry?.error("storage.r2.write.failed", {
        artifactId: publication.artifactId,
        publicationId: publication.id,
        targetVersion: publication.targetVersion,
        durationMs: Date.now() - blobStartedAt,
        error,
      });
      this.telemetry?.metric("storage_operation", {
        value: 1,
        durationMs: Date.now() - blobStartedAt,
        route: this.telemetry.context.route,
        operation: "r2",
        result: "failure",
      });
      throw error;
    }
    this.telemetry?.info("storage.r2.write.succeeded", {
      artifactId: publication.artifactId,
      publicationId: publication.id,
      targetVersion: publication.targetVersion,
      durationMs: Date.now() - blobStartedAt,
    });
    this.telemetry?.metric("storage_operation", {
      value: 1,
      durationMs: Date.now() - blobStartedAt,
      route: this.telemetry.context.route,
      operation: "r2",
      result: "success",
    });

    if (publication.state === "blob_ready") {
      return { kind: "ready", publication, replayed };
    }
    const ready = await this.metadata.transitionPublication({
      id: publication.id,
      expectedState: "pending",
      nextState: "blob_ready",
      updatedAt: this.clock.now(),
    });
    if (ready) return { kind: "ready", publication: ready, replayed };

    const raced = await this.metadata.findPublicationById(publication.id);
    if (raced === null)
      throw new Error("publication disappeared during prepare");
    return this.resume(raced, input, true);
  }
}
