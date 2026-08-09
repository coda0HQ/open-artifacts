import type {
  BlobMetadata,
  BlobObject,
  BlobPage,
  BlobStore,
  BlobValue,
} from "../../ports/blob-store";
import { sameBlob } from "../../ports/blob-store";

const byteLength = (body: string): number =>
  new TextEncoder().encode(body).length;

const metadataFrom = (object: R2Object): BlobMetadata => {
  const contentHash = object.customMetadata?.content_hash;
  const publicationId = object.customMetadata?.publication_id;
  if (!contentHash || !publicationId) {
    throw new Error(`blob ${object.key} is missing publication metadata`);
  }
  return {
    contentHash,
    publicationId,
    encrypted: object.customMetadata?.encrypted === "1",
  };
};

const describe = (object: R2Object): BlobObject => ({
  key: object.key,
  size: object.size,
  etag: object.etag,
  metadata: metadataFrom(object),
});

const customMetadata = (metadata: BlobMetadata): Record<string, string> => ({
  content_hash: metadata.contentHash,
  encrypted: metadata.encrypted ? "1" : "0",
  publication_id: metadata.publicationId,
});

export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async putImmutable(
    key: string,
    body: string,
    metadata: BlobMetadata,
  ): Promise<{ created: boolean; object: BlobObject }> {
    const size = byteLength(body);
    const existing = await this.head(key);
    if (existing) {
      if (!sameBlob(existing, size, metadata)) {
        throw new Error(
          `immutable blob key already exists with different content: ${key}`,
        );
      }
      return { created: false, object: existing };
    }

    const written = await this.bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: customMetadata(metadata),
    });
    if (written !== null) {
      return { created: true, object: describe(written) };
    }

    const raced = await this.head(key);
    if (!raced || !sameBlob(raced, size, metadata)) {
      throw new Error(
        `immutable blob key already exists with different content: ${key}`,
      );
    }
    return { created: false, object: raced };
  }

  async head(key: string): Promise<BlobObject | null> {
    const object = await this.bucket.head(key);
    return object ? describe(object) : null;
  }

  async get(key: string): Promise<BlobValue | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return { ...describe(object), body: await object.text() };
  }

  async delete(key: string): Promise<boolean> {
    if ((await this.bucket.head(key)) === null) return false;
    await this.bucket.delete(key);
    return true;
  }

  async list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<BlobPage> {
    const page = await this.bucket.list({
      prefix: options.prefix,
      limit: options.limit,
      cursor: options.cursor,
      include: ["customMetadata"],
    });
    return {
      items: page.objects.flatMap((object) =>
        object.customMetadata?.content_hash &&
        object.customMetadata.publication_id
          ? [describe(object)]
          : [],
      ),
      cursor: page.truncated ? (page.cursor ?? null) : null,
    };
  }
}
