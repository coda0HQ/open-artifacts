import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../../src/adapters/memory/blob-store";
import { MemoryMetadataStore } from "../../src/adapters/memory/metadata-store";
import type {
  BlobMetadata,
  BlobObject,
  BlobPage,
  BlobStore,
  BlobValue,
} from "../../src/ports/blob-store";
import { FixedClock } from "../../src/ports/clock";
import { SequenceIdGenerator } from "../../src/ports/id-generator";
import { BlobWriter } from "../../src/publication/blob-writer";
import {
  fingerprintRequest,
  IdempotencyConflictError,
} from "../../src/publication/idempotency";
import { PublicationService } from "../../src/publication/service";

const request = {
  artifactId: "service-artifact",
  actorScope: "artifact:service-artifact",
  idempotencyKey: "service-key-0001",
  expectedVersion: 1,
  targetVersion: 2,
  body: "<h1>service body</h1>",
  encrypted: false,
};

function service(
  metadata = new MemoryMetadataStore(),
  blobs: BlobStore = new MemoryBlobStore(),
) {
  return {
    metadata,
    service: new PublicationService(
      metadata,
      new BlobWriter(blobs),
      new FixedClock("2026-08-04T12:00:00.000Z"),
      new SequenceIdGenerator(["one", "two", "three"]),
    ),
  };
}

describe("publication preparation service", () => {
  it("creates one pending record, verifies the blob, and becomes blob_ready", async () => {
    const { metadata, service: publicationService } = service();
    const requestFingerprint = await fingerprintRequest({
      operation: "update",
      content: request.body,
    });

    const result = await publicationService.prepare({
      ...request,
      requestFingerprint,
    });

    expect(result).toMatchObject({ kind: "ready", replayed: false });
    expect(result.publication).toMatchObject({
      id: "pub_one",
      state: "blob_ready",
      requestFingerprint,
      blobKey: expect.stringContaining("/pub_one"),
    });
    expect(await metadata.findPublicationById("pub_one")).toEqual(
      result.publication,
    );
  });

  it("returns the same prepared publication for an identical retry", async () => {
    const { service: publicationService } = service();
    const requestFingerprint = await fingerprintRequest({
      content: request.body,
    });
    const first = await publicationService.prepare({
      ...request,
      requestFingerprint,
    });
    const replay = await publicationService.prepare({
      ...request,
      requestFingerprint,
    });

    expect(replay).toMatchObject({
      kind: "ready",
      replayed: true,
      publication: { id: first.publication.id, state: "blob_ready" },
    });
  });

  it("replays an allocated create against its originally assigned artifact", async () => {
    const { service: publicationService } = service();
    const requestFingerprint = await fingerprintRequest({
      content: request.body,
    });
    const first = await publicationService.prepare({
      ...request,
      artifactId: "allocated-first",
      artifactIdMode: "allocate",
      requestFingerprint,
    });
    const replay = await publicationService.prepare({
      ...request,
      artifactId: "allocated-retry",
      artifactIdMode: "allocate",
      requestFingerprint,
    });
    expect(replay.publication.artifactId).toBe("allocated-first");
    expect(replay.publication.id).toBe(first.publication.id);
  });

  it("records stale requested bases as conflicts before writing a blob", async () => {
    const blobs = new MemoryBlobStore();
    const { service: publicationService } = service(
      new MemoryMetadataStore(),
      blobs,
    );
    const result = await publicationService.prepare({
      ...request,
      requestedBaseVersion: 0,
      requestFingerprint: await fingerprintRequest({ baseVersion: 0 }),
    });
    expect(result).toMatchObject({
      kind: "conflict",
      publication: { errorCode: "STALE_BASE_VERSION" },
    });
    expect(await blobs.list({ prefix: "content/", limit: 10 })).toMatchObject({
      items: [],
    });
  });

  it("rejects one actor/key reused for a different request fingerprint", async () => {
    const { service: publicationService } = service();
    await publicationService.prepare({
      ...request,
      requestFingerprint: await fingerprintRequest({ content: "first" }),
    });

    await expect(
      publicationService.prepare({
        ...request,
        requestFingerprint: await fingerprintRequest({ content: "second" }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("marks the publication failed when read-back detects corrupted content", async () => {
    const metadata = new MemoryMetadataStore();
    const corrupting: BlobStore = new CorruptingBlobStore();
    const { service: publicationService } = service(metadata, corrupting);

    await expect(
      publicationService.prepare({
        ...request,
        requestFingerprint: await fingerprintRequest({ content: request.body }),
      }),
    ).rejects.toThrow("blob verification failed");
    expect(
      (await metadata.listPublications({ state: "failed", limit: 10 })).items,
    ).toEqual([
      expect.objectContaining({
        state: "failed",
        errorCode: "BLOB_WRITE_FAILED",
      }),
    ]);
  });

  it("canonicalizes object keys before fingerprinting", async () => {
    expect(await fingerprintRequest({ b: 2, a: { d: 4, c: 3 } })).toBe(
      await fingerprintRequest({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });
});

class CorruptingBlobStore implements BlobStore {
  readonly #delegate = new MemoryBlobStore();

  putImmutable(
    key: string,
    body: string,
    metadata: BlobMetadata,
  ): Promise<{ created: boolean; object: BlobObject }> {
    return this.#delegate.putImmutable(key, body, metadata);
  }

  head(key: string): Promise<BlobObject | null> {
    return this.#delegate.head(key);
  }

  async get(key: string): Promise<BlobValue | null> {
    const value = await this.#delegate.get(key);
    return value ? { ...value, body: `${value.body}-corrupted` } : null;
  }

  delete(key: string): Promise<boolean> {
    return this.#delegate.delete(key);
  }

  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<BlobPage> {
    return this.#delegate.list(options);
  }
}
