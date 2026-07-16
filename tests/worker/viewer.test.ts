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
    // script-src is nonce-only with 'self' (same-origin /vendor/... runtime
    // bundles) and NO 'unsafe-inline', NO external host, NO 'strict-dynamic'
    // (issue #11): with no external script host in the CSP, an artifact's inline
    // JS cannot createElement("script", {src: <external>}) to load an arbitrary
    // package — the bypass is closed without breaking user JS (the nonce is
    // stamped on every user <script> at serve time).
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(csp).not.toContain("'unsafe-inline' cdn.jsdelivr.net");
    expect(csp).not.toContain("cdn.jsdelivr.net");
    expect(csp).not.toContain("'strict-dynamic'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).toContain(
      "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    );
    expect(csp).toContain("img-src data: blob:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("stamps the per-request nonce on every viewer-injected inline script", async () => {
    const created = await create({ content: "<p>safe</p>" });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonceMatch = csp.match(/'nonce-([^']+)'/);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch?.[1] ?? "";
    const html = await res.text();
    // Every inline <script> the viewer emits (THEME_SCRIPT, LAYOUT_SCRIPT) must
    // carry the nonce attribute matching the CSP.
    const inlineScripts = html.match(/<script(?:\s[^>]*)?>/gi) ?? [];
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const tag of inlineScripts) {
      // Authored <script src> tags do not appear in plain-HTML artifacts; every
      // inline script here is viewer-injected and must be nonce'd.
      expect(tag).toContain(`nonce="${nonce}"`);
    }
    // Regression signal that the inline scripts are still present (a worker
    // test cannot execute JS): the theme-stamping markers the scripts produce
    // at runtime are inlined into the served HTML.
    expect(html).toContain("prefers-color-scheme");
    expect(html).toContain('data-theme="dark"');
  });

  it("stamps the per-request nonce on user-authored <script> in an HTML artifact", async () => {
    // Under nonce-only script-src, a nonceless user inline <script> would be
    // blocked — the rework of issue #11 stamps the per-request nonce onto
    // every user <script> at serve time so user JS still runs.
    const created = await create({
      content: "<main><p>x</p><script>console.log(1)</script></main>",
    });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1] ?? "";
    expect(nonce).not.toBe("");
    const html = await res.text();
    // The user-authored inline <script> carries the nonce.
    expect(html).toContain(`<script nonce="${nonce}">console.log(1)</script>`);
    // No nonceless <script> opening tag survives in the served body.
    const userScript = html.match(/<script>\s*console\.log\(1\)<\/script>/);
    expect(userScript).toBeNull();
  });

  it("does not stamp the nonce onto a <script substring inside a user JS string literal", async () => {
    // Regression: the serve-time nonce stamper must be HTML-parser-aware. A
    // <script substring appearing inside an already-open inline <script> body
    // (e.g. in a JS string literal) is script text, not a start tag — stamping
    // there would inject nonce="..." into the JS, break the string literal, and
    // silently kill all user JS. Only top-level <script start tags are stamped.
    const inner = 'var s = "<script>doStuff()</script>";';
    const created = await create({
      content: `<main><script>${inner}</script></main>`,
    });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1] ?? "";
    expect(nonce).not.toBe("");
    const html = await res.text();
    // The outer (top-level) user <script> is stamped with the nonce.
    expect(html).toContain(`<script nonce="${nonce}">var s = "`);
    // The inner <script> inside the JS string is NOT stamped — the string
    // literal survives intact so the inline JS parses.
    expect(html).toContain(`"<script>doStuff()</script>"`);
    expect(html).not.toContain(`<script nonce="${nonce}">doStuff()</script>`);
  });

  it("stamps the nonce on uppercase <SCRIPT> tags (direct-API case-agnostic path)", async () => {
    // The skill compose pipeline lowercases tags, but a direct POST /api/artifacts
    // submission can carry <SCRIPT>. The old 'unsafe-inline' CSP was case-agnostic;
    // the nonce stamper must be too, or uppercase tags are silently blocked.
    const created = await create({
      content: `<main><SCRIPT>console.log("up")</SCRIPT></main>`,
    });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1] ?? "";
    expect(nonce).not.toBe("");
    const html = await res.text();
    // The uppercase tag is stamped (original case preserved).
    expect(html).toContain(
      `<SCRIPT nonce="${nonce}">console.log("up")</SCRIPT>`,
    );
  });

  it("does not stamp the nonce onto a tag whose name merely starts with 'script'", async () => {
    // A <script-ish> custom element would, if naively prefix-matched, be rewritten
    // to a real <script> + boolean attribute, entering script-data state and
    // swallowing the rest of the page. The stamper must anchor on a real tag
    // boundary (space / '/' / '>' / end-of-string) after "script".
    const created = await create({
      content: `<main><scriptish>keep me</scriptish></main>`,
    });
    const res = await exports.default.fetch(`${BASE}/a/${created.id}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1] ?? "";
    const html = await res.text();
    // The custom element is NOT turned into a script; its content survives.
    expect(html).toContain(`<scriptish>keep me</scriptish>`);
    expect(html).not.toContain(`<script nonce="${nonce}">ish`);
  });

  it("serves the self-hosted mermaid bundle same-origin with a JS MIME and nosniff", async () => {
    const res = await exports.default.fetch(
      `${BASE}/vendor/mermaid.runtime.js`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    // The bundle is an IIFE that self-attaches window.mermaid synchronously on
    // load, so the browser init (plain inline JS in the scripts slot, which
    // compose emits AFTER the body) can call window.mermaid.run(). It must NOT
    // be an ESM module (a module script is deferred and would run after the
    // init — the load-order bug, issue #11).
    expect(body).toContain("window.mermaid=");
    expect(body).not.toMatch(/^\s*export\b/m);
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
    // The marked bootstrap inline scripts carry the per-request nonce too.
    const nonceMatch = csp.match(/'nonce-([^']+)'/);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch?.[1] ?? "";
    const tags = html.match(/<script(?:\s[^>]*)?>/gi) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
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

  it("stamps the per-request nonce on the unlock-shell inline scripts", async () => {
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
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonceMatch = csp.match(/'nonce-([^']+)'/);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch?.[1] ?? "";
    // Parent CSP carries the nonce (the encrypted srcdoc iframe inherits the
    // parent CSP, so the same nonce scheme covers the decrypted doc — the
    // unlock script stamps the nonce onto decrypted user <script> client-side).
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-inline' cdn.jsdelivr.net");
    const html = await res.text();
    // The unlock shell emits unlockScript + THEME_SCRIPT + LAYOUT_SCRIPT inline;
    // every one must carry the nonce.
    const inlineScripts = html.match(/<script(?:\s[^>]*)?>/gi) ?? [];
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const tag of inlineScripts) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it("renders exactly one feedback panel on an encrypted page (no duplicate in the iframe template)", async () => {
    const envelope = await encrypt("<h1>Top Secret</h1>", "hunter2");
    const created = await create({
      content: envelope.content,
      encrypted: {
        salt: envelope.salt,
        iv: envelope.iv,
        iterations: envelope.iterations,
      },
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    // The outer unlock page renders the panel; the iframe srcdoc template
    // (built via wrapDocument with feedback:false) must not duplicate it.
    // Count the panel element (id attribute), not the CSS class rules.
    const occurrences = html.split('id="oa-feedback-backdrop"').length - 1;
    expect(occurrences).toBe(1);
  });

  it("does not render a dead feedback button inside the encrypted iframe template", async () => {
    const envelope = await encrypt("<h1>Top Secret</h1>", "hunter2");
    const created = await create({
      content: envelope.content,
      encrypted: {
        salt: envelope.salt,
        iv: envelope.iv,
        iterations: envelope.iterations,
      },
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    // The outer unlock page renders one toggle button (functional); the iframe
    // srcdoc template (feedback:false) must not carry a dead, listener-less
    // button inside the decrypted content.
    const toggles = html.split('id="oa-feedback-toggle"').length - 1;
    expect(toggles).toBe(1);
  });

  it("inlines a projectRef containing $-replacement patterns verbatim (no script corruption)", async () => {
    // projectRef is user-controlled; String.replace treats $&/$'/$`/$1 specially
    // in a string replacement. feedbackScript must use a replacer function so
    // these patterns land verbatim in the JSON-inlined script, not spliced in.
    const projectRef = "$&$`$'$1$$";
    const created = await create({
      content: "<h1>safe</h1>",
      projectRef,
    });
    const html = await (
      await exports.default.fetch(`${BASE}/a/${created.id}`)
    ).text();
    // The projectRef must appear as a JSON string literal verbatim, and the
    // $-patterns must NOT have spliced template text into the script — the
    // slot literals are gone (replaced) and the OA assignment is well-formed.
    expect(html).toContain(JSON.stringify(projectRef));
    expect(html).toContain("var OA={artifactId:");
    expect(html).not.toContain("__OA_ARTIFACT_ID__");
    expect(html).not.toContain("__OA_PROJECT_REF__");
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
    expect(v1).toContain("<p>v1</p>");
    expect(v1).not.toContain("<p>v3</p>");
    // Picker still present, and v1 is now the selected option.
    expect(v1).toContain('id="oa-version-select"');
    expect(v1).toMatch(/value="[^"]*v=1"[^>]* selected/);
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
