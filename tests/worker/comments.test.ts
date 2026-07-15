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
    // The strict CSP is unchanged: runtime fetch stays impossible.
    expect(res.headers.get("content-security-policy") ?? "").toContain(
      "connect-src 'none'",
    );
  });

  it("renders an empty thread without breaking the page", async () => {
    const created = await createArtifact();
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain("No comments yet");
  });
});
