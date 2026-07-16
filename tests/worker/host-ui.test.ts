import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://artifacts.test";

async function hostHtml(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await exports.default.fetch(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "<p>hello</p>",
        title: "Host UI",
        favicon: "📊",
        ...overrides,
      }),
    }),
  );
  const { id } = (await created.json()) as { id: string };
  return (await exports.default.fetch(`${BASE}/a/${id}`)).text();
}

describe("host page interactive UI (tasks 009/010/011)", () => {
  it("carries the add-comment tool, compose popover, and network hooks", async () => {
    const html = await hostHtml();
    expect(html).toContain("oa-cm-tool");
    expect(html).toContain("oa-cm-compose");
    expect(html).toContain("__oaOnAnchorNew");
    expect(html).toContain("__oaOnAnchorOpen");
    expect(html).toContain("__oaOnOrphans");
    expect(html).toContain("window.__oaViewedVersion=");
    // The host is the only party that fetches — create/delete hit the API.
    expect(html).toContain('"/api/artifacts/"+ID+"/comments"');
    // Create failures surface; unanchored compose is a first-class path.
    expect(html).toContain("oa-cm-err");
    expect(html).toContain("function openCompose");
  });

  it("renders comment text with textContent, never innerHTML", async () => {
    const html = await hostHtml();
    // The client-side item builder uses textContent for author/body.
    expect(html).toContain("title.textContent=cm.body");
    expect(html).toContain(".textContent=cm.author");
    expect(html).not.toContain("innerHTML=cm.body");
  });

  it("stores identity and delete tokens under local-storage keys", async () => {
    const html = await hostHtml();
    expect(html).toContain('"oa-cm-name"');
    expect(html).toContain('"oa-cm-dt-"+id');
  });

  it("styles the compose and pin chrome with tokens and focus rings", async () => {
    const html = await hostHtml();
    expect(html).toContain(".oa-cm-compose");
    expect(html).toContain(".oa-cm-tool:focus-visible");
    expect(html).toContain("box-shadow:var(--oa-focus-ring)");
    // Delete control uses the danger token, not a hardcoded colour.
    expect(html).toContain(".oa-cm-del");
    expect(html).toContain("var(--oa-danger)");
  });

  it("still serves the interactive UI on the encrypted unlock shell", async () => {
    // Encrypted artifacts get interactive (unanchored) comments too.
    const html = await hostHtml({
      content: "ZW5jcnlwdGVk",
      encrypted: {
        salt: "c2FsdHNhbHRzYWx0c2FsdA==",
        iv: "aXZpdml2aXZpdml2",
        iterations: 100000,
      },
    });
    expect(html).toContain("oa-cm-compose");
    expect(html).toContain("__oaBridgeId");
    expect(html).toContain("window.__oaViewedVersion=");
    // Arming on an unlock shell opens unanchored compose (no text selection).
    expect(html).toContain('querySelector(".oa-unlock")');
  });

  it("shows version-drift and detached tags in the drawer renderer", async () => {
    const html = await hostHtml();
    expect(html).toContain("oa-cm-tag");
    expect(html).toContain("oa-cm-detached");
    expect(html).toContain('type:"oa:theme"');
  });

  it("exposes card layout: avatar, title, byline, done, and more menu", async () => {
    const html = await hostHtml();
    expect(html).toContain("oa-cm-avatar");
    expect(html).toContain("oa-cm-title");
    expect(html).toContain("oa-cm-byline");
    expect(html).toContain("oa-cm-done");
    expect(html).toContain("Mark done");
    expect(html).toContain("oa-cm-more");
    expect(html).toContain("More actions");
    expect(html).toContain("function toggleDone");
    expect(html).toContain('method:"PATCH"');
    // The shared control rule sets display:grid, which outranks the UA [hidden]
    // rule — the override must be restated or a token-less more control renders
    // an empty menu.
    expect(html).toContain(
      ".oa-cm-more[hidden],.oa-cm-done[hidden]{display:none}",
    );
    // Delete is nested under the more menu, not a bare control.
    expect(html).toContain("oa-cm-menu");
    expect(html).toContain('textContent="Delete"');
  });

  it("renders the filter as a dropdown beside the close button", async () => {
    const html = await hostHtml();
    expect(html).toContain('id="oa-cm-filter"');
    expect(html).toContain("oa-cm-filter-btn");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("oa-cm-filter-menu");
    expect(html).toContain('data-filter="open" aria-checked="true"');
    expect(html).toContain('data-filter="done" aria-checked="false"');
    expect(html).toContain('data-filter="all" aria-checked="false"');
    // The trigger sits left of the close control in the drawer head.
    const filterAt = html.indexOf('id="oa-cm-filter"');
    const closeAt = html.indexOf('<button class="oa-cm-close"');
    expect(filterAt).toBeGreaterThan(-1);
    expect(filterAt).toBeLessThan(closeAt);
    // Done comments drop out of the default view; the filter brings them back.
    expect(html).toContain('var filter="open"');
    expect(html).toContain("function visible()");
    expect(html).toContain("No done comments.");
  });

  it("keeps the more menu non-empty on comments this viewer cannot delete", async () => {
    const html = await hostHtml();
    // An always-available action, so the more control never opens an empty menu.
    expect(html).toContain('textContent="Copy text"');
    expect(html).toContain("navigator.clipboard.writeText");
  });

  it("grants owner moderation from ?wt= and strips the token from the URL", async () => {
    const html = await hostHtml();
    expect(html).toContain("function ownerToken()");
    expect(html).toContain('searchParams.get("wt")');
    // The token must not linger in history once captured.
    expect(html).toContain('u.searchParams.delete("wt")');
    expect(html).toContain("history.replaceState");
    // Delete authorises with the comment's own token or the owner write token.
    expect(html).toContain(
      "function deleteTokenFor(id){return getToken(id)||ownerToken()}",
    );
  });
});
