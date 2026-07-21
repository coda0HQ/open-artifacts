import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/api";
import { createApp } from "../../src/app";
import type { Authorizer, OwnershipGrant } from "../../src/authorizer";
import type { ArtifactRecord } from "../../src/store";

const BASE = "http://artifacts.test";

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

async function fetchWith(
  app: ReturnType<typeof createApp>,
  request: Request,
  environment: AppContext["Bindings"] = env,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function stubAuthorizer(
  overrides: Partial<Authorizer> & {
    grant?: OwnershipGrant;
    rejectCreate?: boolean;
    allowView?: boolean;
    allowWrite?: boolean;
    allowManage?: boolean;
  },
): Authorizer {
  const grant = overrides.grant ?? {
    ownerId: "user-1",
    orgId: "org-1",
    visibility: "private" as const,
  };
  return {
    authorizeCreate:
      overrides.authorizeCreate ??
      (async () => (overrides.rejectCreate ? null : grant)),
    authorizeView:
      overrides.authorizeView ??
      (async (_c, record: ArtifactRecord) => {
        if (record.visibility === "private" && overrides.allowView !== true) {
          return false;
        }
        return true;
      }),
    authorizeWrite:
      overrides.authorizeWrite ?? (async () => overrides.allowWrite === true),
    canManage:
      overrides.canManage ?? (async () => overrides.allowManage === true),
  };
}

interface CreateResult {
  id: string;
  url: string;
  writeToken: string;
  version: number;
}

async function createWith(
  authorizer: Authorizer,
  overrides: Record<string, unknown> = {},
): Promise<CreateResult> {
  const testApp = createApp(authorizer);
  const res = await fetchWith(
    testApp,
    jsonRequest("POST", "/api/artifacts", {
      content: "<h1>Authorizer test</h1>",
      title: "Auth Test",
      favicon: "🔒",
      ...overrides,
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResult;
}

describe("Authorizer hook", () => {
  it("rejects create when authorizeCreate returns null", async () => {
    const app = createApp(stubAuthorizer({ rejectCreate: true }));
    const res = await fetchWith(
      app,
      jsonRequest("POST", "/api/artifacts", {
        content: "<p>x</p>",
        title: "t",
        favicon: "📊",
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("stamps ownerId and visibility from the ownership grant", async () => {
    const grant = {
      ownerId: "user-abc",
      orgId: "org-xyz",
      visibility: "private" as const,
    };
    const authorizer = stubAuthorizer({ grant, allowView: true });
    const app = createApp(authorizer);
    const created = await createWith(authorizer);

    const rawDenied = await fetchWith(
      createApp(stubAuthorizer({ grant })),
      new Request(`${BASE}/api/artifacts/${created.id}/raw`),
    );
    expect(rawDenied.status).toBe(404);

    const rawAllowed = await fetchWith(
      app,
      new Request(`${BASE}/api/artifacts/${created.id}/raw`),
    );
    expect(rawAllowed.status).toBe(200);
  });
});

describe("Visibility gate", () => {
  it("returns sign-in page on /a/:id for private artifacts when view is denied", async () => {
    const authorizer = stubAuthorizer({
      grant: { ownerId: "u1", orgId: null, visibility: "private" },
    });
    const app = createApp(authorizer);
    const created = await createWith(authorizer);

    const res = await fetchWith(app, new Request(`${BASE}/a/${created.id}`));
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Sign in to view");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("Artifact not found");
  });

  it("returns 404 on /frame for private artifacts when view is denied", async () => {
    const authorizer = stubAuthorizer({
      grant: { ownerId: "u1", orgId: null, visibility: "private" },
    });
    const app = createApp(authorizer);
    const created = await createWith(authorizer);

    const res = await fetchWith(
      app,
      new Request(`${BASE}/a/${created.id}/frame`),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 on /raw for private artifacts when view is denied", async () => {
    const authorizer = stubAuthorizer({
      grant: { ownerId: "u1", orgId: null, visibility: "private" },
    });
    const app = createApp(authorizer);
    const created = await createWith(authorizer);

    const res = await fetchWith(
      app,
      new Request(`${BASE}/api/artifacts/${created.id}/raw`),
    );
    expect(res.status).toBe(404);
  });

  it("allows canManage to PATCH visibility", async () => {
    const authorizer = stubAuthorizer({
      grant: { ownerId: "u1", orgId: null, visibility: "private" },
      allowManage: true,
      allowView: true,
    });
    const app = createApp(authorizer);
    const created = await createWith(authorizer);

    const res = await fetchWith(
      app,
      jsonRequest("PATCH", `/api/artifacts/${created.id}`, {
        visibility: "public",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; visibility: string };
    expect(body.visibility).toBe("public");

    const frame = await fetchWith(
      app,
      new Request(`${BASE}/a/${created.id}/frame`),
    );
    expect(frame.status).toBe(200);
  });

  it("renders a visibility selector when canManage is true", async () => {
    const authorizer = stubAuthorizer({
      grant: { ownerId: "u1", orgId: null, visibility: "private" },
      allowManage: true,
      allowView: true,
    });
    const app = createApp(authorizer);
    const created = await createWith(authorizer);

    const res = await fetchWith(app, new Request(`${BASE}/a/${created.id}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="oa-visibility-select"');
    expect(html).toContain('value="private" selected');
    expect(html).toContain("X-OA-CSRF");
    expect(html).toContain('method:"PATCH"');
  });

  it("still authorizes PUT via write token without authorizer write", async () => {
    const app = createApp(stubAuthorizer({ allowView: true }));
    const res = await fetchWith(
      app,
      jsonRequest("POST", "/api/artifacts", {
        content: "<p>v1</p>",
        title: "Cap Test",
        favicon: "📊",
      }),
    );
    expect(res.status).toBe(201);
    const { id, writeToken } = (await res.json()) as CreateResult;

    const put = await fetchWith(
      app,
      jsonRequest(
        "PUT",
        `/api/artifacts/${id}`,
        { content: "<p>v2</p>", title: "Cap Test", favicon: "📊" },
        { authorization: `Bearer ${writeToken}` },
      ),
    );
    expect(put.status).toBe(200);
  });
});

describe("validateVisibility", () => {
  it("accepts known visibility values", async () => {
    const { validateVisibility } = await import("../../src/authorizer");
    expect(validateVisibility("private")).toBe("private");
    expect(validateVisibility("org")).toBe("org");
    expect(validateVisibility("public")).toBe("public");
    expect(validateVisibility("secret")).toBeNull();
  });
});

describe("defaultAuthorizer compatibility", () => {
  it("keeps existing open-create behavior without CREATE_TOKEN", async () => {
    const app = createApp();
    const res = await fetchWith(
      app,
      jsonRequest("POST", "/api/artifacts", {
        content: "<p>open</p>",
        title: "Open",
        favicon: "📊",
      }),
    );
    expect(res.status).toBe(201);
  });
});
