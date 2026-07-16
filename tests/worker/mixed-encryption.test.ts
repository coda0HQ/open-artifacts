import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://artifacts.test";

interface CreateResult {
  id: string;
  url: string;
  writeToken: string;
  version: number;
}

async function create(body: Record<string, unknown>): Promise<CreateResult> {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Mixed", favicon: "🔬", ...body }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResult;
}

const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes));
};

async function encrypt(plaintext: string, password: string, iterations = 5000) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext),
  );
  return {
    content: toB64(ciphertext),
    salt: toB64(salt),
    iv: toB64(iv),
    iterations,
  };
}

async function put(id: string, body: Record<string, unknown>, token: string) {
  return exports.default.fetch(
    new Request(`${BASE}/api/artifacts/${id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("mixed encryption across versions", () => {
  it("parses each version by its own encryption state", async () => {
    // v1: plain HTML
    const created = await create({ content: "<h1>Plain v1</h1>" });

    // v2: encrypted
    const env = await encrypt("<h1>Secret v2</h1>", "pw");
    await put(
      created.id,
      {
        content: env.content,
        encrypted: { salt: env.salt, iv: env.iv, iterations: env.iterations },
      },
      created.writeToken,
    );

    // v3: plain again
    await put(created.id, { content: "<h1>Plain v3</h1>" }, created.writeToken);

    // Plain versions render their body only in the sandboxed artifact frame;
    // the host page (/a/:id) embeds it via <iframe src=".../frame?v=N">.
    const v1res = await exports.default.fetch(
      `${BASE}/a/${created.id}/frame?v=1`,
    );
    const v1 = await v1res.text();
    expect(v1).toContain("<h1>Plain v1</h1>");
    expect(v1res.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    const v1host = await (
      await exports.default.fetch(`${BASE}/a/${created.id}?v=1`)
    ).text();
    expect(v1host).toContain(`/a/${created.id}/frame?v=1`);

    const v2 = await exports.default.fetch(`${BASE}/a/${created.id}?v=2`);
    const v2html = await v2.text();
    expect(v2html).not.toContain("Secret v2");
    expect(v2html).toContain("Password");
    expect(v2html).toContain(env.salt);
    // The frame sub-route never serves an encrypted version's plaintext.
    expect(
      (await exports.default.fetch(`${BASE}/a/${created.id}/frame?v=2`)).status,
    ).toBe(404);

    const v3res = await exports.default.fetch(
      `${BASE}/a/${created.id}/frame?v=3`,
    );
    const v3 = await v3res.text();
    expect(v3).toContain("<h1>Plain v3</h1>");
    expect(v3res.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );

    const v1raw = await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}/raw?v=1`)
    ).text();
    expect(v1raw).toBe("<h1>Plain v1</h1>");
    const v2raw = (await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}/raw?v=2`)
    ).json()) as { ciphertext: string };
    expect(v2raw.ciphertext).toBe(env.content);
  });

  it("renders the unlock shell for a legacy encrypted version even when the versions-table flag is stale", async () => {
    // Simulate a legacy mixed-encryption artifact: the artifact is currently
    // plain, but v1's stored content is encrypted (so its R2 metadata says
    // encrypted). The ensureSchema backfill stamps every legacy version row's
    // `encrypted` from the artifact's CURRENT (plain) flag — so the table
    // reads `false` while R2 truth is `true`. The host must follow R2, or it
    // renders a plain shell whose frame 404s and the version can't be unlocked.
    const cipher = await encrypt("<h1>Legacy secret</h1>", "pw");
    const created = await create({
      content: cipher.content,
      encrypted: {
        salt: cipher.salt,
        iv: cipher.iv,
        iterations: cipher.iterations,
      },
    });
    // Switch the artifact's CURRENT state to plain (v2 plain), then poison the
    // v1 version row's encrypted flag to 0 to mimic a stale backfill.
    await put(created.id, { content: "<h1>Plain v2</h1>" }, created.writeToken);
    await env.DB.prepare(
      "UPDATE versions SET encrypted = 0 WHERE artifact_id = ? AND version = 1",
    )
      .bind(created.id)
      .run();

    const v1host = await (
      await exports.default.fetch(`${BASE}/a/${created.id}?v=1`)
    ).text();
    // R2 truth wins over the stale table flag → the unlock shell, not a plain
    // host shell pointing at a 404'ing frame.
    expect(v1host).toContain("Password");
    expect(v1host).toContain(cipher.salt);
    expect(v1host).not.toContain("/frame?v=1");
  });
});
