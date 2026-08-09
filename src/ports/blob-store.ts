export interface BlobMetadata {
  contentHash: string;
  encrypted: boolean;
  publicationId: string;
}

export interface BlobObject {
  key: string;
  size: number;
  etag: string;
  metadata: BlobMetadata;
}

export interface BlobValue extends BlobObject {
  body: string;
}

export interface BlobPage {
  items: BlobObject[];
  cursor: string | null;
}

export interface BlobStore {
  putImmutable(
    key: string,
    body: string,
    metadata: BlobMetadata,
  ): Promise<{ created: boolean; object: BlobObject }>;
  head(key: string): Promise<BlobObject | null>;
  get(key: string): Promise<BlobValue | null>;
  delete(key: string): Promise<boolean>;
  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<BlobPage>;
}

export function sameBlob(
  object: BlobObject,
  size: number,
  metadata: BlobMetadata,
): boolean {
  return (
    object.size === size &&
    object.metadata.contentHash === metadata.contentHash &&
    object.metadata.encrypted === metadata.encrypted &&
    object.metadata.publicationId === metadata.publicationId
  );
}
