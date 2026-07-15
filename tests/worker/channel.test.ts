import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://artifacts.test";

interface CreateResult {
  id: string;
  url: string;
  writeToken?: string;
  version: number;
  channel?: string;
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

async function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return exports.default.fetch(
    jsonRequest("POST", "/api/artifacts", body, headers),
  );
}

const ARTIFACT = {
  content: "<h1>v1</h1>",
  title: "Channel Demo",
  favicon: "📊",
};

describe("channel binding", () => {
  it("first POST with a channel creates an artifact and echoes the channel", async () => {
    const res = await post({ ...ARTIFACT, channel: "ch_testchannel123" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateResult;
    expect(body.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/);
    expect(body.channel).toBe("ch_testchannel123");
    expect(body.version).toBe(1);
  });

  it("second POST with the same channel updates the same URL (no new artifact)", async () => {
    const first = (await (
      await post({ ...ARTIFACT, channel: "ch_sameone" })
    ).json()) as CreateResult;
    const second = (await (
      await post({ ...ARTIFACT, content: "<h1>v2</h1>", channel: "ch_sameone" })
    ).json()) as CreateResult;
    expect(second.id).toBe(first.id);
    expect(second.url).toBe(first.url);
    expect(second.version).toBe(2);
    expect(second.writeToken).toBeUndefined();

    const live = await (
      await exports.default.fetch(`${BASE}/a/${first.id}/frame`)
    ).text();
    expect(live).toContain("<h1>v2</h1>");
  });

  it("the channel token authorizes PUT without the write token", async () => {
    const created = (await (
      await post({ ...ARTIFACT, channel: "ch_putauth" })
    ).json()) as CreateResult;
    const res = await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<h1>via channel</h1>" },
        { authorization: "Bearer ch_putauth" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(2);
  });

  it("a wrong channel token cannot update an artifact it doesn't own", async () => {
    const created = (await (
      await post({ ...ARTIFACT, channel: "ch_real" })
    ).json()) as CreateResult;
    const res = await exports.default.fetch(
      jsonRequest(
        "PUT",
        `/api/artifacts/${created.id}`,
        { content: "<h1>evil</h1>" },
        { authorization: "Bearer ch_wrong" },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("different channels create different artifacts", async () => {
    const a = (await (
      await post({ ...ARTIFACT, channel: "ch_alpha" })
    ).json()) as CreateResult;
    const b = (await (
      await post({ ...ARTIFACT, channel: "ch_beta" })
    ).json()) as CreateResult;
    expect(a.id).not.toBe(b.id);
  });

  it("rejects a channel that is not a channel token", async () => {
    const res = await post({ ...ARTIFACT, channel: "not-a-channel" });
    expect(res.status).toBe(400);
  });

  it("POST without a channel still mints a new artifact + write token (backwards compatible)", async () => {
    const res = await post(ARTIFACT);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateResult;
    expect(body.writeToken).toMatch(/^wt_/);
    expect(body.channel).toBeUndefined();
  });

  it("concurrent first publishes to one channel land on one artifact", async () => {
    const [a, b] = await Promise.all([
      post({ ...ARTIFACT, channel: "ch_racing" }),
      post({ ...ARTIFACT, content: "<h1>rival</h1>", channel: "ch_racing" }),
    ]);
    expect([a.status, b.status].every((s) => s === 200 || s === 201)).toBe(
      true,
    );
    const first = (await a.json()) as CreateResult;
    const second = (await b.json()) as CreateResult;
    expect(second.id).toBe(first.id);
    expect(second.url).toBe(first.url);
    expect([first.version, second.version].sort()).toEqual([1, 2]);
  });

  it("channel-bound metadata does not leak the channel token", async () => {
    const created = (await (
      await post({ ...ARTIFACT, channel: "ch_secret" })
    ).json()) as CreateResult;
    const meta = await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}`)
    ).json();
    expect(JSON.stringify(meta)).not.toContain("ch_secret");
  });
});
