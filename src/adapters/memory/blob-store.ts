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
const copyObject = (value: BlobValue): BlobObject => ({
  key: value.key,
  size: value.size,
  etag: value.etag,
  metadata: { ...value.metadata },
});

export class MemoryBlobStore implements BlobStore {
  readonly #objects = new Map<string, BlobValue>();

  async putImmutable(
    key: string,
    body: string,
    metadata: BlobMetadata,
  ): Promise<{ created: boolean; object: BlobObject }> {
    const size = byteLength(body);
    const existing = this.#objects.get(key);
    if (existing) {
      if (!sameBlob(existing, size, metadata) || existing.body !== body) {
        throw new Error(
          `immutable blob key already exists with different content: ${key}`,
        );
      }
      return { created: false, object: copyObject(existing) };
    }
    const value: BlobValue = {
      key,
      body,
      size,
      etag: metadata.contentHash,
      metadata: { ...metadata },
    };
    this.#objects.set(key, value);
    return { created: true, object: copyObject(value) };
  }

  async head(key: string): Promise<BlobObject | null> {
    const value = this.#objects.get(key);
    return value ? copyObject(value) : null;
  }

  async get(key: string): Promise<BlobValue | null> {
    const value = this.#objects.get(key);
    return value ? { ...copyObject(value), body: value.body } : null;
  }

  async delete(key: string): Promise<boolean> {
    return this.#objects.delete(key);
  }

  async list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<BlobPage> {
    const matches = [...this.#objects.values()]
      .filter(
        (item) =>
          item.key.startsWith(options.prefix) &&
          (options.cursor === undefined || item.key > options.cursor),
      )
      .sort((left, right) => left.key.localeCompare(right.key));
    const page = matches.slice(0, options.limit);
    return {
      items: page.map(copyObject),
      cursor:
        matches.length > options.limit ? (page.at(-1)?.key ?? null) : null,
    };
  }
}
