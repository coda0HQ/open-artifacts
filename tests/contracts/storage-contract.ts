import { describe, expect, it } from "vitest";
import type { BlobStore } from "../../src/ports/blob-store";
import type { MetadataStore } from "../../src/ports/metadata-store";
import type { Publication } from "../../src/publication/model";

let sequence = 0;

function fixture(prefix: string): Publication {
  sequence += 1;
  const suffix = `${prefix}-${sequence}`;
  return {
    id: `pub-${suffix}`,
    artifactId: `artifact-${suffix}`,
    actorScope: `actor-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    requestFingerprint: `fingerprint-${suffix}`,
    expectedVersion: 1,
    targetVersion: 2,
    blobKey: `content/${suffix}`,
    contentHash: `hash-${suffix}`,
    state: "pending",
    errorCode: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-05T00:00:00.000Z",
  };
}

export function metadataStoreContract(
  name: string,
  createStore: () => Promise<MetadataStore> | MetadataStore,
): void {
  describe(`${name} MetadataStore contract`, () => {
    it("deduplicates actor-scoped idempotency keys", async () => {
      const store = await createStore();
      const publication = fixture(`${name}-idempotency`);

      const first = await store.createPublication(publication);
      const duplicate = await store.createPublication({
        ...publication,
        id: `${publication.id}-duplicate`,
      });

      expect(first).toEqual({ publication, created: true });
      expect(duplicate).toEqual({ publication, created: false });
      expect(
        await store.findPublicationByIdempotency(
          publication.actorScope,
          publication.idempotencyKey,
        ),
      ).toEqual(publication);
    });

    it("uses compare-and-set transitions and keeps terminal states final", async () => {
      const store = await createStore();
      const publication = fixture(`${name}-cas`);
      await store.createPublication(publication);

      const blobReady = await store.transitionPublication({
        id: publication.id,
        expectedState: "pending",
        nextState: "blob_ready",
        updatedAt: "2026-08-04T00:01:00.000Z",
      });
      expect(blobReady?.state).toBe("blob_ready");
      expect(
        await store.transitionPublication({
          id: publication.id,
          expectedState: "pending",
          nextState: "failed",
          errorCode: "LATE_FAILURE",
          updatedAt: "2026-08-04T00:02:00.000Z",
        }),
      ).toBeNull();

      const committed = await store.transitionPublication({
        id: publication.id,
        expectedState: "blob_ready",
        nextState: "committed",
        updatedAt: "2026-08-04T00:03:00.000Z",
      });
      expect(committed?.state).toBe("committed");
      await expect(
        store.transitionPublication({
          id: publication.id,
          expectedState: "committed",
          nextState: "failed",
          errorCode: "TOO_LATE",
          updatedAt: "2026-08-04T00:04:00.000Z",
        }),
      ).rejects.toThrow("cannot transition publication");
    });

    it("queries state and deletes repairable metadata", async () => {
      const store = await createStore();
      const publication = fixture(`${name}-query`);
      await store.createPublication(publication);

      expect(
        (await store.listPublications({ state: "pending", limit: 10 })).items,
      ).toContainEqual(publication);
      expect(await store.deletePublication(publication.id)).toBe(true);
      expect(await store.findPublicationById(publication.id)).toBeNull();
      expect(await store.deletePublication(publication.id)).toBe(false);
    });
  });
}

export function blobStoreContract(
  name: string,
  createStore: () => Promise<BlobStore> | BlobStore,
): void {
  describe(`${name} BlobStore contract`, () => {
    it("writes immutable content with verifiable metadata", async () => {
      const store = await createStore();
      const key = `contracts/${name}/${crypto.randomUUID()}`;
      const metadata = {
        contentHash: "sha256-contract-body",
        encrypted: false,
        publicationId: `pub-${name}`,
      };

      expect(await store.putImmutable(key, "contract body", metadata)).toEqual({
        created: true,
        object: expect.objectContaining({ key, size: 13, metadata }),
      });
      expect(await store.putImmutable(key, "contract body", metadata)).toEqual({
        created: false,
        object: expect.objectContaining({ key, size: 13, metadata }),
      });
      expect(await store.head(key)).toEqual(
        expect.objectContaining({ key, size: 13, metadata }),
      );
      expect(await store.get(key)).toEqual(
        expect.objectContaining({ key, body: "contract body", metadata }),
      );

      await expect(
        store.putImmutable(key, "different", {
          ...metadata,
          contentHash: "different-hash",
        }),
      ).rejects.toThrow("immutable blob key already exists");
      expect(await store.delete(key)).toBe(true);
      expect(await store.head(key)).toBeNull();
      expect(await store.delete(key)).toBe(false);
    });
  });
}
