import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { frameDocument } from "../../src/wrap";

const BASE = "http://artifacts.test";

// A stand-in for the skill's precompiled bundle: the server never compiles JSX
// (the skill does), it stores and serves the bytes. A tiny self-mounting script
// is enough to exercise the react serve path, mount node, and CSP.
const REACT_BUNDLE =
  '(function(){var el=document.getElementById("oa-root");if(el)el.textContent="mounted";})();';

async function createReact(): Promise<{ id: string }> {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "React Test",
        favicon: "⚛️",
        format: "react",
        content: REACT_BUNDLE,
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

function scriptSrc(csp: string): string {
  return (
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src")) ?? ""
  );
}

describe("React/JSX artifact format", () => {
  it("accepts a create request with format react", async () => {
    const { id } = await createReact();
    const meta = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${id}`),
    );
    expect(meta.status).toBe(200);
    expect((await meta.json()) as { format: string }).toMatchObject({
      format: "react",
    });
  });

  it("rejects a react create with no title (a bundle has none to extract)", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          favicon: "⚛️",
          format: "react",
          content: REACT_BUNDLE,
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/title is required/i);
  });

  it("serves the frame with a mount node and the bundle in a nonce'd script", async () => {
    const { id } = await createReact();
    const res = await exports.default.fetch(
      new Request(`${BASE}/a/${id}/frame`),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="oa-root"></div>');
    // The bundle is inlined under a nonce'd <script>, not a <script src>.
    expect(html).toContain(REACT_BUNDLE);
    expect(html).toMatch(/<script nonce="[^"]+">/);
    expect(html).not.toMatch(/<script[^>]*\bsrc=/);
  });

  it("keeps the strict CSP: no unsafe-eval, no external script host", async () => {
    const { id } = await createReact();
    const res = await exports.default.fetch(
      new Request(`${BASE}/a/${id}/frame`),
    );
    const csp = res.headers.get("content-security-policy") ?? "";
    const directive = scriptSrc(csp);

    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive).not.toContain("'unsafe-inline'");
    // script-src is the response origin (same-origin, not external) + a nonce.
    expect(directive).toMatch(
      /^script-src http:\/\/artifacts\.test 'nonce-[^']+'$/,
    );
    // No external script host (only the same-origin response origin is present).
    expect(directive).not.toMatch(/https:\/\//);
  });

  it("frameDocument mounts react content under a nonce'd inline script", () => {
    const doc = frameDocument({
      format: "react",
      content: REACT_BUNDLE,
      nonce: "test-nonce",
    });
    expect(doc).toContain('<div id="oa-root"></div>');
    expect(doc).toContain(
      `<script nonce="test-nonce">${REACT_BUNDLE}</script>`,
    );
    expect(doc).not.toMatch(/<script[^>]*\bsrc=/);
  });
});
