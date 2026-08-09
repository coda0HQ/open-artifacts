import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../../src/adapters/memory/blob-store";
import { MemoryMetadataStore } from "../../src/adapters/memory/metadata-store";
import { FixedClock } from "../../src/ports/clock";
import type {
  Publication,
  PublicationState,
} from "../../src/publication/model";
import { PublicationReconciler } from "../../src/publication/reconcile";

const old = "2026-08-04T10:00:00.000Z";
const now = "2026-08-04T12:00:00.000Z";

function publication(
  id: string,
  state: PublicationState,
  overrides: Partial<Publication> = {},
): Publication {
  return {
    id,
    artifactId: `artifact-${id}`,
    actorScope: `actor-${id}`,
    idempotencyKey: `key-${id}`,
    requestFingerprint: `fingerprint-${id}`,
    expectedVersion: 1,
    targetVersion: 2,
    blobKey: `content/artifact-${id}/blobs/hash-${id}/${id}`,
    contentHash: `hash-${id}`,
    state,
    errorCode: null,
    createdAt: old,
    updatedAt: old,
    expiresAt: "2026-08-04T11:00:00.000Z",
    ...overrides,
  };
}

describe("publication reconciliation", () => {
  it("dry-run reports stale, missing, and orphaned data without mutations", async () => {
    const metadata = new MemoryMetadataStore();
    const blobs = new MemoryBlobStore();
    const pending = publication("pub-pending", "pending");
    const ready = publication("pub-ready", "blob_ready");
    const committed = publication("pub-missing", "committed");
    for (const item of [pending, ready, committed]) {
      await metadata.createPublication(item);
    }
    await blobs.putImmutable(ready.blobKey, "ready", {
      contentHash: ready.contentHash,
      encrypted: false,
      publicationId: ready.id,
    });
    await blobs.putImmutable("content/orphan/blobs/hash/pub-orphan", "orphan", {
      contentHash: "orphan-hash",
      encrypted: false,
      publicationId: "pub-orphan",
    });

    const reconciler = new PublicationReconciler(
      metadata,
      blobs,
      new FixedClock(now),
    );
    const report = await reconciler.run({
      dryRun: true,
      limit: 50,
      staleAfterMs: 60 * 60 * 1000,
      auditId: "audit-dry-run",
    });

    expect(report.findings.map((finding) => finding.kind).sort()).toEqual([
      "missing_blob",
      "orphan_blob",
      "stale_publication",
      "stale_publication",
    ]);
    expect(report.results.every((result) => result.mutated === false)).toBe(
      true,
    );
    expect((await metadata.findPublicationById(pending.id))?.state).toBe(
      "pending",
    );
    expect((await metadata.findPublicationById(ready.id))?.state).toBe(
      "blob_ready",
    );
    expect(await blobs.head(ready.blobKey)).not.toBeNull();
    expect(
      await blobs.head("content/orphan/blobs/hash/pub-orphan"),
    ).not.toBeNull();
  });

  it("execution expires stale work, removes safe blobs, and is idempotent", async () => {
    const metadata = new MemoryMetadataStore();
    const blobs = new MemoryBlobStore();
    const ready = publication("pub-ready-execute", "blob_ready");
    await metadata.createPublication(ready);
    await blobs.putImmutable(ready.blobKey, "ready", {
      contentHash: ready.contentHash,
      encrypted: false,
      publicationId: ready.id,
    });
    const orphanKey = "content/orphan/blobs/hash/pub-orphan-execute";
    await blobs.putImmutable(orphanKey, "orphan", {
      contentHash: "orphan-hash",
      encrypted: false,
      publicationId: "pub-orphan-execute",
    });
    const reconciler = new PublicationReconciler(
      metadata,
      blobs,
      new FixedClock(now),
    );

    const first = await reconciler.run({
      dryRun: false,
      limit: 50,
      staleAfterMs: 60 * 60 * 1000,
      auditId: "audit-execute",
    });
    expect(first.results.filter((result) => result.mutated)).toHaveLength(2);
    expect((await metadata.findPublicationById(ready.id))?.state).toBe(
      "expired",
    );
    expect(await blobs.head(ready.blobKey)).toBeNull();
    expect(await blobs.head(orphanKey)).toBeNull();

    const second = await reconciler.run({
      dryRun: false,
      limit: 50,
      staleAfterMs: 60 * 60 * 1000,
      auditId: "audit-repeat",
    });
    expect(second.results.some((result) => result.mutated)).toBe(false);
  });

  it("can constrain a storage repair without mutating stale publications", async () => {
    const metadata = new MemoryMetadataStore();
    const blobs = new MemoryBlobStore();
    const pending = publication("pub-storage-filter", "pending");
    await metadata.createPublication(pending);
    const orphanKey = "content/orphan/blobs/hash/storage-filter";
    await blobs.putImmutable(orphanKey, "orphan", {
      contentHash: "orphan-hash",
      encrypted: false,
      publicationId: "no-publication",
    });
    const report = await new PublicationReconciler(
      metadata,
      blobs,
      new FixedClock(now),
    ).run({
      dryRun: false,
      limit: 50,
      staleAfterMs: 60 * 60 * 1000,
      auditId: "audit-storage-only",
      kinds: ["missing_blob", "orphan_blob"],
    });

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "orphan_blob",
    ]);
    expect((await metadata.findPublicationById(pending.id))?.state).toBe(
      "pending",
    );
    expect(await blobs.head(orphanKey)).toBeNull();
  });
});
