import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1MetadataStore } from "../../../src/adapters/cloudflare/d1-metadata-store";
import { R2BlobStore } from "../../../src/adapters/cloudflare/r2-blob-store";
import { MemoryBlobStore } from "../../../src/adapters/memory/blob-store";
import { MemoryMetadataStore } from "../../../src/adapters/memory/metadata-store";
import { FixedClock, SystemClock } from "../../../src/ports/clock";
import {
  CryptoIdGenerator,
  SequenceIdGenerator,
} from "../../../src/ports/id-generator";
import { ensureSchemaForTests } from "../../../src/store";
import {
  blobStoreContract,
  metadataStoreContract,
} from "../../contracts/storage-contract";

metadataStoreContract("memory", () => new MemoryMetadataStore());
metadataStoreContract("d1", async () => {
  await ensureSchemaForTests(env.DB);
  return new D1MetadataStore(env.DB);
});

blobStoreContract("memory", () => new MemoryBlobStore());
blobStoreContract("r2", () => new R2BlobStore(env.CONTENT));

describe("deterministic domain utilities", () => {
  it("injects time instead of reading the global clock", () => {
    expect(new FixedClock("2026-08-04T12:00:00.000Z").now()).toBe(
      "2026-08-04T12:00:00.000Z",
    );
    expect(Date.parse(new SystemClock().now())).not.toBeNaN();
  });

  it("supports deterministic IDs and cryptographically random production IDs", () => {
    const sequence = new SequenceIdGenerator(["one", "two"]);
    expect(sequence.next("pub")).toBe("pub_one");
    expect(sequence.next("pub")).toBe("pub_two");
    expect(() => sequence.next("pub")).toThrow("ID sequence exhausted");
    expect(new CryptoIdGenerator().next("pub")).toMatch(
      /^pub_[1-9A-HJ-NP-Za-km-z]{12}$/,
    );
  });
});
