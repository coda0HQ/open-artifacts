import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://artifacts.test";

interface CreateResult {
  id: string;
  url: string;
  writeToken: string;
  version: number;
}

function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createArtifact(
  overrides: Record<string, unknown> = {},
): Promise<CreateResult> {
  const res = await exports.default.fetch(
    jsonRequest("POST", "/api/artifacts", {
      content: "<h1>Hello</h1>",
      title: "Test Artifact",
      favicon: "📊",
      ...overrides,
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResult;
}

async function postComment(id: string, body: unknown): Promise<Response> {
  return exports.default.fetch(
    jsonRequest("POST", `/api/artifacts/${id}/comments`, body),
  );
}

async function getComments(id: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/api/artifacts/${id}/comments`);
}

const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes));
};

async function encrypt(
  plaintext: string,
  password: string,
  iterations = 10_000,
): Promise<{ content: string; salt: string; iv: string; iterations: number }> {
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
    ["encrypt", "decrypt"],
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

async function createEncrypted(envelope: {
  content: string;
  salt: string;
  iv: string;
  iterations: number;
}): Promise<CreateResult> {
  return createArtifact({
    content: envelope.content,
    encrypted: {
      salt: envelope.salt,
      iv: envelope.iv,
      iterations: envelope.iterations,
    },
  });
}

describe("POST /api/artifacts/:id/comments", () => {
  it("persists a comment and returns 201 with the stored shape", async () => {
    const created = await createArtifact();
    const res = await postComment(created.id, { body: "nice work" });
    expect(res.status).toBe(201);
    const comment = (await res.json()) as {
      id: string;
      artifactId: string;
      author: string | null;
      body: string;
      createdAt: string;
    };
    expect(comment.artifactId).toBe(created.id);
    expect(comment.body).toBe("nice work");
    expect(comment.author).toBeNull();
    expect(comment.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/);
    expect(comment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts an optional author", async () => {
    const created = await createArtifact();
    const res = await postComment(created.id, {
      body: "hi",
      author: "Frad",
    });
    expect(res.status).toBe(201);
    const comment = (await res.json()) as { author: string };
    expect(comment.author).toBe("Frad");
  });

  it("requires a non-empty body (400)", async () => {
    const created = await createArtifact();
    const res = await postComment(created.id, { body: "" });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string };
    expect(err.error).toMatch(/body/i);
  });

  it("rejects a missing body field (400)", async () => {
    const created = await createArtifact();
    const res = await postComment(created.id, { author: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects a body over the byte cap (413)", async () => {
    const created = await createArtifact();
    const res = await postComment(created.id, {
      body: "x".repeat(8 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });

  it("404s for an unknown artifact", async () => {
    const res = await postComment("zzzzzzzzzzzz", { body: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects a non-JSON body (400)", async () => {
    const created = await createArtifact();
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${created.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/artifacts/:id/comments", () => {
  it("returns the thread oldest-first", async () => {
    const created = await createArtifact();
    await postComment(created.id, { body: "first", author: "A" });
    await postComment(created.id, { body: "second", author: "B" });
    await postComment(created.id, { body: "third" });
    const res = await getComments(created.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comments: Array<{ body: string; author: string | null }>;
    };
    expect(body.comments.map((c) => c.body)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(body.comments[0]?.author).toBe("A");
    expect(body.comments[2]?.author).toBeNull();
  });

  it("returns an empty list for an artifact with no comments", async () => {
    const created = await createArtifact();
    const res = await getComments(created.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: unknown[] };
    expect(body.comments).toEqual([]);
  });

  it("404s for an unknown artifact", async () => {
    const res = await getComments("zzzzzzzzzzzz");
    expect(res.status).toBe(404);
  });
});

describe("comments survive artifact deletion", () => {
  it("does not leave orphan comments behind", async () => {
    const created = await createArtifact();
    await postComment(created.id, { body: "gone soon" });
    await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${created.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${created.writeToken}` },
      }),
    );
    // After delete the artifact (and its comments) are gone: GET 404s.
    const res = await getComments(created.id);
    expect(res.status).toBe(404);
  });
});

describe("comments are inlined into the viewer page", () => {
  it("stamps the persisted thread into /a/:id at serve time", async () => {
    const created = await createArtifact();
    await postComment(created.id, { body: "inlined hello", author: "Sam" });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("inlined hello");
    expect(html).toContain("Sam");
    // The drawer and a count badge are present.
    expect(html).toContain('id="oa-cm-drawer"');
    expect(html).toContain("oa-cm-toggle");
    // The host page carries the drawer, so its CSP is the host CSP
    // (connect-src 'self' — the drawer is the only party that talks to the
    // API); the artifact frame stays air-gapped at connect-src 'none'.
    expect(res.headers.get("content-security-policy") ?? "").toContain(
      "connect-src 'self'",
    );
  });

  it("renders an empty thread without breaking the page", async () => {
    const created = await createArtifact();
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain("No comments yet");
  });

  it("inlines the thread into the encrypted unlock shell chrome", async () => {
    const envelope = await encrypt("<h1>Top Secret</h1>", "hunter2");
    const created = await createEncrypted(envelope);
    await postComment(created.id, { body: "secret comment", author: "Sam" });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The surrounding chrome carries the drawer even before unlock — the body
    // (ciphertext) stays hidden until the password is entered.
    expect(html).toContain("secret comment");
    expect(html).toContain('id="oa-cm-drawer"');
    expect(html).toContain("oa-cm-toggle");
    // The ciphertext is never leaked into the comment thread.
    expect(html).toContain(envelope.content);
  });
});

function deleteComment(
  id: string,
  commentId: string,
  token: string,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`${BASE}/api/artifacts/${id}/comments/${commentId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

describe("anchored comments", () => {
  it("stores a point anchor and returns a delete token", async () => {
    const created = await createArtifact();
    const res = await postComment(created.id, {
      body: "off-center",
      anchor: { mode: "point", x: 100, y: 100, anchorVersion: 1 },
    });
    expect(res.status).toBe(201);
    const comment = (await res.json()) as {
      anchor: { mode: string; x: number; y: number; anchorVersion: number };
      deleteToken: string;
    };
    expect(comment.anchor).toMatchObject({
      mode: "point",
      x: 100,
      y: 100,
      anchorVersion: 1,
    });
    expect(comment.deleteToken).toMatch(/^wt_/);

    const list = (await (await getComments(created.id)).json()) as {
      comments: { anchor: { mode: string } | null }[];
    };
    expect(list.comments[0]?.anchor?.mode).toBe("point");
  });

  it("clamps a forged future anchorVersion to the artifact currentVersion", async () => {
    const created = await createArtifact();
    const res = await postComment(created.id, {
      body: "forged future",
      anchor: { mode: "point", x: 1, y: 2, anchorVersion: 999_999 },
    });
    expect(res.status).toBe(201);
    const comment = (await res.json()) as {
      anchor: { anchorVersion: number };
    };
    // Fresh artifacts are at version 1 — the server must not store 999999.
    expect(comment.anchor.anchorVersion).toBe(1);
  });

  it("accepts unanchored but rejects a text anchor on an encrypted artifact", async () => {
    const envelope = await encrypt("secret revenue $5M", "pw");
    const created = await createEncrypted(envelope);

    const ok = await postComment(created.id, { body: "nice work" });
    expect(ok.status).toBe(201);

    const rejected = await postComment(created.id, {
      body: "leaky",
      anchor: {
        mode: "text",
        quote: "secret revenue $5M",
        prefix: "",
        suffix: "",
        start: 0,
      },
    });
    expect(rejected.status).toBe(400);
    const list = (await (await getComments(created.id)).json()) as {
      comments: { body: string }[];
    };
    expect(list.comments.map((c) => c.body)).toEqual(["nice work"]);
  });
});

describe("DELETE /api/artifacts/:id/comments/:commentId", () => {
  it("deletes your own comment with its delete token", async () => {
    const created = await createArtifact();
    const posted = (await (
      await postComment(created.id, { body: "mine" })
    ).json()) as { id: string; deleteToken: string };

    const res = await deleteComment(created.id, posted.id, posted.deleteToken);
    expect(res.status).toBe(200);
    const list = (await (await getComments(created.id)).json()) as {
      comments: unknown[];
    };
    expect(list.comments.length).toBe(0);
  });

  it("rejects a delete with the wrong token (403)", async () => {
    const created = await createArtifact();
    const posted = (await (
      await postComment(created.id, { body: "keep me" })
    ).json()) as { id: string };

    const res = await deleteComment(created.id, posted.id, "wt_bogustoken");
    expect(res.status).toBe(403);
    const list = (await (await getComments(created.id)).json()) as {
      comments: unknown[];
    };
    expect(list.comments.length).toBe(1);
  });

  it("lets the artifact owner delete any comment with the write token", async () => {
    const created = await createArtifact();
    const posted = (await (
      await postComment(created.id, { body: "moderate me" })
    ).json()) as { id: string };

    const res = await deleteComment(created.id, posted.id, created.writeToken);
    expect(res.status).toBe(200);
  });

  it("404s when the comment belongs to a different artifact", async () => {
    const a = await createArtifact();
    const b = await createArtifact();
    const posted = (await (
      await postComment(a.id, { body: "on A" })
    ).json()) as { id: string; deleteToken: string };

    const res = await deleteComment(b.id, posted.id, posted.deleteToken);
    expect(res.status).toBe(404);
  });
});
