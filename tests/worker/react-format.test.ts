import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { frameDocument, unlockShell } from "../../src/wrap";

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

// A react bundle can carry a literal "</script" inside a string; the plain
// serve path neutralizes it via escapeInlineScript, but the ENCRYPTED path
// splices the decrypted bundle into the frame's inline <script> client-side, so
// it must apply the same escape. These tests exercise the actual emitted
// unlock-shell client code (extracting and running its escScript helper) so the
// template-literal escaping is verified, not eyeballed.
describe("React/JSX encrypted serve path", () => {
  const ENVELOPE = {
    salt: "AAAA",
    iv: "AAAA",
    iterations: 10000,
    ciphertext: "AAAA",
  };

  function makeUnlock(format: "react" | "html" | "markdown"): string {
    return unlockShell({
      title: "Encrypted",
      description: "",
      favicon: "⚛️",
      format,
      url: "http://artifacts.test/a/abc123456789",
      ogImage: "http://artifacts.test/og/abc123456789",
      hostname: "artifacts.test",
      artifactId: "abc123456789",
      nonce: "test-nonce",
      envelope: ENVELOPE,
    });
  }

  // Pull the client escScript helper out of the emitted unlock shell and run it,
  // so the assertion is on the ACTUAL shipped escaping (correct template-literal
  // levels), not a reimplementation.
  function extractEscScript(html: string): (s: string) => string {
    const src = html.match(/function escScript\(s\)\{[^}]*\}/)?.[0];
    if (!src) throw new Error("escScript helper not found in unlock shell");
    return new Function(`${src}\nreturn escScript;`)() as (s: string) => string;
  }

  it("neutralizes </script in the decrypted react bundle", () => {
    const escScript = extractEscScript(makeUnlock("react"));
    // The escape mirrors the server-side escapeInlineScript exactly:
    // "</script" (case-insensitive) -> "<\\/script".
    expect(escScript('var s = "</script>";')).toBe('var s = "<\\/script>";');
    expect(escScript("a</SCRIPT b")).toBe("a<\\/script b");
    expect(escScript("no closing tag")).toBe("no closing tag");

    // Simulate the react client splice into the real frame template: after the
    // escape, the bundle region carries no raw "</script" that could break out.
    const template = frameDocument({
      format: "react",
      content: "__OA_CONTENT_SLOT__",
      nonce: "test-nonce",
    });
    const bundle = 'var s="</script>";console.log(s);';
    const escaped = escScript(bundle);
    const doc = template.split("__OA_CONTENT_SLOT__").join(escaped);
    expect(escaped).not.toMatch(/<\/script/i);
    expect(escaped).toContain("<\\/script");
    expect(doc).toContain('<script nonce="test-nonce">');
  });

  it("wires escScript into the react branch only", () => {
    const unlock = makeUnlock("react");
    // React branch escapes the bundle; html keeps stampNonce; markdown keeps
    // jsonEmbed. escScript is applied to nothing else.
    expect(unlock).toContain('OA.format==="react"');
    expect(unlock).toContain("escScript(content)");
    expect(unlock).toContain("jsonEmbed(content)");
    expect(unlock).toMatch(
      /stampNonce\(OA\.template\.split\(OA\.slot\)\.join\(content\)\)/,
    );
    // escScript is only ever called in the react branch.
    expect(unlock.match(/escScript\(content\)/g) ?? []).toHaveLength(1);
  });

  it("does not escape </script on the html or markdown paths", () => {
    // The unlock client code is format-agnostic (branches on runtime OA.format),
    // so html/markdown recipes ship the same branches; assert their splices are
    // unchanged and never route through escScript.
    for (const format of ["html", "markdown"] as const) {
      const unlock = makeUnlock(format);
      expect(unlock).toContain("jsonEmbed(content)");
      expect(unlock).toMatch(
        /stampNonce\(OA\.template\.split\(OA\.slot\)\.join\(content\)\)/,
      );
    }
  });
});
