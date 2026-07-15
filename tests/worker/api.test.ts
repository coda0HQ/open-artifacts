import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/api";
import app from "../../src/index";
import type { ArtifactRecord } from "../../src/store";

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

describe("POST /api/artifacts", () => {
  it("publishes a new HTML artifact", async () => {
    const created = await createArtifact();
    expect(created.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/);
    expect(created.url).toBe(`${BASE}/a/${created.id}`);
    expect(created.writeToken).toMatch(/^wt_[A-Za-z0-9_-]{43}$/);
    expect(created.version).toBe(1);
  });

  it("publishes a markdown artifact and reports its format", async () => {
    const created = await createArtifact({
      content: "# Notes\n\nSome *markdown*.",
      format: "markdown",
      title: "Design Notes",
      favicon: "📝",
    });
    const meta = await exports.default.fetch(
      `${BASE}/api/artifacts/${created.id}`,
    );
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as { format: string };
    expect(body.format).toBe("markdown");
  });

  it("extracts the title from a <title> tag when no explicit title given", async () => {
    const res = await exports.default.fetch(
      jsonRequest("POST", "/api/artifacts", {
        content: "<title>From The Tag</title><p>hi</p>",
        favicon: "🎯",
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as CreateResult;
    const meta = (await (
      await exports.default.fetch(`${BASE}/api/artifacts/${id}`)
    ).json()) as { title: string };
    expect(meta.title).toBe("From The Tag");
  });

  it("rejects a request without content", async () => {
    const res = await exports.default.fetch(
      jsonRequest("POST", "/api/artifacts", { title: "x", favicon: "📊" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/content/i);
  });

  it("rejects a request with no title and none extractable", async () => {
    const res = await exports.default.fetch(
      jsonRequest("POST", "/api/artifacts", {
        content: "<p>anonymous</p>",
        favicon: "📊",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/title/i);
  });

  it("rejects a non-emoji favicon", async () => {
    for (const favicon of ["<script>", "ab", "x", ""]) {
      const res = await exports.default.fetch(
        jsonRequest("POST", "/api/artifacts", {
          content: "<p>x</p>",
          title: "t",
          favicon,
        }),
      );
      expect(res.status, `favicon ${JSON.stringify(favicon)}`).toBe(400);
    }
  });

  it("accepts one or two emoji as favicon", async () => {
    for (const favicon of ["📊", "⚡🔥", "🇩🇪", "👍🏽"]) {
      const res = await exports.default.fetch(
        jsonRequest("POST", "/api/artifacts", {
          content: "<p>x</p>",
          title: "t",
          favicon,
        }),
      );
      expect(res.status, `favicon ${favicon}`).toBe(201);
    }
  });

  it("rejects content that is too large", async () => {
    const res = await exports.default.fetch(
      jsonRequest("POST", "/api/artifacts", {
        content: "x".repeat(4 * 1024 * 1024 + 1),
        title: "big",
        favicon: "📊",
      }),
    );
    expect(res.status).toBe(413);
  });

  it("rejects an invalid format", async () => {
    const res = await exports.default.fetch(
      jsonRequest("POST", "/api/artifacts", {
        content: "x",
        title: "t",
        favicon: "📊",
        format: "pdf",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("create gate (CREATE_TOKEN secret)", () => {
  const gatedEnv = { ...env, CREATE_TOKEN: "sekret-create" };

  it("rejects creation without the create token when gated", async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      jsonRequest("POST", "/api/artifacts", {
        content: "<p>x</p>",
        title: "t",
        favicon: "📊",
      }),
      gatedEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("accepts creation with the create token as bearer auth", async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      jsonRequest(
        "POST",
        "/api/artifacts",
        { content: "<p>x</p>", title: "t", favicon: "📊" },
        { authorization: "Bearer sekret-create" },
      ),
      gatedEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201);
  });

  it("does not accept a same-length-but-wrong create token", async () => {
    const ctx = createExecutionContext();
    const wrong = `${"sekret-create".slice(0, -1)}X`;
    const res = await app.fetch(
      jsonRequest(
        "POST",
        "/api/artifacts",
        { content: "<p>x</p>", title: "t", favicon: "📊" },
        { authorization: `Bearer ${wrong}` },
      ),
      gatedEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("does not let the create token act as a write token", async () => {
    const ctx = createExecutionContext();
    const createRes = await app.fetch(
      jsonRequest(
        "POST",
        "/api/artifacts",
        { content: "<p>x</p>", title: "t", favicon: "📊" },
        { authorization: "Bearer sekret-create" },
      ),
      gatedEnv,
      ctx,
    );
    const { id } = (await createRes.json()) as CreateResult;
    const res = await app.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${id}`,
        { content: "<p>evil</p>" },
        { authorization: "Bearer sekret-create" },
      ),
      gatedEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });
});

describe("canonical public URL (PUBLIC_URL)", () => {
  const pubEnv = { ...env, PUBLIC_URL: "https://coda0.com" };

  async function fetchWith(
    request: Request,
    environment: Bindings,
  ): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await app.fetch(request, environment, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  const createBody = { content: "<h1>x</h1>", title: "t", favicon: "📊" };

  it("pins the returned url to PUBLIC_URL regardless of request host", async () => {
    const res = await fetchWith(
      jsonRequest("POST", "/api/artifacts", createBody),
      pubEnv,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^https:\/\/coda0\.com\/a\/[A-Za-z0-9]+$/);
  });

  it("uses PUBLIC_URL for og:url and og:image on the viewer page", async () => {
    const createRes = await fetchWith(
      jsonRequest("POST", "/api/artifacts", createBody),
      pubEnv,
    );
    const { id } = (await createRes.json()) as { id: string };
    const html = await (
      await fetchWith(new Request(`${BASE}/a/${id}`), pubEnv)
    ).text();
    expect(html).toContain(
      `<meta property="og:url" content="https://coda0.com/a/${id}">`,
    );
    expect(html).toContain(
      `<meta property="og:image" content="https://coda0.com/og/${id}">`,
    );
  });

  it("strips a trailing slash on PUBLIC_URL", async () => {
    const res = await fetchWith(
      jsonRequest("POST", "/api/artifacts", createBody),
      { ...env, PUBLIC_URL: "https://coda0.com/" },
    );
    const body = (await res.json()) as { url: string };
    expect(body.url).not.toContain("coda0.com//");
    expect(body.url).toMatch(/^https:\/\/coda0\.com\/a\//);
  });

  it("falls back to the request origin when PUBLIC_URL is unset", async () => {
    const res = await fetchWith(
      jsonRequest("POST", "/api/artifacts", createBody),
      env,
    );
    const body = (await res.json()) as { url: string };
    expect(body.url.startsWith(`${BASE}/a/`)).toBe(true);
  });

  it("treats an empty PUBLIC_URL as unset (request origin)", async () => {
    const res = await fetchWith(
      jsonRequest("POST", "/api/artifacts", createBody),
      { ...env, PUBLIC_URL: "" },
    );
    const body = (await res.json()) as { url: string };
    expect(body.url.startsWith(`${BASE}/a/`)).toBe(true);
  });
});

describe("PUT /api/artifacts/:id", () => {
  it("updates content with a valid write token and serves it immediately", async () => {
    const created = await createArtifact();
    const res = await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<h1>Updated</h1>" },
        { authorization: `Bearer ${created.writeToken}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(2);

    const page = await exports.default.fetch(`${BASE}/a/${created.id}/frame`);
    expect(await page.text()).toContain("<h1>Updated</h1>");
  });

  it("rejects an update without a token", async () => {
    const created = await createArtifact();
    const res = await exports.default.fetch(
      jsonRequest("PUT", `/api/artifacts/${created.id}`, { content: "x" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an update with a wrong token", async () => {
    const created = await createArtifact();
    const res = await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "x" },
        { authorization: `Bearer wt_${"A".repeat(43)}` },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("404s for an unknown artifact", async () => {
    const res = await exports.default.fetch(
      jsonRequest(
        "PUT",
        "/api/artifacts/zzzzzzzzzzzz",
        { content: "x" },
        { authorization: `Bearer wt_${"A".repeat(43)}` },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("can update title and favicon", async () => {
    const created = await createArtifact();
    await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<p>v2</p>", title: "New Title", favicon: "🚀" },
        { authorization: `Bearer ${created.writeToken}` },
      ),
    );
    const meta = (await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}`)
    ).json()) as { title: string; favicon: string };
    expect(meta.title).toBe("New Title");
    expect(meta.favicon).toBe("🚀");
  });

  it("records version labels in history", async () => {
    const created = await createArtifact();
    await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<p>v2</p>", label: "fixed-charts" },
        { authorization: `Bearer ${created.writeToken}` },
      ),
    );
    const meta = (await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}`)
    ).json()) as { versions: Array<{ version: number; label: string | null }> };
    expect(meta.versions).toHaveLength(2);
    expect(meta.versions.find((v) => v.version === 2)?.label).toBe(
      "fixed-charts",
    );
  });

  it("records version size in UTF-8 bytes, not UTF-16 code units", async () => {
    const content = "<h1>你好，世界</h1>";
    const created = await createArtifact({ content, title: "Bytes" });
    const meta = (await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}`)
    ).json()) as { versions: Array<{ version: number; size: number }> };
    expect(meta.versions[0]?.size).toBe(
      new TextEncoder().encode(content).byteLength,
    );
  });

  it("stores per-version metadata so old versions keep their old title", async () => {
    const created = await createArtifact({ title: "Original Title" });
    await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<p>v2</p>", title: "Renamed" },
        { authorization: `Bearer ${created.writeToken}` },
      ),
    );
    const meta = (await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}`)
    ).json()) as {
      versions: Array<{
        version: number;
        title: string;
        favicon: string;
        format: string;
      }>;
    };
    expect(meta.versions.find((v) => v.version === 1)?.title).toBe(
      "Original Title",
    );
    expect(meta.versions.find((v) => v.version === 2)?.title).toBe("Renamed");
    expect(meta.versions.every((v) => v.favicon && v.format)).toBe(true);
  });

  it("409s on a baseVersion mismatch and creates no new version", async () => {
    const created = await createArtifact();
    await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<p>v2</p>" },
        { authorization: `Bearer ${created.writeToken}` },
      ),
    );
    const res = await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<p>stale</p>", baseVersion: 1 },
        { authorization: `Bearer ${created.writeToken}` },
      ),
    );
    expect(res.status).toBe(409);
    const meta = (await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}`)
    ).json()) as { version: number };
    expect(meta.version).toBe(2);
  });

  it("force overrides a baseVersion conflict", async () => {
    const created = await createArtifact();
    await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<p>v2</p>" },
        { authorization: `Bearer ${created.writeToken}` },
      ),
    );
    const res = await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<p>forced</p>", baseVersion: 1, force: true },
        { authorization: `Bearer ${created.writeToken}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(3);
  });
});

describe("compare-and-swap update safety (store layer)", () => {
  it("a stale snapshot loses to a committed update and creates no orphan", async () => {
    const created = await createArtifact();
    // Read two stale snapshots of version 1 before either update.
    const { D1R2Store } = await import("../../src/store");
    const store = new D1R2Store(env.DB, env.CONTENT);
    const snapshot = await store.get(created.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.currentVersion).toBe(1);

    // First update wins from the snapshot.
    const winner = await store.update(snapshot as ArtifactRecord, {
      content: "<p>winner</p>",
      format: null,
      title: null,
      description: null,
      favicon: null,
      label: null,
      encrypted: null,
      baseVersion: null,
      force: false,
    });
    expect(winner).toBe(2);

    // Second update from the SAME stale snapshot must conflict — the row's
    // current_version is now 2, not 1, so the CAS WHERE clause matches nothing.
    const loser = await store.update(snapshot as ArtifactRecord, {
      content: "<p>loser</p>",
      format: null,
      title: null,
      description: null,
      favicon: null,
      label: null,
      encrypted: null,
      baseVersion: null,
      force: false,
    });
    expect(typeof loser).toBe("object");
    expect(
      (loser as { conflict: true; currentVersion: number }).currentVersion,
    ).toBe(2);

    // The loser never wrote R2: only versions 1 and 2 exist, and v2 holds the winner.
    const meta = (await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}`)
    ).json()) as { versions: Array<{ version: number }> };
    expect(meta.versions.map((v) => v.version)).toEqual([1, 2]);
    const live = await (
      await exports.default.fetch(`${BASE}/a/${created.id}/frame`)
    ).text();
    expect(live).toContain("winner");
    expect(live).not.toContain("loser");
  });
});

describe("invalid version parameter", () => {
  it("returns a 400 with an invalid-version page, not the not-found page", async () => {
    const created = await createArtifact();
    const res = await exports.default.fetch(`${BASE}/a/${created.id}?v=latest`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Invalid version");
    expect(html).not.toContain("does not exist");
  });

  it("returns 404 for an out-of-range version", async () => {
    const created = await createArtifact();
    const res = await exports.default.fetch(`${BASE}/a/${created.id}?v=99`);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/artifacts/:id", () => {
  it("deletes an artifact and its content", async () => {
    const created = await createArtifact();
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${created.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${created.writeToken}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(
      (await exports.default.fetch(`${BASE}/a/${created.id}`)).status,
    ).toBe(404);
    expect(
      (await exports.default.fetch(`${BASE}/api/artifacts/${created.id}`))
        .status,
    ).toBe(404);
  });

  it("requires the write token", async () => {
    const created = await createArtifact();
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${created.id}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/artifacts/:id and /raw", () => {
  it("returns public metadata without secrets", async () => {
    const created = await createArtifact({ description: "A test page" });
    const res = await exports.default.fetch(
      `${BASE}/api/artifacts/${created.id}`,
    );
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.id).toBe(created.id);
    expect(meta.title).toBe("Test Artifact");
    expect(meta.description).toBe("A test page");
    expect(meta.encrypted).toBe(false);
    expect(JSON.stringify(meta)).not.toContain("wt_");
    expect(meta.writeToken).toBeUndefined();
  });

  it("serves raw stored content", async () => {
    const created = await createArtifact({ content: "<h1>Raw</h1>" });
    const res = await exports.default.fetch(
      `${BASE}/api/artifacts/${created.id}/raw`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>Raw</h1>");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves a specific raw version", async () => {
    const created = await createArtifact({ content: "<p>one</p>" });
    await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<p>two</p>" },
        { authorization: `Bearer ${created.writeToken}` },
      ),
    );
    const res = await exports.default.fetch(
      `${BASE}/api/artifacts/${created.id}/raw?v=1`,
    );
    expect(await res.text()).toBe("<p>one</p>");
  });
});
