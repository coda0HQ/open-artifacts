import type { Context } from "hono";
import { Hono } from "hono";
import { MAX_CONTENT_BYTES, validateCreate, validateUpdate } from "./domain";
import type { ArtifactRecord, ArtifactStore } from "./store";
import { D1R2Store } from "./store";
import {
  generateId,
  generateWriteToken,
  looksLikeChannelToken,
  sha256Hex,
  timingSafeEqual,
} from "./tokens";
import { userContentHeaders } from "./wrap";

export type Bindings = Env & { CREATE_TOKEN?: string; BRAND_URL?: string };
export type AppContext = { Bindings: Bindings };

// JSON escaping and encryption metadata inflate the body beyond the content
// cap; anything past this is rejected before parsing.
const MAX_BODY_BYTES = MAX_CONTENT_BYTES * 1.5 + 16 * 1024;

export const storeFrom = (c: Context<AppContext>): ArtifactStore =>
  new D1R2Store(c.env.DB, c.env.CONTENT);

export const artifactUrl = (c: Context<AppContext>, id: string): string =>
  `${new URL(c.req.url).origin}/a/${id}`;

function bearerToken(c: Context<AppContext>): string | null {
  const header = c.req.header("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

type AuthResult =
  | { ok: true; record: ArtifactRecord }
  | { ok: false; response: Response };

async function authorizeWrite(
  c: Context<AppContext>,
  store: ArtifactStore,
  id: string,
): Promise<AuthResult> {
  const token = bearerToken(c);
  if (token === null) {
    return {
      ok: false,
      response: c.json({ error: "missing bearer write token" }, 401),
    };
  }
  const record = await store.get(id);
  if (record === null) {
    return {
      ok: false,
      response: c.json({ error: "artifact not found" }, 404),
    };
  }
  const tokenHash = await sha256Hex(token);
  // A write token (wt_) authorizes by matching the artifact's token_hash.
  // A channel token (ch_) authorizes by matching the artifact's channel_hash,
  // so the channel holder can update the bound artifact without the wt_.
  const authorized = looksLikeChannelToken(token)
    ? record.channelHash !== null &&
      timingSafeEqual(tokenHash, record.channelHash)
    : timingSafeEqual(tokenHash, record.tokenHash);
  if (!authorized) {
    return {
      ok: false,
      response: c.json({ error: "invalid write token" }, 403),
    };
  }
  return { ok: true, record };
}

export function parseVersionParam(
  raw: string | undefined,
  currentVersion: number,
): number | { error: string; status: 400 | 404 } {
  if (raw === undefined) return currentVersion;
  if (!/^\d+$/.test(raw))
    return { error: "v must be a positive integer", status: 400 };
  const version = Number(raw);
  if (version < 1 || version > currentVersion) {
    return { error: "version not found", status: 404 };
  }
  return version;
}

export const api = new Hono<AppContext>();

api.post("/artifacts", async (c) => {
  const createToken = c.env.CREATE_TOKEN;
  if (createToken !== undefined && createToken !== "") {
    const token = bearerToken(c);
    // Compare SHA-256 hashes so both sides are a fixed-length hex string,
    // avoiding the length oracle of a raw timingSafeEqual on the secret.
    const presented = token === null ? "" : token;
    if (
      token === null ||
      !timingSafeEqual(await sha256Hex(presented), await sha256Hex(createToken))
    ) {
      return c.json({ error: "this instance requires a create token" }, 401);
    }
  }

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const parsed = validateCreate(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const store = storeFrom(c);

  // Channel binding: a POST carrying a channel token (ch_) targets the
  // artifact already bound to that channel — creating a new version at the
  // same URL instead of minting a new artifact. First use of a channel
  // creates the artifact and binds the channel to it, so every future POST
  // with the same channel lands on the same link.
  const channelRaw = typeof body.channel === "string" ? body.channel : null;
  if (channelRaw !== null && !looksLikeChannelToken(channelRaw)) {
    return c.json({ error: "channel must be a channel token (ch_...)" }, 400);
  }

  if (channelRaw !== null) {
    const channelHash = await sha256Hex(channelRaw);
    const existing = await store.findByChannel(channelHash);
    if (existing !== null) {
      const result = await store.update(existing, {
        content: parsed.value.content,
        format: parsed.value.format,
        title: parsed.value.title,
        description: parsed.value.description,
        favicon: parsed.value.favicon,
        label: parsed.value.label,
        encrypted: parsed.value.encrypted,
        baseVersion: null,
        force: false,
      });
      if (typeof result !== "number") {
        return c.json(
          { error: "version conflict", currentVersion: result.currentVersion },
          409,
        );
      }
      return c.json({
        id: existing.id,
        url: artifactUrl(c, existing.id),
        version: result,
        channel: channelRaw,
      });
    }
  }

  const id = generateId();
  const writeToken = generateWriteToken();
  const channelHash = channelRaw ? await sha256Hex(channelRaw) : null;
  await store.create(
    id,
    await sha256Hex(writeToken),
    parsed.value,
    channelHash,
  );

  return c.json(
    {
      id,
      url: artifactUrl(c, id),
      writeToken,
      version: 1,
      ...(channelRaw ? { channel: channelRaw } : {}),
    },
    201,
  );
});

api.put("/artifacts/:id", async (c) => {
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const parsed = validateUpdate(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const { baseVersion, force } = parsed.value;
  if (
    baseVersion !== null &&
    baseVersion !== auth.record.currentVersion &&
    !force
  ) {
    return c.json(
      {
        error: `baseVersion ${baseVersion} does not match current version ${auth.record.currentVersion}`,
        currentVersion: auth.record.currentVersion,
      },
      409,
    );
  }

  const result = await store.update(auth.record, parsed.value);
  if (typeof result !== "number") {
    return c.json(
      {
        error: `version conflict: artifact is at version ${result.currentVersion}`,
        currentVersion: result.currentVersion,
      },
      409,
    );
  }
  return c.json({
    id: auth.record.id,
    url: artifactUrl(c, auth.record.id),
    version: result,
  });
});

api.delete("/artifacts/:id", async (c) => {
  const store = storeFrom(c);
  const auth = await authorizeWrite(c, store, c.req.param("id"));
  if (!auth.ok) return auth.response;
  await store.delete(auth.record.id);
  return c.json({ ok: true });
});

api.get("/artifacts/:id", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) return c.json({ error: "artifact not found" }, 404);
  const versions = await store.listVersions(record.id);
  return c.json({
    id: record.id,
    url: artifactUrl(c, record.id),
    title: record.title,
    description: record.description,
    favicon: record.favicon,
    format: record.format,
    encrypted: record.encrypted,
    version: record.currentVersion,
    versions,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
});

api.get("/artifacts/:id/raw", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  if (record === null) return c.json({ error: "artifact not found" }, 404);

  const version = parseVersionParam(c.req.query("v"), record.currentVersion);
  if (typeof version !== "number") {
    return c.json({ error: version.error }, version.status);
  }

  const content = await store.getContent(record.id, version);
  if (content === null) return c.json({ error: "content not found" }, 404);

  if (content.encrypted !== null) {
    const headers = userContentHeaders({
      sandbox: true,
      contentType: "application/json",
    });
    return new Response(
      JSON.stringify({
        alg: "AES-GCM",
        kdf: "PBKDF2-SHA256",
        iterations: content.encrypted.iterations,
        salt: content.encrypted.salt,
        iv: content.encrypted.iv,
        ciphertext: content.body,
      }),
      { headers },
    );
  }

  const headers = userContentHeaders({
    sandbox: true,
    contentType: "text/plain; charset=utf-8",
  });
  return new Response(content.body, { headers });
});
