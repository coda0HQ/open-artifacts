import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/api";
import { createApp } from "../../src/app";
import type { Authorizer } from "../../src/authorizer";

const defaultApp = createApp();
const base = "http://artifacts.test";

async function fetchWith(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
  environment: AppContext["Bindings"] = env,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`${base}${path}`, init),
    environment,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

const jsonInit = (
  method: string,
  body: unknown,
  token?: string,
): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

describe("artifact credential lifecycle API", () => {
  it("rotates, revokes, reports status without secrets, and recovers", async () => {
    const createdResponse = await fetchWith(
      defaultApp,
      "/api/artifacts",
      jsonInit("POST", {
        content: "credential API",
        title: "Credential API",
        favicon: "🔐",
      }),
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      writeToken: string;
    };

    const rotateResponse = await fetchWith(
      defaultApp,
      `/api/artifacts/${created.id}/credentials/rotate`,
      jsonInit("POST", { graceSeconds: 0 }, created.writeToken),
    );
    expect(rotateResponse.status).toBe(200);
    const rotated = (await rotateResponse.json()) as {
      credentialId: string;
      writeToken: string;
    };
    expect(rotated.writeToken).toMatch(/^wt_/);

    const update = {
      content: "credential API v2",
      title: "Credential API",
      favicon: "🔐",
      baseVersion: 1,
    };
    expect(
      await fetchWith(
        defaultApp,
        `/api/artifacts/${created.id}`,
        jsonInit("PUT", update, created.writeToken),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await fetchWith(
        defaultApp,
        `/api/artifacts/${created.id}`,
        jsonInit("PUT", update, rotated.writeToken),
      ),
    ).toMatchObject({ status: 200 });

    const statusResponse = await fetchWith(
      defaultApp,
      `/api/artifacts/${created.id}/credentials`,
      { headers: { authorization: `Bearer ${rotated.writeToken}` } },
    );
    expect(statusResponse.status).toBe(200);
    const statusText = await statusResponse.text();
    expect(statusText).not.toContain(created.writeToken);
    expect(statusText).not.toContain(rotated.writeToken);
    expect(JSON.parse(statusText)).toMatchObject({
      credentials: expect.arrayContaining([
        expect.objectContaining({
          id: rotated.credentialId,
          status: "active",
        }),
      ]),
    });

    expect(
      await fetchWith(
        defaultApp,
        `/api/artifacts/${created.id}/credentials/revoke`,
        jsonInit(
          "POST",
          { credentialId: rotated.credentialId },
          rotated.writeToken,
        ),
      ),
    ).toMatchObject({ status: 200 });
    expect(
      await fetchWith(
        defaultApp,
        `/api/artifacts/${created.id}`,
        jsonInit(
          "PUT",
          { ...update, content: "should fail", baseVersion: 2 },
          rotated.writeToken,
        ),
      ),
    ).toMatchObject({ status: 403 });

    const manager: Authorizer = {
      authorizeCreate: async () => null,
      authorizeView: async () => true,
      authorizeWrite: async () => false,
      canManage: async () => true,
    };
    const recoveryResponse = await fetchWith(
      createApp(manager),
      `/api/artifacts/${created.id}/credentials/recover`,
      jsonInit("POST", {}),
    );
    expect(recoveryResponse.status).toBe(200);
    const recovered = (await recoveryResponse.json()) as {
      writeToken: string;
    };
    expect(recovered.writeToken).toMatch(/^wt_/);
    expect(
      await fetchWith(
        defaultApp,
        `/api/artifacts/${created.id}`,
        jsonInit(
          "PUT",
          { ...update, content: "recovered", baseVersion: 2 },
          recovered.writeToken,
        ),
      ),
    ).toMatchObject({ status: 200 });
  });
});
