import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://artifacts.test";

async function createArtifact(): Promise<{ id: string; writeToken: string }> {
  const response = await exports.default.fetch(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "<p>security</p>",
        title: "Abuse",
        favicon: "📊",
      }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; writeToken: string };
}

describe("credential and input abuse", () => {
  it("does not authorize one artifact with another artifact's capability", async () => {
    const first = await createArtifact();
    const second = await createArtifact();
    const response = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${second.id}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${first.writeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "<p>overwrite</p>", baseVersion: 1 }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid write token" });
  });

  it("rejects guessed capabilities without reflecting them", async () => {
    const artifact = await createArtifact();
    const guessed = "wt_guess_that_must_not_be_reflected";
    const response = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${artifact.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${guessed}` },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(guessed);
  });

  it("rejects a declared oversized update before parsing its body", async () => {
    const artifact = await createArtifact();
    const response = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${artifact.id}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${artifact.writeToken}`,
          "content-type": "application/json",
          "content-length": String(10 * 1024 * 1024),
        },
        body: JSON.stringify({ content: "small" }),
      }),
    );
    expect(response.status).toBe(413);
  });
});
