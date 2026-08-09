import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("zero-knowledge password abuse control", () => {
  it("ships bounded exponential browser backoff without sending the password", async () => {
    const created = await exports.default.fetch(
      new Request("http://artifacts.test/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Y2lwaGVydGV4dA==",
          title: "Password",
          favicon: "🔐",
          encrypted: {
            salt: "c2FsdHNhbHRzYWx0c2FsdA==",
            iv: "aXZpdml2aXZpdml2",
            iterations: 10_000,
          },
        }),
      }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const html = await (
      await exports.default.fetch(`http://artifacts.test/a/${id}`)
    ).text();
    expect(html).toContain("failedAttempts+=1");
    expect(html).toContain("Math.min(8000,500*Math.pow(2");
    expect(html).toContain("Please wait before trying again.");
    expect(html).not.toContain('fetch("/api/password');
  });
});
