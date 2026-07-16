import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://artifacts.test";

interface CreateResult {
  id: string;
  url: string;
  writeToken: string;
  version: number;
}

async function create(body: Record<string, unknown>): Promise<CreateResult> {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Viewer Test", favicon: "🔬", ...body }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResult;
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

describe("GET /a/:id (plain HTML) — host page", () => {
  it("wraps the chrome in a complete skeleton with title, favicon, and reset, embedding the artifact frame", async () => {
    const created = await create({ content: "<h1>Wrapped</h1>" });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain(
      "<title>Viewer Test · Open Artifacts — self-hosted artifact viewer</title>",
    );
    expect(html).toContain('rel="icon"');
    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("box-sizing");
    // The artifact body itself lives only in the framed sub-document.
    expect(html).not.toContain("<h1>Wrapped</h1>");
    expect(html).toContain(
      `<iframe id="oa-frame" src="/a/${created.id}/frame"`,
    );
  });

  it("has a normal-origin CSP (connect-src 'self', frame-src 'self', no sandbox) and embeds a sandboxed artifact frame with the opposite CSP", async () => {
    const created = await create({ content: "<h1>Wrapped</h1>" });
    const hostRes = await exports.default.fetch(`${BASE}/a/${created.id}`);
    const hostCsp = hostRes.headers.get("content-security-policy") ?? "";
    expect(hostCsp).toContain("connect-src 'self'");
    expect(hostCsp).toContain("frame-src 'self'");
    expect(hostCsp).not.toMatch(/(^|;\s*)sandbox/);
    expect(hostCsp).toContain("default-src 'none'");
    expect(hostCsp).toContain("form-action 'none'");
    expect(hostCsp).toContain("base-uri 'none'");

    const frameRes = await exports.default.fetch(
      `${BASE}/a/${created.id}/frame`,
    );
    expect(frameRes.status).toBe(200);
    const frameCsp = frameRes.headers.get("content-security-policy") ?? "";
    expect(frameCsp).toContain("sandbox allow-scripts");
    expect(frameCsp).toContain("connect-src 'none'");
    // R1: never allow-same-origin on the artifact frame, even with webFonts
    // on (the test environment's wrangler.jsonc sets it to "1").
    expect(frameCsp).not.toContain("allow-same-origin");
    const frameHtml = await frameRes.text();
    expect(frameHtml).toContain("<h1>Wrapped</h1>");
    // No host chrome (og/title meta, header element, drawer) leaks into the
    // frame — it renders no <header>, even though the frame's reset CSS
    // still carries the (unused, harmless) .oa-header selector rules.
    expect(frameHtml).not.toContain("<title>");
    expect(frameHtml).not.toContain("<header");
    expect(frameHtml).not.toContain("oa-cm-drawer");
  });

  it("carries crawler metadata on the host page, with og:url pointing at /a/:id (never /a/:id/frame)", async () => {
    const created = await create({
      content: "<h1>Wrapped</h1>",
      description: "A crawlable page.",
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain(`<title>Viewer Test`);
    expect(html).toContain(
      `<meta property="og:image" content="${BASE}/og/${created.id}">`,
    );
    // The exact match (closing quote right after the id) proves og:url is
    // the canonical page, never the "/frame" sub-route.
    expect(html).toContain(
      `<meta property="og:url" content="${BASE}/a/${created.id}">`,
    );
  });

  it("escapes the title", async () => {
    const created = await create({
      content: "<p>x</p>",
      title: "<img src=x onerror=alert(1)>",
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });

  it("frame sends the sandboxing CSP and hardening headers", async () => {
    const created = await create({ content: "<p>safe</p>" });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}/frame`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    // Opaque frame: CSP stamps the real response origin (not 'self') so the
    // same-host /fonts proxy still loads under frameSandbox.
    expect(csp).toContain(
      "script-src http://artifacts.test 'unsafe-inline' cdn.jsdelivr.net",
    );
    expect(csp).toContain(
      "style-src http://artifacts.test 'unsafe-inline' fonts.googleapis.com",
    );
    expect(csp).toContain("img-src data: blob:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("supports both theme signals", async () => {
    const created = await create({ content: "<p>theme</p>" });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('[data-theme="dark"]');
    expect(html).toContain('[data-theme="light"]');
    expect(html).toContain("data-theme");
  });

  it("ships complete interaction states for viewer chrome", async () => {
    const created = await create({ content: "<p>chrome</p>" });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();

    expect(html).toContain("--oa-focus-ring");
    expect(html).toContain("#oa-theme-toggle:focus-visible");
    expect(html).toContain("#oa-theme-toggle:active");
    expect(html).toContain(".oa-brand:focus-visible");
    expect(html).toContain("@media (hover:hover) and (pointer:fine)");
    expect(html).toContain("inset:-6px");
    expect(html).toContain("Switch to light theme");
    expect(html).toContain("Switch to dark theme");
  });

  it("names its title with a reserved class author CSS cannot match", async () => {
    // The service header is inlined into the same document as HTML artifact
    // content. If both used ".oa-title", an artifact styling its own masthead
    // (a natural class name) would restyle the header through the shared
    // cascade. The resident chrome owns a reserved namespace instead, so the
    // generator supplies only data (title, favicon) and can never match the
    // header element. A bare ".oa-title" in content stays out of the header.
    const created = await create({
      content:
        '<style>.oa-title{font-size:2.5rem;line-height:1.05;margin:0 0 1.5rem}</style><h1 class="oa-title">Author masthead</h1>',
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    // The header element carries the reserved class, not the generic one.
    expect(html).toContain('<span class="oa-header-title">');
    expect(html).not.toContain('<span class="oa-title">');
    // And the resident chrome describes its own type scale explicitly.
    const rule =
      html.match(/\.oa-header \.oa-header-title\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("font-size:.8rem");
    expect(rule).toContain("line-height:");
    expect(rule).toContain("margin:0");
  });

  it("404s for an unknown artifact", async () => {
    const res = await exports.default.fetch(`${BASE}/a/nonexistent00`);
    expect(res.status).toBe(404);
  });

  it("serves a specific version via ?v=, and the host page's frame src carries it through", async () => {
    const created = await create({ content: "<p>first</p>" });
    await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${created.id}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${created.writeToken}`,
        },
        body: JSON.stringify({ content: "<p>second</p>" }),
      }),
    );
    const v1 = await (
      await exports.default.fetch(`${BASE}/a/${created.id}/frame?v=1`)
    ).text();
    expect(v1).toContain("<p>first</p>");
    const latest = await (
      await exports.default.fetch(`${BASE}/a/${created.id}/frame`)
    ).text();
    expect(latest).toContain("<p>second</p>");

    const hostV1 = await (
      await exports.default.fetch(`${BASE}/a/${created.id}?v=1`)
    ).text();
    expect(hostV1).toContain(`src="/a/${created.id}/frame?v=1"`);
  });
});

describe("GET /a/:id/frame (markdown)", () => {
  it("embeds the markdown source and a client-side renderer", async () => {
    const created = await create({
      content: "# Heading\n\nSome **bold** text.",
      format: "markdown",
    });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}/frame`);
    const html = await res.text();
    expect(html).toContain("marked");
    expect(html).toContain("Some **bold** text.");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
  });

  it("safely embeds markdown containing a closing script tag", async () => {
    const created = await create({
      content: "Code: `</script><script>alert(1)</script>`",
      format: "markdown",
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}/frame`)
    ).text();
    expect(html).not.toContain("</script><script>alert(1)");
  });
});

describe("GET /a/:id (encrypted)", () => {
  it("stores and returns only ciphertext", async () => {
    const envelope = await encrypt("<h1>Top Secret</h1>", "hunter2");
    const created = await create({
      content: envelope.content,
      encrypted: {
        salt: envelope.salt,
        iv: envelope.iv,
        iterations: envelope.iterations,
      },
    });
    const raw = await exports.default.fetch(
      `${BASE}/api/artifacts/${created.id}/raw`,
    );
    expect(raw.headers.get("content-type")).toContain("application/json");
    const stored = (await raw.json()) as Record<string, string>;
    expect(stored.ciphertext).toBe(envelope.content);
    expect(stored.alg).toBe("AES-GCM");
    expect(JSON.stringify(stored)).not.toContain("Top Secret");
  });

  it("serves an unlock shell without plaintext or sandbox CSP", async () => {
    const envelope = await encrypt("<h1>Top Secret</h1>", "hunter2");
    const created = await create({
      content: envelope.content,
      encrypted: {
        salt: envelope.salt,
        iv: envelope.iv,
        iterations: envelope.iterations,
      },
    });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Top Secret");
    expect(html).toContain(envelope.salt);
    expect(html).toContain("PBKDF2");
    expect(html).toContain("sandbox");
    // The unlock shell is itself a host page (hostHeaders — connect-src
    // 'self', no sandbox); the strict connect-src 'none' air-gap now lives on
    // the <meta> CSP re-asserted inside the srcdoc'd artifact frame template
    // (R2), embedded below as part of the decrypt script.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).not.toMatch(/(^|;\s*)sandbox/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    // The re-asserted meta CSP (R2) rides along inside the JSON-embedded
    // srcdoc template in the decrypt script — single quotes survive
    // JSON.stringify unescaped, so both substrings still appear verbatim.
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('<label class="oa-label" for="oa-password">');
    expect(html).toContain('aria-describedby="oa-help oa-error"');
    expect(html).toContain("min-height:44px");
    expect(html).toContain("color:var(--oa-danger)");
    expect(html).toContain("Password incorrect. Check it and try again.");
  });

  it("the frame sub-route refuses to serve an encrypted artifact as plaintext", async () => {
    const envelope = await encrypt("<h1>Top Secret</h1>", "hunter2");
    const created = await create({
      content: envelope.content,
      encrypted: {
        salt: envelope.salt,
        iv: envelope.iv,
        iterations: envelope.iterations,
      },
    });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}/frame`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("Top Secret");
  });

  it("round-trips: the shell's envelope decrypts with the right password", async () => {
    const plaintext = "<h1>Decryptable</h1>";
    const envelope = await encrypt(plaintext, "correct horse", 5000);
    const created = await create({
      content: envelope.content,
      encrypted: {
        salt: envelope.salt,
        iv: envelope.iv,
        iterations: envelope.iterations,
      },
    });
    const raw = (await (
      await exports.default.fetch(`${BASE}/api/artifacts/${created.id}/raw`)
    ).json()) as {
      ciphertext: string;
      salt: string;
      iv: string;
      iterations: number;
    };

    const dec = new TextDecoder();
    const fromB64 = (s: string) =>
      Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const baseKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("correct horse"),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: fromB64(raw.salt),
        iterations: raw.iterations,
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(raw.iv) },
      key,
      fromB64(raw.ciphertext),
    );
    expect(dec.decode(plain)).toBe(plaintext);

    const wrongKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: fromB64(raw.salt),
        iterations: raw.iterations,
      },
      await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("wrong password"),
        "PBKDF2",
        false,
        ["deriveKey"],
      ),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    await expect(
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(raw.iv) },
        wrongKey,
        fromB64(raw.ciphertext),
      ),
    ).rejects.toThrow();
  });

  it("rejects an encrypted create with bad params", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "bad",
          favicon: "🔒",
          content: "not-base64!!!",
          encrypted: { salt: "###", iv: "", iterations: 0 },
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /a/:id version picker", () => {
  async function putVersion(id: string, writeToken: string, content: string) {
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${id}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${writeToken}`,
        },
        body: JSON.stringify({ content }),
      }),
    );
    expect(res.status).toBe(200);
  }

  it("renders a picker listing all versions with the current marked selected", async () => {
    const created = await create({ content: "<p>v1</p>" });
    await putVersion(created.id, created.writeToken, "<p>v2</p>");
    await putVersion(created.id, created.writeToken, "<p>v3</p>");

    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain('id="oa-version-select"');
    expect(html).toContain(">v1</option>");
    expect(html).toContain(">v2</option>");
    expect(html).toContain(">v3</option>");
    // Current (latest = 3) is selected.
    expect(html).toMatch(/value="[^"]*v=3"[^>]* selected/);
    // No runtime fetch for versions: the list is inlined as options, and the
    // CSP forbids any connect.
    expect(html).toContain('aria-label="Artifact version"');
  });

  it("selecting an older version via ?v= serves that snapshot and keeps the picker", async () => {
    const created = await create({ content: "<p>v1</p>" });
    await putVersion(created.id, created.writeToken, "<p>v2</p>");
    await putVersion(created.id, created.writeToken, "<p>v3</p>");

    const v1 = await (
      await exports.default.fetch(`${BASE}/a/${created.id}?v=1`)
    ).text();
    // Picker is on the host page, with v1 the selected option; the artifact
    // body itself lives in the sandboxed sub-frame (see below).
    expect(v1).toContain('id="oa-version-select"');
    expect(v1).toMatch(/value="[^"]*v=1"[^>]* selected/);
    // The host page mirrors the pinned version into the frame src.
    expect(v1).toContain("/a/" + created.id + "/frame?v=1");
    // The version-1 snapshot is served by the frame route, not the host page.
    const frameV1 = await (
      await exports.default.fetch(`${BASE}/a/${created.id}/frame?v=1`)
    ).text();
    expect(frameV1).toContain("<p>v1</p>");
    expect(frameV1).not.toContain("<p>v3</p>");
  });

  it("renders no picker for a single-version artifact", async () => {
    const created = await create({ content: "<p>only</p>" });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).not.toContain('id="oa-version-select"');
    expect(html).not.toContain('<select id="oa-version-select"');
    // No <label class="oa-version"> control is emitted for a single version.
    expect(html).not.toContain('<label class="oa-version"');
  });

  it("ships keyboard + both-theme support for the picker", async () => {
    const created = await create({ content: "<p>v1</p>" });
    await putVersion(created.id, created.writeToken, "<p>v2</p>");
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain(".oa-version-select:focus-visible");
    expect(html).toContain("var(--oa-focus-ring)");
    expect(html).toContain('[data-theme="light"]');
    expect(html).toContain('[data-theme="dark"]');
  });

  it("inlines the picker into the encrypted unlock shell chrome", async () => {
    const envelope = await encrypt("<h1>Secret v1</h1>", "hunter2");
    const created = await create({
      content: envelope.content,
      encrypted: {
        salt: envelope.salt,
        iv: envelope.iv,
        iterations: envelope.iterations,
      },
    });
    const env2 = await encrypt("<h1>Secret v2</h1>", "hunter2");
    await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${created.id}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${created.writeToken}`,
        },
        body: JSON.stringify({
          content: env2.content,
          encrypted: {
            salt: env2.salt,
            iv: env2.iv,
            iterations: env2.iterations,
          },
        }),
      }),
    );
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(html).toContain('id="oa-version-select"');
    expect(html).toContain(">v2</option>");
    expect(html).toMatch(/value="[^"]*v=2"[^>]* selected/);
  });
});
