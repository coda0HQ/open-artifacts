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

describe("GET /a/:id (plain HTML)", () => {
  it("wraps content in a complete skeleton with title, favicon, and reset", async () => {
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
    expect(html).toContain("<h1>Wrapped</h1>");
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

  it("sends the sandboxing CSP and hardening headers", async () => {
    const created = await create({ content: "<p>safe</p>" });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' cdn.jsdelivr.net");
    expect(csp).toContain(
      "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
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

  it("serves a specific version via ?v=", async () => {
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
      await exports.default.fetch(`${BASE}/a/${created.id}?v=1`)
    ).text();
    expect(v1).toContain("<p>first</p>");
    const latest = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    expect(latest).toContain("<p>second</p>");
  });
});

describe("GET /a/:id (markdown)", () => {
  it("embeds the markdown source and a client-side renderer", async () => {
    const created = await create({
      content: "# Heading\n\nSome **bold** text.",
      format: "markdown",
    });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
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
      await exports.default.fetch(`${BASE}/a/${created.id}`)
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
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).not.toMatch(/(^|;\s*)sandbox/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(html).toContain('<label class="oa-label" for="oa-password">');
    expect(html).toContain('aria-describedby="oa-help oa-error"');
    expect(html).toContain("min-height:44px");
    expect(html).toContain("color:var(--oa-danger)");
    expect(html).toContain("Password incorrect. Check it and try again.");
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
