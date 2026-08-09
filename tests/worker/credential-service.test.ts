import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CredentialService } from "../../src/credentials/service";
import type { CreateInput } from "../../src/domain";
import { FixedClock } from "../../src/ports/clock";
import { SequenceIdGenerator } from "../../src/ports/id-generator";
import { D1R2Store } from "../../src/store";
import { sha256Hex } from "../../src/tokens";

const createInput: CreateInput = {
  content: "credential fixture",
  format: "html",
  title: "Credential lifecycle",
  description: "",
  favicon: "🔑",
  label: null,
  encrypted: null,
};

describe("credential lifecycle service", () => {
  it("rotates with grace, expires old access, revokes, and recovers", async () => {
    const artifactId = "credential01";
    const oldToken = "wt_old-credential-token";
    const oldHash = await sha256Hex(oldToken);
    const store = new D1R2Store(env.DB, env.CONTENT);
    await store.create(artifactId, oldHash, createInput, null);
    const atNoon = new CredentialService(
      env.DB,
      new FixedClock("2026-08-04T12:00:00.000Z"),
      new SequenceIdGenerator(["rotated", "recovered"]),
    );

    expect(await atNoon.isAuthorized(artifactId, oldHash, oldHash)).toBe(true);
    const rotated = await atNoon.rotate({
      artifactId,
      currentTokenHash: oldHash,
      actorId: "owner-1",
      graceSeconds: 60,
    });
    const rotatedHash = await sha256Hex(rotated.token);
    expect(rotated).toMatchObject({ credentialId: "cred_rotated" });
    expect(await atNoon.isAuthorized(artifactId, oldHash, rotatedHash)).toBe(
      true,
    );
    expect(
      await atNoon.isAuthorized(artifactId, rotatedHash, rotatedHash),
    ).toBe(true);

    const afterGrace = new CredentialService(
      env.DB,
      new FixedClock("2026-08-04T12:01:01.000Z"),
      new SequenceIdGenerator(["unused"]),
    );
    expect(
      await afterGrace.isAuthorized(artifactId, oldHash, rotatedHash),
    ).toBe(false);
    expect(await afterGrace.revoke(artifactId, rotated.credentialId)).toEqual({
      revoked: true,
      primary: true,
    });
    expect(
      await afterGrace.isAuthorized(artifactId, rotatedHash, rotatedHash),
    ).toBe(false);

    const recovered = await afterGrace.recover({
      artifactId,
      actorId: "admin-1",
    });
    const recoveredHash = await sha256Hex(recovered.token);
    expect(recovered).toMatchObject({ credentialId: "cred_unused" });
    expect(
      await afterGrace.isAuthorized(artifactId, recoveredHash, recoveredHash),
    ).toBe(true);
    const statuses = await afterGrace.list(artifactId);
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: rotated.credentialId,
          status: "revoked",
        }),
        expect.objectContaining({
          id: recovered.credentialId,
          status: "active",
        }),
      ]),
    );
    expect(JSON.stringify(statuses)).not.toContain(rotated.token);
    expect(JSON.stringify(statuses)).not.toContain(recovered.token);
  });
});
