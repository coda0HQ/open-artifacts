import type { BlobObject, BlobStore } from "../ports/blob-store";
import { sha256Hex } from "../tokens";
import type { Publication } from "./model";

const byteLength = (body: string): number =>
  new TextEncoder().encode(body).length;

export class BlobWriter {
  constructor(private readonly blobs: BlobStore) {}

  async writeAndVerify(
    publication: Publication,
    body: string,
    encrypted: boolean,
  ): Promise<BlobObject> {
    if ((await sha256Hex(body)) !== publication.contentHash) {
      throw new Error(
        "blob verification failed: request hash does not match body",
      );
    }
    await this.blobs.putImmutable(publication.blobKey, body, {
      contentHash: publication.contentHash,
      encrypted,
      publicationId: publication.id,
    });
    const stored = await this.blobs.get(publication.blobKey);
    if (
      stored === null ||
      stored.size !== byteLength(body) ||
      stored.metadata.contentHash !== publication.contentHash ||
      stored.metadata.encrypted !== encrypted ||
      stored.metadata.publicationId !== publication.id ||
      (await sha256Hex(stored.body)) !== publication.contentHash
    ) {
      throw new Error("blob verification failed after immutable write");
    }
    return stored;
  }
}
