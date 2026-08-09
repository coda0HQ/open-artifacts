import { Hono } from "hono";
import {
  type AppContext,
  authorizeWrite,
  bearerToken,
  storeFrom,
} from "../api";
import {
  CredentialRotationConflictError,
  CredentialService,
} from "../credentials/service";
import { SystemClock } from "../ports/clock";
import { CryptoIdGenerator } from "../ports/id-generator";
import { looksLikeChannelToken, sha256Hex } from "../tokens";

export const credentialsApi = new Hono<AppContext>();

const serviceFrom = (c: Parameters<typeof storeFrom>[0]): CredentialService =>
  new CredentialService(c.env.DB, new SystemClock(), new CryptoIdGenerator());

async function jsonBody(
  c: Parameters<typeof storeFrom>[0],
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  try {
    return { ok: true, value: await c.req.json<Record<string, unknown>>() };
  } catch {
    return {
      ok: false,
      response: c.json({ error: "request body must be JSON" }, 400),
    };
  }
}

credentialsApi.get("/artifacts/:id/credentials", async (c) => {
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  return c.json({
    artifactId: auth.record.id,
    credentials: await serviceFrom(c).list(auth.record.id),
  });
});

credentialsApi.post("/artifacts/:id/credentials/rotate", async (c) => {
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  const parsed = await jsonBody(c);
  if (!parsed.ok) return parsed.response;
  const graceSeconds = parsed.value.graceSeconds ?? 0;
  if (
    typeof graceSeconds !== "number" ||
    !Number.isInteger(graceSeconds) ||
    graceSeconds < 0 ||
    graceSeconds > 300
  ) {
    return c.json(
      { error: "graceSeconds must be an integer from 0 to 300" },
      400,
    );
  }
  const raw = bearerToken(c);
  const currentTokenHash =
    raw && !looksLikeChannelToken(raw)
      ? await sha256Hex(raw)
      : auth.record.tokenHash;
  try {
    const rotated = await serviceFrom(c).rotate({
      artifactId: auth.record.id,
      currentTokenHash,
      actorId: auth.record.ownerId || "credential-holder",
      graceSeconds,
    });
    return c.json({
      credentialId: rotated.credentialId,
      writeToken: rotated.token,
      graceUntil: rotated.graceUntil,
    });
  } catch (error) {
    if (error instanceof CredentialRotationConflictError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }
});

credentialsApi.post("/artifacts/:id/credentials/revoke", async (c) => {
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  const parsed = await jsonBody(c);
  if (!parsed.ok) return parsed.response;
  const credentialId = parsed.value.credentialId;
  if (
    typeof credentialId !== "string" ||
    !/^cred_[A-Za-z0-9_-]+$/.test(credentialId)
  ) {
    return c.json({ error: "credentialId is invalid" }, 400);
  }
  const result = await serviceFrom(c).revoke(auth.record.id, credentialId);
  if (!result.revoked) return c.json({ error: "credential not found" }, 404);
  return c.json({ ok: true, credentialId, revokedPrimary: result.primary });
});

credentialsApi.post("/artifacts/:id/credentials/recover", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) return c.json({ error: "artifact not found" }, 404);
  if (!(await c.get("authorizer").canManage(c, record))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const recovered = await serviceFrom(c).recover({
    artifactId: record.id,
    actorId: record.ownerId || "authorized-manager",
  });
  return c.json({
    credentialId: recovered.credentialId,
    writeToken: recovered.token,
  });
});
