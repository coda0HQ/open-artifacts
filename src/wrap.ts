import { buildTextAnchor, reAnchor } from "./anchor";
import type {
  ArtifactFormat,
  CommentMeta,
  EncryptionParams,
  VersionMeta,
} from "./domain";
import { MARKED_SOURCE } from "./generated/marked-source";
import { type Brand, brandFor, isCoda0Host } from "./home";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function faviconDataUri(emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="85">${escapeHtml(emoji)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Embeds a string into an inline <script> safely: JSON escapes quotes/controls,
// and < prevents "</script>" from terminating the block.
export function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

// Per-request nonce: base64 of 16 random bytes (~22 chars). Stamped on every
// inline <script> (viewer-injected AND user-authored) and emitted as
// 'nonce-<value>' in script-src so 'unsafe-inline' can be dropped. script-src
// is nonce-only with no 'strict-dynamic' and no external script host: the
// only non-inline scripts allowed are same-origin ('self'), so mermaid loads
// from /vendor/mermaid.runtime.js under 'self' while a runtime
// createElement("script", {src: externalURL}) is blocked (no host allowlisted)
// — closing the inline-JS jsdelivr bypass (issue #11) WITHOUT breaking user JS.
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // btoa is available in the Worker runtime; base64 keeps the nonce CSP-safe
  // (no separators that would split the directive value).
  return btoa(String.fromCharCode(...bytes));
}

function scriptSrcForNonce(selfSrc: string, nonce: string): string {
  // selfSrc ('self' for normal-origin docs, the explicit response origin for
  // opaque-origin frames) lets the same-origin /vendor/mermaid.runtime.js
  // script load; the nonce lets every inline <script> run. No
  // 'strict-dynamic' (so trust does not propagate from a nonce'd script to a
  // runtime-created one) and no external host (so a
  // createElement("script", {src: <external>}) is blocked).
  return `${selfSrc} 'nonce-${nonce}'`;
}

// Web fonts + runtime libraries are an opt-in per-deploy surface (env var
// OPEN_ARTIFACTS_WEB_FONTS). When enabled, the sandbox gains allow-same-origin
// so the browser can cache fonts, font-src widens to 'self' plus a bounded
// allowlist of font CDNs (Fontshare + Google Fonts, the two that serve woff2
// over a stable CDN for Awwwards-listed families), style-src gains 'self' plus
// the Google Fonts CSS host (so the same-origin /fonts/<slug>.css shim and
// Google Fonts @import load). Runtime libraries (mermaid) are self-hosted:
// the vendored bundle is served same-origin from /vendor/mermaid.runtime.js
// (a static asset under public/), so script-src stays 'self' + nonce with no
// external script host. The trade-off: artifacts lose the opaque-origin
// guarantee and can read the host origin's localStorage/cookies, and an
// artifact can pull passive font bytes from the allowlisted CDNs (fonts are
// non-executable, so the allowlist has no code-execution surface). Default
// (webFonts=false) keeps the strict opaque-origin sandbox and font-src of a
// self-hosted deploy.
// fontHosts is the bare CDN host list reused by the frameSandbox+origin path
// (opaque-origin frames cannot use CSP 'self', so the real origin is swapped
// in for 'self' and the CDN hosts are appended verbatim — see
// contentSecurityPolicy).
const WEB_FONT_CSP = {
  fontSrc: "'self' data: cdn.fontshare.com fonts.gstatic.com",
  styleSrc: "'self' 'unsafe-inline' fonts.googleapis.com",
  fontHosts: "data: cdn.fontshare.com fonts.gstatic.com",
};
export function contentSecurityPolicy(options: {
  sandbox: boolean;
  webFonts?: boolean;
  // Forces a strict sandbox (no allow-same-origin) even when webFonts is on.
  // The artifact frame (GET /a/:id/frame) must never become same-origin with
  // the privileged host page (R1) — allow-same-origin on a sandboxed frame
  // grants it the response URL's origin, which would let it read the host
  // page's localStorage/cookies across the air-gap.
  frameSandbox?: boolean;
  // Absolute origin of the response URL (e.g. https://coda0.com). Required for
  // frameSandbox+webFonts: an opaque-origin document's CSP 'self' does not
  // match the worker host, so the same-origin /fonts/<slug> proxy would be
  // blocked. Passing the real origin lets those subresources load as
  // cross-origin-from-opaque while the sandbox token stays strict.
  origin?: string;
  // Per-request CSP nonce; stamped on every viewer-injected inline <script>
  // and emitted in script-src so 'unsafe-inline' can be dropped (issue #11).
  nonce: string;
}): string {
  const webFonts = options.webFonts === true;
  const opaqueFrame = options.sandbox && options.frameSandbox === true;
  // Prefer an explicit origin for opaque frames; fall back to 'self' only for
  // non-opaque sandboxes (legacy webFonts+allow-same-origin path).
  const selfSrc = opaqueFrame && options.origin ? options.origin : "'self'";
  const directives = [
    "default-src 'none'",
    // script-src is the same nonce-only form whether or not web fonts are on:
    // 'self' (same-origin /vendor/... runtime scripts) + a per-request nonce
    // (every inline <script>). No external script host, no 'strict-dynamic'.
    `script-src ${scriptSrcForNonce(selfSrc, options.nonce)}`,
    `style-src ${webFonts ? `${selfSrc} ${WEB_FONT_CSP.styleSrc.replace(/^'self' /, "")}` : "'unsafe-inline'"}`,
    "img-src data: blob:",
    `font-src ${webFonts ? `${selfSrc} ${WEB_FONT_CSP.fontHosts}` : "data:"}`,
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ];
  if (options.sandbox) {
    const allowSameOrigin = webFonts && options.frameSandbox !== true;
    directives.unshift(
      `sandbox allow-scripts allow-modals allow-forms allow-popups${allowSameOrigin ? " allow-same-origin" : ""}`,
    );
  }
  return directives.join("; ");
}

export function userContentHeaders(options: {
  sandbox: boolean;
  contentType: string;
  webFonts?: boolean;
  frameSandbox?: boolean;
  origin?: string;
  nonce: string;
}): Headers {
  return new Headers({
    "content-type": options.contentType,
    "content-security-policy": contentSecurityPolicy({
      sandbox: options.sandbox,
      webFonts: options.webFonts,
      frameSandbox: options.frameSandbox,
      origin: options.origin,
      nonce: options.nonce,
    }),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-cache",
  });
}

// The host page (GET /a/:id) is a normal-origin document: it holds
// cross-frame state (theme localStorage) and is the only party that talks to
// the API (comments fetch, in a later phase). It embeds the artifact as a
// sandboxed <iframe src="/a/:id/frame">, never the artifact body itself, so
// it carries no sandbox directive of its own — connect-src/frame-src widen
// just enough for same-origin API calls and the embed; everything else stays
// locked down like the artifact frame.
export function hostContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    // script-src is nonce-only with 'self' (same-origin /vendor/... runtime
    // bundles) — no 'unsafe-inline', no external script host, no
    // 'strict-dynamic' (issue #11).
    `script-src ${scriptSrcForNonce("'self'", nonce)}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'self'",
    "frame-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function hostHeaders(nonce: string): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": hostContentSecurityPolicy(nonce),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-cache",
  });
}

// Service chrome typeface. Host chrome and frame-injected widgets (selection
// chip, etc.) pin to this stack so they never inherit an artifact's
// display/serif/web font. CJK faces trail so Chinese UI copy still renders.
const OA_FONT =
  'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif';

const RESET_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--oa-font);line-height:1.5;background:var(--oa-bg);color:var(--oa-fg)}
img,video,canvas{max-width:100%}
:root{color-scheme:light dark;--oa-font:${OA_FONT};--oa-bg:#ffffff;--oa-fg:#18181b;--oa-muted:#71717a;--oa-border:#e4e4e7;--oa-surface:#f8f8f8;--oa-accent:#6457f0;--oa-accent-on:#ffffff;--oa-danger:#b42318;--oa-focus-ring:0 0 0 2px var(--oa-bg),0 0 0 4px var(--oa-accent)}
@media (prefers-color-scheme: dark){:root{--oa-bg:#131316;--oa-fg:#e7e7ea;--oa-muted:#9a9aa2;--oa-border:#2e2e33;--oa-surface:#1c1c21;--oa-accent:#8d82f5;--oa-accent-on:#16151b;--oa-danger:#ff8f85}}
:root[data-theme="light"]{color-scheme:light;--oa-bg:#ffffff;--oa-fg:#18181b;--oa-muted:#71717a;--oa-border:#e4e4e7;--oa-surface:#f8f8f8;--oa-accent:#6457f0;--oa-accent-on:#ffffff;--oa-danger:#b42318}
:root[data-theme="dark"]{color-scheme:dark;--oa-bg:#131316;--oa-fg:#e7e7ea;--oa-muted:#9a9aa2;--oa-border:#2e2e33;--oa-surface:#1c1c21;--oa-accent:#8d82f5;--oa-accent-on:#16151b;--oa-danger:#ff8f85}
/* Header height is measured at runtime and exposed as --oa-header-h so
   anchor scroll-offset stays correct without author effort. The header is
   sticky (in-flow), so body content is never obscured — only anchor jumps
   need the offset. */
:root{--oa-header-h:2.5rem}
[id]{scroll-margin-top:calc(var(--oa-header-h) + .5rem)}
.oa-header{position:sticky;top:0;z-index:2147483646;display:flex;align-items:center;gap:.6rem;padding:.375rem 1rem;background:color-mix(in oklab,var(--oa-bg),transparent 8%);backdrop-filter:blur(10px);border-bottom:1px solid var(--oa-border);font-family:var(--oa-font);font-size:.8rem}
.oa-header .oa-header-title{flex:1;min-width:0;font-size:.8rem;font-weight:600;line-height:1.5;letter-spacing:normal;margin:0;color:var(--oa-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oa-header .oa-header-title .oa-header-fav{margin-right:.4rem;font-size:1em}
.oa-header #oa-theme-toggle{position:relative;width:28px;height:28px;border-radius:6px;border:1px solid var(--oa-border);background:var(--oa-surface);color:var(--oa-fg);font-size:13px;line-height:1;cursor:pointer;opacity:.8;transition:opacity .15s,border-color .15s,background .15s;flex-shrink:0}
.oa-header #oa-theme-toggle::before{content:"";position:absolute;inset:-6px}
.oa-header #oa-theme-toggle:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-header #oa-theme-toggle:active{transform:translateY(1px)}
.oa-header #oa-theme-toggle svg{display:block}
.oa-brand{position:relative;display:inline-flex;align-items:center;gap:.35rem;min-height:28px;text-decoration:none;color:var(--oa-muted);font-size:.75rem;flex-shrink:0;padding:.2rem .5rem;border-radius:6px;transition:color .15s,background .15s}
.oa-brand::before{content:"";position:absolute;inset:-6px 0}
.oa-brand:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-brand:active{transform:translateY(1px)}
.oa-brand svg{display:block;width:14px;height:14px}
@media (hover:hover) and (pointer:fine){.oa-header #oa-theme-toggle:hover{opacity:1;border-color:color-mix(in oklab,var(--oa-border),var(--oa-fg) 25%)}.oa-brand:hover{color:var(--oa-fg);background:var(--oa-surface)}}
@media (max-width:30rem){.oa-brand .oa-brand-text{display:none}}
.oa-version{display:inline-flex;align-items:center;flex-shrink:0}
.oa-version .oa-version-select{min-height:28px;padding:.2rem 1.6rem .2rem .5rem;border:1px solid var(--oa-border);border-radius:6px;background:var(--oa-surface);color:var(--oa-fg);font-size:.75rem;font-family:inherit;line-height:1.4;cursor:pointer;transition:border-color .15s,background .15s;-webkit-appearance:none;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--oa-muted) 50%),linear-gradient(135deg,var(--oa-muted) 50%,transparent 50%);background-position:calc(100% - .7rem) 55%,calc(100% - .4rem) 55%;background-size:.3rem .3rem;background-repeat:no-repeat}
.oa-version .oa-version-select:focus-visible{outline:none;border-color:var(--oa-accent);box-shadow:var(--oa-focus-ring)}
.oa-version .oa-version-select:active{transform:translateY(1px)}
@media (hover:hover) and (pointer:fine){.oa-version .oa-version-select:hover{border-color:color-mix(in oklab,var(--oa-border),var(--oa-fg) 25%)}}
`;

const MARKDOWN_CSS = `
.oa-md{max-width:72ch;margin:0 auto;padding:2.5rem 1.25rem 5rem}
.oa-md h1,.oa-md h2,.oa-md h3{line-height:1.25;text-wrap:balance}
.oa-md pre{background:var(--oa-surface);border:1px solid var(--oa-border);border-radius:6px;padding:.75rem 1rem;overflow-x:auto}
.oa-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.925em}
.oa-md :not(pre)>code{background:var(--oa-surface);border:1px solid var(--oa-border);border-radius:4px;padding:.1em .35em}
.oa-md table{border-collapse:collapse;display:block;overflow-x:auto}
.oa-md th,.oa-md td{border:1px solid var(--oa-border);padding:.4rem .7rem;text-align:left}
.oa-md blockquote{margin:0;padding-left:1rem;border-left:3px solid var(--oa-border);color:var(--oa-muted)}
.oa-md img{max-width:100%}
.oa-md a{color:inherit}
`;

const COMMENTS_CSS = `
.oa-cm-toggle{position:relative;width:28px;height:28px;border-radius:6px;border:1px solid var(--oa-border);background:var(--oa-surface);color:var(--oa-fg);font-size:13px;line-height:1;cursor:pointer;opacity:.8;transition:opacity .15s,border-color .15s,background .15s;flex-shrink:0}
.oa-cm-toggle::before{content:"";position:absolute;inset:-6px}
.oa-cm-toggle:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-toggle:active{transform:translateY(1px)}
.oa-cm-toggle svg{display:block;width:15px;height:15px;margin:auto}
.oa-cm-toggle .oa-cm-count{position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;padding:0 3px;border-radius:8px;background:var(--oa-accent);color:var(--oa-accent-on);font-size:9px;font-weight:600;line-height:15px;text-align:center;display:none}
.oa-cm-toggle[data-count] .oa-cm-count{display:block}
.oa-cm-drawer{position:fixed;top:var(--oa-header-h);right:0;height:calc(100dvh - var(--oa-header-h));width:100%;max-width:23rem;transform:translateX(100%);transition:transform .18s ease;display:flex;flex-direction:column;background:var(--oa-bg);border-left:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 6%);z-index:2147483645;font-family:var(--oa-font)}
.oa-cm-drawer[data-open]{transform:translateX(0)}
/* Right inset matches .oa-header padding (1rem) so the close control lines up
   with the theme toggle above it, and the list card shares the same edge. */
.oa-cm-drawer .oa-cm-head{display:flex;align-items:center;gap:.6rem;min-height:2.75rem;padding:.375rem 1rem;border-bottom:1px solid var(--oa-border);flex-shrink:0}
.oa-cm-drawer .oa-cm-head h2{flex:1;display:flex;align-items:baseline;gap:.4rem;margin:0;font-size:.8rem;font-weight:600;letter-spacing:-.01em;color:var(--oa-fg)}
.oa-cm-drawer .oa-cm-head-count{display:none;padding:.05rem .35rem;border-radius:4px;background:var(--oa-surface);color:var(--oa-fg);font-size:.72rem;font-weight:600;font-variant-numeric:tabular-nums}
.oa-cm-drawer .oa-cm-head-count[data-count]{display:inline-block}
.oa-cm-drawer .oa-cm-close{position:relative;width:28px;height:28px;flex-shrink:0;display:grid;place-items:center;border-radius:6px;border:1px solid var(--oa-border);background:var(--oa-surface);color:var(--oa-fg);font-size:15px;line-height:1;cursor:pointer;opacity:.8;transition:opacity .15s,border-color .15s,background .15s}
.oa-cm-drawer .oa-cm-close:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-drawer .oa-cm-close:active{transform:translateY(1px)}
@media (hover:hover) and (pointer:fine){.oa-cm-drawer .oa-cm-close:hover{opacity:1;border-color:color-mix(in oklab,var(--oa-border),var(--oa-fg) 25%)}}
/* Filter — done comments are hidden under "Open" by default, so this dropdown
   is the way back to them. The trigger shares the close button's chrome and
   sits beside it. */
.oa-cm-filter{position:relative;flex-shrink:0;display:flex}
.oa-cm-filter-btn{position:relative;width:28px;height:28px;flex-shrink:0;display:grid;place-items:center;border-radius:6px;border:1px solid var(--oa-border);background:var(--oa-surface);color:var(--oa-fg);cursor:pointer;opacity:.8;transition:opacity .15s,border-color .15s,background .15s}
.oa-cm-filter-btn svg{width:14px;height:14px;display:block}
.oa-cm-filter-btn:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-filter-btn:active{transform:translateY(1px)}
@media (hover:hover) and (pointer:fine){.oa-cm-filter-btn:hover{opacity:1;border-color:color-mix(in oklab,var(--oa-border),var(--oa-fg) 25%)}}
.oa-cm-filter-menu{top:calc(100% + 4px)}
.oa-cm-filter-menu button[aria-checked="true"]{background:var(--oa-surface);color:var(--oa-fg);font-weight:600}
/* Card list — each comment is a rounded surface card (reference UI). */
.oa-cm-list{flex:1;min-height:0;overflow-y:auto;margin:.55rem .75rem .75rem;padding:0;border:0;background:transparent;display:flex;flex-direction:column;gap:.5rem}
.oa-cm-empty{color:var(--oa-muted);font-size:.85rem;text-align:center;margin:2rem 1rem}
.oa-cm-item{position:relative;display:flex;gap:.65rem;align-items:flex-start;padding:.7rem .75rem;border-radius:10px;border:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 4%);background:var(--oa-surface);transition:border-color .12s,background .12s}
@media (hover:hover) and (pointer:fine){.oa-cm-item:hover{border-color:color-mix(in oklab,var(--oa-border),var(--oa-fg) 14%)}}
.oa-cm-avatar{flex-shrink:0;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:color-mix(in oklab,var(--oa-fg),transparent 90%);color:var(--oa-fg);font-size:.75rem;font-weight:600;line-height:1;text-transform:uppercase;user-select:none}
.oa-cm-stack{flex:1;min-width:0;display:flex;flex-direction:column;gap:.2rem}
.oa-cm-top{display:flex;gap:.4rem;align-items:flex-start}
.oa-cm-title{flex:1;min-width:0;font-size:.875rem;font-weight:600;line-height:1.35;letter-spacing:-.01em;color:var(--oa-fg);white-space:pre-wrap;word-break:break-word}
.oa-cm-byline{font-size:.72rem;line-height:1.4;color:var(--oa-muted)}
.oa-cm-byline .oa-cm-author{font-weight:500;color:var(--oa-muted)}
.oa-cm-byline .oa-cm-anon{font-weight:500;color:var(--oa-muted)}
.oa-cm-tag,.oa-cm-detached{font-size:.72rem;font-weight:500;color:var(--oa-muted)}
.oa-cm-detached{font-style:italic}
.oa-cm-item[data-done] .oa-cm-title{color:var(--oa-muted);text-decoration:line-through;text-decoration-thickness:1px}
.oa-cm-item[data-done] .oa-cm-avatar{opacity:.65}
/* Trail: more ··· then done ○✓. Same 24px hit target; appear on card hover. */
.oa-cm-trail{display:inline-flex;align-items:center;gap:.15rem;flex-shrink:0;margin-top:-.15rem}
.oa-cm-actions{position:relative;flex-shrink:0}
.oa-cm-more,.oa-cm-done{box-sizing:border-box;width:24px;height:24px;padding:0;flex-shrink:0;display:grid;place-items:center;border:0;border-radius:6px;cursor:pointer;color:var(--oa-muted);background:transparent;transition:opacity .12s,background .12s,color .12s,box-shadow .12s}
/* display:grid above outranks the UA [hidden] rule, so restate it: without a
   delete token the more control has an empty menu and must not render. */
.oa-cm-more[hidden],.oa-cm-done[hidden]{display:none}
.oa-cm-more svg{width:14px;height:14px;display:block}
.oa-cm-done svg{width:13px;height:13px;display:block}
/* Why a refused resolve/delete bounced back — the drawer's only error surface. */
.oa-cm-drawer-err{flex-shrink:0;margin:.5rem 1rem 0;padding:.4rem .6rem;border:1px solid color-mix(in oklab,var(--oa-danger),transparent 60%);border-radius:6px;background:color-mix(in oklab,var(--oa-danger),transparent 92%);color:var(--oa-danger);font-size:.75rem;line-height:1.4}
.oa-cm-drawer-err[hidden]{display:none}
.oa-cm-done[aria-pressed="true"]{color:var(--oa-accent)}
.oa-cm-done[aria-pressed="true"] svg circle{fill:var(--oa-accent)}
.oa-cm-done[aria-pressed="true"] svg path{stroke:var(--oa-accent-on)}
.oa-cm-more:focus-visible,.oa-cm-done:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
/* Fine pointer: hide until card hover / focus / open menu; shared hover wash. */
@media (hover:hover) and (pointer:fine){
  .oa-cm-more,.oa-cm-done{opacity:0}
  .oa-cm-item:hover .oa-cm-more,.oa-cm-item:hover .oa-cm-done,
  .oa-cm-item:focus-within .oa-cm-more,.oa-cm-item:focus-within .oa-cm-done,
  .oa-cm-more[aria-expanded="true"],.oa-cm-more:focus-visible,.oa-cm-done:focus-visible,
  .oa-cm-done[aria-pressed="true"]{opacity:1}
  .oa-cm-more:hover,.oa-cm-done:hover{background:color-mix(in oklab,var(--oa-fg),transparent 92%);color:var(--oa-fg)}
  .oa-cm-done[aria-pressed="true"]:hover{color:var(--oa-accent)}
}
.oa-cm-menu{position:absolute;top:100%;right:0;z-index:2;min-width:7.5rem;padding:.25rem;border:1px solid var(--oa-border);border-radius:8px;background:var(--oa-bg)}
.oa-cm-menu[hidden]{display:none}
.oa-cm-menu button{display:block;width:100%;text-align:left;padding:.4rem .55rem;border:0;border-radius:6px;background:none;color:var(--oa-fg);font:inherit;font-size:.8rem;cursor:pointer}
.oa-cm-menu button:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
@media (hover:hover) and (pointer:fine){.oa-cm-menu button:hover{background:color-mix(in oklab,var(--oa-fg),transparent 94%)}}
.oa-cm-menu .oa-cm-del{color:var(--oa-danger)}
@media (hover:hover) and (pointer:fine){.oa-header .oa-cm-toggle:hover{opacity:1;border-color:color-mix(in oklab,var(--oa-border),var(--oa-fg) 25%)}}
@media (max-width:30rem){.oa-cm-drawer{max-width:100%}}
/* Anchored-comment chrome (task 011): the "add comment" tool, the compose
   popover, delete controls, and the focused-thread state. Tokens only, both
   themes, visible focus rings, no decorative motion. */
.oa-cm-tool{position:relative;width:28px;height:28px;border-radius:6px;border:1px solid var(--oa-border);background:var(--oa-surface);color:var(--oa-fg);font-size:17px;line-height:1;cursor:pointer;opacity:.8;transition:opacity .15s,border-color .15s,background .15s;flex-shrink:0}
.oa-cm-tool:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-tool svg{display:block;width:15px;height:15px;margin:auto}
.oa-cm-tool[aria-pressed="true"]{opacity:1;border-color:var(--oa-accent);color:var(--oa-accent)}
.oa-cm-tool:active{transform:translateY(1px)}
@media (hover:hover) and (pointer:fine){.oa-cm-tool:hover{opacity:1}}
/* Compose: a single rounded pill — "Add a comment" + a circular send button
   (muted until there is text, then accent) — floating over the artifact. The
   name is a small quiet pill shown only the first time, before one is saved. */
.oa-cm-compose{position:fixed;z-index:2147483646;width:min(22rem,calc(100vw - 1rem));display:flex;flex-direction:column;gap:.4rem;font-family:var(--oa-font)}
.oa-cm-compose[hidden]{display:none}
.oa-cm-compose ::placeholder{color:var(--oa-muted);opacity:1}
/* The name pill and the input row are the same object at two sizes: identical
   surface, border, and pill radius, no shadow — the border carries the edge. */
.oa-cm-name,.oa-cm-row{background:var(--oa-bg);border:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 6%);border-radius:999px}
.oa-cm-name{align-self:flex-start;max-width:70%;padding:.32rem .7rem;color:var(--oa-fg);font-family:var(--oa-font);font-size:.78rem}
.oa-cm-name[hidden]{display:none}
/* One focus treatment for both pills: whichever holds focus takes the accent
   border. Not the full focus ring — compose autofocuses the textarea, so a ring
   would fire on every open; the send button keeps its ring for keyboard users. */
.oa-cm-name:focus-within,.oa-cm-row:focus-within{outline:none;border-color:var(--oa-accent)}
/* No :focus-within darkening: compose autofocuses the textarea, so it would
   render the row permanently darker than the name pill. The caret marks focus;
   the send button and name keep their own rings. */
.oa-cm-row{display:flex;align-items:center;gap:.35rem;padding:.25rem .25rem .25rem .95rem}
.oa-cm-body{flex:1;min-width:0;border:0;background:none;resize:none;color:var(--oa-fg);font-family:var(--oa-font);font-size:.9rem;line-height:1.45;padding:.5rem 0;max-height:8rem;overflow-y:auto}
.oa-cm-body:focus{outline:none}
.oa-cm-send{flex-shrink:0;width:32px;height:32px;border-radius:50%;border:0;display:grid;place-items:center;background:color-mix(in oklab,var(--oa-fg),var(--oa-bg) 80%);color:var(--oa-muted);cursor:default;transition:background .13s,color .13s,transform .1s}
.oa-cm-send svg{width:16px;height:16px}
.oa-cm-send[data-ready]{background:var(--oa-accent);color:var(--oa-accent-on);cursor:pointer}
.oa-cm-send:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-send[data-ready]:active{transform:scale(.93)}
@media (hover:hover) and (pointer:fine){.oa-cm-send[data-ready]:hover{background:color-mix(in oklab,var(--oa-accent),var(--oa-fg) 12%)}}
@media (prefers-reduced-motion:no-preference){.oa-cm-compose{transition:opacity .13s ease-out,transform .13s ease-out,display .13s allow-discrete}.oa-cm-compose[hidden]{opacity:0;transform:translateY(-4px) scale(.985)}@starting-style{.oa-cm-compose:not([hidden]){opacity:0;transform:translateY(-4px) scale(.985)}}}
.oa-cm-item[data-focus]{border-color:color-mix(in oklab,var(--oa-accent),transparent 55%);box-shadow:0 0 0 1px color-mix(in oklab,var(--oa-accent),transparent 70%)}
.oa-cm-err{display:none;margin:0 .25rem;padding:0 .2rem;color:var(--oa-danger);font-size:.75rem;font-weight:500}
.oa-cm-err:not([hidden]){display:block}
`;

const SUN_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 18C8.68629 18 6 15.3137 6 12C6 8.68629 8.68629 6 12 6C15.3137 6 18 8.68629 18 12C18 15.3137 15.3137 18 12 18ZM12 16C14.2091 16 16 14.2091 16 12C16 9.79086 14.2091 8 12 8C9.79086 8 8 9.79086 8 12C8 14.2091 9.79086 16 12 16ZM11 1H13V4H11V1ZM11 20H13V23H11V20ZM3.51472 4.92893L4.92893 3.51472L7.05025 5.63604L5.63604 7.05025L3.51472 4.92893ZM16.9497 18.364L18.364 16.9497L20.4853 19.0711L19.0711 20.4853L16.9497 18.364ZM19.0711 3.51472L20.4853 4.92893L18.364 7.05025L16.9497 5.63604L19.0711 3.51472ZM5.63604 16.9497L7.05025 18.364L4.92893 20.4853L3.51472 19.0711L5.63604 16.9497ZM23 11V13H20V11H23ZM4 11V13H1V11H4Z"/></svg>';
const MOON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M10 7C10 10.866 13.134 14 17 14C18.9584 14 20.729 13.1957 21.9995 11.8995C22 11.933 22 11.9665 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C12.0335 2 12.067 2 12.1005 2.00049C10.8043 3.27098 10 5.04157 10 7ZM4 12C4 16.4183 7.58172 20 12 20C15.0583 20 17.7158 18.2839 19.062 15.7621C18.3945 15.9187 17.7035 16 17 16C12.0294 16 8 11.9706 8 7C8 6.29648 8.08133 5.60547 8.2379 4.938C5.71611 6.28423 4 8.9417 4 12Z"/></svg>';

const COMMENT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
// The "add a comment" tool icon: Figma's comment-marker silhouette — a rounded
// bubble whose tail points to the bottom-left, the same shape as the pins it
// drops on the canvas, so the tool visibly IS the marker it places. Outline in
// the toolbar, filled once placed (cursor + pin) — Figma's own convention. Its
// teardrop reads distinctly from the drawer toggle's rectangular chat bubble.
const COMMENT_ADD_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M4 18V10a8 8 0 0 1 8-8 8 8 0 0 1 8 8 8 8 0 0 1-8 8H4z"/></svg>';
// Done toggle: checkmark inside the circle (visible when aria-pressed).
// Circle-check "done" control. The circle lives in the icon, not on the button,
// so the button chrome stays identical to the three-dot control beside it.
const DONE_CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"/><path d="M8.4 12.3l2.4 2.4 4.8-5.1"/></svg>';
// Horizontal three-dot "more" control (reference card UI).
const MORE_DOTS_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="19" cy="12" r="1.75"/></svg>';
// Filter control in the drawer head (sits left of the close button).
const FILTER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';
// The compose send button's up-arrow (post the comment).
const SEND_ARROW_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 19V6M6 12l6-6 6 6"/></svg>';
const BRAND_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M20.0833 15.1999L21.2854 15.9212C21.5221 16.0633 21.5989 16.3704 21.4569 16.6072C21.4146 16.6776 21.3557 16.7365 21.2854 16.7787L12.5144 22.0412C12.1977 22.2313 11.8021 22.2313 11.4854 22.0412L2.71451 16.7787C2.47772 16.6366 2.40093 16.3295 2.54301 16.0927C2.58523 16.0223 2.64413 15.9634 2.71451 15.9212L3.9166 15.1999L11.9999 20.0499L20.0833 15.1999ZM20.0833 10.4999L21.2854 11.2212C21.5221 11.3633 21.5989 11.6704 21.4569 11.9072C21.4146 11.9776 21.3557 12.0365 21.2854 12.0787L11.9999 17.6499L2.71451 12.0787C2.47772 11.9366 2.40093 11.6295 2.54301 11.3927C2.58523 11.3223 2.64413 11.2634 2.71451 11.2212L3.9166 10.4999L11.9999 15.3499L20.0833 10.4999ZM12.5144 1.30864L21.2854 6.5712C21.5221 6.71327 21.5989 7.0204 21.4569 7.25719C21.4146 7.32757 21.3557 7.38647 21.2854 7.42869L11.9999 12.9999L2.71451 7.42869C2.47772 7.28662 2.40093 6.97949 2.54301 6.7427C2.58523 6.67232 2.64413 6.61343 2.71451 6.5712L11.4854 1.30864C11.8021 1.11864 12.1977 1.11864 12.5144 1.30864ZM11.9999 3.33233L5.88723 6.99995L11.9999 10.6676L18.1126 6.99995L11.9999 3.33233Z"/></svg>';

function versionPickerHtml(
  versions: VersionMeta[],
  currentVersion: number,
  url: string,
): string {
  // Single-version artifacts have nothing to switch between; render no
  // picker so the chrome stays quiet for the common one-shot case.
  if (versions.length <= 1) return "";
  // The version list is inlined at serve time as <option>s. Selecting an
  // option sets location.search to ?v=<n>, driving a full re-serve with the
  // version-N snapshot inlined. No runtime fetch: the sandboxed opaque-origin
  // iframe cannot make one anyway, and the picker lives in the host chrome.
  const base = new URL(url, "https://placeholder.local");
  const options = versions
    .map((v) => {
      const q = new URL(base);
      q.searchParams.set("v", String(v.version));
      const target = `${q.pathname}?${q.searchParams.toString()}`;
      const label = v.label
        ? `${escapeHtml(v.label)} (v${v.version})`
        : `v${v.version}`;
      const selected = v.version === currentVersion ? " selected" : "";
      return `<option value="${escapeHtml(target)}"${selected}>${label}</option>`;
    })
    .join("");
  return `<label class="oa-version" for="oa-version-select"><span class="oa-version-sr" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0">Version</span><select id="oa-version-select" class="oa-version-select" aria-label="Artifact version">${options}</select></label>`;
}

// The badge counts what the drawer's default view shows (open comments), so a
// fully-done thread never renders a count over a "No open comments." list.
function openCommentsCount(comments: CommentMeta[]): number {
  return comments.filter((c) => !c.done).length;
}

function headerHtml(
  favicon: string,
  title: string,
  hostname: string,
  brandUrl?: string | null,
  versions?: VersionMeta[],
  currentVersion?: number,
  url?: string,
  artifactId?: string,
  commentsCount = 0,
): string {
  // The hosted host always names itself "coda0" and links its own root,
  // ignoring BRAND_URL entirely (same override rule as the landing page); a
  // self-hoster's deploy shows the neutral "Open Artifacts" credit only when
  // it opts in by setting BRAND_URL.
  const brand = brandFor(hostname);
  const href = isCoda0Host(hostname) ? "/" : brandUrl;
  const chip = href
    ? `<a class="oa-brand" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Made with ${escapeHtml(brand.name)}">${BRAND_SVG}<span class="oa-brand-text">${escapeHtml(brand.name)}</span></a>`
    : "";
  // The comments toggle is part of the service header. Rendered only when an
  // artifact id is available (the public 404/version pages have none). The
  // count badge reflects the serve-time-inlined thread.
  const comments = artifactId
    ? `<button class="oa-cm-toggle" type="button" aria-label="Open comments" aria-expanded="false" aria-controls="oa-cm-drawer"${commentsCount > 0 ? ` data-count="${commentsCount}"` : ""}><span aria-hidden="true">${COMMENT_SVG}</span><span class="oa-cm-count" aria-hidden="true">${commentsCount}</span></button>`
    : "";
  const picker =
    versions && currentVersion && url
      ? versionPickerHtml(versions, currentVersion, url)
      : "";
  return `<header class="oa-header">
  <span class="oa-header-title"><span class="oa-header-fav">${escapeHtml(favicon)}</span>${escapeHtml(title)}</span>
  ${picker}
  ${chip}
  ${comments}
  <button id="oa-theme-toggle" type="button" aria-label="Toggle theme"></button>
</header>`;
}

// The comments drawer is surrounding-chrome rendered into the same sandboxed
// document as the artifact body. Runtime fetch is impossible under the strict
// viewer CSP (connect-src 'none'), so the thread is inlined at serve time —
// the same pattern the version picker uses. Future viewers see the persisted
// thread on load. Live (no-reload) fan-out is Phase 2 (Durable Object) and
// would require splitting the viewer into an outer host page + sandboxed
// iframe so the outer page can hold a WebSocket without widening the iframe's
// CSP. The iframe may already postMessage out (sandbox allow-scripts); a
// future live channel would bridge through here.
function commentsDrawerHtml(
  artifactId: string,
  comments: CommentMeta[],
): string {
  const items = comments.length
    ? comments
        .map((c) => {
          const done = c.done ? ' data-done=""' : "";
          const pressed = c.done ? "true" : "false";
          const initial = c.author ? escapeHtml([...c.author][0] ?? "?") : "?";
          const who = c.author
            ? `<span class="oa-cm-author">${escapeHtml(c.author)}</span>`
            : '<span class="oa-cm-anon">anonymous</span>';
          return `<div class="oa-cm-item"${done} data-id="${escapeHtml(c.id)}"><div class="oa-cm-avatar" aria-hidden="true">${initial}</div><div class="oa-cm-stack"><div class="oa-cm-top"><div class="oa-cm-title">${escapeHtml(c.body)}</div><span class="oa-cm-trail"><button class="oa-cm-more" type="button" aria-label="More actions" aria-expanded="false" aria-haspopup="menu" hidden>${MORE_DOTS_SVG}</button><button class="oa-cm-done" type="button" aria-pressed="${pressed}" aria-label="${c.done ? "Mark not done" : "Mark done"}">${DONE_CHECK_SVG}</button></span></div><div class="oa-cm-byline">${who} · <span class="oa-cm-time">${escapeHtml(c.createdAt)}</span></div></div></div>`;
        })
        .join("")
    : '<p class="oa-cm-empty">No comments yet.</p>';
  const count = openCommentsCount(comments);
  return `<aside class="oa-cm-drawer" id="oa-cm-drawer" aria-label="Comments" aria-hidden="true" data-artifact-id="${escapeHtml(artifactId)}">
  <div class="oa-cm-head">
    <h2>Comments<span class="oa-cm-head-count" id="oa-cm-head-count"${count > 0 ? ` data-count="${count}"` : ""}>${count}</span></h2>
    <div class="oa-cm-filter" id="oa-cm-filter">
      <button class="oa-cm-filter-btn" type="button" aria-label="Filter comments" aria-haspopup="menu" aria-expanded="false">${FILTER_SVG}</button>
      <div class="oa-cm-menu oa-cm-filter-menu" role="menu" hidden>
        <button type="button" role="menuitemradio" data-filter="open" aria-checked="true">Open</button>
        <button type="button" role="menuitemradio" data-filter="done" aria-checked="false">Done</button>
        <button type="button" role="menuitemradio" data-filter="all" aria-checked="false">All</button>
      </div>
    </div>
    <button class="oa-cm-close" type="button" aria-label="Close comments" aria-controls="oa-cm-drawer">&times;</button>
  </div>
  <div class="oa-cm-drawer-err" id="oa-cm-drawer-err" role="alert" hidden></div>
  <div class="oa-cm-list" id="oa-cm-list">${items}</div>
</aside>`;
}

const VERSION_SCRIPT = `
(function(){
  var sel=document.getElementById('oa-version-select');
  if(!sel)return;
  sel.addEventListener('change',function(){
    if(sel.value)location.search='?'+sel.value.split('?')[1];
  });
})();
`;

const THEME_SCRIPT = `
(function(){
  var root=document.documentElement,KEY="oa-theme",saved=null;
  try{saved=localStorage.getItem(KEY)}catch(e){}
  if(saved==="light"||saved==="dark"){
    root.setAttribute("data-theme",saved);
  }else{
    var dark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme",dark?"dark":"light");
  }
  var btn=document.getElementById("oa-theme-toggle");
  if(!btn)return;
  function paint(){
    var t=root.getAttribute("data-theme");
    btn.innerHTML=t==="dark"?${JSON.stringify(MOON_SVG)}:${JSON.stringify(SUN_SVG)};
    btn.title="Theme: "+(t||"auto");
    btn.setAttribute("aria-label",t==="dark"?"Switch to light theme":"Switch to dark theme");
  }
  btn.addEventListener("click",function(){
    var t=root.getAttribute("data-theme");
    var next=t==="dark"?"light":"dark";
    root.setAttribute("data-theme",next);
    try{localStorage.setItem(KEY,next)}catch(e){}
    paint();
    // Keep the sandboxed frame on the same theme (pins/highlights use frame tokens).
    if(typeof window.__oaToFrame==="function")window.__oaToFrame({type:"oa:theme",theme:next});
  });
  paint();
})();
`;

const LAYOUT_SCRIPT = `
(function(){
  var h=document.querySelector('.oa-header');
  if(!h)return;
  function measure(){document.documentElement.style.setProperty('--oa-header-h',h.getBoundingClientRect().height+'px')}
  // An authored \`body { padding-top }\` pushes the sticky service header
  // down by that padding (the header is a body child), so it sits below the
  // viewport top instead of pinned to it. The chrome owns the top edge:
  // collapse the body padding-top into a margin-top on the header's first
  // sibling so the header pins at 0 and the body padding still offsets the
  // page content below it. Side and bottom body padding are untouched.
  function pinHeaderToTop(){
    var bodyPadTop=parseFloat(getComputedStyle(document.body).paddingTop)||0;
    if(bodyPadTop>0){
      document.body.style.paddingTop='0px';
      // Preserve the author's intended content offset as margin on the
      // first in-flow sibling after the header.
      var sib=h.nextElementSibling;
      if(sib){var cs=getComputedStyle(sib);var mt=parseFloat(cs.marginTop)||0;sib.style.marginTop=(mt+bodyPadTop)+'px'}
    }
  }
  // Push author-authored sticky elements (e.g. an in-page nav) below the
  // service header so they stick under it instead of being obscured. Run
  // once on load; cheap enough since only sticky elements get touched.
  function offsetSticky(){
    var els=document.body.children;
    for(var i=0;i<els.length;i++){
      var el=els[i];
      if(el===h)continue;
      var stack=[el];
      while(stack.length){
        var node=stack.pop();
        if(node.nodeType!==1)continue;
        var cs=getComputedStyle(node);
        if(cs.position==='sticky'&&(cs.top==='0px'||cs.top==='auto')){
          node.style.top='var(--oa-header-h)';
        }
        var ch=node.children;
        for(var j=0;j<ch.length;j++)stack.push(ch[j]);
      }
    }
  }
  measure();
  if(window.requestIdleCallback){requestIdleCallback(function(){pinHeaderToTop();offsetSticky()},{timeout:500})}
  else{setTimeout(function(){pinHeaderToTop();offsetSticky()},1)}
  if(window.ResizeObserver){new ResizeObserver(measure).observe(h)}
})();
`;

// Positions the embedded artifact frame below the sticky service header
// rather than covering it — the header's actual rendered height is measured
// at runtime into --oa-header-h (LAYOUT_SCRIPT); the CSS default (2.5rem)
// covers first paint. Deliberately NOT `inset:0` (R3): that would place the
// frame's top edge at the viewport top, sliding it under the header instead
// of starting beneath it.
const HOST_FRAME_CSS = `
#oa-frame{position:fixed;top:var(--oa-header-h);inset-inline:0;bottom:0;width:100%;height:calc(100dvh - var(--oa-header-h));border:0}
`;

export interface FrameDocumentOptions {
  format: ArtifactFormat;
  content: string;
  /** Per-request CSP nonce; stamped on every viewer-injected inline <script>
   *  in the frame (THEME_SCRIPT, marked bootstrap, bridge/anchor/text scripts)
   *  and on every user-authored <script> in an HTML artifact body, so the
   *  frame's nonce-only script-src (no 'unsafe-inline') lets them run. */
  nonce: string;
  /** Stamp an explicit <meta http-equiv="Content-Security-Policy"> into the
   *  frame document. Required for the encrypted srcdoc variant (R2): a
   *  `srcdoc` child has no HTTP response of its own to carry a CSP header, so
   *  without this it would inherit no CSP beyond the iframe's sandbox=
   *  attribute. The plain HTTP-served /a/:id/frame route already gets its CSP
   *  from the real response header and omits this. */
  stampCsp?: boolean;
}

// The re-asserted CSP for a srcdoc'd artifact frame (R2). Deliberately fixed
// (no webFonts variant): the meta tag is a belt-and-suspenders backstop, not
// the primary air-gap, so it stays at the strictest baseline. Nonce-only
// script-src (no 'unsafe-inline') — the per-request nonce is stamped on every
// frame inline script and user <script> by frameDocument, and the parent
// unlock-shell CSP carries the same nonce which the srcdoc iframe inherits.
function frameMetaCsp(nonce: string): string {
  return `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'`;
}

// The inner ARTIFACT FRAME document: just the artifact body plus enough head
// to render it (reset/markdown CSS, a theme script so the frame can paint
// itself before the host sends anything). No og/title meta, no header, no
// comments drawer, no LAYOUT_SCRIPT — those are host-page chrome that never
// enters the sandboxed, opaque-origin document.
export function frameDocument(options: FrameDocumentOptions): string {
  const { format, content, nonce, stampCsp } = options;
  const body =
    format === "markdown"
      ? `<main class="oa-md" id="oa-content"></main>
<script nonce="${nonce}">${escapeInlineScript(MARKED_SOURCE)}</script>
<script nonce="${nonce}">
document.getElementById("oa-content").innerHTML=marked.parse(${jsonForInlineScript(content)});
</script>`
      : stampNonceOnUserScripts(content, nonce);
  const cspMeta = stampCsp
    ? `<meta http-equiv="Content-Security-Policy" content="${frameMetaCsp(nonce)}">\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${RESET_CSS}${format === "markdown" ? MARKDOWN_CSS : ""}${FRAME_ANCHOR_CSS}${FRAME_TEXT_CSS}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${THEME_SCRIPT}</script>
<script nonce="${nonce}">${FRAME_BRIDGE_SCRIPT}</script>
<script nonce="${nonce}">${FRAME_ANCHOR_SCRIPT}</script>
<script nonce="${nonce}">${FRAME_TEXT_SCRIPT}</script>
</body>
</html>
`;
}

export interface HostShellOptions {
  title: string;
  description: string;
  favicon: string;
  url: string;
  ogImage: string;
  /** Request hostname; selects the coda0 vs. Open Artifacts identity. */
  hostname: string;
  /** "Powered by Open Artifacts" link URL; omit to hide the brand entry. */
  brandUrl?: string | null;
  /** Artifact id; drives the comment thread drawer and the frame's src. */
  artifactId: string;
  /** Comments inlined at serve time (runtime fetch is impossible under the
   *  strict artifact-frame CSP, so the thread is stamped into the page for
   *  future viewers — the same inlining pattern the version picker uses). */
  comments?: CommentMeta[];
  /** Path (+ query) to the artifact frame sub-route, e.g. "/a/:id/frame" or
   *  "/a/:id/frame?v=2" to mirror a pinned version. */
  frameSrc: string;
  /** Per-request CSP nonce; stamped on every viewer-injected inline script. */
  nonce: string;
  /** All published versions, inlined into the chrome picker at serve time. */
  versions?: VersionMeta[];
  /** Version currently being served; marked selected in the picker. */
  currentVersion?: number;
}

const OG_CARD_W = 1200;
const OG_CARD_H = 630;
const OG_CARD_TYPE = "image/png";

// The brand mark's path, reused from BRAND_SVG so the two never drift.
const OG_BRAND_D = BRAND_SVG.match(/ d="([^"]+)"/)?.[1] ?? "";

const OG_HEAD = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_CARD_W}" height="${OG_CARD_H}" viewBox="0 0 ${OG_CARD_W} ${OG_CARD_H}">
<rect width="${OG_CARD_W}" height="${OG_CARD_H}" fill="#131316"/>`;

// A quiet call-to-action pill in the card's bottom-right — a single-accent
// button so the link preview reads as clickable, balancing the brand footer at
// left. Present on every card (real and fallback).
const OG_CTA = `<rect x="962" y="544" width="158" height="48" rx="24" fill="#6457f0"/>
<text x="1041" y="576" text-anchor="middle" font-size="25" font-family="'Inter SemiBold'" fill="#ffffff" letter-spacing=".3">Open →</text>`;

// Codepoint ranges covered by the embedded faces: Inter (Latin + punctuation)
// and the Noto Sans SC subset (GB2312 hanzi, kana, and CJK/fullwidth
// punctuation). Text outside them (Cyrillic, Hangul, Arabic, emoji, ...) has no
// glyph, so resvg would draw it blank; such artifacts get a text-light branded
// card instead, and their real title/description still reach viewers through
// the og:title/og:description meta tags. The CJK ranges are accepted whole even
// though the subset is GB2312-scoped — a rare ideograph outside it shows one
// missing-glyph box rather than dropping the entire title to the fallback card.
function isRenderable(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const ok =
      cp <= 0x024f ||
      (cp >= 0x2000 && cp <= 0x20bf) ||
      cp === 0x2122 ||
      (cp >= 0x2190 && cp <= 0x2193) ||
      cp === 0x2212 ||
      cp === 0x2215 ||
      (cp >= 0x3000 && cp <= 0x30ff) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      cp === 0xfeff ||
      cp === 0xfffd;
    if (!ok) return false;
  }
  return true;
}

// Centered brand lockup shown when the title can't be drawn with the Latin
// fonts — a clean branded card instead of a blank one.
function fallbackCardSvg(brand: Brand): string {
  return `${OG_HEAD}
<g transform="translate(564 211) scale(3)"><path d="${OG_BRAND_D}" fill="#6457f0"/></g>
<text x="600" y="372" text-anchor="middle" font-size="34" font-family="'Inter SemiBold'" fill="#9a9aa2" letter-spacing="2">${escapeHtml(brand.wordmark)}</text>
${OG_CTA}
</svg>`;
}

// Double-width glyph ranges (CJK ideographs, kana, CJK/fullwidth punctuation)
// drawn by the Noto Sans SC subset. They cost two width units and, unlike
// Latin, may break between any two characters — Chinese carries no spaces.
function isWideCodepoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

// Greedily wrap to a width budget (Latin char = 1 unit, CJK = 2) across at most
// `maxLines`, escaping each line for XML. resvg draws no automatic line breaks,
// so the card lays every line out explicitly. Latin words never split; CJK
// breaks between characters, and author spaces are preserved.
function wrapLines(text: string, budget: number, maxLines: number): string[] {
  interface Unit {
    text: string;
    width: number;
    spaceBefore: boolean;
  }
  const units: Unit[] = [];
  let word = "";
  let pendingSpace = false;
  const flushWord = () => {
    if (!word) return;
    units.push({ text: word, width: word.length, spaceBefore: pendingSpace });
    word = "";
    pendingSpace = false;
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (/\s/.test(ch)) {
      flushWord();
      pendingSpace = true;
    } else if (isWideCodepoint(cp)) {
      flushWord();
      units.push({ text: ch, width: 2, spaceBefore: pendingSpace });
      pendingSpace = false;
    } else {
      word += ch;
    }
  }
  flushWord();

  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const u of units) {
    const gap = line && u.spaceBefore ? 1 : 0;
    if (line && width + gap + u.width > budget) {
      lines.push(line);
      line = u.text;
      width = u.width;
    } else {
      line += (gap ? " " : "") + u.text;
      width += gap + u.width;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines).map(escapeHtml);
}

// A self-contained SVG OG card built from the artifact's title and
// description. Rasterized to PNG by src/og.ts and served at GET /og/:id;
// social crawlers ignore SVG og:image, so the endpoint returns the PNG. The
// card draws with the embedded Inter fonts (resvg has no system fonts) and
// makes no external requests. The emoji favicon is intentionally omitted:
// resvg cannot render color emoji, and it still appears as the page favicon.
export function ogCardSvg(options: {
  title: string;
  description: string;
  hostname: string;
}): string {
  const { title, description, hostname } = options;
  const brand = brandFor(hostname);
  if (!isRenderable(title)) return fallbackCardSvg(brand);
  const titleLines = wrapLines(title, 30, 4);
  const descLines =
    description && isRenderable(description)
      ? wrapLines(description, 62, 3)
      : [];

  let y = 190;
  const titleEls = titleLines
    .map((l) => {
      const el = `<text x="80" y="${y}" font-size="60" font-family="'Inter SemiBold'" fill="#e7e7ea">${l}</text>`;
      y += 74;
      return el;
    })
    .join("\n");

  // Description follows the actual title height, clipped so its last line
  // stays clear of the footer row (brand wordmark and the CTA pill).
  let dy = y + 8;
  const descEls: string[] = [];
  for (const l of descLines) {
    if (dy > 520) break;
    descEls.push(
      `<text x="80" y="${dy}" font-size="30" font-family="'Inter'" fill="#9a9aa2">${l}</text>`,
    );
    dy += 42;
  }

  return `${OG_HEAD}
${titleEls}
${descEls.join("\n")}
<g transform="translate(80 556) scale(1.08)"><path d="${OG_BRAND_D}" fill="#6457f0"/></g>
<text x="116" y="578" font-size="24" font-family="'Inter SemiBold'" fill="#9a9aa2" letter-spacing="1.5">${escapeHtml(brand.wordmark)}</text>
${OG_CTA}
</svg>`;
}

// Stamps the per-request nonce onto every user-authored <script> opening tag in
// an HTML artifact body so it runs under nonce-only script-src (no
// 'unsafe-inline'). The authored content from compose.mjs carries bare
// <script>...</script> and <script src="..."> tags with no nonce; under
// script-src 'self' 'nonce-<x>' a nonceless inline <script> is blocked, so user
// JS would silently stop running. This injects nonce="<nonce>" right after the
// <script token on every opening tag that does not already declare a nonce
// (defense against a future stamping path double-stamping — the browser takes
// the first nonce attribute, but a stray duplicate is still lint noise).
// Closing </script> and the script bodies are untouched. Markdown artifacts
// render via the nonce'd marked.parse bootstrap and carry no user <script>, so
// only HTML format needs this.
//
// The scan is HTML-parser-aware: it tracks the script-data state so a `<script`
// substring that appears INSIDE an already-open inline <script> body (e.g. in a
// JS string literal like `el.innerHTML = "<script>...</script>"`) is NOT
// treated as a start tag — stamping there would inject `nonce="..."` into the
// JS source, breaking the string literal and silently killing all user JS. Only
// <script start tags at the top level (outside any script body) are stamped,
// matching the browser's own script-data-state boundaries.
// Case-insensitive, boundary-anchored script-tag matchers. The lookahead
// (?=[\s>/]|$) ensures we match an actual <script> tag (followed by a space,
// '/', '>', or end-of-string), NOT a tag whose name merely starts with
// "script" (e.g. <scripting>), which the HTML parser would otherwise treat as
// a real <script> element after nonce injection and swallow the rest of the
// page. Case-insensitive so a direct-API submission with <SCRIPT> (bypassing
// the skill compose pipeline, which lowercases) still gets a nonce — the old
// 'unsafe-inline' CSP was case-agnostic. Original case is preserved in output.
const SCRIPT_OPEN_RE = /<script(?=[\s>/]|$)/gi;
const SCRIPT_CLOSE_RE = /<\/script(?=[\s>/]|$)/gi;
const SCRIPT_OPEN_LEN = "<script".length;

function stampNonceOnUserScripts(html: string, nonce: string): string {
  let out = "";
  let i = 0;
  let inScript = false;
  while (i < html.length) {
    if (inScript) {
      // Inside a script body: look for the closing </script> to exit. A
      // <script substring here is script text, not a start tag.
      SCRIPT_CLOSE_RE.lastIndex = i;
      const close = SCRIPT_CLOSE_RE.exec(html);
      if (close === null || close.index === undefined) {
        out += html.slice(i);
        break;
      }
      const start = close.index;
      // Copy through the closing tag's '>'.
      const gt = html.indexOf(">", start);
      const end = gt === -1 ? html.length : gt + 1;
      out += html.slice(i, end);
      i = end;
      inScript = false;
    } else {
      // Outside a script: find the next <script start tag.
      SCRIPT_OPEN_RE.lastIndex = i;
      const open = SCRIPT_OPEN_RE.exec(html);
      if (open === null || open.index === undefined) {
        out += html.slice(i);
        break;
      }
      const start = open.index;
      out += html.slice(i, start);
      // Find the end of this start tag's attributes.
      const gt = html.indexOf(">", start);
      const end = gt === -1 ? html.length : gt + 1;
      const tag = html.slice(start, end);
      const stamped = /\bnonce\s*=/i.test(tag)
        ? tag
        : `${tag.slice(0, SCRIPT_OPEN_LEN)} nonce="${nonce}"${tag.slice(SCRIPT_OPEN_LEN)}`;
      out += stamped;
      i = end;
      // If this start tag had no src (inline script), enter script-data state;
      // a <script src="..."></script> is empty but still bounded by </script>.
      inScript = true;
    }
  }
  return out;
}

// The outer HOST PAGE (GET /a/:id): a normal-origin document holding the
// crawler-facing <head>, the reused header + comments drawer chrome, and an
// <iframe> embedding the sandboxed artifact frame below the header. It never
// renders the artifact body itself — that lives entirely in frameDocument(),
// served (or srcdoc'd) into #oa-frame.
export function hostShell(options: HostShellOptions): string {
  const {
    title,
    description,
    favicon,
    url,
    ogImage,
    hostname,
    brandUrl,
    artifactId,
    frameSrc,
    nonce,
    versions,
    currentVersion,
  } = options;

  const brand = brandFor(hostname);
  const ogDescription = description || title;
  const commentsList = options.comments ?? [];
  const drawer = commentsDrawerHtml(artifactId, commentsList);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(brand.name)} — ${escapeHtml(brand.tagline)}</title>
<meta name="description" content="${escapeHtml(ogDescription)}">
<link rel="icon" href="${faviconDataUri(favicon)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${escapeHtml(brand.name)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(ogDescription)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:type" content="${OG_CARD_TYPE}">
<meta property="og:image:width" content="${OG_CARD_W}">
<meta property="og:image:height" content="${OG_CARD_H}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(ogDescription)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
<style>${RESET_CSS}${COMMENTS_CSS}${HOST_FRAME_CSS}</style>
</head>
<body>
${headerHtml(favicon, title, hostname, brandUrl, versions, currentVersion, url, artifactId, openCommentsCount(commentsList))}
<iframe id="oa-frame" src="${escapeHtml(frameSrc)}" sandbox="allow-scripts allow-modals allow-forms allow-popups" title="${escapeHtml(title)}"></iframe>
${drawer}
${commentsDataScript(commentsList)}
<script nonce="${nonce}">window.__oaViewedVersion=${Number(currentVersion ?? 1)};</script>
<script nonce="${nonce}">${VERSION_SCRIPT}</script>
<script nonce="${nonce}">${THEME_SCRIPT}</script>
<script nonce="${nonce}">${LAYOUT_SCRIPT}</script>
<script nonce="${nonce}">${escapeInlineScript(COMMENTS_SCRIPT)}</script>
<script nonce="${nonce}">${escapeInlineScript(hostBridgeScript(artifactId))}</script>
<script nonce="${nonce}">${escapeInlineScript(HOST_UI_SCRIPT)}</script>
</body>
</html>
`;
}

const COMMENTS_SCRIPT = `
(function(){
  var toggle=document.querySelector('.oa-cm-toggle');
  var drawer=document.getElementById('oa-cm-drawer');
  if(!toggle||!drawer)return;
  var closeBtn=drawer.querySelector('.oa-cm-close');
  function open(){drawer.setAttribute('data-open','');drawer.setAttribute('aria-hidden','false');toggle.setAttribute('aria-expanded','true')}
  function shut(){drawer.removeAttribute('data-open');drawer.setAttribute('aria-hidden','true');toggle.setAttribute('aria-expanded','false')}
  toggle.addEventListener('click',function(){drawer.hasAttribute('data-open')?shut():open()});
  if(closeBtn)closeBtn.addEventListener('click',shut);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&drawer.hasAttribute('data-open'))shut()});
})();
`;

// The host↔frame bridge. The artifact frame is air-gapped (connect-src 'none'),
// so it can never fetch. It does not ask the host to fetch on its behalf either:
// the frame's whole vocabulary is a fixed set of oa:* messages carrying anchors
// and marker events, and every request URL is built by the host from its own
// serve-time id. There is no relay to turn into an open proxy — the frame cannot
// supply a URL, method, host, or comment id used in a path. Messages are
// authenticated by window identity (event.source), not origin, because a
// sandboxed opaque-origin frame reports origin "null".

// Frame side: announce readiness, then apply host commands. The frame never
// initiates network I/O; it only relays anchor intents out and renders what the
// host sends back. Marker rendering (pins/highlights) is attached by the
// canvas/text anchoring layers via window.__oaRenderMarkers; the bridge just
// stores the latest list and calls the hook if present.
const FRAME_BRIDGE_SCRIPT = `
(function(){
  var root=document.documentElement;
  function send(msg){if(window.parent&&window.parent!==window)window.parent.postMessage(msg,"*")}
  window.__oaSend=send;
  window.__oaComments=[];
  window.addEventListener("message",function(e){
    if(e.source!==window.parent)return;
    var msg=e.data;
    if(!msg||typeof msg!=="object")return;
    if(msg.type==="oa:theme"){
      if(msg.theme==="light"||msg.theme==="dark")root.setAttribute("data-theme",msg.theme);
    }else if(msg.type==="oa:config"){
      // Encrypted artifacts reject text anchors server-side (REQ-017); the
      // frame must not offer the selection→Comment chip for them.
      window.__oaEncrypted=!!msg.encrypted;
    }else if(msg.type==="oa:arm"){
      window.__oaArmed=msg.mode||null;
      if(typeof window.__oaOnArm==="function")window.__oaOnArm(window.__oaArmed);
    }else if(msg.type==="oa:comments"){
      window.__oaComments=Array.isArray(msg.list)?msg.list:[];
      window.__oaViewedVersion=typeof msg.viewedVersion==="number"?msg.viewedVersion:1;
      if(typeof window.__oaRenderMarkers==="function")window.__oaRenderMarkers(window.__oaComments);
    }
  });
  // Mode is a runtime property of the artifact content (a canvas has a
  // transformed .oa-plane), so the frame detects it and reports it: the host
  // hides the drawer toggle on a canvas (comments live as pins at their point,
  // Figma-style) and keeps it on a document (comments list in the drawer,
  // Notion-style). The armed comment cursor is canvas-only — on a document the
  // native text caret must stay so a selection can be made.
  var pl=document.querySelector('.oa-plane');
  window.__oaMode=(pl&&getComputedStyle(pl).transform!=='none')?'canvas':'text';
  window.__oaOnArm=function(armed){root.classList.toggle('oa-cm-arming',!!armed&&window.__oaMode==='canvas')};
  send({type:"oa:ready",mode:window.__oaMode});
})();
`;

// Canvas comment pin: a passive freeform child of the transformed plane. The
// plane's own translate/scale pans and zooms it on the GPU for free; the pin's
// own scale(1/k) cancels the zoom so it holds a constant on-screen size (the
// collapsed-note-chip idiom), and translate(-50%,-50%) centres it. Unlike a
// note it counter-scales unconditionally at every zoom (no CHIP_K threshold).
const FRAME_ANCHOR_CSS = `
.oa-cm-pin{position:absolute;left:calc(var(--x,0)*1px);top:calc(var(--y,0)*1px);transform:scale(calc(1/var(--k,1))) translate(-50%,-50%);transform-origin:0 0;z-index:2;width:18px;height:18px;padding:0;border:1.5px solid var(--oa-bg);border-radius:50% 50% 50% 2px;background:var(--oa-accent);cursor:pointer}
.oa-cm-pin:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
/* Comment tool armed (canvas): a Figma-style comment marker replaces the pan
   cursor, its tail as the hotspot so the pin lands where the tip points. */
html.oa-cm-arming,html.oa-cm-arming *{cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='27' height='27' viewBox='-2 -2 28 28'%3E%3Cpath d='M4 18V10a8 8 0 0 1 8-8 8 8 0 0 1 8 8 8 8 0 0 1-8 8H4z' fill='%23fff' stroke='%23fff' stroke-width='6' stroke-linejoin='round'/%3E%3Cpath d='M4 18V10a8 8 0 0 1 8-8 8 8 0 0 1 8 8 8 8 0 0 1-8 8H4z' fill='%23fff' stroke='%23000' stroke-width='1.2' stroke-linejoin='round'/%3E%3C/svg%3E") 6 19,crosshair !important}
`;

// Frame side, canvas mode: capture a click to drop a pin (world coords, read
// once from the plane transform) and render existing point anchors as passive
// plane children. No-op on non-canvas documents (text mode is separate).
const FRAME_ANCHOR_SCRIPT = `
(function(){
  var plane=document.querySelector('.oa-plane');
  if(!plane||getComputedStyle(plane).transform==='none')return;
  // Origin must be the UNtransformed container (.oa-canvas). The plane's own
  // getBoundingClientRect already includes translate(tx,ty), so using it and
  // then subtracting m.e/m.f double-counts pan and drops pins off-click.
  function screenToWorld(cx,cy){
    var origin=plane.parentElement||plane;
    var r=origin.getBoundingClientRect();
    var m=new DOMMatrixReadOnly(getComputedStyle(plane).transform);
    var k=m.a||1;
    return {x:Math.round((cx-r.left-m.e)/k),y:Math.round((cy-r.top-m.f)/k)};
  }
  document.addEventListener('click',function(e){
    if(!window.__oaArmed)return;
    e.stopPropagation();e.preventDefault();
    window.__oaArmed=null;
    var w=screenToWorld(e.clientX,e.clientY);
    if(window.__oaSend)window.__oaSend({type:'oa:anchor:new',anchor:{mode:'point',x:w.x,y:w.y,anchorVersion:window.__oaViewedVersion||1},point:{x:e.clientX,y:e.clientY}});
  },true);
  window.__oaRenderMarkers=function(list){
    var old=plane.querySelectorAll('.oa-cm-pin');
    for(var i=0;i<old.length;i++)old[i].remove();
    var vv=window.__oaViewedVersion||1;
    (list||[]).forEach(function(cm){
      if(cm.done)return;
      if(!cm.anchor||cm.anchor.mode!=='point')return;
      if((cm.anchor.anchorVersion||1)>vv)return;
      var pin=document.createElement('button');
      pin.className='oa-cm-pin';pin.type='button';
      pin.setAttribute('aria-label','Open comment');
      pin.style.setProperty('--x',String(cm.anchor.x));
      pin.style.setProperty('--y',String(cm.anchor.y));
      pin.setAttribute('data-id',cm.id);
      pin.addEventListener('click',function(ev){
        ev.stopPropagation();
        if(window.__oaSend)window.__oaSend({type:'oa:anchor:open',ids:[cm.id],point:{x:ev.clientX,y:ev.clientY}});
      });
      plane.appendChild(pin);
    });
  };
  if(window.__oaComments&&window.__oaComments.length)window.__oaRenderMarkers(window.__oaComments);
})();
`;

// Text-range highlight via the CSS Custom Highlight API — no DOM mutation of
// the untrusted author content. A restrained accent tint reads in both themes.
// Selection bubble (.oa-cm-sel) is the Notion-style "Comment" chip that appears
// after a text selection so the user can start a comment without arming first.
const FRAME_TEXT_CSS = `
::highlight(oa-cm){background-color:color-mix(in oklab,var(--oa-accent),transparent 72%)}
/* font-family is pinned to --oa-font — never inherit the artifact face. */
.oa-cm-sel{position:fixed;z-index:2147483647;display:inline-flex;align-items:center;gap:.35rem;padding:.28rem .55rem .28rem .45rem;border-radius:7px;border:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 8%);background:var(--oa-bg);color:var(--oa-fg);font-family:var(--oa-font);font-size:.78rem;font-weight:600;line-height:1;letter-spacing:-.01em;cursor:pointer;transform:translate(-50%,.4rem);opacity:.98;transition:border-color .12s,background .12s,opacity .12s}
.oa-cm-sel svg{display:block;width:14px;height:14px;flex-shrink:0}
.oa-cm-sel:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-sel:active{transform:translate(-50%,.4rem) translateY(1px)}
@media (hover:hover) and (pointer:fine){.oa-cm-sel:hover{border-color:color-mix(in oklab,var(--oa-border),var(--oa-fg) 28%)}}
`;

// Frame side, normal-page mode: capture a text selection into a quote selector
// (posted to the host) and highlight existing text anchors, re-resolved against
// the live document text. No-op on canvas documents (pins handle those). The
// pure matcher is injected verbatim from src/anchor.ts so tests pin its
// behaviour to the exact code that runs here.
//
// Notion-style selection UX: any non-empty text selection shows a floating
// "Comment" chip at the selection. Clicking it posts oa:anchor:new so the host
// opens compose. Armed mode still skips the chip and opens compose immediately.
const FRAME_TEXT_SCRIPT = `
(function(){
  if(document.querySelector('.oa-plane'))return;
  // esbuild's keepNames wraps named inner functions in __name(); that helper
  // lives in the worker bundle, not this sandboxed frame, so the injected
  // matcher sources below reference it. A passthrough shim makes them run here.
  var __name=function(f){return f};
  var buildTextAnchor=${buildTextAnchor.toString()};
  var reAnchor=${reAnchor.toString()};
  var SEL_ICON=${jsonForInlineScript(COMMENT_SVG)};
  // Walk only rendered text — skip SCRIPT/STYLE so injected code never counts
  // toward offsets. All three walkers share this filter so offsets are consistent.
  function walker(){
    return document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
      var p=n.parentNode;
      return p&&(p.nodeName==='SCRIPT'||p.nodeName==='STYLE')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;
    }});
  }
  function fullText(){
    var w=walker();var s="",n;while((n=w.nextNode()))s+=n.textContent;return s;
  }
  function offsetOf(node,off){
    // Element containers (e.g. selection starts at a <p>): map to the first/last
    // text offset inside that subtree so multi-element ranges still work.
    if(node.nodeType!==3){
      var w=walker(),total=0,n,inside=false,acc=0;
      while((n=w.nextNode())){
        var p=n;var hit=false;
        while(p){if(p===node){hit=true;break}p=p.parentNode}
        if(hit){
          if(!inside){inside=true;if(off===0)return total}
          acc+=n.textContent.length;
          if(off>0&&acc>=off)return total+n.textContent.length-(acc-off);
        }else if(inside){
          return total;
        }
        total+=n.textContent.length;
      }
      return total;
    }
    var w2=walker();var total2=0,n2;while((n2=w2.nextNode())){if(n2===node)return total2+off;total2+=n2.textContent.length;}
    return total2;
  }
  function rangeOf(start,end){
    var w=walker();
    var pos=0,n,range=document.createRange(),startSet=false;
    while((n=w.nextNode())){
      var len=n.textContent.length;
      if(!startSet&&pos+len>=start){range.setStart(n,start-pos);startSet=true;}
      if(startSet&&pos+len>=end){range.setEnd(n,end-pos);return range;}
      pos+=len;
    }
    return startSet?range:null;
  }
  var bubble=null;
  function hideBubble(){if(bubble){bubble.remove();bubble=null}}
  function postNew(anchor,point){
    hideBubble();
    if(window.__oaSend)window.__oaSend({type:'oa:anchor:new',anchor:anchor,point:point});
  }
  function showBubble(rect,anchor,point){
    hideBubble();
    bubble=document.createElement('button');
    bubble.type='button';bubble.className='oa-cm-sel';
    bubble.setAttribute('aria-label','Comment on selection');
    bubble.innerHTML=SEL_ICON+'<span>Comment</span>';
    var x=rect.left+rect.width/2,y=rect.bottom;
    // Keep the chip inside the frame viewport.
    x=Math.max(48,Math.min(x,window.innerWidth-48));
    y=Math.max(0,Math.min(y,window.innerHeight-40));
    bubble.style.left=x+'px';bubble.style.top=y+'px';
    // mousedown preventDefault keeps the selection from collapsing before click.
    bubble.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation()});
    bubble.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      postNew(anchor,point);
      var s=window.getSelection();if(s)s.removeAllRanges();
    });
    document.documentElement.appendChild(bubble);
  }
  function captureSelection(){
    // Encrypted frames: text anchors are rejected server-side — no chip, no post.
    if(window.__oaEncrypted){hideBubble();return}
    var sel=window.getSelection();
    if(!sel||sel.isCollapsed||sel.rangeCount===0){hideBubble();return}
    var r=sel.getRangeAt(0);
    var start=offsetOf(r.startContainer,r.startOffset);
    var end=offsetOf(r.endContainer,r.endOffset);
    if(end<=start){hideBubble();return}
    // Ignore pure-whitespace selections (accidental double-clicks on gaps).
    if(!fullText().slice(start,end).trim()){hideBubble();return}
    var anchor=buildTextAnchor(fullText(),start,end,window.__oaViewedVersion||1);
    var rect=r.getBoundingClientRect();
    var point={x:rect.left+rect.width/2,y:rect.bottom};
    if(window.__oaArmed){
      window.__oaArmed=null;
      if(typeof window.__oaOnArm==='function')window.__oaOnArm(null);
      postNew(anchor,point);
      return;
    }
    showBubble(rect,anchor,point);
  }
  document.addEventListener('mouseup',function(e){
    // Don't re-open the bubble when the user is clicking it.
    if(bubble&&bubble.contains(e.target))return;
    // Defer so the browser finishes updating the selection after mouseup.
    setTimeout(captureSelection,0);
  });
  document.addEventListener('selectionchange',function(){
    var sel=window.getSelection();
    if(!sel||sel.isCollapsed)hideBubble();
  });
  document.addEventListener('scroll',hideBubble,true);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')hideBubble()});
  window.__oaRenderMarkers=function(list){
    if(!window.CSS||!CSS.highlights||typeof Highlight==='undefined')return;
    var run=function(){
      var text=fullText(),vv=window.__oaViewedVersion||1,hl=new Highlight(),orphans=[];
      (list||[]).forEach(function(cm){
        if(cm.done)return;
        if(!cm.anchor||cm.anchor.mode!=='text')return;
        if((cm.anchor.anchorVersion||1)>vv)return;
        var m=reAnchor(text,cm.anchor);
        if(m==='orphan'){orphans.push(cm.id);return;}
        var range=rangeOf(m.start,m.end);
        if(range)hl.add(range);
      });
      CSS.highlights.set('oa-cm',hl);
      if(window.__oaSend)window.__oaSend({type:'oa:orphans',ids:orphans});
    };
    if(window.requestIdleCallback)requestIdleCallback(run,{timeout:500});else run();
  };
  if(window.__oaComments&&window.__oaComments.length)window.__oaRenderMarkers(window.__oaComments);
})();
`;

// Host side: the privileged endpoint. Guards every message by window identity,
// switches over a fixed allowlist, and only ever sends the frame non-sensitive
// data (theme + a public comment list; never delete tokens). anchor:new and
// anchor:open are handled by the compose/drawer layers, which register hooks.
function hostBridgeScript(artifactId: string): string {
  return `
(function(){
  var frame=document.getElementById("oa-frame");
  if(!frame)return;
  var ID=${jsonForInlineScript(artifactId)};
  window.__oaBridgeId=ID;
  function post(msg){if(frame.contentWindow)frame.contentWindow.postMessage(msg,"*")}
  window.__oaToFrame=post;
  function theme(){return document.documentElement.getAttribute("data-theme")||"light"}
  function inlined(){
    var el=document.getElementById("oa-cm-data");
    if(!el)return[];
    try{return JSON.parse(el.textContent||"[]")}catch(e){return[]}
  }
  window.__oaInlinedComments=inlined;
  window.addEventListener("message",function(e){
    if(e.source!==frame.contentWindow)return;
    var msg=e.data;
    if(!msg||typeof msg!=="object")return;
    if(msg.type==="oa:ready"){
      // Canvas: comments are pins, so the pin tool appears — but the drawer
      // stays as the way to read the whole thread (a pin off-screen or on a
      // done comment is otherwise unreachable). Document: comments are
      // text-selection chips, so the pin tool goes away. Encrypted unlock
      // shells keep the tool as the unanchored compose entry (text anchors are
      // rejected server-side).
      window.__oaMode=msg.mode==="canvas"?"canvas":"text";
      var tool=document.querySelector(".oa-cm-tool");
      var unlock=document.querySelector(".oa-unlock");
      if(window.__oaMode==="canvas"){
        if(tool)tool.style.display="";
      }else{
        if(tool&&!unlock)tool.style.display="none";
      }
      // Unlock shells keep .oa-unlock in the DOM; tell the frame so text-anchor
      // capture stays off (REQ-017 — encrypted interactive comments are unanchored).
      post({type:"oa:config",encrypted:!!unlock});
      post({type:"oa:theme",theme:theme()});
      post({type:"oa:comments",list:(window.__oaLiveComments?window.__oaLiveComments():inlined()),viewedVersion:window.__oaViewedVersion||1});
    }else if(msg.type==="oa:anchor:new"){
      if(typeof window.__oaOnAnchorNew==="function")window.__oaOnAnchorNew(msg);
    }else if(msg.type==="oa:anchor:open"){
      if(typeof window.__oaOnAnchorOpen==="function")window.__oaOnAnchorOpen(msg);
    }else if(msg.type==="oa:orphans"){
      if(typeof window.__oaOnOrphans==="function")window.__oaOnOrphans(msg);
    }
  });
})();
`;
}

// The serve-time-inlined public comment list, embedded as JSON for the host
// bridge to forward into the frame (marker rendering happens frame-side). Only
// public fields cross — never the delete-token hash.
function commentsDataScript(comments: CommentMeta[]): string {
  const publicList = comments.map((cm) => ({
    id: cm.id,
    author: cm.author,
    body: cm.body,
    anchor: cm.anchor,
    done: cm.done,
    createdAt: cm.createdAt,
  }));
  return `<script type="application/json" id="oa-cm-data">${jsonForInlineScript(
    publicList,
  )}</script>`;
}

// Host-side interactive UI (tasks 009+010): the "add comment" tool that arms
// the frame, the compose popover positioned at the frame-reported point, the
// create/delete network calls (the host is the only party that fetches), local
// identity + delete-token storage, and drawer rendering. All comment fields are
// rendered with textContent (never innerHTML) — author/body/quote are untrusted.
const HOST_UI_SCRIPT = `
(function(){
  var frame=document.getElementById("oa-frame");
  var header=document.querySelector(".oa-header");
  var drawer=document.getElementById("oa-cm-drawer");
  var list=document.getElementById("oa-cm-list");
  var toggle=document.querySelector(".oa-cm-toggle");
  var filterBar=document.getElementById("oa-cm-filter");
  var ID=window.__oaBridgeId;
  if(!frame||!ID)return;
  var drawerErrEl=document.getElementById("oa-cm-drawer-err");
  var drawerErrTimer=null;
  function drawerErr(msg){
    if(!drawerErrEl)return;
    drawerErrEl.textContent=msg;drawerErrEl.removeAttribute("hidden");
    if(drawerErrTimer)clearTimeout(drawerErrTimer);
    drawerErrTimer=setTimeout(function(){drawerErrEl.setAttribute("hidden","")},5000);
  }
  function headerH(){return header?Math.round(header.getBoundingClientRect().height):40}
  function getName(){try{return localStorage.getItem("oa-cm-name")||""}catch(e){return""}}
  function setName(v){try{localStorage.setItem("oa-cm-name",v)}catch(e){}}
  function saveToken(id,t){try{localStorage.setItem("oa-cm-dt-"+id,t)}catch(e){}}
  function getToken(id){try{return localStorage.getItem("oa-cm-dt-"+id)}catch(e){return null}}
  function dropToken(id){try{localStorage.removeItem("oa-cm-dt-"+id)}catch(e){}}
  // Owner moderation: /a/:id?wt=<artifact write token> grants delete on every
  // comment (the server already accepts the write token on DELETE). The token is
  // moved straight into storage and stripped from the URL so it stays out of
  // history, and it never crosses into the frame.
  function ownerToken(){try{return localStorage.getItem("oa-cm-wt-"+ID)}catch(e){return null}}
  (function(){try{
    var u=new URL(location.href),wt=u.searchParams.get("wt");
    if(!wt)return;
    try{localStorage.setItem("oa-cm-wt-"+ID,wt)}catch(e){}
    u.searchParams.delete("wt");
    history.replaceState(null,"",u.pathname+(u.search||"")+u.hash);
  }catch(e){}})();
  function deleteTokenFor(id){return getToken(id)||ownerToken()}

  var state=(window.__oaInlinedComments?window.__oaInlinedComments():[])||[];
  // The bridge answers oa:ready from here rather than re-reading the serve-time
  // seed: on the encrypted path the frame only exists after decrypt, so the
  // thread may already have changed by the time it announces itself.
  window.__oaLiveComments=function(){return state};
  var orphans={};
  // Done comments drop out of the default "Open" view; the filter is how they
  // come back. Markers in the frame follow the same rule (a done thread is
  // resolved, so its pin/highlight goes quiet).
  var filter="open";
  // Unlock shells keep .oa-unlock in the DOM (hidden after decrypt). Encrypted
  // artifacts only allow unanchored interactive comments (text anchors rejected).
  var encrypted=!!document.querySelector(".oa-unlock");

  var arm=document.createElement("button");
  arm.type="button";arm.className="oa-cm-tool";arm.innerHTML=${jsonForInlineScript(COMMENT_ADD_SVG)};
  arm.setAttribute("aria-pressed","false");arm.title="Add a comment";arm.setAttribute("aria-label","Add a comment");
  // Pin tool is canvas-only. Hide until oa:ready reports canvas; encrypted
  // unlock shells keep it visible as the unanchored compose entry.
  if(!encrypted)arm.style.display="none";
  if(header&&toggle)header.insertBefore(arm,toggle);else if(header)header.appendChild(arm);
  function setArmed(on){
    arm.setAttribute("aria-pressed",on?"true":"false");
    if(window.__oaToFrame)window.__oaToFrame({type:"oa:arm",mode:on?"on":null});
  }
  arm.addEventListener("click",function(e){
    // Encrypted: unanchored compose only. Canvas: arm for pin drop.
    if(encrypted){openCompose(null,{x:window.innerWidth/2,y:headerH()+48});return}
    setArmed(arm.getAttribute("aria-pressed")!=="true");
  });

  var pop=document.createElement("div");
  pop.className="oa-cm-compose";pop.id="oa-cm-compose";pop.setAttribute("hidden","");
  var nameEl=document.createElement("input");nameEl.type="text";nameEl.className="oa-cm-name";nameEl.placeholder="Your name (optional)";nameEl.setAttribute("aria-label","Your name");nameEl.setAttribute("hidden","");
  var row=document.createElement("div");row.className="oa-cm-row";
  var bodyEl=document.createElement("textarea");bodyEl.className="oa-cm-body";bodyEl.rows=1;bodyEl.placeholder="Add a comment";bodyEl.setAttribute("aria-label","Comment");
  var sendBtn=document.createElement("button");sendBtn.type="button";sendBtn.className="oa-cm-send";sendBtn.setAttribute("aria-label","Post comment");sendBtn.innerHTML=${jsonForInlineScript(SEND_ARROW_SVG)};
  row.appendChild(bodyEl);row.appendChild(sendBtn);
  var errEl=document.createElement("div");errEl.className="oa-cm-err";errEl.setAttribute("role","alert");errEl.setAttribute("hidden","");
  pop.appendChild(nameEl);pop.appendChild(row);pop.appendChild(errEl);
  document.body.appendChild(pop);

  var pending=null,posting=false,lastPost=0;
  function autosize(){bodyEl.style.height="auto";bodyEl.style.height=Math.min(bodyEl.scrollHeight,128)+"px"}
  function refreshSend(){if(bodyEl.value.trim())sendBtn.setAttribute("data-ready","");else sendBtn.removeAttribute("data-ready")}
  function clearErr(){errEl.textContent="";errEl.setAttribute("hidden","")}
  function closePop(){pop.setAttribute("hidden","");pending=null;bodyEl.value="";clearErr();autosize();refreshSend()}
  function openCompose(anchor,point){
    pending=anchor||null;setArmed(false);clearErr();
    var saved=getName();
    if(saved){nameEl.value=saved;nameEl.setAttribute("hidden","")}else{nameEl.value="";nameEl.removeAttribute("hidden")}
    bodyEl.value="";refreshSend();
    var px=(point&&point.x)||16,py=((point&&point.y)||16)+headerH();
    pop.style.left=Math.max(8,Math.min(px,window.innerWidth-360))+"px";
    pop.style.top=Math.max(8,Math.min(py,window.innerHeight-120))+"px";
    pop.removeAttribute("hidden");autosize();bodyEl.focus();
  }
  bodyEl.addEventListener("input",function(){autosize();refreshSend();clearErr()});
  bodyEl.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();submit()}});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!pop.hasAttribute("hidden"))closePop()});
  document.addEventListener("mousedown",function(e){if(pop.hasAttribute("hidden"))return;if(pop.contains(e.target)||arm===e.target||arm.contains(e.target))return;closePop()});
  window.__oaOnAnchorNew=function(msg){
    var a=msg&&msg.anchor||null;
    // Defense in depth: never open compose with a text anchor on encrypted.
    if(encrypted&&a&&a.mode==="text")a=null;
    openCompose(a,msg&&msg.point);
  };
  sendBtn.addEventListener("click",submit);
  function submit(){
    var body=bodyEl.value.trim();if(!body||posting)return;
    // Key-repeat guard, not a security control — the server's token bucket is
    // authoritative. Stops a held Enter from spending the real budget on
    // duplicates, which would then lock the thread out for everyone on this IP.
    if(Date.now()-lastPost<1500)return;
    var author=nameEl.value.trim();if(author)setName(author);
    posting=true;lastPost=Date.now();clearErr();
    fetch("/api/artifacts/"+ID+"/comments",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({body:body,author:author||null,anchor:pending,anchorVersion:(pending&&pending.anchorVersion)||1})})
      .then(function(r){return r.ok?r.json():Promise.reject(r.status)})
      .then(function(cm){if(cm.deleteToken)saveToken(cm.id,cm.deleteToken);
        state.push({id:cm.id,author:cm.author,body:cm.body,anchor:cm.anchor,done:!!cm.done,createdAt:cm.createdAt});
        sync();closePop();
      }).catch(function(err){
        // 429 is the rate limit, and it is the one failure here a viewer can
        // actually act on — say so plainly instead of showing them a number.
        errEl.textContent=err===429?"Too many comments just now. Try again in a moment.":
          typeof err==="number"?"Could not post ("+err+")":"Could not post";
        errEl.removeAttribute("hidden");
      }).then(function(){posting=false});
  }

  // Counts the default (open) view, not the whole thread: a fully-done thread
  // otherwise shows a badge of "3" over a drawer reading "No open comments."
  function bumpCount(){
    var n=state.filter(function(c){return !c.done}).length;
    if(toggle){
      if(n>0){toggle.setAttribute("data-count",String(n));var c=toggle.querySelector(".oa-cm-count");if(c)c.textContent=String(n)}
      else{toggle.removeAttribute("data-count");var c2=toggle.querySelector(".oa-cm-count");if(c2)c2.textContent="0"}
    }
    var hc=document.getElementById("oa-cm-head-count");
    if(hc){if(n>0){hc.setAttribute("data-count",String(n));hc.textContent=String(n)}else{hc.removeAttribute("data-count");hc.textContent="0"}}
  }
  function relTime(iso){
    var t=Date.parse(iso);if(isNaN(t))return"";
    var s=Math.max(0,(Date.now()-t)/1e3);
    if(s<45)return"just now";
    var m=Math.round(s/60);if(m<60)return m===1?"1 minute ago":m+" minutes ago";
    var h=Math.round(m/60);if(h<24)return h===1?"1 hour ago":h+" hours ago";
    var d=Math.round(h/24);if(d<7)return d===1?"1 day ago":d+" days ago";
    return new Date(t).toLocaleDateString(undefined,{month:"short",day:"numeric"});
  }
  function initialOf(name){
    if(!name)return"?";
    var ch=[...name.trim()][0];
    return ch?ch.toUpperCase():"?";
  }
  // Scoped to the drawer, not the list: the filter dropdown lives in the head
  // and must close alongside the per-comment menus.
  function closeMenus(except){
    if(!drawer)return;
    var menus=drawer.querySelectorAll(".oa-cm-menu");
    for(var i=0;i<menus.length;i++){
      if(menus[i]===except)continue;
      menus[i].setAttribute("hidden","");
      var btn=menus[i].parentElement&&menus[i].parentElement.querySelector('[aria-haspopup="menu"]');
      if(btn)btn.setAttribute("aria-expanded","false");
    }
  }
  function toggleMenu(btn,menu){
    var open=menu.hasAttribute("hidden");
    closeMenus(menu);
    if(open){menu.removeAttribute("hidden");btn.setAttribute("aria-expanded","true")}
    else{menu.setAttribute("hidden","");btn.setAttribute("aria-expanded","false")}
  }
  function itemEl(cm){
    var item=document.createElement("div");item.className="oa-cm-item";item.setAttribute("data-id",cm.id);
    if(cm.done)item.setAttribute("data-done","");
    var avatar=document.createElement("div");avatar.className="oa-cm-avatar";avatar.setAttribute("aria-hidden","true");
    avatar.textContent=initialOf(cm.author);
    var stack=document.createElement("div");stack.className="oa-cm-stack";
    var top=document.createElement("div");top.className="oa-cm-top";
    var title=document.createElement("div");title.className="oa-cm-title";title.textContent=cm.body;
    var trail=document.createElement("span");trail.className="oa-cm-trail";
    var actions=document.createElement("div");actions.className="oa-cm-actions";
    var more=document.createElement("button");more.type="button";more.className="oa-cm-more";
    more.setAttribute("aria-label","More actions");more.setAttribute("aria-expanded","false");more.setAttribute("aria-haspopup","menu");
    more.innerHTML=${jsonForInlineScript(MORE_DOTS_SVG)};
    var menu=document.createElement("div");menu.className="oa-cm-menu";menu.setAttribute("role","menu");menu.setAttribute("hidden","");
    // Always-available action, so the more control is never an empty menu on a
    // comment this viewer cannot delete.
    var copy=document.createElement("button");copy.type="button";copy.setAttribute("role","menuitem");copy.textContent="Copy text";
    copy.addEventListener("click",function(e){
      e.stopPropagation();closeMenus();
      try{navigator.clipboard.writeText(cm.body)}catch(err){}
    });
    menu.appendChild(copy);
    if(deleteTokenFor(cm.id)){
      var del=document.createElement("button");del.type="button";del.className="oa-cm-del";del.setAttribute("role","menuitem");del.textContent="Delete";
      del.addEventListener("click",function(e){e.stopPropagation();closeMenus();remove(cm.id)});
      menu.appendChild(del);
    }
    more.addEventListener("click",function(e){e.stopPropagation();toggleMenu(more,menu)});
    actions.appendChild(more);actions.appendChild(menu);trail.appendChild(actions);
    var doneBtn=document.createElement("button");
    doneBtn.type="button";doneBtn.className="oa-cm-done";
    doneBtn.setAttribute("aria-pressed",cm.done?"true":"false");
    doneBtn.setAttribute("aria-label",cm.done?"Mark not done":"Mark done");
    doneBtn.innerHTML=${jsonForInlineScript(DONE_CHECK_SVG)};
    doneBtn.addEventListener("click",function(e){e.stopPropagation();toggleDone(cm.id)});
    // Always offered: the server is the authority on who may resolve, and a
    // refused toggle rolls back and says why rather than being pre-disabled.
    trail.appendChild(doneBtn);
    top.appendChild(title);top.appendChild(trail);
    var byline=document.createElement("div");byline.className="oa-cm-byline";
    var who=document.createElement("span");
    if(cm.author){who.className="oa-cm-author";who.textContent=cm.author}else{who.className="oa-cm-anon";who.textContent="anonymous"}
    byline.appendChild(who);
    byline.appendChild(document.createTextNode(" \\u00b7 "));
    var time=document.createElement("span");time.className="oa-cm-time";time.textContent=relTime(cm.createdAt);time.title=cm.createdAt||"";
    byline.appendChild(time);
    if(cm.anchor){
      var vv=window.__oaViewedVersion||1,av=cm.anchor.anchorVersion||1;
      if(av!==vv){byline.appendChild(document.createTextNode(" "));var tag=document.createElement("span");tag.className="oa-cm-tag";tag.textContent="v"+av;byline.appendChild(tag)}
      if(orphans[cm.id]){byline.appendChild(document.createTextNode(" "));var det=document.createElement("span");det.className="oa-cm-detached";det.textContent="detached";byline.appendChild(det)}
    }
    stack.appendChild(top);stack.appendChild(byline);
    item.appendChild(avatar);item.appendChild(stack);
    return item;
  }
  function visible(){
    if(filter==="done")return state.filter(function(c){return !!c.done});
    if(filter==="all")return state.slice();
    return state.filter(function(c){return !c.done});
  }
  function renderList(){if(!list)return;list.textContent="";
    var rows=visible();
    if(!rows.length){
      var p=document.createElement("p");p.className="oa-cm-empty";
      p.textContent=!state.length?"No comments yet.":(filter==="done"?"No done comments.":"No open comments.");
      list.appendChild(p);return;
    }
    rows.forEach(function(cm){list.appendChild(itemEl(cm))});
  }
  if(filterBar){
    var filterBtn=filterBar.querySelector(".oa-cm-filter-btn");
    var filterMenu=filterBar.querySelector(".oa-cm-filter-menu");
    filterBtn.addEventListener("click",function(e){e.stopPropagation();toggleMenu(filterBtn,filterMenu)});
    filterMenu.addEventListener("click",function(e){
      var b=e.target&&e.target.closest?e.target.closest("[data-filter]"):null;
      if(!b||!filterMenu.contains(b))return;
      e.stopPropagation();
      filter=b.getAttribute("data-filter")||"open";
      var opts=filterMenu.querySelectorAll("[data-filter]");
      for(var i=0;i<opts.length;i++)opts[i].setAttribute("aria-checked",opts[i]===b?"true":"false");
      closeMenus();renderList();
    });
  }
  function toFrame(){if(window.__oaToFrame)window.__oaToFrame({type:"oa:comments",list:state,viewedVersion:window.__oaViewedVersion||1})}
  function sync(){renderList();bumpCount();toFrame()}
  // Resolving hides a comment from the default view, so the server gates it like
  // delete: the comment's own token, or the owner's write token. The control is
  // always live — we attempt, and roll back with a reason if refused.
  function toggleDone(id){
    var cm=null;for(var i=0;i<state.length;i++){if(state[i].id===id){cm=state[i];break}}
    if(!cm)return;
    var tok=deleteTokenFor(id);
    var next=!cm.done;
    // Optimistic UI — roll back on failure.
    cm.done=next;renderList();bumpCount();toFrame();
    var headers={"content-type":"application/json"};
    if(tok)headers.authorization="Bearer "+tok;
    fetch("/api/artifacts/"+ID+"/comments/"+id,{method:"PATCH",headers:headers,body:JSON.stringify({done:next})})
      .then(function(r){if(!r.ok)return Promise.reject(r.status)})
      .catch(function(s){
        cm.done=!next;renderList();bumpCount();toFrame();
        drawerErr(s===401||s===403
          ?"Only the comment's author or the artifact owner can resolve this."
          :"Could not update that comment.");
      });
  }
  function remove(id){var tok=deleteTokenFor(id);if(!tok)return;
    fetch("/api/artifacts/"+ID+"/comments/"+id,{method:"DELETE",headers:{authorization:"Bearer "+tok}})
      .then(function(r){
        if(!r.ok){drawerErr(r.status===401||r.status===403
          ?"Only the comment's author or the artifact owner can delete this."
          :"Could not delete that comment.");return}
        state=state.filter(function(c){return c.id!==id});dropToken(id);sync();
      });
  }
  // Click-away closes any open menu. Triggers and menu interiors are exempt so
  // mousedown does not race the click handler that opens/acts on them.
  document.addEventListener("mousedown",function(e){
    var t=e.target;
    if(t&&t.closest&&(t.closest(".oa-cm-menu")||t.closest('[aria-haspopup="menu"]')))return;
    closeMenus();
  });
  document.addEventListener("keydown",function(e){if(e.key==="Escape")closeMenus()});
  window.__oaOnOrphans=function(msg){
    orphans={};
    (msg&&msg.ids||[]).forEach(function(id){if(typeof id==="string")orphans[id]=true});
    renderList();
  };
  window.__oaOnAnchorOpen=function(msg){
    if(drawer){drawer.setAttribute("data-open","");drawer.setAttribute("aria-hidden","false");if(toggle)toggle.setAttribute("aria-expanded","true")}
    var id=msg&&msg.ids&&msg.ids[0];if(!id||!list||typeof id!=="string")return;
    // Avoid attribute-selector injection from frame-supplied ids: walk children.
    var el=null,kids=list.children;
    for(var i=0;i<kids.length;i++){if(kids[i].getAttribute("data-id")===id){el=kids[i];break}}
    if(el){el.scrollIntoView({block:"center"});el.setAttribute("data-focus","");setTimeout(function(){el.removeAttribute("data-focus")},1600)}
  };

  // Upgrade the server-rendered list so this browser's own comments gain a
  // Delete control (the server can't know which delete tokens we hold), and
  // sync the badge to the filtered view this render actually produced.
  renderList();bumpCount();
})();
`;

const CONTENT_SLOT = "__OA_CONTENT_SLOT__";

const UNLOCK_CSS = `
.oa-unlock{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.25rem}
.oa-card{width:100%;max-width:22rem;border:1px solid var(--oa-border);border-radius:12px;padding:2rem;background:var(--oa-surface)}
.oa-card .oa-emoji{font-size:2rem;line-height:1;margin-bottom:.6rem}
.oa-card h1{font-size:1.1rem;line-height:1.3;margin:0 0 .3rem}
.oa-card p{margin:0 0 1.35rem;color:var(--oa-muted);font-size:.9rem;line-height:1.55}
.oa-label{display:block;margin:0 0 .4rem;color:var(--oa-fg);font-size:.875rem;font-weight:600}
.oa-card input{width:100%;min-height:44px;padding:.6rem .75rem;border:1px solid var(--oa-border);border-radius:8px;background:var(--oa-bg);color:var(--oa-fg);font-size:1rem;transition:border-color .15s,box-shadow .15s}
.oa-card input:focus-visible{outline:none;border-color:var(--oa-accent);box-shadow:var(--oa-focus-ring)}
.oa-card button{width:100%;min-height:44px;margin-top:.8rem;padding:.6rem .75rem;border:none;border-radius:8px;background:var(--oa-fg);color:var(--oa-bg);font-size:1rem;font-weight:600;cursor:pointer;transition:background .15s,box-shadow .15s,opacity .15s}
.oa-card button:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-card button:active:not(:disabled){transform:translateY(1px)}
.oa-card button:disabled{opacity:.6;cursor:wait}
.oa-error{color:var(--oa-danger);font-size:.85rem;font-weight:500;min-height:1.2em;margin-top:.7rem}
@media (hover:hover) and (pointer:fine){.oa-card button:hover:not(:disabled){background:color-mix(in oklab,var(--oa-fg),var(--oa-bg) 14%)}}
#oa-frame{position:fixed;top:var(--oa-header-h);inset-inline:0;bottom:0;width:100%;border:0;display:none}
`;

export interface UnlockShellOptions {
  title: string;
  description: string;
  favicon: string;
  format: ArtifactFormat;
  url: string;
  ogImage: string;
  hostname: string;
  brandUrl?: string | null;
  artifactId: string;
  comments?: CommentMeta[];
  envelope: EncryptionParams & { ciphertext: string };
  /** Per-request CSP nonce; stamped on every viewer-injected inline <script>
   *  in the unlock shell and threaded into the srcdoc'd frame template so the
   *  decrypted user <script> tags the unlock script stamps client-side match
   *  the parent CSP. */
  nonce: string;
  /** All published versions, inlined into the chrome picker at serve time. */
  versions?: VersionMeta[];
  /** Version currently being served; marked selected in the picker. */
  currentVersion?: number;
}

// The unlock page is itself a HOST PAGE (chrome + password form); the server
// never holds plaintext, so it cannot serve /a/:id/frame for an encrypted
// artifact. Instead this builds the same frameDocument() artifact frame as a
// template string, decrypts client-side, splices the plaintext into the
// template, and assigns the result to the frame's `srcdoc` — the encrypted
// delivery path from architecture.md's "Delivery mechanism" table.
export function unlockShell(options: UnlockShellOptions): string {
  const {
    title,
    description,
    favicon,
    format,
    url,
    ogImage,
    hostname,
    brandUrl,
    artifactId,
    comments,
    envelope,
    nonce,
    versions,
    currentVersion,
  } = options;
  // The decrypted document renders inside a sandboxed iframe. The version
  // picker would have no parent origin to navigate, so the inner template is
  // built WITHOUT versions; the picker lives only in the unlock shell's own
  // chrome (the parent page), which can navigate ?v= normally.
  // stampCsp: true — a srcdoc'd document has no HTTP response of its own, so
  // the CSP meta tag is the only thing re-asserting connect-src 'none' (R2)
  // once the plaintext lands inside it. The nonce matches the parent CSP so
  // the unlock script's client-side stamping of decrypted user <script> tags
  // lets them run under the inherited nonce-only script-src.
  const template = frameDocument({
    format,
    content: CONTENT_SLOT,
    nonce,
    stampCsp: true,
  });

  const unlockScript = `
const OA = {
  envelope: ${jsonForInlineScript(envelope)},
  format: ${jsonForInlineScript(format)},
  template: ${jsonForInlineScript(template)},
  slot: ${jsonForInlineScript(CONTENT_SLOT)},
  nonce: ${jsonForInlineScript(nonce)},
};
function fromB64(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})}
function jsonEmbed(s){return JSON.stringify(s).replace(/</g,"\\\\u003c")}
// The srcdoc iframe inherits the parent CSP, which is nonce-only with no
// 'unsafe-inline'. Decrypted HTML artifact content carries bare user script
// tags; stamp the per-request nonce onto every opening one that does not
// already declare one so user JS runs inside the iframe. Mirrors the
// serve-time stampNonceOnUserScripts in wrapDocument. Markdown is rendered by
// the nonce'd marked bootstrap and has no user script.
//
// HTML-parser-aware: track script-data state so a script-start-tag substring
// appearing INSIDE an already-open inline script body (e.g. inside a JS string
// literal) is NOT treated as a start tag — stamping there would inject the
// nonce into the JS source and corrupt it. Only top-level script start tags
// (outside any script body) are stamped.
function stampNonce(html){
  // Case-insensitive + boundary-anchored match for an actual script start tag
  // (followed by space / slash / '>' / end-of-string), NOT a tag whose name
  // merely starts with "script". Case-insensitive so an uppercase tag from a
  // direct API submission still gets a nonce. Original case preserved in
  // output. Uses manual char comparison (no regex) to avoid the template-literal
  // escaping pitfalls of the surrounding unlockScript.
  var LT="<",S="scr"+"ipt",SL="/",TOK=(LT+S).length;
  var low=html.toLowerCase();
  function isTagCh(c){return c===" "||c==="\\t"||c==="\\n"||c==="\\r"||c===">"||c===SL||c==='"'||c==="'"}
  function findTag(from,close){
    var needle=close?(LT+SL+S):(LT+S);
    var nlen=needle.length;
    var j=from;
    for(;;){
      var at=low.indexOf(needle,j);
      if(at===-1)return -1;
      var after=html.charAt(at+nlen);
      if(after===""||isTagCh(after))return at;
      j=at+nlen;
    }
  }
  var out="",i=0,inS=false;
  while(i<html.length){
    if(inS){
      var cl=findTag(i,true);
      if(cl===-1){out+=html.slice(i);break}
      var g=html.indexOf(">",cl);
      var e=g===-1?html.length:g+1;
      out+=html.slice(i,e);i=e;inS=false;
    }else{
      var st=findTag(i,false);
      if(st===-1){out+=html.slice(i);break}
      out+=html.slice(i,st);
      var g2=html.indexOf(">",st);
      var e2=g2===-1?html.length:g2+1;
      var tag=html.slice(st,e2);
      var stamped=/\\bnonce\\s*=/.test(tag)?tag:((LT+S)+' nonce="'+OA.nonce+'"'+tag.slice(TOK));
      out+=stamped;i=e2;inS=true;
    }
  }
  return out;
}
async function decrypt(password){
  const baseKey=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveKey"]);
  const key=await crypto.subtle.deriveKey(
    {name:"PBKDF2",hash:"SHA-256",salt:fromB64(OA.envelope.salt),iterations:OA.envelope.iterations},
    baseKey,{name:"AES-GCM",length:256},false,["decrypt"]);
  const plain=await crypto.subtle.decrypt(
    {name:"AES-GCM",iv:fromB64(OA.envelope.iv)},key,fromB64(OA.envelope.ciphertext));
  return new TextDecoder().decode(plain);
}
const form=document.getElementById("oa-form");
const input=document.getElementById("oa-password");
const button=document.getElementById("oa-submit");
const error=document.getElementById("oa-error");
form.addEventListener("submit",async function(event){
  event.preventDefault();
  error.textContent="";
  button.disabled=true;
  button.textContent="Unlocking\\u2026";
  try{
    const content=await decrypt(input.value);
    const doc=OA.format==="markdown"
      ? OA.template.split(JSON.stringify(OA.slot)).join(jsonEmbed(content))
      : stampNonce(OA.template.split(OA.slot).join(content));
    const frame=document.getElementById("oa-frame");
    frame.srcdoc=doc;
    frame.style.display="block";
    document.querySelector(".oa-unlock").style.display="none";
  }catch(e){
    error.textContent="Password incorrect. Check it and try again.";
    button.disabled=false;
    button.textContent="Unlock";
  }
});
input.focus();
`;

  const brand = brandFor(hostname);
  const ogDescription = description || title;
  const commentsList = comments ?? [];
  const drawer = commentsDrawerHtml(artifactId, commentsList);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(brand.name)} — ${escapeHtml(brand.tagline)}</title>
<meta name="description" content="${escapeHtml(ogDescription)}">
<link rel="icon" href="${faviconDataUri(favicon)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${escapeHtml(brand.name)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(ogDescription)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:type" content="${OG_CARD_TYPE}">
<meta property="og:image:width" content="${OG_CARD_W}">
<meta property="og:image:height" content="${OG_CARD_H}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(ogDescription)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
<style>${RESET_CSS}${UNLOCK_CSS}${COMMENTS_CSS}</style>
</head>
<body>
${headerHtml(favicon, title, hostname, brandUrl, versions, currentVersion, url, artifactId, openCommentsCount(commentsList))}
<div class="oa-unlock">
  <form class="oa-card" id="oa-form">
    <div class="oa-emoji">${escapeHtml(favicon)}</div>
    <h1>${escapeHtml(title)}</h1>
    <p id="oa-help">This artifact is password protected. It is decrypted in your browser (PBKDF2 + AES-GCM); the server never sees the password.</p>
    <label class="oa-label" for="oa-password">Password</label>
    <input id="oa-password" type="password" autocomplete="current-password" aria-describedby="oa-help oa-error" required>
    <button id="oa-submit" type="submit">Unlock</button>
    <div class="oa-error" id="oa-error" role="alert"></div>
  </form>
</div>
<iframe id="oa-frame" sandbox="allow-scripts allow-modals" title="${escapeHtml(title)}"></iframe>
${drawer}
${commentsDataScript(commentsList)}
<script nonce="${nonce}">window.__oaViewedVersion=${Number(currentVersion ?? 1)};</script>
<script nonce="${nonce}">${unlockScript}</script>
<script nonce="${nonce}">${VERSION_SCRIPT}</script>
<script nonce="${nonce}">${THEME_SCRIPT}</script>
<script nonce="${nonce}">${LAYOUT_SCRIPT}</script>
<script nonce="${nonce}">${escapeInlineScript(COMMENTS_SCRIPT)}</script>
<script nonce="${nonce}">${escapeInlineScript(hostBridgeScript(artifactId))}</script>
<script nonce="${nonce}">${escapeInlineScript(HOST_UI_SCRIPT)}</script>
</body>
</html>
`;
}

const STATUS_CSS = `
.oa-status{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.4rem;padding:2rem;text-align:center}
.oa-status .oa-mark{width:38px;height:38px;color:var(--oa-accent);margin-bottom:.75rem}
.oa-status h1{font-size:1.15rem;line-height:1.3;margin:0;color:var(--oa-fg)}
.oa-status p{margin:0;max-width:28rem;color:var(--oa-muted);font-size:.925rem;line-height:1.6}
.oa-status code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em;background:var(--oa-surface);border:1px solid var(--oa-border);border-radius:4px;padding:.05em .3em}
.oa-status a{margin-top:1rem;color:var(--oa-accent);font-size:.875rem;text-decoration:none}
.oa-status a:hover{text-decoration:underline;text-underline-offset:2px}
`;

// Minimal, on-brand page for the states that don't render an artifact
// (missing artifact, invalid ?v=). No header/toggle: the reset's
// prefers-color-scheme default handles the theme without any JS. The "go
// home" link names and links whichever identity this host presents (coda0 on
// the hosted host, Open Artifacts everywhere else), mirroring the header chip.
function statusPage(options: {
  title: string;
  heading: string;
  body: string;
  hostname: string;
}): string {
  const brand = brandFor(options.hostname);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${RESET_CSS}${STATUS_CSS}</style>
</head>
<body>
<div class="oa-status">
<span class="oa-mark">${BRAND_SVG}</span>
<h1>${options.heading}</h1>
<p>${options.body}</p>
<a href="/">Go to ${escapeHtml(brand.name)}</a>
</div>
</body>
</html>
`;
}

export function notFoundPage(hostname: string): string {
  return statusPage({
    title: "Artifact not found",
    heading: "Artifact not found",
    body: "This link does not exist, or the artifact it pointed to was deleted.",
    hostname,
  });
}

export function badVersionPage(hostname: string): string {
  return statusPage({
    title: "Invalid version",
    heading: "Invalid version",
    body: "The <code>?v=</code> parameter must be a positive integer version number.",
    hostname,
  });
}
