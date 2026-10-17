import { buildTextAnchor, reAnchor } from "./anchor";
import type { Visibility } from "./authorizer";
import type {
  ArtifactFormat,
  CommentMeta,
  EncryptionParams,
  HandoffMeta,
  VersionMeta,
} from "./domain";
import { MARKED_SOURCE } from "./generated/marked-source";
import { CLOSE_SVG, HANDOFF_SVG, HANDOFF_SVGS, handoffScript } from "./handoff";
import { HANDOFF_CSS } from "./handoff/styles";
import type { Brand, StatusTheme } from "./home";

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
// OPEN_ARTIFACTS_WEB_FONTS). When enabled, font-src widens to 'self' plus a
// bounded allowlist of font CDNs (Fontshare + Google Fonts, the two that serve
// woff2 over a stable CDN for Awwwards-listed families), and style-src gains
// 'self' plus the Google Fonts CSS host (so the same-origin /fonts/<slug>.css
// shim and Google Fonts @import load). Runtime libraries (mermaid) are
// self-hosted: the vendored bundle is served same-origin from
// /vendor/mermaid.runtime.js (a static asset under public/), so script-src
// stays 'self' + nonce with no external script host. The trade-off is narrow:
// an artifact can pull passive font bytes from the allowlisted CDNs (fonts are
// non-executable, so the allowlist has no code-execution surface). The sandbox
// stays opaque either way — the opt-in never grants allow-same-origin (R1), so
// the air-gap to the host page holds. Default (webFonts=false) keeps font-src
// data:-only, the strict form for a self-hosted deploy.
// fontHosts is the bare CDN host list reused by the opaque-frame path: an
// opaque-origin frame cannot use CSP 'self', so the caller passes the real
// origin (swapped in for 'self') and the CDN hosts are appended verbatim —
// see contentSecurityPolicy.
const WEB_FONT_CSP = {
  fontSrc: "'self' data: cdn.fontshare.com fonts.gstatic.com",
  styleSrc: "'self' 'unsafe-inline' fonts.googleapis.com",
  fontHosts: "data: cdn.fontshare.com fonts.gstatic.com",
};
export function contentSecurityPolicy(options: {
  sandbox: boolean;
  webFonts?: boolean;
  // Absolute origin of the response URL (e.g. https://example.com). A sandboxed
  // document has an opaque origin, so its CSP 'self' matches nothing and the
  // same-origin /fonts/<slug> proxy would be blocked; passing the real origin
  // lets those subresources load as cross-origin-from-opaque. Only the artifact
  // frame passes it — /raw serves non-frame content under 'self'.
  origin?: string;
  // Per-request CSP nonce; stamped on every viewer-injected inline <script>
  // and emitted in script-src so 'unsafe-inline' can be dropped (issue #11).
  nonce: string;
}): string {
  const webFonts = options.webFonts === true;
  // Opaque-origin frames can't use 'self'; the caller passes the real origin.
  // Only the frame does, so /raw (no origin) stays on 'self' as before.
  const selfSrc = options.origin ?? "'self'";
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
    // Never allow-same-origin. A sandboxed artifact frame must keep its opaque
    // origin so it cannot reach the privileged host page's storage across the
    // air-gap (R1), and that holds unconditionally — it is not a per-call
    // choice a future route could forget. Font caching does not need it: fonts
    // load via the CDN allowlist and the origin above, not same-origin access.
    directives.unshift(
      "sandbox allow-scripts allow-modals allow-forms allow-popups",
    );
  }
  return directives.join("; ");
}

export function userContentHeaders(options: {
  sandbox: boolean;
  contentType: string;
  webFonts?: boolean;
  origin?: string;
  nonce: string;
}): Headers {
  return new Headers({
    "content-type": options.contentType,
    "content-security-policy": contentSecurityPolicy({
      sandbox: options.sandbox,
      webFonts: options.webFonts,
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
  // coda0's account chip loads provider-hosted profile pictures. Keep the
  // allowlist limited to the two identity providers that supply those URLs;
  // the artifact frame below remains isolated from all external images.
  const accountAvatarHosts =
    "https://lh3.googleusercontent.com https://avatars.githubusercontent.com";
  return [
    "default-src 'none'",
    // script-src is nonce-only with 'self' (same-origin /vendor/... runtime
    // bundles) — no 'unsafe-inline', no external script host, no
    // 'strict-dynamic' (issue #11). 'wasm-unsafe-eval' lets the handoff webcam's
    // MediaPipe Selfie Segmentation instantiate its WASM module on the host
    // page (compile/run only — no eval of JS strings, no arbitrary code); the
    // sandboxed artifact frame stays without it (its connect-src 'none' blocks
    // the WASM fetch anyway, and it never runs MediaPipe).
    `script-src ${scriptSrcForNonce("'self'", nonce)} 'wasm-unsafe-eval'`,
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${accountAvatarHosts}`,
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

// Minimal reset for the artifact iframe: box-sizing, body defaults, theme
// tokens, and scroll-margin — everything the artifact document needs to read
// --oa-* variables. Excludes the 6 KB of .oa-header/.oa-version/.oa-brand
// styles that only exist in the host shell, never inside the frame.
const FRAME_RESET_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--oa-font);line-height:1.5;background:var(--oa-bg);color:var(--oa-fg)}
img,video,canvas{max-width:100%}
:root{color-scheme:light dark;--oa-font:${OA_FONT};--oa-bg:#ffffff;--oa-fg:#18181b;--oa-muted:#71717a;--oa-border:#e4e4e7;--oa-surface:#f8f8f8;--oa-accent:#6457f0;--oa-accent-on:#ffffff;--oa-danger:#b42318;--oa-focus-ring:0 0 0 2px var(--oa-bg),0 0 0 4px var(--oa-accent)}
@media (prefers-color-scheme: dark){:root{--oa-bg:#131316;--oa-fg:#e7e7ea;--oa-muted:#9a9aa2;--oa-border:#2e2e33;--oa-surface:#1c1c21;--oa-accent:#8d82f5;--oa-accent-on:#16151b;--oa-danger:#ff8f85}}
:root[data-theme="light"]{color-scheme:light;--oa-bg:#ffffff;--oa-fg:#18181b;--oa-muted:#71717a;--oa-border:#e4e4e7;--oa-surface:#f8f8f8;--oa-accent:#6457f0;--oa-accent-on:#ffffff;--oa-danger:#b42318}
:root[data-theme="dark"]{color-scheme:dark;--oa-bg:#131316;--oa-fg:#e7e7ea;--oa-muted:#9a9aa2;--oa-border:#2e2e33;--oa-surface:#1c1c21;--oa-accent:#8d82f5;--oa-accent-on:#16151b;--oa-danger:#ff8f85}
/* The frame carries no service header: the host page owns it and positions
   the iframe below it, so the frame viewport already is the visible area.
   Author CSS that sizes a viewport as calc(100dvh - var(--oa-header-h)) —
   the vendored canvas kit's own rule, and the documented pattern for a
   full-height hero — must therefore subtract nothing here. The host's header
   height used to leak in as this default, which left a header-tall strip
   with no dot lattice at the bottom of every canvas artifact and pulled
   full-height author content short by the same amount. */
:root{--oa-header-h:0px}
/* Anchor jumps clear the sheet's own top inset instead of a header that is
   not in this document. */
[id]{scroll-margin-top:calc(var(--oa-shell-gap, .75rem) + .5rem)}
`;

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
:root{--oa-header-h:calc(2.5rem + 1px)}
[id]{scroll-margin-top:calc(var(--oa-header-h) + .5rem)}
.oa-header{position:sticky;top:0;z-index:2147483646;isolation:isolate;display:flex;align-items:center;gap:.75rem;min-height:2.5rem;padding:.375rem .75rem;background:color-mix(in oklab,var(--oa-bg),transparent 5%);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-bottom:1px solid var(--oa-border);font-family:var(--oa-font);font-size:.8rem}
.oa-header-title-group{display:flex;align-items:center;gap:.6rem;flex:1;min-width:0}
.oa-header .oa-header-title{display:flex;align-items:center;flex:1;min-width:0;font-size:.8rem;font-weight:600;line-height:1.5;letter-spacing:-.01em;margin:0;color:var(--oa-fg);white-space:nowrap}
.oa-header .oa-header-title .oa-header-fav{display:grid;place-items:center;flex-shrink:0;width:1.25rem;height:1.25rem;margin-right:.375rem;font-size:1em;line-height:1}
.oa-header .oa-header-title .oa-header-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.oa-header-overflow{display:flex;align-items:center;min-width:0}
.oa-header-panel{display:flex;align-items:center;gap:.75rem;min-width:0}
.oa-header-control-label,.oa-header-action-label{display:none}
.oa-header #oa-theme-toggle,.oa-header-more{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;background:transparent;color:var(--oa-muted);border-radius:6px;cursor:pointer;transition:color .15s,background .15s;flex-shrink:0}
.oa-header-more{display:none}
.oa-header-more[hidden]{display:none}
.oa-header #oa-theme-toggle::before,.oa-header-more::before{content:"";position:absolute;inset:-6px}
.oa-header #oa-theme-toggle:focus-visible,.oa-header-more:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-header #oa-theme-toggle:active,.oa-header-more:active{transform:translateY(1px)}
.oa-header #oa-theme-toggle svg,.oa-header-more svg{display:block;width:16px;height:16px}
.oa-header-more[aria-expanded="true"]{color:var(--oa-accent);background:color-mix(in oklab,var(--oa-accent),transparent 88%)}
.oa-brand{position:relative;display:inline-flex;align-items:center;gap:.35rem;min-height:28px;text-decoration:none;color:var(--oa-muted);font-size:.75rem;flex-shrink:0;padding:.2rem .5rem;border-radius:6px;background:transparent;transition:color .15s,background .15s}
.oa-brand::before{content:"";position:absolute;inset:-6px 0}
.oa-brand:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-brand:active{transform:translateY(1px)}
.oa-brand svg{display:block;width:14px;height:14px}
@media (hover:hover) and (pointer:fine){.oa-header #oa-theme-toggle:hover,.oa-header-more:hover{color:var(--oa-fg);background:color-mix(in oklab,var(--oa-fg),transparent 90%)}.oa-brand:hover{color:var(--oa-fg);background:color-mix(in oklab,var(--oa-fg),transparent 90%)}}
.oa-version,.oa-visibility{display:inline-flex;align-items:center;flex-shrink:0;min-width:0}
.oa-version .oa-version-select,.oa-visibility .oa-visibility-select{min-height:28px;padding:.2rem 1.6rem .2rem .5rem;border:1px solid var(--oa-border);border-radius:6px;background-color:var(--oa-bg);color:var(--oa-fg);font-size:.75rem;font-family:inherit;line-height:1.4;cursor:pointer;transition:background-color .15s,border-color .15s;-webkit-appearance:none;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--oa-muted) 50%),linear-gradient(135deg,var(--oa-muted) 50%,transparent 50%);background-position:calc(100% - .7rem) 55%,calc(100% - .4rem) 55%;background-size:.3rem .3rem;background-repeat:no-repeat}
/* After the base rule, not before: same selector, same specificity, and a
   media query does not raise it, so source order alone decides. Emitted
   first, the base rule's padding shorthand resets padding-right and silently
   drops the narrow-screen value. */
@media (max-width:30rem){.oa-version .oa-version-select,.oa-visibility .oa-visibility-select{max-width:5rem;padding-right:1.4rem}}
.oa-version .oa-version-select:focus-visible,.oa-visibility .oa-visibility-select:focus-visible{outline:none;border-color:var(--oa-accent);box-shadow:var(--oa-focus-ring)}
@media (hover:hover) and (pointer:fine){.oa-version .oa-version-select:hover,.oa-visibility .oa-visibility-select:hover{background-color:color-mix(in oklab,var(--oa-fg),transparent 92%)}}
.oa-visibility-confirm{padding:.5rem;min-width:14rem;box-shadow:0 4px 12px -2px color-mix(in oklab,var(--oa-fg),transparent 78%)}
.oa-visibility-confirm-text{font-size:.75rem;line-height:1.4;color:var(--oa-fg);margin-bottom:.5rem; padding:0 .25rem}
.oa-visibility-confirm button{display:block;width:100%;text-align:left;padding:.375rem .5rem;border:0;border-radius:4px;background:none;color:var(--oa-fg);font:inherit;font-size:.8rem;cursor:pointer}
.oa-visibility-confirm button:hover{background:color-mix(in oklab,var(--oa-fg),transparent 94%)}
.oa-visibility-confirm button:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-visibility-confirm .oa-cm-del{color:var(--oa-danger)}
@media (max-width:52rem){
.oa-header{gap:.75rem;padding-inline:.75rem}
.oa-header .oa-header-title .oa-header-title-text{display:block;min-width:0}
.oa-header-overflow{position:relative;flex-shrink:0}
.oa-header-more{display:inline-flex}
.oa-header-panel{position:fixed;top:calc(var(--oa-header-h) + .5rem);right:.5rem;display:none;flex-direction:column;align-items:stretch;gap:.125rem;width:min(17rem,calc(100vw - 1rem));max-height:calc(100dvh - var(--oa-header-h) - 1rem);overflow-y:auto;padding:.375rem;border:1px solid var(--oa-border);border-radius:6px;background:var(--oa-bg)}
.oa-header-overflow[data-open] .oa-header-panel{display:flex}
.oa-header-panel .oa-version,.oa-header-panel .oa-visibility{justify-content:space-between;gap:1rem;width:100%;min-height:36px;padding:.25rem .375rem}
.oa-header-panel .oa-version-select,.oa-header-panel .oa-visibility-select{max-width:9rem}
.oa-header-panel .oa-header-control-label,.oa-header-panel .oa-header-action-label{display:inline;color:var(--oa-muted);font-size:.75rem;font-weight:400}
.oa-header-panel .oa-brand{width:100%;min-height:36px;padding:.375rem}
.oa-header-panel [data-oa-header-secondary]{justify-content:flex-start;gap:.5rem;width:100%;height:36px;padding:0 .375rem}
.oa-header-panel .oa-cm-toggle,.oa-header-panel #oa-theme-toggle{justify-content:flex-start;gap:.5rem;width:100%;height:36px;padding:0 .375rem}
.oa-header-panel .oa-account-slot{width:100%;margin:0}
.oa-header-panel .oa-account-btn,.oa-header-panel .oa-account-signin{justify-content:flex-start;width:100%;height:36px;padding-inline:.375rem;border-radius:4px}
.oa-header-panel .oa-account-menu{position:static;width:100%;margin-top:.25rem;padding:.25rem 0 0;border:0;border-top:1px solid var(--oa-border);border-radius:0;box-shadow:none}
}
`;

const TOAST_CSS = `
.oa-toast-container{position:fixed;top:calc(var(--oa-header-h) + 1rem);right:1rem;z-index:2147483647;display:flex;flex-direction:column;gap:.5rem;max-width:min(24rem,calc(100vw - 2rem));pointer-events:none}
.oa-toast{padding:.75rem 1rem;border-radius:8px;background:var(--oa-bg);border:1px solid var(--oa-border);box-shadow:0 4px 16px -4px color-mix(in oklab,var(--oa-fg),transparent 85%);font-family:var(--oa-font);font-size:.85rem;line-height:1.4;color:var(--oa-fg);pointer-events:auto;animation:oa-toast-in .2s ease-out}
.oa-toast[data-type="error"]{border-color:var(--oa-danger);background:color-mix(in oklab,var(--oa-danger),var(--oa-bg) 92%);color:var(--oa-danger)}
.oa-toast[data-type="success"]{border-color:var(--oa-accent);background:color-mix(in oklab,var(--oa-accent),var(--oa-bg) 92%);color:var(--oa-accent)}
.oa-toast[data-removing]{animation:oa-toast-out .2s ease-in forwards}
@keyframes oa-toast-in{from{opacity:0;transform:translateX(100%)}}
@keyframes oa-toast-out{to{opacity:0;transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.oa-toast{animation:none}.oa-toast[data-removing]{opacity:.5}}
.oa-toast-undo{display:flex;align-items:center;justify-content:space-between;gap:.75rem;cursor:pointer;position:relative;overflow:hidden}
.oa-toast-undo-btn{flex-shrink:0;border:0;background:none;color:var(--oa-accent);font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;padding:0;border-radius:4px}
.oa-toast-undo-btn:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-toast-undo-bar{position:absolute;bottom:0;left:0;height:2px;width:100%;background:var(--oa-accent);border-radius:0 0 8px 8px;animation:oa-toast-undo-bar 5s linear forwards}
@keyframes oa-toast-undo-bar{to{width:0%}}
@media (prefers-reduced-motion:reduce){.oa-toast-undo-bar{animation:none;width:100%}}
.oa-shortcut-sheet{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:color-mix(in oklab,var(--oa-fg),transparent 70%);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);font-family:var(--oa-font);outline:none}
.oa-shortcut-sheet[hidden]{display:none}
.oa-shortcut-sheet-inner{max-width:20rem;width:calc(100vw - 2rem);padding:1.25rem 1.5rem;border-radius:8px;background:var(--oa-bg);border:1px solid var(--oa-border);box-shadow:0 8px 32px -4px color-mix(in oklab,var(--oa-fg),transparent 78%)}
.oa-shortcut-sheet-title{margin:0 0 .75rem;font-size:.8rem;font-weight:600;color:var(--oa-fg)}
.oa-shortcut-list{display:grid;grid-template-columns:auto 1fr;gap:.5rem .75rem;margin:0}
.oa-shortcut-list dt{margin:0}
.oa-shortcut-list dd{margin:0;font-size:.8rem;color:var(--oa-fg);display:flex;align-items:center}
.oa-shortcut-list kbd{display:inline-flex;align-items:center;justify-content:center;min-width:1.5rem;height:1.5rem;padding:0 .35rem;border:1px solid var(--oa-border);border-radius:4px;background:var(--oa-surface);color:var(--oa-fg);font-family:var(--oa-font-mono,ui-monospace,monospace);font-size:.72rem;font-weight:600;line-height:1}
.oa-shortcut-list kbd:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
/* Touch: coarse pointers get WCAG-friendly targets for all header ghost
   icon buttons. LAYOUT_SCRIPT measures the header's actual height into
   --oa-header-h, so a 44px toggle just grows the header a little on touch. */
@media (pointer:coarse){
  .oa-header #oa-theme-toggle,.oa-header-more,.oa-header .oa-cm-toggle,.oa-header [aria-keyshortcuts="h"]{width:44px;height:44px}
}
/* Phones (coarse + narrow): restore full-width panel rows at 44px height so
   the coarse-pointer square doesn't collapse the More panel layout. */
@media (pointer:coarse) and (max-width:52rem){
  .oa-header-panel .oa-cm-toggle,.oa-header-panel #oa-theme-toggle,.oa-header-panel [aria-keyshortcuts="h"],.oa-header-panel [data-oa-header-secondary]{width:100%;height:44px}
}
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
.oa-cm-toggle{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;background:transparent;color:var(--oa-muted);border-radius:6px;cursor:pointer;transition:color .15s,background .15s;flex-shrink:0}.oa-cm-toggle[aria-expanded="true"]{color:var(--oa-accent);background:color-mix(in oklab,var(--oa-accent),transparent 88%)}
.oa-cm-toggle::before{content:"";position:absolute;inset:-6px}
.oa-cm-toggle:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-toggle:active{transform:translateY(1px)}
.oa-cm-toggle svg{display:block;width:16px;height:16px}
.oa-cm-toggle .oa-cm-count{position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;padding:0 3px;border-radius:999px;background:var(--oa-accent);color:var(--oa-accent-on);font-size:9px;font-weight:600;line-height:15px;text-align:center;display:none}
.oa-cm-toggle[data-count] .oa-cm-count{display:block}
.oa-cm-drawer{position:fixed;top:var(--oa-header-h);right:0;height:calc(100dvh - var(--oa-header-h));width:100%;max-width:23rem;transform:translateX(100%);transition:transform .18s ease;display:flex;flex-direction:column;background:var(--oa-bg);border-left:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 6%);z-index:2147483645;font-family:var(--oa-font);contain:layout style paint}
.oa-cm-drawer[data-open]{transform:translateX(0)}
@media (prefers-reduced-motion:reduce){.oa-cm-drawer{transition:none}}
/* Right inset matches .oa-header padding (1rem) so the close control lines up
   with the theme toggle above it, and the list card shares the same edge. */
.oa-cm-drawer .oa-cm-head{display:flex;align-items:center;gap:.6rem;min-height:2.75rem;padding:.375rem 1rem;border-bottom:1px solid var(--oa-border);flex-shrink:0}
.oa-cm-drawer .oa-cm-head h2{flex:1;display:flex;align-items:baseline;gap:.4rem;margin:0;font-size:.8rem;font-weight:600;letter-spacing:-.01em;color:var(--oa-fg)}
.oa-cm-drawer .oa-cm-head-count{display:none;padding:.05rem .35rem;border-radius:4px;background:var(--oa-surface);color:var(--oa-fg);font-size:.72rem;font-weight:600;font-variant-numeric:tabular-nums}
.oa-cm-drawer .oa-cm-head-count[data-count]{display:inline-block}
.oa-cm-drawer .oa-cm-close{position:relative;width:28px;height:28px;flex-shrink:0;display:grid;place-items:center;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--oa-muted);font-size:.875rem;line-height:1;cursor:pointer;transition:color .15s,background .15s}
.oa-cm-drawer .oa-cm-close:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-drawer .oa-cm-close:active{transform:translateY(1px)}
@media (hover:hover) and (pointer:fine){.oa-cm-drawer .oa-cm-close:hover{color:var(--oa-fg);background:color-mix(in oklab,var(--oa-fg),transparent 90%)}}
/* Filter — done comments are hidden under "Open" by default, so this dropdown
   is the way back to them. The trigger shares the close button's chrome and
   sits beside it. */
.oa-cm-filter{position:relative;flex-shrink:0;display:flex}
.oa-cm-filter-btn{position:relative;width:28px;height:28px;flex-shrink:0;display:grid;place-items:center;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--oa-muted);cursor:pointer;transition:color .15s,background .15s}
.oa-cm-filter-btn svg{width:14px;height:14px;display:block}
.oa-cm-filter-btn:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-filter-btn:active{transform:translateY(1px)}
@media (hover:hover) and (pointer:fine){.oa-cm-filter-btn:hover{color:var(--oa-fg);background:color-mix(in oklab,var(--oa-fg),transparent 90%)}}
.oa-cm-filter-menu{top:calc(100% + 4px)}
.oa-cm-filter-menu button[aria-checked="true"]{background:var(--oa-surface);color:var(--oa-fg);font-weight:600}
/* Card list — each comment is a rounded surface card (reference UI). */
.oa-cm-list{flex:1;min-height:0;overflow-y:auto;margin:.55rem .75rem .75rem;padding:0;border:0;background:transparent;display:flex;flex-direction:column;gap:.5rem;content-visibility:auto;contain-intrinsic-size:auto 500px}
.oa-cm-empty{color:var(--oa-muted);font-size:.85rem;text-align:center;margin:2rem 1rem}
.oa-cm-item{position:relative;display:flex;gap:.65rem;align-items:flex-start;padding:.7rem .75rem;border-radius:8px;border:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 4%);background:var(--oa-surface);transition:border-color .12s,background .12s}
@media (hover:hover) and (pointer:fine){.oa-cm-item:hover{background:color-mix(in oklab,var(--oa-fg),transparent 94%)}}
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
.oa-cm-menu{position:absolute;top:100%;right:0;z-index:2;min-width:7.5rem;padding:.25rem;border:1px solid var(--oa-border);border-radius:6px;background:var(--oa-bg);box-shadow:0 4px 12px -2px color-mix(in oklab,var(--oa-fg),transparent 78%)}
.oa-cm-menu[hidden]{display:none}
.oa-cm-menu button{display:block;width:100%;text-align:left;padding:.375rem .5rem;border:0;border-radius:4px;background:none;color:var(--oa-fg);font:inherit;font-size:.8rem;cursor:pointer}
.oa-cm-menu button:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
@media (hover:hover) and (pointer:fine){.oa-cm-menu button:hover{background:color-mix(in oklab,var(--oa-fg),transparent 94%)}}
.oa-cm-menu .oa-cm-del{color:var(--oa-danger)}
@media (hover:hover) and (pointer:fine){.oa-header .oa-cm-toggle:hover{color:var(--oa-fg);background:color-mix(in oklab,var(--oa-fg),transparent 90%)}}
@media (max-width:30rem){.oa-cm-drawer{max-width:100%}}
/* Anchored-comment chrome (task 011): the "add comment" tool, the compose
   popover, delete controls, and the focused-thread state. Tokens only, both
   themes, visible focus rings, no decorative motion. */
.oa-cm-tool{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;background:transparent;color:var(--oa-muted);border-radius:6px;cursor:pointer;transition:color .15s,background .15s;flex-shrink:0}
.oa-cm-tool:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-tool svg{display:block;width:16px;height:16px}
.oa-cm-tool[aria-pressed="true"]{color:var(--oa-accent);background:color-mix(in oklab,var(--oa-accent),transparent 88%)}
.oa-cm-tool:active{transform:translateY(1px)}
@media (hover:hover) and (pointer:fine){.oa-cm-tool:hover{color:var(--oa-fg);background:color-mix(in oklab,var(--oa-fg),transparent 90%)}}
/* Compose: a single rounded pill — "Add a comment" + a circular send button
   (muted until there is text, then accent) — floating over the artifact. The
   name is a small quiet pill shown only the first time, before one is saved. */
.oa-cm-compose{position:fixed;z-index:2147483646;width:min(22rem,calc(100vw - 1rem));display:flex;flex-direction:column;gap:.4rem;font-family:var(--oa-font)}
.oa-cm-compose[hidden]{display:none}
.oa-cm-compose ::placeholder{color:var(--oa-muted);opacity:1}
/* The name pill and the input row are the same object at two sizes: identical
   surface, border, and pill radius, no shadow — the border carries the edge. */
.oa-cm-name,.oa-cm-row{background:var(--oa-bg);border:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 6%);border-radius:999px;box-shadow:0 4px 16px -4px color-mix(in oklab,var(--oa-fg),transparent 75%)}
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
// Live editor toggle: a crosshair — the same "pick an element" glyph as
// impeccable-live's global-bar pick toggle, so the affordance reads
// identically. Stroke icon to match the toolbar's other outline controls.
const LIVE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';

// Handoff toggle: a video camera (the record-a-walkthrough affordance), stroke
// to match the toolbar's other outline controls (Live/comments). The record
// action itself uses a filled dot; stop uses a square; play uses a triangle.

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
      // The header is cramped on narrow screens, so each option's visible text
      // is the compact "v<n>" form; the version's own label (if any) is kept as
      // a tooltip via the title attribute so context is not lost.
      const short = `v${v.version}`;
      const title = v.label ? ` title="${escapeHtml(v.label)}"` : "";
      const selected = v.version === currentVersion ? " selected" : "";
      return `<option value="${escapeHtml(target)}"${selected}${title}>${short}</option>`;
    })
    .join("");
  return `<label class="oa-version" for="oa-version-select"><span class="oa-header-control-label" aria-hidden="true">Version</span><select id="oa-version-select" class="oa-version-select" aria-label="Artifact version">${options}</select></label>`;
}

const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: "Private",
  org: "Organization",
  public: "Public",
};

function visibilityPickerHtml(visibility: Visibility): string {
  const options = (["private", "org", "public"] as const)
    .map((value) => {
      const selected = value === visibility ? " selected" : "";
      return `<option value="${value}"${selected}>${VISIBILITY_LABELS[value]}</option>`;
    })
    .join("");
  return `<label class="oa-visibility" for="oa-visibility-select"><span class="oa-header-control-label" aria-hidden="true">Visibility</span><select id="oa-visibility-select" class="oa-visibility-select" aria-label="Artifact visibility">${options}</select></label>`;
}

// The badge counts what the drawer's default view shows (open comments), so a
// fully-done thread never renders a count over a "No open comments." list.
function openCommentsCount(comments: CommentMeta[]): number {
  return comments.filter((c) => !c.done).length;
}

function headerHtml(
  favicon: string,
  title: string,
  brand: Brand,
  branded: boolean,
  brandUrl?: string | null,
  versions?: VersionMeta[],
  currentVersion?: number,
  url?: string,
  artifactId?: string,
  commentsCount = 0,
  canManage = false,
  visibility: Visibility = "public",
  liveEnabled = false,
  handoffEnabled = false,
): string {
  // A primary brand (BRAND_NAME) always names itself and links its own root,
  // ignoring BRAND_URL; a self-hoster without BRAND_NAME shows the neutral
  // "Open Artifacts" credit only when they opt in via BRAND_URL.
  const href = branded ? "/" : brandUrl;
  const chip = href
    ? `<a class="oa-brand" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Made with ${escapeHtml(brand.name)}">${BRAND_SVG}<span class="oa-brand-text">${escapeHtml(brand.name)}</span></a>`
    : "";
  // The comments toggle is part of the service header. Rendered only when an
  // artifact id is available (the public 404/version pages have none). The
  // count badge reflects the serve-time-inlined thread.
  const comments = artifactId
    ? `<button class="oa-cm-toggle" type="button" aria-label="Open comments" aria-expanded="false" aria-controls="oa-cm-drawer" aria-keyshortcuts="c" title="Comments (C)"${commentsCount > 0 ? ` data-count="${commentsCount}"` : ""}><span aria-hidden="true">${COMMENT_SVG}</span><span class="oa-cm-count" aria-hidden="true">${commentsCount}</span><span class="oa-header-action-label">Comments</span></button>`
    : "";
  const theme = `<button id="oa-theme-toggle" type="button" aria-label="Toggle theme" aria-keyshortcuts="t" title="Toggle theme (T)"><span class="oa-header-action-label">Theme</span></button>`;
  const picker =
    versions && currentVersion && url
      ? versionPickerHtml(versions, currentVersion, url)
      : "";
  const share = canManage ? visibilityPickerHtml(visibility) : "";
  // The Live toggle opens the live-edit bar (host chrome, outside the
  // sandbox). Only when the deploy bound a LIVE_DO namespace AND the viewer is
  // an owner (canManage) — live editing mutates the artifact, so it's
  // write-gated server-side too; the button is just hidden for non-owners.
  const live =
    liveEnabled && canManage
      ? `<button class="oa-live-toggle" type="button" data-oa-header-secondary aria-label="Open live editor" aria-expanded="false" aria-controls="oa-live-root" aria-keyshortcuts="l" title="Live editor (L)"><span aria-hidden="true">${LIVE_SVG}</span><span class="oa-header-action-label">Live</span><span class="oa-live-connection" data-live-connection hidden>Connected</span></button>`
      : "";
  // The Handoff toggle opens the record/play dock. Record is owner-only
  // (write-gated server-side); Play is open to any viewer. The button is shown
  // to owners (Record + Play) and to viewers who have a handoff to Play — but
  // since a non-owner can't Record and the only owner-action is Record, hide
  // the toggle entirely for non-owners and surface Play through the inlined
  // handoff list when one exists. Simpler: gate on canManage, and render a
  // Play-only affordance for non-owners when a handoff is inlined.
  const handoff =
    handoffEnabled && canManage
      ? `<button class="oa-handoff-toggle" type="button" data-oa-header-secondary aria-label="Open handoff recording" aria-expanded="false" aria-controls="oa-handoff-root" aria-keyshortcuts="h" title="Handoff recording (H)"><span aria-hidden="true">${HANDOFF_SVG}</span><span class="oa-header-action-label">Handoff</span></button>`
      : "";
  // Keep the service controls together, then place the account slot before
  // branding so the brand stays at the panel's far right edge.
  const secondaryControls = `${picker}${share}${live}${handoff}`;
  const hasPanelControls = `${secondaryControls}${comments}${theme}${chip}`;
  const moreHidden = hasPanelControls ? "" : " hidden";
  // The title leads from the left; the right-side trail keeps handoff before
  // comments and theme, then the account slot and brand at the far edge.
  const header = `<header class="oa-header">
  <div class="oa-header-title-group">
    <span class="oa-header-title" title="${escapeHtml(title)}"><span class="oa-header-fav" aria-hidden="true">${escapeHtml(favicon)}</span><span class="oa-header-title-text">${escapeHtml(title)}</span></span>
  </div>
  <div class="oa-header-overflow">
    <button id="oa-header-more" class="oa-header-more" type="button" aria-label="More artifact controls" aria-expanded="false" aria-controls="oa-header-panel"${moreHidden}>${MORE_DOTS_SVG}</button>
    <div id="oa-header-panel" class="oa-header-panel" role="group" aria-label="Artifact controls">
      ${secondaryControls}
      ${comments}
      ${theme}
      <span id="oa-account-slot" class="oa-account-slot"></span>
      ${chip}
    </div>
  </div>
</header>`;
  return header;
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
    : '<p class="oa-cm-empty">No comments yet. Click on the artifact to leave a comment, or type below.</p>';
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

const TOAST_SCRIPT = `
(function(){
  var container=document.getElementById('oa-toast-container');
  if(!container)return;
  function show(msg,type){
    var el=document.createElement('div');
    el.className='oa-toast';
    el.textContent=msg;
    if(type)el.setAttribute('data-type',type);
    container.appendChild(el);
    setTimeout(function(){
      el.setAttribute('data-removing','');
      setTimeout(function(){el.remove()},200);
    },5000);
  }
  window.__oaShowError=function(msg){show(msg,'error')};
  window.__oaShowSuccess=function(msg){show(msg,'success')};
  window.__oaShowInfo=function(msg){show(msg,'info')};
})();
`;

const VERSION_SCRIPT = `
(function(){
  var sel=document.getElementById('oa-version-select');
  if(!sel)return;
  sel.addEventListener('change',function(){
    if(!sel.value)return;
    try{
      var url=new URL(sel.value,location.origin);
      location.search=url.search;
    }catch(e){
      location.href=sel.value;
    }
  });
})();
`;

const VISIBILITY_SCRIPT = `
(function(){
  var sel=document.getElementById('oa-visibility-select');
  if(!sel)return;
  var id=window.__oaBridgeId;
  if(!id)return;
  var prev=sel.value;
  var pendingNext=null;
  // Confirm popover for public-exposure — reuses the dropdown-menu chrome.
  var confirmPop=null;
  function clearConfirm(){
    if(confirmPop){confirmPop.remove();confirmPop=null}
    document.removeEventListener('mousedown',outsideClick,true);
  }
  function outsideClick(e){
    if(confirmPop&&confirmPop.contains(e.target))return;
    if(sel.contains(e.target))return;
    clearConfirm();sel.value=prev;
  }
  function showConfirm(next){
    clearConfirm();
    confirmPop=document.createElement('div');
    confirmPop.className='oa-cm-menu oa-visibility-confirm';
    confirmPop.setAttribute('role','dialog');
    confirmPop.setAttribute('aria-label','Confirm public visibility');
    confirmPop.innerHTML='<div class="oa-visibility-confirm-text">Make this artifact public? Anyone with the link can view it.</div>';
    var yes=document.createElement('button');yes.type='button';yes.textContent='Make public';yes.className='oa-cm-del';
    var no=document.createElement('button');no.type='button';no.textContent='Cancel';
    yes.addEventListener('click',function(e){e.stopPropagation();clearConfirm();applyChange(next)});
    no.addEventListener('click',function(e){e.stopPropagation();clearConfirm();sel.value=prev;sel.focus()});
    confirmPop.appendChild(yes);confirmPop.appendChild(no);
    // Position below the select, clamped to the viewport.
    var rect=sel.getBoundingClientRect();
    var popWidth=224; // min-width:14rem
    confirmPop.style.position='fixed';
    confirmPop.style.top=(rect.bottom+4)+'px';
    confirmPop.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-popWidth-8))+'px';
    confirmPop.style.zIndex='2147483646';
    document.body.appendChild(confirmPop);
    document.addEventListener('mousedown',outsideClick,true);
    confirmPop.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();clearConfirm();sel.value=prev;sel.focus()}});
    // Close on resize — position is captured at open time.
    window.addEventListener('resize',function rs(){clearConfirm();sel.value=prev;window.removeEventListener('resize',rs)});
    yes.focus();
  }
  function applyChange(next){
    sel.disabled=true;
    sel.setAttribute('aria-busy','true');
    fetch('/api/artifacts/'+id,{method:'PATCH',headers:{'content-type':'application/json','X-OA-CSRF':'1'},body:JSON.stringify({visibility:next})})
      .then(function(r){if(!r.ok)throw new Error('Failed to update visibility');return r.json()})
      .then(function(){prev=next})
      .catch(function(e){
        sel.value=prev;
        var msg=e.message||'Failed to update visibility. Please try again.';
        if(window.__oaShowError)window.__oaShowError(msg);
        else if(console&&console.error)console.error(msg);
      })
      .finally(function(){
        sel.disabled=false;
        sel.removeAttribute('aria-busy');
      });
  }
  sel.addEventListener('change',function(){
    var next=sel.value;
    // Gate public exposure: confirm when transitioning to public from a non-public state.
    if(next==='public'&&prev!=='public'){
      sel.value=prev;
      showConfirm(next);
      return;
    }
    applyChange(next);
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
    btn.innerHTML=(t==="dark"?${JSON.stringify(MOON_SVG)}:${JSON.stringify(SUN_SVG)})+'<span class="oa-header-action-label">Theme</span>';
    btn.title="Theme: "+(t||"auto")+" (T)";
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
  pinHeaderToTop();
  offsetSticky();
  measure();
  if(window.ResizeObserver){new ResizeObserver(measure).observe(h)}
})();
`;

// At compact widths, the complete right-side header trail moves into one
// floating panel so its desktop ordering remains intact beside the artifact
// identity. The panel uses the same button and focus vocabulary as desktop
// chrome; this script owns only disclosure state and keyboard/outside-click
// dismissal.
const HEADER_SCRIPT = `
(function(){
  var root=document.querySelector('.oa-header-overflow');
  var button=document.getElementById('oa-header-more');
  var panel=document.getElementById('oa-header-panel');
  if(!root||!button||!panel)return;
  function hasControls(){
    for(var i=0;i<panel.children.length;i++){
      var child=panel.children[i];
      if(child.id!=='oa-account-slot'||child.children.length>0)return true;
    }
    return false;
  }
  function close(restore){
    root.removeAttribute('data-open');
    button.setAttribute('aria-expanded','false');
    var accountButton=panel.querySelector('.oa-account-btn');
    var accountMenu=panel.querySelector('.oa-account-menu');
    if(accountMenu)accountMenu.hidden=true;
    if(accountButton)accountButton.setAttribute('aria-expanded','false');
    if(restore&&!button.hidden)button.focus();
  }
  function sync(){
    button.hidden=!hasControls();
    if(button.hidden)close(false);
  }
  window.__oaSyncHeaderOverflow=sync;
  window.__oaRestoreHeaderControlFocus=function(control){
    if(control&&control.offsetParent!==null){control.focus();return}
    if(!button.hidden&&button.offsetParent!==null)button.focus();
  };
  button.addEventListener('click',function(){
    var open=!root.hasAttribute('data-open');
    if(open){root.setAttribute('data-open','');button.setAttribute('aria-expanded','true')}
    else close(false);
  });
  panel.addEventListener('click',function(e){
    var action=e.target.closest&&e.target.closest('button,a');
    if(action&&!action.classList.contains('oa-account-btn'))close(false);
  });
  document.addEventListener('click',function(e){if(!root.contains(e.target))close(false)});
  document.addEventListener('keydown',function(e){if(e.key==="Escape"&&root.hasAttribute('data-open'))close(true)});
  if(window.matchMedia){
    var narrow=window.matchMedia('(max-width:52rem)');
    var onChange=function(){if(!narrow.matches)close(false)};
    if(narrow.addEventListener)narrow.addEventListener('change',onChange);
  }
  sync();
})();
`;

// Live edit chrome styles. Mirrors the comments-toggle language
// (.oa-cm-toggle: 28px square, surface bg, border, focus ring, hover lift)
// so the Live button reads as a sibling of the comments toggle in the header.
// The global bar is a fixed bottom toolbar (Figma/Linear style); the action
// bar is a centered pill that floats next to the picked element and morphs
// Pick -> Configure -> Generating -> Confirmed. Quiet chrome, single
// --accent, both themes, no decorative motion.
// Shared dock-button vocabulary used by both the Live and Handoff toolbars so
// the two docks read as one chrome: one 30px ghost-button base (.oa-dock-btn)
// with an icon span + label span, and three variants --primary (accent fill,
// the CTA: Submit / Play), --record (danger fill: Record / Stop), and --exit
// (margin-left:auto, the right-aligned close affordance). [aria-pressed="true"]
// tints toward the accent for toggle states (Pick, Blur). Emitted when either
// dock is enabled; supersedes the per-dock .oa-live-icon / .oa-handoff-btn rules.
const DOCK_CSS = `
.oa-dock-btn{position:relative;display:inline-flex;align-items:center;gap:.35rem;height:30px;padding:0 .6rem;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--oa-fg);font:inherit;font-weight:500;line-height:1;cursor:pointer;opacity:.85;transition:opacity .15s,background .15s,border-color .15s;flex-shrink:0}
.oa-dock-btn:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-dock-btn:not(.oa-dock-btn--indicator):active{transform:translateY(1px)}
.oa-dock-btn .oa-dock-icon{display:inline-flex;align-items:center}
.oa-dock-btn .oa-dock-icon svg{width:14px;height:14px;display:block}
.oa-dock-btn .oa-dock-label{white-space:nowrap}
.oa-dock-btn[aria-pressed="true"],.oa-dock-btn--active{background:color-mix(in oklab,var(--oa-accent),transparent 88%);border-color:color-mix(in oklab,var(--oa-accent),transparent 60%);color:var(--oa-accent);opacity:1}
.oa-dock-btn--primary{background:var(--oa-accent);color:var(--oa-accent-on);border-color:transparent;opacity:1;font-weight:600}
.oa-dock-btn--record{background:var(--oa-danger);color:#fff;border-color:transparent;opacity:1}
.oa-dock-btn--exit{margin-left:auto}
.oa-dock-btn--indicator{cursor:default}
@media (hover:hover) and (pointer:fine){.oa-dock-btn:not(.oa-dock-btn--record):not(.oa-dock-btn--primary):not(.oa-dock-btn--indicator):not(.oa-dock-btn--blur):not(.oa-dock-btn--discard):hover{opacity:1;background:color-mix(in oklab,var(--oa-fg),transparent 94%)}.oa-dock-btn--primary:hover{background:color-mix(in oklab,var(--oa-accent),var(--oa-fg) 10%)}}
`;

const LIVE_CSS = `
.oa-live-toggle{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;background:transparent;color:var(--oa-muted);border-radius:6px;cursor:pointer;transition:color .15s,background .15s;flex-shrink:0}
.oa-live-toggle::before{content:"";position:absolute;inset:-6px}
.oa-live-toggle:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-live-toggle:active{transform:translateY(1px)}
.oa-live-toggle svg{display:block;width:16px;height:16px}
.oa-live-toggle[aria-expanded="true"]{color:var(--oa-accent);background:color-mix(in oklab,var(--oa-accent),transparent 88%)}
.oa-live-toggle[data-agent="on"],.oa-live-toggle[data-agent="busy"]{width:auto;gap:.35rem;padding-inline:.4rem}
.oa-live-connection{display:none;align-items:center;gap:.25rem;color:var(--oa-accent);font-size:.7rem;font-weight:600;white-space:nowrap}
.oa-live-connection[hidden]{display:none}
.oa-live-toggle[data-agent="on"] .oa-live-connection,.oa-live-toggle[data-agent="busy"] .oa-live-connection{display:inline-flex}
.oa-live-connection::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
@media (hover:hover) and (pointer:fine){.oa-live-toggle:hover{color:var(--oa-fg);background:color-mix(in oklab,var(--oa-fg),transparent 90%)}}
/* Agent-presence dot: set by LIVE_SCRIPT from /live/status. The pulsing halo
   is informational, like the handoff rec dot — never on high-frequency
   actions. Three states (impeccable semantics): on = accent pill, no dot;
   busy (a pending event is leased to the agent) = the accent dot pulses;
   off = the mark dims and an amber dot pulses, so the user knows the watcher
   dropped before they start picking. */
.oa-live-toggle[data-agent="busy"]::after{content:"";position:absolute;top:2px;right:2px;width:7px;height:7px;border-radius:50%;background:var(--oa-accent);box-shadow:0 0 0 2px color-mix(in oklab,var(--oa-bg),transparent 10%),0 0 0 0 color-mix(in oklab,var(--oa-accent),transparent 55%)}
@media (prefers-reduced-motion:no-preference){.oa-live-toggle[data-agent="busy"]::after{animation:oa-live-agent-pulse 2s ease-out infinite}}
@keyframes oa-live-agent-pulse{to{box-shadow:0 0 0 2px color-mix(in oklab,var(--oa-bg),transparent 10%),0 0 0 5px transparent}}
.oa-live-toggle[data-agent="off"]::after{content:"";position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;background:oklch(77% 0.13 82);box-shadow:0 0 0 2px color-mix(in oklab,var(--oa-bg),transparent 10%)}
@media (prefers-reduced-motion:no-preference){.oa-live-toggle[data-agent="off"]::after{animation:oa-live-agent-off-pulse 1.4s ease-in-out infinite}}
@keyframes oa-live-agent-off-pulse{0%,100%{opacity:.45;transform:scale(.9)}50%{opacity:1;transform:scale(1)}}
#oa-live-apply[hidden],#oa-live-discard[hidden]{display:none}
.oa-live-guide[hidden]{display:none}
.oa-live-guide{width:100%;box-sizing:border-box;padding:.4rem .6rem;border:1px solid var(--oa-border);border-radius:10px;background:var(--oa-surface);color:var(--oa-fg);font-family:var(--oa-font);font-size:.8rem;line-height:1.45}
.oa-live-guide-bar{display:flex;align-items:center;gap:.75rem}
.oa-live-guide-bar strong{flex:1;font-size:.85rem;font-weight:600}
.oa-live-guide-close{border:0;background:transparent;color:var(--oa-muted);font:inherit;font-size:.75rem;cursor:pointer;padding:.25rem;border-radius:4px}
.oa-live-guide-close:hover{color:var(--oa-fg);background:color-mix(in oklab,var(--oa-fg),transparent 92%)}
.oa-live-guide-close:focus-visible,.oa-live-guide-copy:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
#oa-live-guide-details[hidden]{display:none}
#oa-live-guide-details p{margin:.65rem 0 0;color:var(--oa-muted)}
.oa-live-add:disabled{opacity:.5;cursor:default}
.oa-live-discard.oa-dock-btn--danger{background:color-mix(in oklab,var(--oa-danger),transparent 88%);color:var(--oa-danger);border-color:color-mix(in oklab,var(--oa-danger),transparent 60%);opacity:1}
.oa-live-guide-text{display:block;width:100%;min-height:8rem;resize:vertical;padding:.55rem;border:1px solid var(--oa-border);border-radius:6px;background:var(--oa-surface);color:var(--oa-fg);font:inherit;font-family:var(--oa-font-mono,ui-monospace,monospace);font-size:.75rem;line-height:1.45}
.oa-live-guide-text:focus{outline:none;border-color:var(--oa-accent);box-shadow:var(--oa-focus-ring)}
.oa-live-guide-actions{display:flex;justify-content:flex-end;margin-top:.65rem}
.oa-live-guide-copy{min-height:28px;padding:.3rem .6rem;border:1px solid transparent;border-radius:6px;background:var(--oa-accent);color:var(--oa-accent-on);font:inherit;font-size:.75rem;font-weight:600;cursor:pointer}
.oa-live-guide-copy:hover{background:color-mix(in oklab,var(--oa-accent),var(--oa-fg) 10%)}
.oa-live-guide-copy:active{transform:translateY(1px)}
#oa-live-root[hidden]{display:none}
#oa-live-root{position:fixed;inset:0;z-index:2147483645;pointer-events:none;font-family:var(--oa-font);font-size:.8rem}
#oa-live-dock{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(1rem + env(safe-area-inset-bottom));width:min(28rem,92vw);max-height:calc(100dvh - 6rem);display:flex;flex-direction:column;gap:.5rem;padding:.6rem .6rem .55rem;border-radius:14px;border:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 4%);background:color-mix(in oklab,var(--oa-bg),transparent 4%);backdrop-filter:blur(14px) saturate(120%);box-shadow:0 8px 32px -4px color-mix(in oklab,var(--oa-fg),transparent 86%),0 1px 0 0 color-mix(in oklab,var(--oa-fg),transparent 92%) inset;overflow-y:auto;pointer-events:auto;z-index:2147483645;contain:layout style paint}
#oa-live-chips{display:flex;flex-direction:column;gap:.35rem;min-height:0;overflow-y:auto;padding:.1rem}
#oa-live-chips:empty{display:none}
#oa-live-chips .oa-live-chip{position:relative;display:block;padding:.5rem .6rem .5rem .65rem;border-radius:8px;background:color-mix(in oklab,var(--oa-surface),transparent 4%);border:0;font-size:.8rem;line-height:1.4}
#oa-live-chips .oa-live-chip+.oa-live-chip{border-top:1px solid color-mix(in oklab,var(--oa-border),transparent 40%);border-radius:0}
#oa-live-chips .oa-live-chip:first-child{border-radius:8px 8px 0 0}
#oa-live-chips .oa-live-chip:last-child{border-radius:0 0 8px 8px}
#oa-live-chips .oa-live-chip:only-child{border-radius:8px}
#oa-live-chips .oa-live-chip-tag{display:inline-block;color:color-mix(in oklab,var(--oa-accent),var(--oa-fg) 8%);font-weight:600;font-size:.7rem;letter-spacing:.02em;margin:0 0 .25rem 0;font-family:var(--oa-font-mono,ui-monospace,monospace)}
#oa-live-chips .oa-live-chip-txt{display:block;color:var(--oa-fg);white-space:normal;word-break:break-word;line-height:1.45;padding-right:1.6rem}
#oa-live-chips .oa-live-chip-rm{position:absolute;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--oa-muted);cursor:pointer;font-size:18px;line-height:1;top:.4rem;right:.35rem;transition:color .12s,background .12s}
#oa-live-chips .oa-live-chip-rm:hover{color:var(--oa-fg);background:color-mix(in oklab,var(--oa-fg),transparent 92%)}
#oa-live-chips .oa-live-chip-rm:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
#oa-live-controls{display:flex;align-items:center;gap:.35rem;flex-shrink:0;padding-bottom:.5rem;border-bottom:1px solid color-mix(in oklab,var(--oa-border),transparent 50%)}
#oa-live-dock:not(:has(#oa-live-chips:not(:empty))) #oa-live-controls{padding-bottom:0;border-bottom:0}
#oa-live-submit-wrap{margin-left:.35rem}
#oa-live-submit-wrap:empty{display:none}
#oa-live-action-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(1rem + 5rem + env(safe-area-inset-bottom));display:flex;pointer-events:auto;z-index:2147483645}
#oa-live-action-bar[hidden]{display:none}
#oa-live-action-bar .oa-live-row{display:flex;align-items:center;gap:.35rem;padding:.4rem .45rem;border-radius:12px;border:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 4%);background:color-mix(in oklab,var(--oa-bg),transparent 4%);backdrop-filter:blur(14px) saturate(120%);box-shadow:0 6px 24px -4px color-mix(in oklab,var(--oa-fg),transparent 88%)}
#oa-live-action-bar .oa-live-row>input,#oa-live-action-bar .oa-live-row>button{height:32px;font:inherit;font-size:.8rem;color:var(--oa-fg);background:var(--oa-surface);border:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 4%);border-radius:6px;padding:0 .6rem;transition:border-color .15s,box-shadow .15s}
#oa-live-action-bar .oa-live-row>input{min-width:14rem}
#oa-live-action-bar .oa-live-row>input::placeholder{color:color-mix(in oklab,var(--oa-fg),transparent 55%)}
#oa-live-action-bar .oa-live-row>input:focus-visible{outline:none;border-color:color-mix(in oklab,var(--oa-accent),var(--oa-border) 40%);box-shadow:var(--oa-focus-ring)}
#oa-live-action-bar .oa-live-add{background:var(--oa-accent);border-color:transparent;color:var(--oa-accent-on);font-weight:600;cursor:pointer}
#oa-live-action-bar .oa-live-add:hover{background:color-mix(in oklab,var(--oa-accent),var(--oa-fg) 8%)}
#oa-live-action-bar .oa-live-add:focus-visible{box-shadow:var(--oa-focus-ring)}
#oa-live-action-bar .oa-live-add:active{transform:translateY(1px)}
#oa-live-status{color:var(--oa-muted);font-size:.78rem;line-height:1.4;padding:0 .15rem .5rem;display:flex;align-items:center;gap:.35rem;min-height:1.2rem}
#oa-live-status[hidden]{display:none}
#oa-live-status .oa-live-stall{color:var(--oa-danger)}
#oa-live-status .oa-live-spin{display:inline-block;width:11px;height:11px;border:2px solid color-mix(in oklab,var(--oa-fg),transparent 70%);border-top-color:var(--oa-accent);border-radius:50%;animation:oa-live-spin .7s linear infinite;vertical-align:-1px;flex-shrink:0}
@keyframes oa-live-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#oa-live-status .oa-live-spin{animation:none}}
#oa-live-action-bar .oa-live-spin{display:inline-block;width:12px;height:12px;border:2px solid color-mix(in oklab,var(--oa-fg),transparent 70%);border-top-color:var(--oa-accent);border-radius:50%;animation:oa-live-spin .7s linear infinite;vertical-align:-2px;flex-shrink:0}
/* Touch: coarse pointers get WCAG-friendly targets without disturbing the
   desktop chrome (LAYOUT_SCRIPT measures the header's actual height, so a
   44px toggle just grows the header a little on touch devices). */
@media (pointer:coarse){
  .oa-live-toggle{width:44px;height:44px}
  .oa-dock-btn{height:44px}
  #oa-live-action-bar .oa-live-row>input,#oa-live-action-bar .oa-live-row>button{height:44px}
}
/* Narrow viewports: the floating bar wraps instead of overflowing; on phones
   the prompt input takes its own line so the row reads predictably and every
   control is a wide touch target. */
#oa-live-action-bar{max-width:calc(100vw - 1.5rem)}
#oa-live-action-bar .oa-live-row{flex-wrap:wrap}
@media (max-width:480px){
  #oa-live-action-bar .oa-live-row>input{min-width:0;flex:1 1 100%;order:2}
  /* The floating bar is shrink-to-fit (positionBar pins it inline), so
     flex-grow has no free space to distribute — a min-width is what actually
     widens the touch targets. */
  #oa-live-action-bar .oa-live-row>button{min-width:4.5rem}
}
`;

// Positions the embedded artifact frame below the sticky service header
// rather than covering it — the header's actual rendered height is measured
// at runtime into --oa-header-h (LAYOUT_SCRIPT); the CSS default (calc(2.5rem + 1px))
// covers first paint. Deliberately NOT `inset:0` (R3): that would place the
// frame's top edge at the viewport top, sliding it under the header instead
// of starting beneath it.
const HOST_FRAME_CSS = `
#oa-frame{position:fixed;top:var(--oa-header-h);inset-inline:0;bottom:0;width:100%;height:calc(100dvh - var(--oa-header-h));border:0;opacity:0;transition:opacity .15s ease}
#oa-frame[data-ready]{opacity:1}
#oa-frame[data-ready]~#oa-loading{display:none}
.oa-loading{position:fixed;top:var(--oa-header-h);inset-inline:0;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:0}
.oa-loading-spin{width:20px;height:20px;border:2px solid color-mix(in oklab,var(--oa-fg),transparent 85%);border-top-color:var(--oa-accent);border-radius:50%;animation:oa-loading-spin .8s linear infinite}
@keyframes oa-loading-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.oa-loading-spin{animation:none;border-top-color:var(--oa-muted)}}
.oa-live-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

// Account chip in the coda0 service header: provider avatar (with a name-initial
// fallback) + dropdown (dashboard / sign out), or a "Sign in" link when no
// session. Driven by a same-origin fetch('/api/me') from coda0's hosted account
// service, which returns {user:{name,picture}}. A self-host without that
// endpoint gets a non-200 and the chip stays empty.
const ACCOUNT_CSS = `
.oa-account-slot{position:relative;display:inline-flex;align-items:center;flex-shrink:0;min-height:28px}
.oa-account-slot:empty{display:none}
.oa-account-btn{position:relative;display:inline-flex;align-items:center;gap:.4rem;height:28px;padding:0 .35rem 0 .3rem;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--oa-fg);font:inherit;font-size:.75rem;line-height:1;cursor:pointer;transition:color .15s,background .15s}
.oa-account-btn:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-account-btn:active{transform:translateY(1px)}
@media (hover:hover) and (pointer:fine){.oa-account-btn:hover{background:color-mix(in oklab,var(--oa-fg),transparent 90%)}}
.oa-account-av{flex-shrink:0;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;overflow:hidden;background:color-mix(in oklab,var(--oa-fg),transparent 88%);color:var(--oa-fg);font-size:.7rem;font-weight:600;line-height:1;text-transform:uppercase;user-select:none}
.oa-account-av-image{display:block;width:100%;height:100%;object-fit:cover}
.oa-account-name{max-width:8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oa-account-menu{position:absolute;top:calc(100% + 4px);right:0;min-width:9rem;padding:.25rem;border:1px solid var(--oa-border);border-radius:6px;background:var(--oa-bg);box-shadow:0 4px 12px -2px color-mix(in oklab,var(--oa-fg),transparent 78%);z-index:2147483646}
.oa-account-menu[hidden]{display:none}
.oa-account-menu a,.oa-account-menu button{display:block;width:100%;text-align:left;padding:.375rem .5rem;border:0;border-radius:4px;background:none;color:var(--oa-fg);font:inherit;font-size:.78rem;cursor:pointer;text-decoration:none}
.oa-account-menu a:focus-visible,.oa-account-menu button:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
@media (hover:hover) and (pointer:fine){.oa-account-menu a:hover,.oa-account-menu button:hover{background:color-mix(in oklab,var(--oa-fg),transparent 94%)}}
.oa-account-signin{display:inline-flex;align-items:center;height:28px;padding:0 .7rem;border-radius:999px;border:1px solid var(--oa-border);background:var(--oa-accent);color:var(--oa-accent-on);font:inherit;font-size:.75rem;font-weight:600;line-height:1;cursor:pointer;text-decoration:none;transition:background .15s,transform .06s}
.oa-account-signin:active{transform:translateY(1px)}
.oa-account-signin:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
@media (hover:hover) and (pointer:fine){.oa-account-signin:hover{background:color-mix(in oklab,var(--oa-accent),var(--oa-fg) 10%)}}
`;

// Fetches /api/me (same-origin, connect-src 'self') and renders an account chip
// into #oa-account-slot. Resilient: any non-200 hides the slot (a self-host with
// no /api/me keeps today's chrome). On coda0 a session returns
// {user:{name,email,picture}}; 401 renders a "Sign in" link to /login. Logout
// is POST /auth/logout (no body).
const ACCOUNT_SCRIPT = `
(function(){
  var slot=document.getElementById('oa-account-slot');
  if(!slot)return;
  function initial(name){var ch=[...String(name||'').trim()][0];return ch?ch.toUpperCase():'?';}
  function initialAvatar(name){var fallback=document.createElement('span');fallback.className='oa-account-av';fallback.setAttribute('aria-hidden','true');fallback.textContent=initial(name);return fallback;}
  function syncOverflow(){if(window.__oaSyncHeaderOverflow)window.__oaSyncHeaderOverflow();}
  function clear(){slot.innerHTML='';syncOverflow();}
  function renderSignin(){slot.innerHTML='<a class="oa-account-signin" href="/login">Sign in</a>';syncOverflow();}
  function renderUser(name,picture){
    var btn=document.createElement('button');btn.type='button';btn.id='oa-account-button';btn.className='oa-account-btn';btn.setAttribute('aria-haspopup','menu');btn.setAttribute('aria-expanded','false');btn.setAttribute('aria-controls','oa-account-menu');
    var av=initialAvatar(name);
    if(picture){
      var img=document.createElement('img');img.className='oa-account-av-image';img.src=picture;img.alt='';
      img.addEventListener('error',function(){av.replaceWith(initialAvatar(name));});
      av.textContent='';av.appendChild(img);
    }
    var nm=document.createElement('span');nm.className='oa-account-name';nm.textContent=name||'Account';
    btn.appendChild(av);btn.appendChild(nm);
    var menu=document.createElement('div');menu.id='oa-account-menu';menu.className='oa-account-menu';menu.setAttribute('role','menu');menu.hidden=true;
    var dash=document.createElement('a');dash.href='/dashboard';dash.setAttribute('role','menuitem');dash.textContent='Dashboard';
    var lo=document.createElement('button');lo.type='button';lo.setAttribute('role','menuitem');lo.textContent='Sign out';
    lo.addEventListener('click',function(){fetch('/auth/logout',{method:'POST',credentials:'same-origin'}).then(function(){location.href='/';}).catch(function(){location.href='/';});});
    menu.appendChild(dash);menu.appendChild(lo);
    btn.addEventListener('click',function(e){e.stopPropagation();var open=menu.hidden;menu.hidden=!open;btn.setAttribute('aria-expanded',String(open));});
    var closeMenu=function(e){if(e.key==='Escape'&&!menu.hidden){e.stopPropagation();menu.hidden=true;btn.setAttribute('aria-expanded','false');btn.focus();}};
    btn.addEventListener('keydown',closeMenu);menu.addEventListener('keydown',closeMenu);
    document.addEventListener('click',function(){menu.hidden=true;btn.setAttribute('aria-expanded','false');});
    slot.innerHTML='';slot.appendChild(btn);slot.appendChild(menu);syncOverflow();
  }
  // Defer the /api/me fetch so it doesn't compete with the iframe load for
  // network bandwidth. The account chip is above-the-fold but non-critical;
  // requestIdleCallback (or a 0ms timeout fallback) lets the browser finish
  // first-paint and iframe negotiation before spending a round-trip on auth.
  var fire=function(){
    fetch('/api/me',{credentials:'same-origin'}).then(function(r){if(!r.ok){if(r.status===401)renderSignin();else clear();return null;}return r.json();}).then(function(me){
      if(!me){clear();return;}var user=me.user||{};var name=user.name||user.email||null;var picture=typeof user.picture==='string'?user.picture:null;if(name)renderUser(name,picture);else renderSignin();
    }).catch(clear);
  };
  if(window.requestIdleCallback){window.requestIdleCallback(fire,{timeout:2000});}
  else{setTimeout(fire,0);}
})();
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
  /** When true the deploy set OPEN_ARTIFACTS_HANDOFF=1 and the frame carries
   *  the handoff record + play shims. They are inert until armed by the host
   *  over the postMessage bridge (the same always-present-but-unarmed pattern
   *  the Live picker uses), so a normal view pays no behavioral cost. */
  handoffEnabled?: boolean;
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
  const { format, content, nonce, stampCsp, handoffEnabled = false } = options;
  // A react artifact's content is a precompiled, self-contained IIFE (React +
  // ReactDOM + the component, bundled by the skill). It mounts itself into
  // #oa-root, so the frame emits the mount node plus the bundle as a single
  // nonce'd inline <script> — it runs under the same nonce-only script-src (no
  // 'unsafe-eval', no external host) that every viewer-injected script uses, so
  // the CSP is unchanged. escapeInlineScript neutralizes any "</script" the
  // bundle might carry in a string literal.
  const body =
    format === "markdown"
      ? `<main class="oa-md" id="oa-content"></main>
<script nonce="${nonce}">${escapeInlineScript(MARKED_SOURCE)}</script>
<script nonce="${nonce}">
document.getElementById("oa-content").innerHTML=marked.parse(${jsonForInlineScript(content)});
</script>`
      : format === "react"
        ? `<div id="oa-root"></div>
<script nonce="${nonce}">${escapeInlineScript(content)}</script>`
        : stampNonceOnUserScripts(content, nonce);
  const cspMeta = stampCsp
    ? `<meta http-equiv="Content-Security-Policy" content="${frameMetaCsp(nonce)}">\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${FRAME_RESET_CSS}${format === "markdown" ? MARKDOWN_CSS : ""}${FRAME_SHELL_CSS}${FRAME_CANVAS_CSS}${FRAME_ANCHOR_CSS}${FRAME_TEXT_CSS}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${THEME_SCRIPT}</script>
<script nonce="${nonce}">${FRAME_SHELL_SCRIPT}</script>
<script nonce="${nonce}">${FRAME_BRIDGE_SCRIPT}</script>
<script nonce="${nonce}">${FRAME_ANCHOR_SCRIPT}</script>
<script nonce="${nonce}">${FRAME_TEXT_SCRIPT}</script>
<script nonce="${nonce}">${FRAME_LIVE_PICKER_SCRIPT}</script>
${handoffEnabled ? `<script nonce="${nonce}">${FRAME_HANDOFF_RECORD_SCRIPT}</script>` : ""}
${handoffEnabled ? `<script nonce="${nonce}">${FRAME_HANDOFF_PLAY_SCRIPT}</script>` : ""}
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
  /** Resolved brand identity for chrome / meta. */
  brand: Brand;
  /** True when BRAND_NAME is set — chip links home and overrides BRAND_URL. */
  branded: boolean;
  /** "Powered by Open Artifacts" link URL; omit to hide the brand entry when
   *  not branded. */
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
  /** When true, render the visibility selector for owners. */
  canManage?: boolean;
  /** Current artifact visibility; drives the share selector. */
  visibility?: Visibility;
  /** When true the deploy bound a LIVE_DO namespace and the Live button +
   *  action bar should render. False for self-hosters without the binding. */
  liveEnabled?: boolean;
  /** Absolute WebSocket URL for the live channel, e.g. "wss://coda0.com/api/artifacts/<id>/live".
   *  Only used when liveEnabled is true. */
  liveWsUrl?: string;
  /** When true the deploy set OPEN_ARTIFACTS_HANDOFF=1 and the host page renders
   *  the Handoff button + record/play dock, and the frame carries the handoff
   *  shims. False for self-hosters without the flag. */
  handoffEnabled?: boolean;
  /** Handoffs inlined at serve time (the same inlining pattern comments and the
   *  version picker use) so the play UI can list them with no runtime fetch from
   *  the sandboxed frame. Only read when handoffEnabled is true. */
  handoffs?: HandoffMeta[];
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
  brand: Brand;
}): string {
  const { title, description, brand } = options;
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

// Live edit chrome. A global bar (Pick + Exit) and an action bar pill that
// morphs Pick -> Configure -> Generating -> Confirmed, floating next to the
// picked element. Hidden until the Live button toggles it open. The host
// chrome owns the WebSocket (the sandboxed artifact frame cannot —
// connect-src 'none' + opaque origin); the frame runs the element picker
// itself, armed via the existing postMessage bridge. On Go the host sends
// `generate` to the LiveObject; the agent edits source, republishes, and
// replies `done`; the host reloads the frame to show the result. One shot,
// no variant cycling.
function liveChromeHtml(
  wsUrl: string,
  artifactId: string,
  canManage: boolean,
): string {
  // The offline guide is a one-line banner with the startup prompt behind a
  // disclosure — the full wall occluded the pick surface on every reopen.
  const guide = canManage
    ? `<div id="oa-live-guide" class="oa-live-guide" role="group" aria-label="Live watcher setup" hidden>
      <div class="oa-live-guide-bar"><strong id="oa-live-guide-title">Live agent not connected</strong><button id="oa-live-guide-toggle" class="oa-live-guide-close" type="button" aria-expanded="false" aria-controls="oa-live-guide-details">Show start prompt</button></div>
      <div id="oa-live-guide-details" hidden>
        <p>Copy this prompt to the coding agent, then keep its Live watcher running while you make edits here.</p>
        <textarea id="oa-live-guide-text" class="oa-live-guide-text" readonly aria-label="Live watcher startup prompt"></textarea>
        <div class="oa-live-guide-actions"><button id="oa-live-guide-copy" class="oa-live-guide-copy" type="button">Copy start prompt</button></div>
      </div>
    </div>`
    : "";
  return `<div id="oa-live-root" hidden>
  <div id="oa-live-dock">
    ${guide}
    <div id="oa-live-status" role="status" aria-live="polite"></div>
    <div id="oa-live-controls" role="toolbar" aria-label="Live editor">
      <span class="oa-dock-btn oa-dock-btn--active oa-dock-btn--indicator" id="oa-live-pick-toggle" title="Pick mode is on"><span class="oa-dock-icon" aria-hidden="true">${LIVE_SVG}</span><span class="oa-dock-label">Pick</span></span>
      <div id="oa-live-submit-wrap"></div>
      <button type="button" class="oa-dock-btn oa-dock-btn--primary oa-live-apply" id="oa-live-apply" hidden><span class="oa-dock-label">Apply copy edits</span></button>
      <button type="button" class="oa-dock-btn oa-dock-btn--discard oa-live-discard" id="oa-live-discard" title="Discard staged edits" aria-label="Discard staged edits" hidden><span class="oa-dock-icon" aria-hidden="true">${CLOSE_SVG}</span></button>
      <button type="button" class="oa-dock-btn oa-dock-btn--exit" id="oa-live-exit" title="Exit live editor"><span class="oa-dock-icon" aria-hidden="true">${CLOSE_SVG}</span><span class="oa-dock-label">Exit</span></button>
    </div>
    <div id="oa-live-chips" role="list" aria-label="Collected changes"></div>
  </div>
  <div id="oa-live-action-bar" role="dialog" aria-label="Live actions" hidden></div>
  <script type="application/json" id="oa-live-config">${jsonForInlineScript({ wsUrl, artifactId })}</script>
</div>`;
}

// Shared dock manager for the Live and Handoff docks. Both are bottom-center
// pills that inherit the icon-button vocabulary, and DESIGN.md pins them as
// mutually exclusive - opening one closes the other. Rather than each script
// reaching across to the other's exit hook (__oaExitLive / __oaCloseHandoff),
// both register an {open, close, restoreFocus, refuseMessage} API here and a
// single owner tracks the active dock, enforces exclusion, wires one
// Escape-to-close handler, and places focus on open / restores it on close.
// close() returns false (and the manager toasts refuseMessage) when a dock
// holds irreplaceable in-flight work - Handoff mid-record/playback. Live always
// yields. Runs before LIVE_SCRIPT and HANDOFF_SCRIPT; __oaShowError (TOAST_SCRIPT)
// is already defined by then.
const DOCK_SCRIPT = `
(function(){
  var docks={}, active=null;
  function refuse(d){ if(d&&d.refuseMessage&&window.__oaShowError){ var m=d.refuseMessage(); if(m)window.__oaShowError(m); } }
  function open(name){
    var d=docks[name]; if(!d)return false;
    if(active===name)return true;
    // Close the comments drawer if it is open — docks and comments are
    // mutually exclusive, like Live and Handoff.
    var cmDrawer=document.getElementById('oa-cm-drawer');
    if(cmDrawer&&cmDrawer.hasAttribute('data-open')){
      var cmToggle=document.querySelector('.oa-cm-toggle');
      cmDrawer.removeAttribute('data-open');
      cmDrawer.setAttribute('aria-hidden','true');
      if(cmToggle)cmToggle.setAttribute('aria-expanded','false');
    }
    if(active){ var o=docks[active]; if(o&&!o.close()){ refuse(o); return false; } }
    d.open(); active=name; return true;
  }
  function close(name){
    var d=docks[name]; if(!d||active!==name)return false;
    if(!d.close()){ refuse(d); return false; }
    active=null; if(d.restoreFocus)d.restoreFocus(); return true;
  }
  window.__oaDock={
    register:function(name,api){docks[name]=api;},
    open:open,
    close:close,
    toggle:function(name){ var d=docks[name]; if(!d)return false; return active===name?close(name):open(name); },
    isActive:function(name){return active===name;},
    getActive:function(){return active;}
  };
  // One Escape closes the active dock, but only after any open comments surface
  // (drawer/compose/menu) has had its turn. The surfaces' own Escape handlers
  // close them synchronously in the bubble phase, so this listener is captured
  // to run FIRST and bail when one is still open - the surface closes on this
  // keypress, the dock on the next. A refused close (Handoff recording/playing)
  // surfaces the dock's refuseMessage instead.
  document.addEventListener('keydown',function(e){
    if(e.key!=='Escape'||!active)return;
    // A visible live guide takes the first Escape — close the banner (and its
    // disclosure) instead of the whole dock. This capture handler runs before
    // the guide's own bubble handler, which is why the check lives here.
    var guide=document.getElementById('oa-live-guide');
    if(guide&&!guide.hidden){
      guide.hidden=true;
      var details=document.getElementById('oa-live-guide-details');
      if(details&&!details.hidden){
        details.hidden=true;
        var t=document.getElementById('oa-live-guide-toggle');
        if(t)t.setAttribute('aria-expanded','false');
      }
      return;
    }
    if(document.querySelector('.oa-cm-drawer[data-open], #oa-cm-compose:not([hidden]), .oa-cm-menu:not([hidden])'))return;
    close(active);
  }, true);
})();
`;

const LIVE_SCRIPT = `
(function(){
  var cfgEl=document.getElementById('oa-live-config');
  if(!cfgEl) return;
  var cfg=JSON.parse(cfgEl.textContent||'{}');
  var root=document.getElementById('oa-live-root');
  var dock=document.getElementById('oa-live-dock');
  var statusEl=document.getElementById('oa-live-status');
  var chipsEl=document.getElementById('oa-live-chips');
  var submitEl=document.getElementById('oa-live-submit-wrap');
  var applyBtn=document.getElementById('oa-live-apply');
  var discardBtn=document.getElementById('oa-live-discard');
  var abar=document.getElementById('oa-live-action-bar');
  var exitBtn=document.getElementById('oa-live-exit');
  var frame=document.getElementById('oa-frame');
  var liveToggle=document.querySelector('.oa-live-toggle');
  var connection=document.querySelector('[data-live-connection]');
  var liveGuide=document.getElementById('oa-live-guide');
  var guideText=document.getElementById('oa-live-guide-text');
  var guideCopy=document.getElementById('oa-live-guide-copy');
  var guideToggle=document.getElementById('oa-live-guide-toggle');
  var guideDetails=document.getElementById('oa-live-guide-details');
  if(!root||!dock||!statusEl||!chipsEl||!submitEl||!abar||!exitBtn||!frame) return;

  var agentOnline=null;
  // The guide banner auto-shows once per session; later offline opens keep
  // the slim status row instead of re-occluding the pick surface.
  var guideAutoShown=false;
  if(guideText){
    var guideOrigin=window.location.origin||'';
    guideText.value=[
      'Start the Live watcher for this artifact:',
      'Artifact URL: '+guideOrigin+'/a/'+encodeURIComponent(cfg.artifactId),
      'Run this from the project root:',
      'node artifact.mjs live '+cfg.artifactId+' --watch',
      'Keep the watcher running while I make Live edits.'
    ].join(String.fromCharCode(10));
  }
  function setGuideToggleLabel(open){
    if(!guideToggle)return;
    guideToggle.textContent=open?'Hide start prompt':'Show start prompt';
  }
  function hideGuide(){
    if(liveGuide)liveGuide.hidden=true;
    // Collapse the disclosure so the next banner opens slim.
    if(guideDetails&&!guideDetails.hidden){
      guideDetails.hidden=true;
      if(guideToggle)guideToggle.setAttribute('aria-expanded','false');
      setGuideToggleLabel(false);
    }
  }
  function showGuide(){
    if(!liveGuide)return;
    liveGuide.hidden=false;
    // Auto-expand the prompt text (the details section) so the user sees the
    // startup prompt immediately. The disclosure toggle still works to close it.
    if(guideDetails&&guideDetails.hidden){
      guideDetails.hidden=false;
      if(guideToggle)guideToggle.setAttribute('aria-expanded','true');
      setGuideToggleLabel(true);
      if(guideCopy)guideCopy.focus();
    }
  }
  function toggleGuideDetails(){
    if(!guideDetails)return;
    var open=guideDetails.hidden;
    guideDetails.hidden=!open;
    if(guideToggle)guideToggle.setAttribute('aria-expanded', open?'true':'false');
    setGuideToggleLabel(!!open);
    if(open&&guideCopy)guideCopy.focus();
  }
  function markGuideCopied(ok){
    if(!guideCopy)return;
    var original=ok?'Copy start prompt':'Copy failed';
    guideCopy.textContent=ok?'Copied':original;
    setTimeout(function(){guideCopy.textContent='Copy start prompt';},1600);
  }
  function fallbackGuideCopy(){
    if(!guideText){markGuideCopied(false);return;}
    guideText.focus();
    guideText.select();
    var copied=false;
    try{copied=document.execCommand('copy');}catch(e){copied=false;}
    markGuideCopied(copied);
  }
  function copyGuide(){
    if(!guideText)return;
    if(navigator.clipboard&&navigator.clipboard.writeText){
      try{
        navigator.clipboard.writeText(guideText.value).then(function(){markGuideCopied(true);}).catch(function(){fallbackGuideCopy();});
      }catch(e){fallbackGuideCopy();}
      return;
    }
    fallbackGuideCopy();
  }
  if(guideToggle)guideToggle.addEventListener('click',toggleGuideDetails);
  if(guideCopy)guideCopy.addEventListener('click',copyGuide);
  document.addEventListener('click',function(e){
    var target=e.target;
    if(liveGuide&&!liveGuide.hidden&&target!==liveToggle&&!liveGuide.contains(target))hideGuide();
  });
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&liveGuide&&!liveGuide.hidden)hideGuide();
  });

  function openLive(){
    // Reconnect if the ws died (a prior Exit, or Handoff tore Live down).
    // onclose only auto-reconnects while non-IDLE, so an IDLE-time close
    // leaves it dead - reopen has to re-establish it explicitly.
    if(!ws || ws.readyState>=2) connect();
    root.removeAttribute('hidden');
    if(liveToggle) liveToggle.setAttribute('aria-expanded','true');
    // Clicking Live = enter pick mode immediately. The dock's Pick control is
    // a display-only indicator, so arming happens here on open. The picker
    // locks while a picked element's prompt is open and is re-armed after the
    // prompt is committed. Arm unconditionally (not gated on state==='IDLE')
    // so a stale non-IDLE state left by an in-flight ws message after Exit
    // can't strand the user with pick disarmed and no way to re-arm.
    setState('PICKING');
    toFrame({type:'oa:live:pick:arm'});
    // Annotate on top of the picked element: comment pins + strokes ride the
    // next generate event so the agent sees the user's marks with the change.
    toFrame({type:'oa:live:annot:enable'});
    // Restore the Apply pill: staged edits from before a reload must survive.
    refreshStash();
  }
  function closeLive(){
    // Live has no irreplaceable in-flight work, so it always yields.
    if(root.hidden) return true;
    // Give the exit its OWN id: send() otherwise stamps the last generate's
    // sessionId, and the watcher's grow-only exclude set would then hide the
    // exit row forever (the watcher would never learn the session ended).
    send({type:'exit', id:genId()}); reset(); ws&&ws.close(); root.hidden=true;
    if(liveToggle) liveToggle.setAttribute('aria-expanded','false');
    return true;
  }
  if(window.__oaDock){
    window.__oaDock.register('live', {
      open: openLive,
      close: closeLive,
      restoreFocus: function(){ if(window.__oaRestoreHeaderControlFocus)window.__oaRestoreHeaderControlFocus(liveToggle);else if(liveToggle)liveToggle.focus(); }
    });
  }
  if(liveToggle){
    liveToggle.addEventListener('click', function(){
      if(root.hidden&&agentOnline===false&&!guideAutoShown){ guideAutoShown=true; showGuide(); }else hideGuide();
      // Toggle (open/close) through the dock manager, like the comments toggle
      // (.oa-cm-toggle) opens/closes its drawer. The manager enforces mutual
      // exclusion with Handoff and toasts when Handoff refuses to yield
      // (mid-recording/playback). Fallback toggles directly if the manager is
      // absent.
      if(window.__oaDock) window.__oaDock.toggle('live'); else if(root.hidden) openLive(); else closeLive();
    });
  }

  // Agent presence: the CLI watcher heartbeats while connected, and the Live
  // toggle shows Connected when an agent is online — so the user knows a watcher
  // will pick up their changes before they start, instead of only learning
  // it from the STALLED hint 2 minutes after submit. Same-origin fetch works
  // on the host page (connect-src 'self'); the frame can never do this.
  // Three states (impeccable semantics): on = accent pill, no dot; busy (a
  // pending event is leased to the agent) = accent dot pulses, tooltip says
  // the agent is working; off = amber dot pulses with the watcher tooltip.
  var agentTimer=null;
  // aria-live region for presence announcements — the visual dot is invisible
  // to screen readers; this gives AT users the same state information.
  var agentLive=document.createElement('div');
  agentLive.setAttribute('aria-live','polite');
  agentLive.setAttribute('aria-atomic','true');
  agentLive.className='oa-live-sr';
  document.body.appendChild(agentLive);
  var lastAgentText='';
  function announceAgent(text){
    if(text===lastAgentText)return;
    lastAgentText=text;
    agentLive.textContent=text;
  }
  function paintAgent(on, busy){
    // The PICKING status text mentions presence — refresh it only when the
    // flag actually flips (a full renderBar would rebuild the compose row and
    // drop a prompt the user is typing).
    var changed=on!==agentOnline;
    agentOnline=on;
    if(!liveToggle)return;
    liveToggle.setAttribute('data-agent', on?(busy?'busy':'on'):'off');
    if(connection)connection.hidden=!on;
    liveToggle.setAttribute('aria-label', on?'Open live editor — agent connected':'Open live editor — live agent not connected');
    liveToggle.title=on?(busy?'Agent is working on an edit':'Live — agent connected'):'Live agent not connected - run the watcher to connect';
    // Announce presence state changes to assistive technology.
    if(changed)announceAgent(on?(busy?'Live agent is working on an edit':'Live agent connected'):'Live agent not connected');
    if(on)hideGuide();
    if(changed)renderStatus();
  }
  function pollAgent(){
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/status'+(window.__oaViewedVersion?'?v='+window.__oaViewedVersion:''),{credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(s){
        // busy = a pending event is leased to the agent (leased_until in the
        // future): the toggle shows the agent is working, not just online.
        var busy=Array.isArray(s.pendingEvents)&&s.pendingEvents.some(function(e){return e.leased_until>Date.now();});
        paintAgent(s.agentActive===true, busy);
        // An unleased queued edit event (from a reload or a prior session)
        // restores the "Queued — click to cancel" pill.
        if(Array.isArray(s.pendingEvents)&&!queuedEditId){
          for(var i=0;i<s.pendingEvents.length;i++){
            var pe=s.pendingEvents[i];
            if(pe.type==='edit'&&pe.leased_until<=Date.now()){ queuedEditId=pe.id; paintQueued(); break; }
          }
        }
      })
      .catch(function(){ /* keep the last state; a blip must not flick the indicator */ });
  }
  function startAgentPoll(){ stopAgentPoll(); pollAgent(); agentTimer=setInterval(pollAgent,15000); }
  function stopAgentPoll(){ if(agentTimer){ clearInterval(agentTimer); agentTimer=null; } }
  document.addEventListener('visibilitychange',function(){
    if(document.hidden) stopAgentPoll(); else startAgentPoll();
  });
  if(liveToggle) startAgentPoll();

  var ws=null, wsReady=false, sessionId=null, state='IDLE', pendingRearm=false;
  // Multi-element batch: the user picks N elements, types a prompt for each
  // (Enter commits that pair), then hits Submit to send one generate event
  // with the full list. draft is the element currently awaiting a prompt.
  var items=[]; // [{element, prompt, rect}]
  var draft=null; // {element, rect} — picked, prompt not yet committed
  // (no preset action — each item carries its own freeform prompt)
  var ackTimer=null;
  // How long to wait for an agent ack before showing the stall hint.
  var ACK_TIMEOUT=120000; // 2 min — generous for an agent spinning up
  // One reload per publish, two signals: the version broadcast and the
  // agent's done reply (which lands ~1-3s later, after the republish).
  // 'done' owns the reload — exactly one per interactive edit, like before
  // this feature; the version branch is the fallback for publishes with no
  // live reply (another session, or no live session at all): it defers
  // past the window in which a done would land and reloads only if none
  // did (versionSeenAt reset by the done handler).
  var versionSeenAt=0, VERSION_DONE_WINDOW_MS=5000;

  function toFrame(msg){ try{ if(frame.contentWindow) frame.contentWindow.postMessage(msg,'*'); }catch(e){} }
  function send(msg){ if(!ws||ws.readyState!==1) return; msg.id=msg.id||sessionId; try{ ws.send(JSON.stringify(msg)); }catch(e){} }
  function genId(){ return 'ev_'+Math.random().toString(36).slice(2)+Date.now().toString(36); }
  // Bridge for the comments chrome: a comment posted while the live channel
  // is up is streamed to the agent's watcher immediately (a comment event
  // the watch loop polls), so "I left a comment" reaches the agent without
  // waiting for a pick+submit. The comments script runs before this one, so
  // it calls the hook lazily at post time.
  window.__oaLivePush=function(msg){
    if(!msg||!msg.type)return;
    if(!msg.id)msg.id=genId();
    send(msg);
  };

  // --- inline copy edits (impeccable-style) ---
  // The frame's contenteditable rows are staged server-side (POST
  // /live/edit-stash) instead of delivered immediately; Apply bundles every
  // staged op for this page into ONE 'edit' event (POST /live/edit-commit) —
  // fixing five typos means one agent round trip, not five. lastSubmitType
  // distinguishes an edit-done from a generate-done in the WS handler; the
  // protocol payload decides first (Array.isArray appliedEntryIds) and this
  // flag only backs up older agents that reply without it.
  var lastSubmitType=null;
  var stashCount=0;
  // In-register inline confirm (the native confirm dialog is off-register):
  // the first Apply/Discard/Exit click arms the control ("Confirm apply?" /
  // danger tint), a second click within the window commits, otherwise it
  // reverts.
  var applyArmed=null, discardArmed=null, cancelArmed=null;
  // A committed edit event waits in the DO queue until a watcher applies it.
  // The pill then becomes the cancel affordance ("Queued — click to cancel",
  // DELETE /live/events/:eid) so "it will queue" is a promise the UI can keep.
  var queuedEditId=null;
  function paintQueued(){
    if(!applyBtn)return;
    if(queuedEditId){
      applyBtn.querySelector('.oa-dock-label').textContent='Queued ('+stashCount+') — click to cancel';
      applyBtn.setAttribute('aria-label','Cancel the queued edit');
    }else{
      applyBtn.querySelector('.oa-dock-label').textContent='Apply copy edits ('+stashCount+')';
      applyBtn.removeAttribute('aria-label');
    }
  }
  function resetApplyArm(){
    if(applyArmed){ clearTimeout(applyArmed); applyArmed=null; }
    if(cancelArmed){ clearTimeout(cancelArmed); cancelArmed=null; }
    if(discardArmed){ clearTimeout(discardArmed); discardArmed=null; }
    if(discardBtn)discardBtn.classList.remove('oa-dock-btn--danger');
    paintQueued();
  }
  function refreshStash(){
    if(!applyBtn)return;
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/edit-stash?pageUrl='+encodeURIComponent(window.location.pathname),{credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(s){
        stashCount=Number(s&&s.pendingCount)||0;
        applyBtn.hidden=stashCount===0&&!queuedEditId;
        if(discardBtn)discardBtn.hidden=stashCount===0;
        resetApplyArm();
      })
      .catch(function(){ /* transient; the pill keeps its last state */ });
  }
  function commitEdits(){
    if(!stashCount)return;
    if(!applyArmed){
      applyBtn.querySelector('.oa-dock-label').textContent='Confirm apply?';
      applyArmed=setTimeout(function(){ applyArmed=null; paintQueued(); },4000);
      return;
    }
    clearTimeout(applyArmed); applyArmed=null;
    lastSubmitType='edit';
    setState('APPLYING');
    // A dead watcher still queues the edit server-side (the DO persists
    // pending events) — say so up front, and time out fast instead of a 2-min
    // silent spin before the stall hint.
    if(agentOnline===false){
      statusEl.innerHTML='No agent connected — the edit will queue until a watcher connects';
      statusEl.hidden=false;
    }
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/edit-commit',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({pageUrl:window.location.pathname})})
      .then(function(r){ if(!r.ok) throw {status:r.status}; return r.json(); })
      .then(function(s){
        // Committed: the event sits in the queue until a watcher applies it.
        queuedEditId=String(s&&s.eventId||'');
        paintQueued();
      })
      .catch(function(err){
        // 409 = the stash changed under us (empty/consumed); anything else is
        // a network blip — the stash is still there either way. Surface the
        // difference instead of the old "still here" line, which lied once
        // the event was queued.
        if(window.__oaShowError)window.__oaShowError(err&&err.status===409?'Apply failed — the stash changed; refresh and try again':'Apply failed — the staged edits are still here, try again');
        setState('PICKING');
      });
    clearTimeout(ackTimer);
    ackTimer=setTimeout(function(){ if(state==='APPLYING') setState('STALLED'); }, agentOnline===false?20000:ACK_TIMEOUT);
  }
  function cancelQueued(){
    if(!queuedEditId)return;
    if(!cancelArmed){
      applyBtn.querySelector('.oa-dock-label').textContent='Cancel queued edit?';
      cancelArmed=setTimeout(function(){ cancelArmed=null; paintQueued(); },4000);
      return;
    }
    clearTimeout(cancelArmed); cancelArmed=null;
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/events/'+encodeURIComponent(queuedEditId),{method:'DELETE',credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw {status:r.status}; return r.json(); })
      .then(function(){
        queuedEditId=null;
        paintQueued();
        refreshStash();
        // Back to picking — the stall/queue warning no longer applies.
        setState('PICKING');
        if(window.__oaShowSuccess)window.__oaShowSuccess('Queued edit cancelled — the stash is still here');
      })
      .catch(function(err){
        // 409 = the watcher already leased it; the row is gone either way.
        if(err&&err.status===409){
          if(window.__oaShowError)window.__oaShowError('The agent already picked up the edit — it is being applied');
        }else{
          if(window.__oaShowError)window.__oaShowError('Cancel failed — try again');
        }
        queuedEditId=null;
        paintQueued();
        setState('PICKING');
      });
  }
  function discardEdits(){
    if(!stashCount)return;
    if(!discardArmed){
      discardBtn.classList.add('oa-dock-btn--danger');
      discardBtn.setAttribute('aria-label','Confirm discard staged edits');
      discardArmed=setTimeout(function(){ discardArmed=null; discardBtn.classList.remove('oa-dock-btn--danger'); discardBtn.setAttribute('aria-label','Discard staged edits'); },4000);
      return;
    }
    clearTimeout(discardArmed); discardArmed=null;
    discardBtn.classList.remove('oa-dock-btn--danger');
    discardBtn.setAttribute('aria-label','Discard staged edits');
    fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/edit-stash?pageUrl='+encodeURIComponent(window.location.pathname),{method:'DELETE',credentials:'same-origin'})
      .then(function(r){ if(!r.ok) throw 0; refreshStash(); })
      .catch(function(){});
  }
  if(applyBtn)applyBtn.onclick=function(){ if(queuedEditId) cancelQueued(); else commitEdits(); };
  if(discardBtn)discardBtn.onclick=discardEdits;

  function setState(s){ state=s; renderBar(); }

  // Float the action bar near the drafted element. draft.rect is the element's
  // rect inside the frame (CSS px); add the iframe's offset on the host page
  // to get page coordinates. Only called in COMPOSE state (which always has a
  // draft); if no rect, hide the bar — the status row in the dock carries the
  // hint, so nothing overlaps.
  function positionBar(){
    var rc=draft&&draft.rect;
    if(!rc){ abar.hidden=true; abar.style.left=''; abar.style.top=''; abar.style.bottom=''; abar.style.transform=''; return; }
    var fr=frame.getBoundingClientRect();
    var x=fr.left+rc.x+ (rc.width/2);
    var y=fr.top+rc.y+rc.height+8;
    abar.style.left=x+'px';
    abar.style.top=y+'px';
    abar.style.bottom='auto';
    abar.style.transform='translateX(-50%)';
    var vw=document.documentElement.clientWidth, vh=document.documentElement.clientHeight;
    if(y>vh-80){ abar.style.top='auto'; abar.style.bottom=(vh-(fr.top+rc.y)+8)+'px'; }
    if(x<150){ abar.style.left='150px'; }
    if(x>vw-150){ abar.style.left=(vw-150)+'px'; }
  }

  // --- bar rendering (Pick / Compose / Edit / Generating / Applying / Confirmed) ---
  // Live state machine (see the state var below):
  //   COMPOSE --Edit chip--> EDITING        (frame arms contenteditable rows)
  //   EDITING --cancel--> COMPOSE           (frame restores the original texts)
  //   EDITING --save ok--> PICKING          (ops stashed; pick re-armed)
  //   COMPOSE --Apply--> APPLYING           (one edit event committed)
  //   APPLYING --ack--> WORKING
  //   APPLYING --done--> CONFIRMED          (stash cleared, frame reloads)
  //   APPLYING --error--> PICKING           (stash kept for retry or discard)
  //   APPLYING --timeout--> STALLED
  //   Closing the dock mid-EDITING/APPLYING runs reset(), which clears
  //   lastSubmitType and cancels frame edit mode; reopening arms cleanly.
  function el(tag, cls, html){ var d=document.createElement(tag); if(cls)d.className=cls; if(html!=null)d.innerHTML=html; return d; }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  // Status row lives INSIDE the dock — it can never overlap the controls.
  // Presence surfaces here too (PICKING names a missing agent), so the
  // disconnected state is visible without hovering the toggle — its tooltip
  // is the hover-only channel, the aria-label covers assistive tech.
  function renderStatus(){
    var status='';
    if(state==='PICKING') status= items.length? 'Pick another element, or Submit below' : (agentOnline===false?'Pick an element in the page — live agent not connected':'Pick an element in the page');
    else if(state==='COMPOSE') status='';
    else if(state==='EDITING') status='Editing text — edit the text lines, then Save or Cancel';
    else if(state==='GENERATING') status='<span class="oa-live-spin"></span> Sent — waiting for agent…';
    else if(state==='APPLYING') status='<span class="oa-live-spin"></span> Applying copy edits…';
    else if(state==='WORKING') status='<span class="oa-live-spin"></span> Agent is editing…';
    // A stalled edit-commit still has its event queued server-side — the hint
    // must acknowledge the queue instead of implying the work is lost.
    else if(state==='STALLED') status= lastSubmitType==='edit' ? '<span class="oa-live-stall">No agent picked up — the edit is queued and will apply when a watcher connects</span>' : '<span class="oa-live-stall">No agent picked up — is your CLI watcher running?</span>';
    else if(state==='CONFIRMED') status='✓ Applied';
    statusEl.innerHTML=status||'';
    statusEl.hidden=!status;
  }
  function renderBar(){
    renderStatus();
    // Floating action bar: ONLY for COMPOSE (prompt input + Add) and EDITING
    // (Save/Cancel), pinned to the picked element. All other states are text
    // in the dock status row.
    abar.innerHTML='';
    if(state==='COMPOSE'){
      abar.hidden=false;
      abar.appendChild(buildComposeRow());
      positionBar();
    }else if(state==='EDITING'){
      abar.hidden=false;
      abar.appendChild(buildEditRow());
      positionBar();
    }else{
      abar.hidden=true;
      abar.style.left=''; abar.style.top=''; abar.style.bottom=''; abar.style.transform='';
    }
    renderChips();
  }
  function renderChips(){
    chipsEl.innerHTML='';
    submitEl.innerHTML='';
    if(!items.length) return;
    items.forEach(function(it, i){
      var chip=el('div','oa-live-chip'); chip.setAttribute('role','listitem');
      chip.appendChild(el('span','oa-live-chip-tag', esc(it.element.tagName)+(it.element.id?'#'+esc(it.element.id):'')));
      chip.appendChild(el('span','oa-live-chip-txt', esc(it.prompt)));
      var rm=el('button','oa-live-chip-rm','×'); rm.type='button';
      rm.setAttribute('aria-label','Remove '+esc(it.element.tagName)+(it.element.id?'#'+esc(it.element.id):''));
      rm.onclick=function(){ items.splice(i,1); if(!items.length&&!draft){ setState('PICKING'); } else renderBar(); };
      chip.appendChild(rm);
      chipsEl.appendChild(chip);
    });
    var sub=el('button','oa-dock-btn oa-dock-btn--primary'); sub.type='button'; sub.onclick=handleSubmit;
    sub.appendChild(el('span','oa-dock-label','Submit ('+items.length+')'));
    submitEl.appendChild(sub);
  }
  function buildComposeRow(){
    var r=el('div','oa-live-row');
    // Two input modes for a picked element: describe the change as a prompt
    // (default), or edit the element's text directly (impeccable-style).
    var edit=el('button','oa-dock-btn oa-live-edit-chip','Edit text'); edit.type='button'; edit.title='Edit the element text directly';
    edit.onclick=function(){ toFrame({type:'oa:live:edit:arm'}); setState('EDITING'); };
    var ff=el('input','oa-live-freeform'); ff.type='text'; ff.placeholder='describe the change; Enter to commit'; ff.setAttribute('aria-label','prompt for picked element');
    ff.onkeydown=function(e){ if(e.key==='Enter'){ e.preventDefault(); commitDraft(ff.value); } };
    // Add stays disabled until the prompt has text — an empty instruction must
    // never ship to the agent (commitDraft guards it too).
    var done=el('button','oa-live-add','Add'); done.type='button'; done.disabled=true;
    done.onclick=function(){ commitDraft(ff.value); };
    ff.addEventListener('input',function(){ done.disabled=!ff.value.trim(); });
    // Un-pick: cancel the draft and re-arm the picker (disarm clears the
    // frame's picked element, highlight, and annotation overlay).
    var unpickIc=el('span','oa-dock-icon'); unpickIc.setAttribute('aria-hidden','true'); unpickIc.innerHTML='${CLOSE_SVG}';
    var unpick=el('button','oa-dock-btn oa-live-unpick'); unpick.type='button'; unpick.appendChild(unpickIc);
    unpick.setAttribute('aria-label','Cancel this pick'); unpick.title='Cancel this pick';
    unpick.onclick=function(){ toFrame({type:'oa:live:pick:disarm'}); draft=null; setState('PICKING'); toFrame({type:'oa:live:pick:arm'}); };
    r.appendChild(edit); r.appendChild(ff); r.appendChild(done); r.appendChild(unpick);
    // Once the batch has items, the bar carries the batch action too — the
    // user does not have to look away from the element to submit everything
    // (the dock Submit stays for the no-draft states).
    if(items.length){
      var sendAll=el('button','oa-dock-btn oa-dock-btn--primary oa-live-send-all','Send all ('+items.length+')'); sendAll.type='button';
      sendAll.onclick=handleSubmit;
      r.appendChild(sendAll);
    }
    // focus the input after the bar lands
    setTimeout(function(){ var f=abar.querySelector('.oa-live-freeform'); if(f) f.focus(); },0);
    return r;
  }
  // EDITING action bar: Save asks the frame to validate + postMessage the
  // ops; Cancel restores the original texts and returns to the prompt row.
  function buildEditRow(){
    var r=el('div','oa-live-row');
    var save=el('button','oa-dock-btn oa-dock-btn--primary','Save'); save.type='button'; save.title='Save the edited text';
    save.onclick=function(){ toFrame({type:'oa:live:edit:save'}); };
    var cancel=el('button','oa-dock-btn','Cancel'); cancel.type='button'; cancel.title='Discard edits and go back';
    cancel.onclick=function(){ toFrame({type:'oa:live:edit:cancel'}); setState('COMPOSE'); };
    r.appendChild(save); r.appendChild(cancel);
    return r;
  }
  function commitDraft(prompt){
    if(!draft) return;
    var text=String(prompt||'').trim();
    if(!text){
      // An empty instruction must not ship to the agent — keep the draft open
      // and tell the user what's missing (the Add button is disabled anyway;
      // this guards Enter).
      if(window.__oaShowError)window.__oaShowError('Type a change first');
      return;
    }
    items.push({element:draft.element, prompt:text, rect:draft.rect});
    draft=null;
    // Back to picking the next element; the prompt lock is over.
    setState('PICKING');
    toFrame({type:'oa:live:pick:arm'});
  }
  // Ask the frame for the annotations (comment pins + strokes) drawn over the
  // picked element. The frame replies oa:live:annot:data echoing the request
  // token; if it never does (no overlay ever shown), fall back after 1.5s so a
  // stalled frame can't block the submit. The token stops a slow reply from a
  // previous submit satisfying a newer one's listener.
  function collectAnnots(cb){
    var done=false, req=genId();
    function onMsg(e){
      if(done) return;
      if(e.source!==frame.contentWindow) return;
      var d=e.data; if(!d||d.type!=='oa:live:annot:data'||d.req!==req) return;
      done=true; window.removeEventListener('message',onMsg);
      cb(d);
    }
    window.addEventListener('message',onMsg);
    toFrame({type:'oa:live:annot:collect', req:req});
    setTimeout(function(){ if(!done){ done=true; window.removeEventListener('message',onMsg); cb(null); } },1500);
  }
  function handleSubmit(){
    // If a draft prompt is typed but not committed, commit it first.
    var ff=abar.querySelector('.oa-live-freeform');
    if(draft && ff && ff.value.trim()){ commitDraft(ff.value); }
    if(!items.length){ return; }
    // One batch per submit: a second click while an edit is in flight would
    // re-send the same items as a duplicate generate event.
    if(state==='GENERATING'||state==='WORKING'){ return; }
    sessionId=genId();
    // A generate-done must not inherit a stale edit-done classification: the
    // lastSubmitType fallback only applies to the event this submit produces.
    lastSubmitType=null;
    setState('GENERATING');
    // The user's comment pins/strokes ride the generate event (live.md):
    // the agent sees them with the change. Omit both when empty.
    collectAnnots(function(annot){
      var payload={type:'generate', id:sessionId, items:items};
      if(annot){
        var hasAnnot=(annot.comments&&annot.comments.length)||(annot.strokes&&annot.strokes.length);
        if(hasAnnot){
          payload.comments=annot.comments||[];
          payload.strokes=annot.strokes||[];
        }
      }
      send(payload);
      // If no agent picks up within ACK_TIMEOUT, show a hint instead of
      // spinning forever — the user likely forgot to start the CLI watcher.
      clearTimeout(ackTimer);
      ackTimer=setTimeout(function(){ if(state==='GENERATING') setState('STALLED'); }, ACK_TIMEOUT);
    });
  }

  // --- WebSocket ---
  function connect(){
    // Idempotent against concurrent callers: the toggle's reopen reconnect can
    // race a pending onclose auto-reconnect (1s timer) when the ws dies while
    // non-IDLE. Bail if a socket is already open or connecting so we don't
    // orphan it - connect() reassigns ws without closing the prior one.
    if(ws && ws.readyState<=1) return;
    try{ ws=new WebSocket(cfg.wsUrl); }catch(e){ setTimeout(connect,1000); return; }
    ws.onopen=function(){ wsReady=true; };
    ws.onmessage=function(e){
      var msg; try{ msg=JSON.parse(e.data); }catch(err){ return; }
      // 'ack' = agent picked up the event, is editing. Clear the stall timer.
      if(msg.type==='ack'){ clearTimeout(ackTimer); setState('WORKING'); }
      // 'done' = the agent finished editing + republished. Reload the frame.
      else if(msg.type==='done'){
        clearTimeout(ackTimer);
        // This done owns the reload (below) — cancel the version branch's
        // fallback timer if one is pending for the same publish.
        versionSeenAt=0;
        // An edit-done is decided by the protocol payload — the canonical
        // reply JSON always carries appliedEntryIds (possibly an empty array
        // when status:'error' also rides a done broadcast), so Array.isArray
        // is the truth — with lastSubmitType as a fallback for older agents.
        var isEditDone=Array.isArray(msg.appliedEntryIds)||lastSubmitType==='edit';
        setState('CONFIRMED');
        if(isEditDone){
          var applied=Array.isArray(msg.appliedEntryIds)?msg.appliedEntryIds.length:0;
          var failed=Array.isArray(msg.failed)?msg.failed.length:0;
          var summary='✓ Applied '+applied+' edit'+(applied===1?'':'s');
          if(failed)summary+=' — '+failed+' failed, re-edit them';
          statusEl.innerHTML=summary;
          statusEl.hidden=false;
          queuedEditId=null;
          refreshStash();
        }
        setTimeout(restartAfterEdit,1200);
      }
      else if(msg.type==='error'){ clearTimeout(ackTimer); setState(draft?'COMPOSE':'PICKING'); }
      // 'version' = a new version was published (ordinary update or Live
      // in-place replace). In the interactive flow the agent republishes and
      // then replies done ~1-3s later — done owns that reload (exactly one
      // per edit, as before this feature), so here it only arms a fallback:
      // if no done lands within the window the publish had no live reply
      // (another session, or no live session), and the staying viewer
      // refreshes in place (the frame src has no version param and is
      // no-cache, so a reload picks up the new version). Guarded: a pinned
      // ?v= view never jumps; mid-work (compose prompt open or inline text
      // editing) the user is told instead of losing unsaved work.
      else if(msg.type==='version'){
        if(/[?&]v=/.test(window.location.search)) return;
        if(draft||state==='EDITING'||state==='COMPOSE'){ if(window.__oaShowInfo)window.__oaShowInfo('New version published — Save or cancel your edit to see it'); return; }
        // A second publish inside the window is covered by the pending
        // fallback timer — don't stack timers.
        if(versionSeenAt&&Date.now()-versionSeenAt<VERSION_DONE_WINDOW_MS) return;
        versionSeenAt=Date.now();
        setTimeout(function(){
          if(!versionSeenAt) return; // a done landed and owned the reload
          versionSeenAt=0;
          reloadFrame();
          if(!root.hidden) pendingRearm=true;
        },VERSION_DONE_WINDOW_MS+1200);
      }
    };
    ws.onclose=function(){ wsReady=false; setTimeout(function(){ if(state!=='IDLE') connect(); },1000); };
  }

  function reloadFrame(){ try{ if(frame.contentWindow) frame.contentWindow.location.reload(); }catch(e){ /* cross-origin: fall back to src resubmit */ frame.src=frame.src; } }

  // --- host<->frame bridge ---
  window.addEventListener('message', function(e){
    if(!e.data||typeof e.data.type!=='string') return;
    if(e.source!==frame.contentWindow) return;
    var d=e.data;
    if(d.type==='oa:element:picked'){ draft={element:d.element, rect:(d.element&&d.element.rect)||d.rect||null}; toFrame({type:'oa:live:pick:lock'}); setState('COMPOSE'); }
    // The frame reports oa:ready on every load. After an edit we reloaded it to
    // show the new version; arm pick now that its listener is back (a fresh
    // frame defaults to disarmed, and arming synchronously would race the
    // reload and be lost).
    else if(d.type==='oa:ready'){
      if(pendingRearm){ pendingRearm=false; if(!root.hidden){ toFrame({type:'oa:live:pick:arm'}); toFrame({type:'oa:live:annot:enable'}); } }
      else if(!root.hidden&&state==='PICKING'&&!draft){ toFrame({type:'oa:live:pick:arm'}); toFrame({type:'oa:live:annot:enable'}); }
    }
    // Inline copy edits: the frame validated + captured the changed rows and
    // replies with the ops; stage them server-side (the pill appears), then
    // re-arm pick for the next element. Empty ops = the user changed nothing.
    else if(d.type==='oa:live:edit:data'){
      var ops=Array.isArray(d.ops)?d.ops:[];
      var elCtx=d.element;
      if(ops.length&&elCtx){
        var eref=elCtx.id||(elCtx.classes&&elCtx.classes.length?elCtx.classes.join('.'):null)||elCtx.tagName||'element';
        fetch('/api/artifacts/'+encodeURIComponent(cfg.artifactId)+'/live/edit-stash',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({pageUrl:window.location.pathname,ref:eref,element:elCtx,ops:ops})})
          .then(function(r){ if(!r.ok) throw 0; return r.json(); })
          .then(function(){ refreshStash(); if(window.__oaShowSuccess)window.__oaShowSuccess('Saved. Click Apply copy edits to write changes.'); })
          .catch(function(){ if(window.__oaShowError)window.__oaShowError('Failed to save the copy edits'); });
      }else if(window.__oaShowInfo){
        window.__oaShowInfo('No changes to save');
      }
      draft=null;
      setState('PICKING');
      toFrame({type:'oa:live:pick:arm'});
    }
    else if(d.type==='oa:live:edit:none'){ if(window.__oaShowInfo)window.__oaShowInfo('No editable text in this element'); setState('COMPOSE'); }
    else if(d.type==='oa:live:edit:rejected'){ if(window.__oaShowError)window.__oaShowError('Edit rejected: '+(d.reason||'plain text only — no markup')); }
  });

  // --- global bar ---
  // The Pick control (#oa-live-pick-toggle) is a display-only indicator, not a
  // button - no click handler. Pick is armed on open, locked while the prompt
  // is open, and re-armed after each committed item; the indicator's static
  // --active tint reflects the Live session.
  var exitArmed=null;
  function exitLive(){
    // A prompt batch is lost on exit — arm a confirm when one exists (same
    // vocabulary as Apply/Discard); with no items, Exit closes immediately.
    if(items.length&&!exitArmed){
      exitBtn.querySelector('.oa-dock-label').textContent='Discard '+items.length+' changes?';
      exitBtn.classList.add('oa-dock-btn--danger');
      exitArmed=setTimeout(function(){ exitArmed=null; exitBtn.querySelector('.oa-dock-label').textContent='Exit'; exitBtn.classList.remove('oa-dock-btn--danger'); },4000);
      return;
    }
    if(exitArmed){ clearTimeout(exitArmed); exitArmed=null; }
    // Route through the dock manager so active-state, focus restore, and
    // mutual-exclusion bookkeeping stay consistent with the header toggle.
    // closeLive is a no-op when already closed.
    if(window.__oaDock) window.__oaDock.close('live'); else closeLive();
  }
  exitBtn.onclick=exitLive;

  function reset(){
    state='IDLE'; items=[]; draft=null; pendingRearm=false; lastSubmitType=null;
    // Restore the Exit control if a batch confirm was armed.
    if(exitArmed){ clearTimeout(exitArmed); exitArmed=null; }
    exitBtn.querySelector('.oa-dock-label').textContent='Exit';
    exitBtn.classList.remove('oa-dock-btn--danger');
    renderBar(); abar.hidden=true;
    toFrame({type:'oa:live:pick:disarm'});
    // A closing session must not leave the frame in edit mode: restore the
    // original texts (the frame's disableEditMode(true) unwraps + restores).
    toFrame({type:'oa:live:edit:cancel'});
  }
  // After a successful edit the frame reloads to show the new version. Clear
  // the batch and return to PICKING - arming the next-item picker once the
  // reloaded frame reports ready (a fresh frame defaults to disarmed; arming
  // synchronously would race the reload and be lost). If the user exited
  // during the CONFIRMED window the dock is hidden: still reload (to show the
  // new version) but skip the re-arm - state stays IDLE from closeLive, so
  // reopening arms cleanly instead of stranding on a stale PICKING state.
  function restartAfterEdit(){ reloadFrame(); if(root.hidden) return; items=[]; draft=null; pendingRearm=true; setState('PICKING'); }

  connect();
})();
`;

// Close-X glyph for the live global bar's Exit button.
// (CLOSE_SVG is imported from ./handoff/svgs and shared with the handoff dock.)

// Handoff record/play chrome. The dock (bottom-center pill, the Live dock
// language) holds the Record button + handoff list in IDLE, Stop/timer/Cancel
// while RECORDING, and Play/Pause/scrub/Exit while PLAYING. The webcam <video>
// is a fixed corner overlay - mirrored during recording (selfie), unmirrored
// during playback. Quiet chrome, single --accent + --danger, both themes,
// visible focus rings, no decorative motion (the rec dot blink is informational).
// The CSS lives in src/handoff/styles.ts so the dock's styles and its JS share
// one home; B1 (Deploy Console restyle) replaces the generic rules there.

// The inlined handoff list is serve-time JSON (the comments/version-picker
// pattern) so the play UI can list recordings with no runtime fetch from the
// sandboxed frame. Only public fields cross - never the delete-token hash.
function handoffChromeHtml(
  artifactId: string,
  handoffs: HandoffMeta[],
  currentVersion: number,
): string {
  // One handoff per artifact+version: inline the recording pinned to the
  // viewed version (or null) so the dock renders Record-when-absent /
  // Play-Re-record-when-present for that version. The version picker does a
  // full page reload, so the host re-inlines on each version switch and the
  // dock shows the right recording. The array stays server-side for the
  // list API; the host only inlines the viewed version's recording.
  const current = handoffs.find((h) => h.version === currentVersion) ?? null;
  const publicSingle = current
    ? {
        id: current.id,
        version: current.version,
        durationMs: current.durationMs,
        hasVideo: current.hasVideo,
        hasAudio: current.hasAudio,
        hasBlur: current.hasBlur,
        author: current.author,
        createdAt: current.createdAt,
      }
    : null;
  return `<div id="oa-handoff-root" hidden>
  <div id="oa-handoff-status" role="status" aria-live="polite" hidden></div>
  <div id="oa-handoff-dock">
    <div id="oa-handoff-controls" role="toolbar" aria-label="Handoff recording"></div>
  </div>
  <video id="oa-handoff-cam" hidden playsinline></video>
  <canvas id="oa-handoff-cam-canvas" hidden></canvas>
  <div id="oa-handoff-countdown" aria-hidden="true"></div>
  <script type="application/json" id="oa-handoff-data" data-artifact-id="${escapeHtml(artifactId)}">${jsonForInlineScript(publicSingle)}</script>
</div>`;
}

// Host-side handoff controller: getUserMedia + MediaRecorder (the sandboxed
// frame cannot), arms the frame record shim over postMessage, buffers events,
// uploads multipart on stop, and drives playback (fetch media -> blob URL ->
// <video>, fetch events -> frame play shim). Recording is write-gated: the
// owner write token is reused from the comments ?wt= storage (oa-cm-wt-<id>),
// or the session cookie authorizes on a SaaS deploy. The author delete token
// is stored per handoff (oa-handoff-dt-<hid>) so the recorder can delete their
// own. Visual-only playback: the frame draws a synthetic cursor + ripples +
// scroll, never real DOM events.
// The host-side handoff controller now lives in src/handoff/ (split into
// focused modules) and is assembled by handoffScript(). The original inline
// ~550-line HANDOFF_SCRIPT template literal was moved there so each concern is
// small and individually syntax-checkable (tests/worker/handoff-script.test.ts).

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
    brand,
    branded,
    brandUrl,
    artifactId,
    frameSrc,
    nonce,
    versions,
    currentVersion,
    canManage = false,
    visibility = "public",
    liveEnabled = false,
    liveWsUrl = "",
    handoffEnabled = false,
  } = options;
  const ogDescription = description || title;
  const commentsList = options.comments ?? [];
  const handoffList = options.handoffs ?? [];
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
<style>${RESET_CSS}${TOAST_CSS}${COMMENTS_CSS}${liveEnabled || handoffEnabled ? DOCK_CSS : ""}${liveEnabled ? LIVE_CSS : ""}${handoffEnabled ? HANDOFF_CSS : ""}${ACCOUNT_CSS}${HOST_FRAME_CSS}</style>
</head>
<body>
<div class="oa-toast-container" id="oa-toast-container" role="status" aria-live="polite" aria-atomic="false"></div>
${headerHtml(favicon, title, brand, branded, brandUrl, versions, currentVersion, url, artifactId, openCommentsCount(commentsList), canManage, visibility, liveEnabled, handoffEnabled)}
<div class="oa-loading" id="oa-loading" aria-label="Loading artifact" role="status"><div class="oa-loading-spin"></div></div>
<iframe id="oa-frame" src="${escapeHtml(frameSrc)}" sandbox="allow-scripts allow-modals allow-forms allow-popups" title="${escapeHtml(title)}" fetchpriority="high"></iframe>
${drawer}
${liveEnabled ? liveChromeHtml(liveWsUrl ?? "", artifactId, canManage) : ""}
${handoffEnabled ? handoffChromeHtml(artifactId, handoffList, Number(currentVersion ?? 1)) : ""}
${commentsDataScript(commentsList)}
<script nonce="${nonce}">window.__oaViewedVersion=${Number(currentVersion ?? 1)};window.__oaCanManage=${canManage};</script>
<script nonce="${nonce}">${TOAST_SCRIPT}</script>
<script nonce="${nonce}">${VERSION_SCRIPT}</script>
<script nonce="${nonce}">${THEME_SCRIPT}</script>
<script nonce="${nonce}">${LAYOUT_SCRIPT}</script>
<script nonce="${nonce}">${HEADER_SCRIPT}</script>
<script nonce="${nonce}">${escapeInlineScript(COMMENTS_SCRIPT)}</script>
<script nonce="${nonce}">${escapeInlineScript(hostBridgeScript(artifactId))}</script>
<script nonce="${nonce}">${VISIBILITY_SCRIPT}</script>
<script nonce="${nonce}">${escapeInlineScript(HOST_UI_SCRIPT)}</script>
<script nonce="${nonce}">${escapeInlineScript(ACCOUNT_SCRIPT)}</script>
${liveEnabled || handoffEnabled ? `<script nonce="${nonce}">${escapeInlineScript(DOCK_SCRIPT)}</script>` : ""}
${liveEnabled ? `<script nonce="${nonce}">${escapeInlineScript(LIVE_SCRIPT)}</script>` : ""}
${handoffEnabled ? `<script nonce="${nonce}">${escapeInlineScript(handoffScript(HANDOFF_SVGS))}</script>` : ""}
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
  var transitioning=false;
  function open(){
    if(transitioning)return;
    transitioning=true;
    drawer.setAttribute('data-open','');
    drawer.setAttribute('aria-hidden','false');
    toggle.setAttribute('aria-expanded','true');
    setTimeout(function(){transitioning=false},180);
  }
  function shut(){
    if(transitioning)return;
    transitioning=true;
    drawer.removeAttribute('data-open');
    drawer.setAttribute('aria-hidden','true');
    toggle.setAttribute('aria-expanded','false');
    setTimeout(function(){transitioning=false},180);
  }
  toggle.addEventListener('click',function(){
    if(drawer.hasAttribute('data-open')){shut();return;}
    // Close the active dock (Live/Handoff) when opening comments — mutual
    // exclusion in the other direction.
    if(window.__oaDock&&window.__oaDock.getActive())window.__oaDock.close(window.__oaDock.getActive());
    open();
  });
  if(closeBtn)closeBtn.addEventListener('click',shut);
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&drawer.hasAttribute('data-open')){
      var textarea=drawer.querySelector('textarea');
      if(textarea&&textarea.value&&textarea.value.trim().length>0)return;
      shut();
    }
  });
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

// Live element picker, running inside the sandboxed artifact frame. The host
// page cannot reach into the opaque-origin frame's DOM, so the picker lives
// here and is armed/disarmed by host postMessage. On pick, sends the element's
// context (tagName/id/classes/outerHTML/computedStyles/etc.) + its viewport
// rect so the host can float the action bar next to it — NOT a CSS selector,
// the agent matches it in source by id->class->tag. The agent edits source
// and republishes; the host reloads the frame to show the result. No variant
// cycling, no wrapper injection — Live is a one-shot edit-and-reload.
const FRAME_LIVE_PICKER_SCRIPT = `
(function(){
  if(!window.__oaSend)return;
  var PREFIX='impeccable-live';
  var armed=false, annotEnabled=false, picked=null, hovered=null;
  var highlight=null, annotSvg=null, annotPins=null;
  var annotState={comments:[],strokes:[]};
  var DRAG_THRESHOLD=5;
  var TAGS_SKIP=new Set(['SCRIPT','STYLE','LINK','META','HEAD','SVG','PATH']);
  function own(el){return el&&(el.id&&el.id.indexOf(PREFIX)===0)|| (el.closest&&el.closest('[id^="'+PREFIX+'"]'));}
  function pickable(el){
    if(!el||el.nodeType!==1)return false;
    if(TAGS_SKIP.has(String(el.tagName||'').toUpperCase()))return false;
    if(own(el))return false;
    var r=el.getBoundingClientRect();
    return r.width>=20&&r.height>=20;
  }
  function showHighlight(el){
    if(!highlight){
      highlight=document.createElement('div');
      highlight.id=PREFIX+'-highlight';
      highlight.style.cssText='position:fixed;pointer-events:none;z-index:100001;border:2px solid var(--oa-accent);background:color-mix(in oklab,var(--oa-accent),transparent 92%);transition:opacity .1s';
      document.body.appendChild(highlight);
    }
    var r=el.getBoundingClientRect();
    highlight.style.left=r.left+'px';highlight.style.top=r.top+'px';
    highlight.style.width=r.width+'px';highlight.style.height=r.height+'px';
    highlight.style.display='block';
  }
  function hideHighlight(){ if(highlight)highlight.style.display='none'; }
  function extractContext(el){
    var cs=getComputedStyle(el), r=el.getBoundingClientRect();
    var p=el.parentElement;
    return {tagName:el.tagName.toLowerCase(), id:el.id||null, classes:[].slice.call(el.classList), textContent:(el.textContent||'').slice(0,500), outerHTML:el.outerHTML.slice(0,10000), computedStyles:{'font-family':cs.fontFamily,'font-size':cs.fontSize,'color':cs.color,'background':cs.backgroundColor,'border-radius':cs.borderRadius,'box-shadow':cs.boxShadow}, parentContext:p?('<'+p.tagName.toLowerCase()+(p.id?' #'+p.id:'')+('')+'>'):'', boundingRect:{width:Math.round(r.width),height:Math.round(r.height)}, rect:{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}};
  }
  function onMove(e){
    if(!armed)return;
    var t=document.elementFromPoint(e.clientX,e.clientY);
    if(!t||!pickable(t)||t===hovered)return;
    hovered=t; showHighlight(t);
  }
  function pickAt(el){
    picked=el;
    // Lock immediately so a second click cannot replace this draft while the
    // host is opening the prompt. Keep picked/annotation state for submit.
    lock();
    showHighlight(picked);
    // Annotation overlay: create over the first pick, reposition on later
    // picks so pins/strokes stay over the element the user is describing.
    if(annotEnabled){ if(annotSvg) positionAnnot(picked); else showAnnot(picked); }
    window.__oaSend({type:'oa:element:picked', element:extractContext(picked)});
  }
  function onClick(e){
    if(!armed)return;
    if(own(e.target))return;
    if(!hovered||!pickable(hovered))return;
    e.preventDefault();e.stopPropagation();
    pickAt(hovered);
  }
  // Touch taps fire no mousemove before the click, so hovered stays null and
  // the click path bails — select directly on pointerdown for touch pointers.
  function onPointerDown(e){
    if(!armed||e.pointerType!=='touch')return;
    var t=e.target;
    if(own(t)||!pickable(t))return;
    e.preventDefault();e.stopPropagation();
    pickAt(t);
  }
  function onKey(e){
    if(!armed)return;
    var nav=armed?hovered:null;
    if(nav&&(e.key==='ArrowUp'||e.key==='ArrowDown')){
      var next=null;
      if(e.key==='ArrowDown'&&!e.shiftKey){next=nav.nextElementSibling;while(next&&!pickable(next))next=next.nextElementSibling;}
      else if(e.key==='ArrowUp'&&!e.shiftKey){next=nav.previousElementSibling;while(next&&!pickable(next))next=nav.previousElementSibling;}
      else if(e.key==='ArrowUp'&&e.shiftKey){next=nav.parentElement;}
      else if(e.key==='ArrowDown'&&e.shiftKey){next=nav.firstElementChild;}
      if(next){e.preventDefault();hovered=next;showHighlight(next);next.scrollIntoView({block:'nearest',behavior:'smooth'});}
    }
  }
  function lock(){
    armed=false;
    hovered=null;
    document.removeEventListener('mousemove',onMove,true);
    document.removeEventListener('click',onClick,true);
    document.removeEventListener('pointerdown',onPointerDown,true);
    document.removeEventListener('keydown',onKey,true);
  }
  function arm(){
    armed=true;
    document.addEventListener('mousemove',onMove,true);
    document.addEventListener('click',onClick,true);
    document.addEventListener('pointerdown',onPointerDown,true);
    document.addEventListener('keydown',onKey,true);
  }
  function disarm(){
    lock();
    hideHighlight();
    // Tear the annotation overlay down so a closed Live session never leaves
    // pointer-grabbing chrome over the artifact, and clear session state so a
    // reopened Live never resurrects a stale picked element or overlay.
    if(annotSvg){ annotSvg.remove(); annotSvg=null; }
    if(annotPins){ annotPins.remove(); annotPins=null; }
    annotState.comments=[]; annotState.strokes=[]; drawing=false; curStroke=null;
    // A closing session must not leave contenteditable rows in the artifact —
    // restore the original texts and unwrap the mixed-content markers.
    if(editRoot)disableEditMode(true);
    picked=null; hovered=null; annotEnabled=false;
  }
  // Annotation overlay: SVG strokes + comment pins over the picked element.
  function showAnnot(el){
    if(annotSvg)return;
    annotSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    annotSvg.style.cssText='position:absolute;z-index:100002;pointer-events:none';
    annotPins=document.createElement('div'); annotPins.style.cssText='position:absolute;z-index:100002';
    document.body.appendChild(annotSvg); document.body.appendChild(annotPins);
    positionAnnot(el);
    annotSvg.style.pointerEvents='auto';
    annotSvg.addEventListener('pointerdown',onAnnotDown);
    annotSvg.addEventListener('pointermove',onAnnotMove);
    annotSvg.addEventListener('pointerup',onAnnotUp);
  }
  function positionAnnot(el){
    var r=el.getBoundingClientRect();
    annotSvg.style.left=r.left+'px';annotSvg.style.top=r.top+'px';annotSvg.setAttribute('width',r.width);annotSvg.setAttribute('height',r.height);
    annotPins.style.left=r.left+'px';annotPins.style.top=r.top+'px';
  }
  function localCoords(e){ var r=annotSvg.getBoundingClientRect(); return [e.clientX-r.left, e.clientY-r.top]; }
  var drawing=false, curStroke=null;
  function onAnnotDown(e){ var p=localCoords(e); if(Math.abs(e.movementX||0)<DRAG_THRESHOLD&&Math.abs(e.movementY||0)<DRAG_THRESHOLD){ dropPin(p); } else { drawing=true; curStroke={points:[p]}; } }
  function onAnnotMove(e){ if(!drawing||!curStroke)return; var p=localCoords(e); curStroke.points.push(p); redrawStrokes(); }
  function onAnnotUp(e){ if(drawing&&curStroke){ annotState.strokes.push(curStroke); drawing=false; curStroke=null; } }
  function dropPin(p){ var id='pin_'+Date.now(); annotState.comments.push({x:p[0],y:p[1],text:''}); redrawPins(); }
  function redrawStrokes(){ if(!annotSvg)return; var ns='http://www.w3.org/2000/svg'; while(annotSvg.firstChild)annotSvg.removeChild(annotSvg.firstChild); annotState.strokes.concat(curStroke?[curStroke]:[]).forEach(function(s){ var p=document.createElementNS(ns,'path'); var d=s.points.map(function(pt,i){return (i?'L':'M')+pt[0]+' '+pt[1];}).join(' '); p.setAttribute('d',d); p.style.stroke='var(--oa-accent)'; p.setAttribute('stroke-width','3'); p.setAttribute('fill','none'); p.setAttribute('stroke-linecap','round'); annotSvg.appendChild(p); }); }
  function redrawPins(){ if(!annotPins)return; annotPins.innerHTML=''; annotState.comments.forEach(function(c){ var d=document.createElement('div'); d.style.cssText='position:absolute;left:'+(c.x-9)+'px;top:'+(c.y-9)+'px;width:18px;height:18px;border-radius:50% 50% 50% 2px;background:var(--oa-accent);'; annotPins.appendChild(d); }); }
  // --- annotation collection (host asks on submit) ---
  function sendAnnots(req){
    // Include the in-progress stroke: redrawStrokes renders it live, so a
    // submit mid-drag must not silently drop what the user sees on screen.
    var strokes=annotState.strokes.concat(drawing&&curStroke?[curStroke]:[]);
    window.__oaSend({type:'oa:live:annot:data', req:req, comments:annotState.comments.slice(), strokes:strokes});
  }

  // --- inline text editing (impeccable-style manual copy edits) ---
  // The host arms edit mode on the picked element: pure-text leaf rows become
  // contenteditable with a data-original-text snapshot; mixed-content nodes
  // get marker spans first so their text can be edited too. input events fill
  // a drafts map; Save validates (plain text only) and postMessages the
  // changed ops; the host stages them server-side for a batch Apply. Escape
  // restores the original texts without leaving edit mode.
  var MIXED_WRAP_SKIP=new Set(['SCRIPT','STYLE','TEMPLATE','NOSCRIPT','SVG','CODE','PRE']);
  var editRoot=null, editRows=null, editDrafts=null, editStyleEl=null;
  // Editable rows get a dashed outline affordance + a solid focus ring, so
  // the user (and a keyboard user's focus) can tell which rows are editable.
  // Injected as a <style> — the frame CSP allows style-src 'unsafe-inline'.
  function ensureEditStyle(){
    if(editStyleEl)return;
    editStyleEl=document.createElement('style');
    editStyleEl.id=PREFIX+'-edit-style';
    editStyleEl.textContent='[data-oa-editable]{outline:1px dashed color-mix(in oklab,var(--oa-accent,#6457f0),transparent 45%);outline-offset:2px;border-radius:2px;cursor:text}[data-oa-editable]:focus-visible{outline:2px solid var(--oa-accent,#6457f0);outline-offset:1px}';
    document.head.appendChild(editStyleEl);
  }
  // Pasted rich content is stripped to plain text so no markup enters a row
  // (Save's plain-text validation would otherwise reject the whole batch).
  function onEditPaste(e){
    var el=e.target;
    if(!el||el.nodeType!==1||el.getAttribute('contenteditable')!=='true')return;
    var cd=e.clipboardData||window.clipboardData, text='';
    if(cd){
      text=cd.getData('text/plain');
      if(!text){
        var html=cd.getData('text/html');
        if(html){ var tmp=document.createElement('div'); tmp.innerHTML=html; text=tmp.textContent||''; }
      }
    }
    if(!text)return;
    e.preventDefault();
    var sel=window.getSelection();
    if(!sel||!sel.rangeCount){ try{el.focus();}catch(err){} sel=window.getSelection(); }
    if(!sel||!sel.rangeCount)return;
    sel.deleteFromDocument();
    var node=document.createTextNode(text);
    var range=sel.getRangeAt(0);
    range.insertNode(node);
    range.setStartAfter(node); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    // insertNode does not fire 'input' — record the draft directly.
    for(var i=0;i<editRows.length;i++){
      if(editRows[i].el===el){ editDrafts[i]=el.textContent; break; }
    }
  }
  function wrapMixedTextNodes(root){
    var walk=[root];
    while(walk.length){
      var el=walk.pop();
      if(!el||el.nodeType!==1)continue;
      if(MIXED_WRAP_SKIP.has(String(el.tagName||'').toUpperCase()))continue;
      var textNodes=[];
      for(var i=0;i<el.childNodes.length;i++){
        var n=el.childNodes[i];
        if(n.nodeType===3&&n.textContent.trim())textNodes.push(n);
      }
      // Mixed content (text + element children): wrap each text node so the
      // row becomes addressable (a row is an element whose children are ALL
      // text nodes).
      if(textNodes.length&&textNodes.length<el.childNodes.length){
        for(var j=0;j<textNodes.length;j++){
          var s=document.createElement('span');
          s.setAttribute('data-oa-text-wrap','1');
          var t=textNodes[j];
          t.parentNode.insertBefore(s,t);
          s.appendChild(t);
        }
      }
      for(var k=0;k<el.children.length;k++)walk.push(el.children[k]);
    }
  }
  function unwrapMixedTextNodes(root){
    var spans=root.querySelectorAll('[data-oa-text-wrap]');
    for(var i=0;i<spans.length;i++){
      var s=spans[i], p=s.parentNode;
      while(s.firstChild)p.insertBefore(s.firstChild,s);
      p.removeChild(s);
    }
  }
  function collectEditableTextRows(root){
    var rows=[];
    (function walk(el){
      if(!el||el.nodeType!==1)return;
      if(MIXED_WRAP_SKIP.has(String(el.tagName||'').toUpperCase()))return;
      var kids=el.childNodes, hasText=false, allText=kids.length>0;
      for(var i=0;i<kids.length;i++){
        if(kids[i].nodeType===3){ if(kids[i].textContent.trim())hasText=true; }
        else allText=false;
      }
      if(hasText&&allText){
        rows.push({el:el, text:el.textContent});
        return; // leaf row; do not descend
      }
      for(var j=0;j<el.children.length;j++)walk(el.children[j]);
    })(root);
    return rows;
  }
  function rowRef(el){
    return el.id||[].slice.call(el.classList).join('.')||String(el.tagName).toLowerCase();
  }
  function onEditInput(e){
    for(var i=0;i<editRows.length;i++){
      if(editRows[i].el===e.currentTarget){ editDrafts[i]=e.currentTarget.textContent; break; }
    }
  }
  function enableEditMode(root){
    if(editRoot||!root)return;
    editRoot=root;
    wrapMixedTextNodes(root);
    var rows=collectEditableTextRows(root);
    if(!rows.length){
      unwrapMixedTextNodes(root);
      editRoot=null;
      window.__oaSend({type:'oa:live:edit:none'});
      return;
    }
    editRows=rows;
    editDrafts={};
    ensureEditStyle();
    editRoot.addEventListener('paste',onEditPaste,true);
    rows.forEach(function(row,i){
      row.el.setAttribute('contenteditable','true');
      row.el.setAttribute('data-original-text',row.text);
      row.el.setAttribute('data-oa-row',String(i));
      row.el.setAttribute('data-oa-editable','');
      row.el.addEventListener('input',onEditInput);
    });
    // The annotation overlay sits over the picked element with pointer events
    // on — it would swallow the clicks that edit the text rows underneath.
    if(annotSvg)annotSvg.style.pointerEvents='none';
    // Focus the first row with the caret collapsed at the end; a focus throw
    // (rare engine quirk) must not leave edit mode half-armed.
    try{
      if(rows[0].el.focus)rows[0].el.focus();
      var sel=window.getSelection();
      if(sel){ sel.selectAllChildren(rows[0].el); sel.collapseToEnd(); }
    }catch(e){}
  }
  function disableEditMode(restore){
    if(!editRoot)return;
    editRows.forEach(function(row,i){
      if(restore&&editDrafts&&editDrafts[i]!==undefined){
        row.el.textContent=row.el.getAttribute('data-original-text')||'';
      }
      row.el.removeAttribute('contenteditable');
      row.el.removeAttribute('data-original-text');
      row.el.removeAttribute('data-oa-row');
      row.el.removeAttribute('data-oa-editable');
      row.el.removeEventListener('input',onEditInput);
    });
    editRoot.removeEventListener('paste',onEditPaste,true);
    if(editStyleEl){ editStyleEl.remove(); editStyleEl=null; }
    unwrapMixedTextNodes(editRoot);
    if(annotSvg)annotSvg.style.pointerEvents='auto';
    editRoot=null; editRows=null; editDrafts=null;
  }
  function onEditKey(e){
    if(!editRoot||e.key!=='Escape')return;
    // Restore every edited row, stay in edit mode.
    editRows.forEach(function(row,i){
      if(editDrafts[i]!==undefined)row.el.textContent=row.el.getAttribute('data-original-text')||'';
    });
    editDrafts={};
  }
  function saveEdit(){
    if(!editRoot)return;
    // Snapshot the element context BEFORE tearing the edit mode down.
    var element=extractContext(editRoot);
    var ops=[];
    for(var i=0;i<editRows.length;i++){
      if(editDrafts[i]===undefined)continue; // unchanged row
      var row=editRows[i], candidate=row.el.textContent;
      if(!candidate.trim()){ rejectEdit('empty text'); return; }
      if(/[<{}\`]/.test(candidate)){ rejectEdit('plain text only — no < { } or backtick'); return; }
      var classes=[].slice.call(row.el.classList);
      var ref=rowRef(row.el);
      var originalText=row.el.getAttribute('data-original-text')||'';
      var op={ref:ref, tag:String(row.el.tagName).toLowerCase(), elementId:row.el.id||null, classes:classes, originalText:originalText, newText:candidate, leaf:{ref:ref, tag:String(row.el.tagName).toLowerCase(), id:row.el.id||null, classes:classes, originalText:originalText, newText:candidate, textContent:candidate, outerHTML:row.el.outerHTML.slice(0,5000)}, nearbyEditableTexts:editRows.map(function(r){return r.text;}).filter(function(t){return t!==originalText;})};
      ops.push(op);
    }
    disableEditMode(false);
    window.__oaSend({type:'oa:live:edit:data', element:element, ops:ops});
  }
  function rejectEdit(reason){
    window.__oaSend({type:'oa:live:edit:rejected', reason:reason});
  }
  document.addEventListener('keydown',onEditKey,true);

  // ONE message listener (the duplicate was merged — the second copy called
  // sendAnnots() without the request token, dropping the req on submits).
  window.addEventListener('message',function(e){
    if(e.source!==window.parent)return;
    var m=e.data; if(!m||typeof m!=='object')return;
    if(m.type==='oa:live:pick:arm')arm();
    else if(m.type==='oa:live:pick:lock')lock();
    else if(m.type==='oa:live:pick:disarm')disarm();
    else if(m.type==='oa:live:annot:enable'){annotEnabled=true;if(picked)showAnnot(picked);}
    else if(m.type==='oa:live:annot:collect')sendAnnots(m.req);
    else if(m.type==='oa:live:edit:arm')enableEditMode(picked);
    else if(m.type==='oa:live:edit:cancel')disableEditMode(true);
    else if(m.type==='oa:live:edit:save')saveEdit();
  });
})();
`;

// Handoff RECORD shim, running inside the sandboxed artifact frame. The host
// page cannot reach the opaque-origin frame's DOM, so the frame captures its
// own pointer + scroll events and postMessages them out with a timestamp (ms
// since arm). Alongside the legacy pixel values it stores normalized viewport
// coordinates and normalized scroll progress. Playback can therefore follow
// the same relative point when the recording and viewing windows have different
// sizes, aspect ratios, or responsive document heights. mousemove is
// rAF-throttled (~30fps); click/scroll fire at native rate. Capture-phase
// listeners only OBSERVE - no preventDefault - so the artifact behaves
// normally during recording. Inert until the host sends
// oa:handoff:record:arm; disarmed by oa:handoff:record:disarm.
export const FRAME_HANDOFF_RECORD_SCRIPT = `
(function(){
  if(!window.__oaSend)return;
  var armed=false, t0=0, raf=0, lastX=0, lastY=0, dirty=false, lastSend=0;
  var THROTTLE_MS=33;
  function now(){ return performance.now()-t0; }
  function curScroll(){ return { sx: window.scrollX||0, sy: window.scrollY||0 }; }
  function finite(n){ return typeof n==='number'&&isFinite(n)?n:0; }
  function clamp01(n){ return Math.max(0,Math.min(1,n)); }
  function viewport(){
    var d=document.documentElement||{}, b=document.body||{};
    var vw=finite(window.innerWidth)||finite(d.clientWidth)||1;
    var vh=finite(window.innerHeight)||finite(d.clientHeight)||1;
    var cw=finite(d.clientWidth)||vw, ch=finite(d.clientHeight)||vh;
    var dw=Math.max(cw,finite(d.scrollWidth),finite(b.scrollWidth));
    var dh=Math.max(ch,finite(d.scrollHeight),finite(b.scrollHeight));
    return {vw:vw,vh:vh,sxMax:Math.max(0,dw-cw),syMax:Math.max(0,dh-ch)};
  }
  function eventData(kind,x,y,sx,sy){
    var v=viewport(), px=finite(x), py=finite(y), psx=finite(sx), psy=finite(sy);
    var msg={type:'oa:handoff:event',t:Math.round(now()),kind:kind,x:px,y:py,sx:psx,sy:psy,
      vw:v.vw,vh:v.vh,sxMax:v.sxMax,syMax:v.syMax,
      nx:clamp01(px/v.vw),ny:clamp01(py/v.vh),
      nsx:v.sxMax?clamp01(psx/v.sxMax):0,nsy:v.syMax?clamp01(psy/v.syMax):0};
    if(kind==='resize'){msg.w=v.vw;msg.h=v.vh;}
    return msg;
  }
  function onMove(e){ if(!armed)return; lastX=e.clientX; lastY=e.clientY; dirty=true; }
  function onClick(e){ if(!armed)return; var s=curScroll(); window.__oaSend(eventData('click',e.clientX,e.clientY,s.sx,s.sy)); }
  function onScroll(){ if(!armed)return; var s=curScroll(); window.__oaSend(eventData('scroll',lastX,lastY,s.sx,s.sy)); }
  function onResize(){ if(!armed){return;} var s=curScroll(); window.__oaSend(eventData('resize',0,0,s.sx,s.sy)); }
  function tick(){
    if(!armed)return;
    var t=performance.now();
    if(dirty && t-lastSend>=THROTTLE_MS){ var s=curScroll(); window.__oaSend(eventData('move',lastX,lastY,s.sx,s.sy)); dirty=false; lastSend=t; }
    raf=requestAnimationFrame(tick);
  }
  function arm(){ if(armed)return; armed=true; t0=performance.now(); dirty=false; lastSend=0;
    document.addEventListener('mousemove',onMove,true);
    document.addEventListener('click',onClick,true);
    window.addEventListener('scroll',onScroll,true);
    window.addEventListener('resize',onResize);
    document.documentElement.classList.add('oa-handoff-recording');
    raf=requestAnimationFrame(tick);
    var s=curScroll(); window.__oaSend(eventData('scroll',lastX,lastY,s.sx,s.sy));
    window.__oaSend({type:'oa:handoff:record:ready'});
  }
  function disarm(){ if(!armed)return; armed=false;
    document.removeEventListener('mousemove',onMove,true);
    document.removeEventListener('click',onClick,true);
    window.removeEventListener('scroll',onScroll,true);
    window.removeEventListener('resize',onResize);
    document.documentElement.classList.remove('oa-handoff-recording');
    if(raf)cancelAnimationFrame(raf); raf=0;
  }
  window.addEventListener('message',function(e){
    if(e.source!==window.parent)return;
    var m=e.data; if(!m||typeof m!=='object')return;
    if(m.type==='oa:handoff:record:arm')arm();
    else if(m.type==='oa:handoff:record:disarm')disarm();
  });
})();
`;

// Handoff PLAY shim, inside the frame. Receives the recorded event stream from
// the host (the frame cannot fetch - connect-src 'none') and reproduces a
// synthetic cursor + click ripples + scroll, driven by its own rAF clock from
// t=0. Normalized viewport coordinates and scroll progress are mapped against
// the playback frame's current geometry, so a responsive layout can be viewed
// at a different size or aspect ratio without stretching the timeline's intent.
// Events from older recordings that lack geometry metadata use their original
// pixel values. The host starts the webcam <video> in the same tick so the two
// share a t=0; pause/resume/seek/stop are mirrored from the host controls.
// Visual-only: no real DOM events are dispatched, so replay can never navigate
// away or trigger destructive actions. Inert until oa:handoff:play arrives.
export const FRAME_HANDOFF_PLAY_SCRIPT = `
(function(){
  if(!window.__oaSend)return;
  var events=[], cursor=null, raf=0, offset=0, lastResume=0, playing=false, idx=0;
  var st=document.createElement('style');
  st.textContent='#oa-handoff-cursor{position:fixed;top:0;left:0;width:16px;height:16px;margin:-2px 0 0 -2px;border-radius:50%;background:var(--oa-accent,#6457f0);border:2px solid var(--oa-accent-on,#fff);box-shadow:0 0 0 2px color-mix(in oklab,var(--oa-accent,#6457f0),transparent 65%),0 2px 6px color-mix(in oklab,var(--oa-fg,#18181b),transparent 70%);pointer-events:none;z-index:2147483644;will-change:transform} .oa-handoff-ripple{position:fixed;border-radius:50%;border:2px solid var(--oa-accent,#6457f0);pointer-events:none;z-index:2147483643;animation:oa-handoff-ripple .6s ease-out forwards} @keyframes oa-handoff-ripple{0%{transform:scale(.5);opacity:.85}100%{transform:scale(2.4);opacity:0}} html.oa-handoff-recording{box-shadow:inset 0 3px 0 0 var(--oa-danger,#b42318)}';
  (document.head||document.documentElement).appendChild(st);
  function mkCursor(){ if(cursor)return; cursor=document.createElement('div'); cursor.id='oa-handoff-cursor'; document.body.appendChild(cursor); }
  function ripple(x,y){ var r=document.createElement('div'); r.className='oa-handoff-ripple'; r.style.left=(x-12)+'px'; r.style.top=(y-12)+'px'; r.style.width='24px'; r.style.height='24px'; document.body.appendChild(r); setTimeout(function(){ if(r.parentNode)r.parentNode.removeChild(r); },650); }
  function finite(n){ return typeof n==='number'&&isFinite(n)?n:0; }
  function clamp01(n){ return Math.max(0,Math.min(1,n)); }
  function viewport(){
    var d=document.documentElement||{}, b=document.body||{};
    var vw=finite(window.innerWidth)||finite(d.clientWidth)||1;
    var vh=finite(window.innerHeight)||finite(d.clientHeight)||1;
    var cw=finite(d.clientWidth)||vw, ch=finite(d.clientHeight)||vh;
    var dw=Math.max(cw,finite(d.scrollWidth),finite(b.scrollWidth));
    var dh=Math.max(ch,finite(d.scrollHeight),finite(b.scrollHeight));
    return {vw:vw,vh:vh,sxMax:Math.max(0,dw-cw),syMax:Math.max(0,dh-ch)};
  }
  function point(ev,v){
    var x=finite(ev.x), y=finite(ev.y);
    if(typeof ev.nx==='number'&&isFinite(ev.nx))x=clamp01(ev.nx)*v.vw;
    else if(typeof ev.vw==='number'&&isFinite(ev.vw)&&ev.vw>0)x=clamp01(x/ev.vw)*v.vw;
    if(typeof ev.ny==='number'&&isFinite(ev.ny))y=clamp01(ev.ny)*v.vh;
    else if(typeof ev.vh==='number'&&isFinite(ev.vh)&&ev.vh>0)y=clamp01(y/ev.vh)*v.vh;
    return {x:x,y:y};
  }
  function scrollPoint(ev,v){
    var sx=finite(ev.sx), sy=finite(ev.sy);
    if(typeof ev.nsx==='number'&&isFinite(ev.nsx))sx=clamp01(ev.nsx)*v.sxMax;
    else if(typeof ev.sxMax==='number'&&isFinite(ev.sxMax))sx=ev.sxMax?clamp01(sx/ev.sxMax)*v.sxMax:0;
    if(typeof ev.nsy==='number'&&isFinite(ev.nsy))sy=clamp01(ev.nsy)*v.syMax;
    else if(typeof ev.syMax==='number'&&isFinite(ev.syMax))sy=ev.syMax?clamp01(sy/ev.syMax)*v.syMax:0;
    return {sx:sx,sy:sy};
  }
  function apply(ev){
    var v=viewport();
    if(ev.kind==='scroll'||ev.kind==='resize'){ if(typeof ev.sx==='number'&&typeof ev.sy==='number'){var s=scrollPoint(ev,v);lastScroll=s;window.scrollTo(s.sx,s.sy);} }
    else if(ev.kind==='click'){ var p=point(ev,v); if(cursor)cursor.style.transform='translate('+p.x+'px,'+p.y+'px)'; ripple(p.x,p.y); }
    else if(ev.kind==='move'){ var p=point(ev,v); if(cursor)cursor.style.transform='translate('+p.x+'px,'+p.y+'px)'; }
  }
  function curT(){ return playing ? offset+(performance.now()-lastResume) : offset; }
  function resetToStart(){
    lastScroll=null;
    for(var i=0;i<events.length;i++){
      var ev=events[i];
      if((ev.kind==='scroll'||ev.kind==='resize')&&typeof ev.sx==='number'&&typeof ev.sy==='number'){
        var s=scrollPoint(ev,viewport()); lastScroll=s; window.scrollTo(s.sx,s.sy); return;
      }
    }
  }
  function tick(){
    var t=curT();
    while(idx<events.length && events[idx].t<=t){ apply(events[idx]); idx++; }
    if(idx<events.length) raf=requestAnimationFrame(tick); else { playing=false; raf=0; }
  }
  function play(){ if(playing)return; playing=true; lockScroll(true); lastResume=performance.now(); if(raf)cancelAnimationFrame(raf); raf=requestAnimationFrame(tick); }
  function pause(){ if(!playing)return; offset=curT(); playing=false; if(raf)cancelAnimationFrame(raf); raf=0; lockScroll(false); }
  function seek(t){ offset=t; lastResume=performance.now(); idx=0; resetToStart(); for(var i=0;i<events.length;i++){ if(events[i].t<=t){ apply(events[i]); idx=i+1; } else break; } if(playing){ if(raf)cancelAnimationFrame(raf); raf=requestAnimationFrame(tick); } }
  function stop(){ playing=false; if(raf)cancelAnimationFrame(raf); raf=0; offset=0; idx=0; lockScroll(false); if(cursor&&cursor.parentNode)cursor.parentNode.removeChild(cursor); cursor=null; }
  // While a handoff is playing, the viewer's own scroll is locked so the only
  // scroll is the recorded one - the play shim drives window.scrollTo from the
  // event stream. Capture-phase, passive:false so preventDefault holds; wheel,
  // touchmove, and the scroll-bearing keys (arrows, space, PgUp/PgDn, Home/End)
  // are all blocked. Released on pause/stop so the page scrolls normally then.
  var locked=false, scrollKeys=new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' ','PageUp','PageDown','Home','End']);
  function blockWheel(e){ e.preventDefault(); e.stopPropagation(); }
  function blockTouch(e){ if(e.cancelable)e.preventDefault(); }
  function blockKey(e){ if(scrollKeys.has(e.key)){ e.preventDefault(); e.stopPropagation(); } }
  function lockScroll(on){
    if(on===locked)return; locked=on;
    if(on){
      document.addEventListener('wheel',blockWheel,{capture:true,passive:false});
      document.addEventListener('touchmove',blockTouch,{capture:true,passive:false});
      document.addEventListener('keydown',blockKey,{capture:true});
      // Freeze the recorded scroll position so the viewport does not jump.
      var r=lastScroll; if(r)window.scrollTo(r.sx,r.sy);
      // Hide the scrollbar WITHOUT releasing its gutter, so the artifact
      // content does not shift horizontally when scroll locks/unlocks on
      // play/pause. scrollbar-gutter:stable reserves the column on the
      // overflow:hidden state; restoring it on unlock keeps the same
      // column, so no layout shift crosses the two states.
      document.documentElement.style.scrollbarGutter='stable';
      document.documentElement.style.overflow='hidden';
    }else{
      document.removeEventListener('wheel',blockWheel,{capture:true});
      document.removeEventListener('touchmove',blockTouch,{capture:true});
      document.removeEventListener('keydown',blockKey,{capture:true});
      document.documentElement.style.scrollbarGutter='stable';
      document.documentElement.style.overflow='';
    }
  }
  var lastScroll=null;
  window.addEventListener('message',function(e){
    if(e.source!==window.parent)return;
    var m=e.data; if(!m||typeof m!=='object')return;
    if(m.type==='oa:handoff:play'){ stop(); events=Array.isArray(m.events)?m.events:[]; mkCursor(); offset=0; idx=0; resetToStart(); play(); }
    else if(m.type==='oa:handoff:pause')pause();
    else if(m.type==='oa:handoff:resume')play();
    else if(m.type==='oa:handoff:seek')seek(Number(m.t)||0);
    else if(m.type==='oa:handoff:stop')stop();
  });
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

// The artifact presents as a sheet on a quiet backdrop inside the frame: the
// root paints a token-derived backdrop tone and the body carries the artifact
// as a rounded, hairline-bordered surface inset from the frame viewport. The
// window stays the scroll container — the handoff record/play shim drives
// window.scrollTo — so authored position:sticky bars are re-pinned to the
// sheet's inner top edge by FRAME_SHELL_SCRIPT instead. Canvas-mode artifacts
// opt out: the frame detects the transformed .oa-plane before first paint (the
// same signal the comments bridge uses) and stamps data-shell="flat",
// restoring the full-bleed plane the canvas runtime owns.
const FRAME_SHELL_CSS = `
:root{--oa-shell-gap:.75rem;--oa-shell-radius:8px;--oa-shell-backdrop:color-mix(in oklab,var(--oa-surface),var(--oa-fg) 3%)}
html{background:var(--oa-shell-backdrop)}
body{margin:var(--oa-shell-gap);background:var(--oa-bg);border:1px solid var(--oa-border);border-radius:var(--oa-shell-radius);min-height:calc(100dvh - 2*var(--oa-shell-gap) - 2px)}
html[data-shell="flat"]{background:var(--oa-bg)}
html[data-shell="flat"] body{margin:0;border:0;border-radius:0;min-height:100dvh}
@media (max-width:52rem){body{margin:.5rem}html[data-shell="flat"] body{margin:0}}
`;

// Frame boundary ring, drawn on an overlay rather than as the body's own
// inset box-shadow. The vendored canvas kit sanctions `padding: 0` for a
// full-bleed frame (an edge-to-edge device screen), and a child that fills
// the body paints over an inset shadow — so the ring survived on the left and
// right only, because the kit insets direct children horizontally and never
// vertically. A positioned ::after paints the boundary above frame content at
// every zoom. It needs a positioning context on the body; the body's box
// coincides with .oa-frame's, so absolutely positioned author content keeps
// the same containing-block origin. The kit carries the same overlay, so an
// artifact renders correctly outside the viewer as well.
const FRAME_CANVAS_CSS = `
.oa-frame-body{position:relative}
.oa-frame-body::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--border,var(--oa-border));pointer-events:none}
`;

// Runs before first paint (synchronous, parser-inserted after the content):
// canvas detection stamps the flat opt-out; otherwise the sticky walk mirrors
// the host LAYOUT_SCRIPT contract — only authored sticky bars pinned at 0/auto
// move, an authored top value is respected. React content mounts after this
// walk, matching the host script's one-shot behavior.
const FRAME_SHELL_SCRIPT = `
(function(){
  var root=document.documentElement;
  var plane=document.querySelector('.oa-plane');
  if(plane&&getComputedStyle(plane).transform!=='none'){root.setAttribute('data-shell','flat');return}
  var stack=[];
  for(var i=0;i<document.body.children.length;i++)stack.push(document.body.children[i]);
  while(stack.length){
    var node=stack.pop();
    if(node.nodeType!==1)continue;
    var cs=getComputedStyle(node);
    if(cs.position==='sticky'&&(cs.top==='0px'||cs.top==='auto'))node.style.top='var(--oa-shell-gap)';
    var ch=node.children;
    for(var j=0;j<ch.length;j++)stack.push(ch[j]);
  }
})();
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
.oa-cm-sel{position:fixed;z-index:2147483647;display:inline-flex;align-items:center;gap:.35rem;padding:.28rem .55rem .28rem .45rem;border-radius:6px;border:1px solid color-mix(in oklab,var(--oa-border),var(--oa-fg) 8%);background:var(--oa-bg);color:var(--oa-fg);font-family:var(--oa-font);font-size:.78rem;font-weight:600;line-height:1;letter-spacing:-.01em;cursor:pointer;transform:translate(-50%,.4rem);opacity:.98;transition:border-color .12s,background .12s,opacity .12s}
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
  // Cache DOM references
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

  function headerH(){
    if(!header)return 40;
    return Math.round(header.getBoundingClientRect().height);
  }

  // Unified localStorage access with error handling
  var storage={
    get:function(key){try{return localStorage.getItem(key)}catch(e){return null}},
    set:function(key,val){try{localStorage.setItem(key,val)}catch(e){}},
    remove:function(key){try{localStorage.removeItem(key)}catch(e){}}
  };

  function drawerErr(msg){
    if(!drawerErrEl)return;
    drawerErrEl.textContent=msg;drawerErrEl.removeAttribute("hidden");
    if(drawerErrTimer)clearTimeout(drawerErrTimer);
    drawerErrTimer=setTimeout(function(){drawerErrEl.setAttribute("hidden","")},5000);
  }
  function getName(){return storage.get("oa-cm-name")||""}
  function setName(v){storage.set("oa-cm-name",v)}
  function saveToken(id,t){storage.set("oa-cm-dt-"+id,t)}
  function getToken(id){return storage.get("oa-cm-dt-"+id)}
  function dropToken(id){storage.remove("oa-cm-dt-"+id)}
  // Owner moderation: /a/:id?wt=<artifact write token> grants delete on every
  // comment (the server already accepts the write token on DELETE). The token is
  // moved straight into storage and stripped from the URL so it stays out of
  // history, and it never crosses into the frame.
  function ownerToken(){return storage.get("oa-cm-wt-"+ID)}
  (function(){try{
    var u=new URL(location.href),wt=u.searchParams.get("wt");
    if(!wt)return;
    storage.set("oa-cm-wt-"+ID,wt);
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
  if(toggle&&toggle.parentNode)toggle.parentNode.insertBefore(arm,toggle);else if(header)header.appendChild(arm);
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
  var sendBtn=document.createElement("button");sendBtn.type="button";sendBtn.className="oa-cm-send";sendBtn.setAttribute("aria-label","Post comment");sendBtn.setAttribute("aria-disabled","true");sendBtn.innerHTML=${jsonForInlineScript(SEND_ARROW_SVG)};
  row.appendChild(bodyEl);row.appendChild(sendBtn);
  var errEl=document.createElement("div");errEl.className="oa-cm-err";errEl.setAttribute("role","alert");errEl.setAttribute("hidden","");
  pop.appendChild(nameEl);pop.appendChild(row);pop.appendChild(errEl);
  document.body.appendChild(pop);

  var pending=null,posting=false;
  function autosize(){bodyEl.style.height="auto";bodyEl.style.height=Math.min(bodyEl.scrollHeight,128)+"px"}
  function refreshSend(){var ready=!!bodyEl.value.trim();if(ready){sendBtn.setAttribute("data-ready","");sendBtn.setAttribute("aria-disabled","false")}else{sendBtn.removeAttribute("data-ready");sendBtn.setAttribute("aria-disabled","true")}}
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
    var author=nameEl.value.trim();if(author)setName(author);
    posting=true;clearErr();
    fetch("/api/artifacts/"+ID+"/comments",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({body:body,author:author||null,anchor:pending,anchorVersion:(pending&&pending.anchorVersion)||1})})
      .then(function(r){return r.ok?r.json():Promise.reject(r.status)})
      .then(function(cm){if(cm.deleteToken)saveToken(cm.id,cm.deleteToken);
        state.push({id:cm.id,author:cm.author,body:cm.body,anchor:cm.anchor,done:!!cm.done,createdAt:cm.createdAt});
        sync();closePop();
        // Live bridge: if a live session's WebSocket is up, stream the
        // comment to the agent's watcher right away — the agent polls it as
        // a comment event instead of waiting for a pick+submit.
        if(window.__oaLivePush)window.__oaLivePush({type:"comment",id:cm.id,body:cm.body,author:cm.author||null,anchor:cm.anchor||null,createdAt:cm.createdAt});
      }).catch(function(err){
        errEl.textContent=typeof err==="number"?"Could not post ("+err+")":"Could not post";
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
      p.textContent=!state.length?"No comments yet. Click on the artifact to leave a comment, or type below.":(filter==="done"?"No done comments.":"No open comments.");
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
    // Optimistic remove + undo toast: hide immediately, give 5s to undo.
    var removed=state.filter(function(c){return c.id===id});
    state=state.filter(function(c){return c.id!==id});sync();
    var undone=false,timer=null;
    // Build an undo toast using the existing toast container.
    var tc=document.getElementById('oa-toast-container');
    var toast=null;
    if(tc){
      toast=document.createElement('div');toast.className='oa-toast oa-toast-undo';toast.setAttribute('role','status');
      var msg=document.createElement('span');msg.textContent='Comment deleted';
      var undoBtn=document.createElement('button');undoBtn.type='button';undoBtn.className='oa-toast-undo-btn';undoBtn.textContent='Undo';
      undoBtn.addEventListener('click',function(e){
        e.stopPropagation();undone=true;if(timer)clearTimeout(timer);
        state=removed.concat(state);sync();
        if(toast){toast.setAttribute('data-removing','');setTimeout(function(){toast.remove()},200)}
      });
      toast.appendChild(msg);toast.appendChild(undoBtn);
      var bar=document.createElement('div');bar.className='oa-toast-undo-bar';
      toast.appendChild(bar);
      tc.appendChild(toast);
      toast.addEventListener('click',function(e){if(e.target===toast){undoBtn.click()}});
    }
    timer=setTimeout(function(){
      if(undone)return;
      if(toast){toast.setAttribute('data-removing','');setTimeout(function(){toast.remove()},200)}
      fetch("/api/artifacts/"+ID+"/comments/"+id,{method:"DELETE",headers:{authorization:"Bearer "+tok}})
        .then(function(r){
          if(!r.ok){
            // Restore on failure.
            state=removed.concat(state);sync();dropToken(id);
            drawerErr(r.status===401||r.status===403
              ?"Only the comment's author or the artifact owner can delete this."
              :"Could not delete that comment.");
          }else{dropToken(id)}
        });
    },5000);
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

  // Frame ready transition & global shortcuts
  function markReady(){frame.setAttribute("data-ready","")}
  frame.addEventListener("load",markReady);
  if(frame.contentDocument&&frame.contentDocument.readyState==="complete")markReady();
  setTimeout(markReady,400);

  document.addEventListener("keydown",function(e){
    if(e.target&&(/^(INPUT|TEXTAREA|SELECT)$/i.test(e.target.tagName)||e.target.isContentEditable))return;
    if(e.ctrlKey||e.metaKey||e.altKey)return;
    if(e.key==="c"||e.key==="C"){
      if(toggle){e.preventDefault();toggle.click()}
    }else if(e.key==="t"||e.key==="T"){
      var themeBtn=document.getElementById("oa-theme-toggle");
      if(themeBtn){e.preventDefault();themeBtn.click()}
    }else if(e.key==="l"||e.key==="L"){
      var liveBtn=document.querySelector('[aria-keyshortcuts="l"]');
      if(liveBtn){e.preventDefault();(liveBtn).click()}
    }else if(e.key==="h"||e.key==="H"){
      var handoffBtn=document.querySelector('[aria-keyshortcuts="h"]');
      if(handoffBtn){e.preventDefault();(handoffBtn).click()}
    }else if(e.key==="?"||e.key==="/"){
      e.preventDefault();toggleShortcutSheet();
    }
  });

  // Shortcut sheet overlay — ? to toggle, Escape to close.
  var sheet=document.createElement("div");
  sheet.className="oa-shortcut-sheet";sheet.setAttribute("hidden","");sheet.setAttribute("tabindex","-1");
  sheet.setAttribute("role","dialog");sheet.setAttribute("aria-label","Keyboard shortcuts");
  sheet.innerHTML='<div class="oa-shortcut-sheet-inner">'+
    '<h2 class="oa-shortcut-sheet-title">Keyboard shortcuts</h2>'+
    '<dl class="oa-shortcut-list">'+
    '<dt><kbd tabindex="0">C</kbd></dt><dd>Toggle comments</dd>'+
    '<dt><kbd tabindex="0">T</kbd></dt><dd>Toggle theme</dd>'+
    '<dt><kbd tabindex="0">L</kbd></dt><dd>Toggle live editor</dd>'+
    '<dt><kbd tabindex="0">H</kbd></dt><dd>Toggle handoff recording</dd>'+
    '<dt><kbd tabindex="0">?</kbd></dt><dd>Show this sheet</dd>'+
    '<dt><kbd tabindex="0">Esc</kbd></dt><dd>Close sheet / drawer / dock</dd>'+
    '</dl></div>';
  document.body.appendChild(sheet);
  var sheetPrevFocus=null;
  function openSheet(){
    sheetPrevFocus=document.activeElement;
    sheet.removeAttribute("hidden");
    var first=sheet.querySelector("kbd");
    if(first)first.focus();else sheet.focus();
  }
  function closeSheet(){
    sheet.setAttribute("hidden","");
    if(sheetPrevFocus&&sheetPrevFocus.focus)sheetPrevFocus.focus();
  }
  function toggleShortcutSheet(){
    if(sheet.hasAttribute("hidden"))openSheet();else closeSheet();
  }
  sheet.addEventListener("keydown",function(e){
    if(e.key==="Escape"||e.key==="?"||e.key==="/"){e.preventDefault();closeSheet();return}
    // Focus trap: keep Tab within the sheet.
    if(e.key==="Tab"){
      var kbd=sheet.querySelectorAll("kbd");
      if(kbd.length===0)return;
      var first=kbd[0],last=kbd[kbd.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
    }
  });
  sheet.addEventListener("mousedown",function(e){if(e.target===sheet)closeSheet()});
})();
`;

const CONTENT_SLOT = "__OA_CONTENT_SLOT__";

const UNLOCK_CSS = `
.oa-unlock{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.25rem}
.oa-card{width:100%;max-width:22rem;border:1px solid var(--oa-border);border-radius:8px;padding:2rem;background:var(--oa-surface)}
.oa-card .oa-emoji{font-size:2rem;line-height:1;margin-bottom:.6rem}
.oa-card h1{font-size:1.25rem;line-height:1.3;margin:0 0 .3rem}
.oa-card p{margin:0 0 1.35rem;color:var(--oa-muted);font-size:.8rem;line-height:1.55}
.oa-label{display:block;margin:0 0 .4rem;color:var(--oa-fg);font-size:.75rem;font-weight:600}
.oa-card input{width:100%;min-height:44px;padding:.6rem .75rem;border:1px solid var(--oa-border);border-radius:6px;background:var(--oa-bg);color:var(--oa-fg);font-size:.875rem;transition:border-color .15s,box-shadow .15s}
.oa-card input:focus-visible{outline:none;border-color:var(--oa-accent);box-shadow:var(--oa-focus-ring)}
.oa-card button{width:100%;min-height:44px;margin-top:.8rem;padding:.6rem .75rem;border:none;border-radius:6px;background:var(--oa-fg);color:var(--oa-bg);font-size:.875rem;font-weight:600;cursor:pointer;transition:background .15s,box-shadow .15s,opacity .15s}
.oa-card button:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-card button:active:not(:disabled){transform:translateY(1px)}
.oa-card button:disabled{opacity:.6;cursor:wait}
.oa-error{color:var(--oa-danger);font-size:.8rem;font-weight:500;min-height:1.2em;margin-top:.7rem}
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
  brand: Brand;
  branded: boolean;
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
  /** When true, render the visibility selector for owners. */
  canManage?: boolean;
  /** Current artifact visibility; drives the share selector. */
  visibility?: Visibility;
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
    brand,
    branded,
    brandUrl,
    artifactId,
    comments,
    envelope,
    nonce,
    versions,
    currentVersion,
    canManage = false,
    visibility = "public",
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
// React content is a JS bundle spliced into the frame inline script body, so a
// literal script-closing sequence in it would prematurely end that block.
// Neutralize it the same way the server-side escapeInlineScript does on the
// plain (unencrypted) react path. Only react needs this: html content carries
// real user-script closing tags stampNonce must leave intact. (This comment
// avoids the raw close-tag token so it can live inside this inline script.)
function escScript(s){return s.replace(/<\\/script/gi,"<\\\\/script")}
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
      : OA.format==="react"
      ? OA.template.split(OA.slot).join(escScript(content))
      : stampNonce(OA.template.split(OA.slot).join(content));
    const frame=document.getElementById("oa-frame");
    frame.srcdoc=doc;
    frame.style.display="block";
    document.querySelector(".oa-unlock").style.display="none";
  }catch(e){
    error.textContent="That password didn\u2019t work \u2014 try again.";
    button.disabled=false;
    button.textContent="Unlock";
    input.focus();
    input.select();
  }
});
input.focus();
`;

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
${headerHtml(favicon, title, brand, branded, brandUrl, versions, currentVersion, url, artifactId, openCommentsCount(commentsList), canManage, visibility, false)}
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
<script nonce="${nonce}">${HEADER_SCRIPT}</script>
<script nonce="${nonce}">${escapeInlineScript(COMMENTS_SCRIPT)}</script>
<script nonce="${nonce}">${escapeInlineScript(hostBridgeScript(artifactId))}</script>
<script nonce="${nonce}">${VISIBILITY_SCRIPT}</script>
<script nonce="${nonce}">${escapeInlineScript(HOST_UI_SCRIPT)}</script>
</body>
</html>
`;
}

const STATUS_CSS = `
.oa-status{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.4rem;padding:2rem;text-align:center}
.oa-status .oa-mark{width:38px;height:38px;color:var(--oa-accent);margin-bottom:.75rem}
.oa-status h1{font-size:1.25rem;line-height:1.3;margin:0;color:var(--oa-fg)}
.oa-status p{margin:0;max-width:28rem;color:var(--oa-muted);font-size:.8rem;line-height:1.6}
.oa-status code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em;background:var(--oa-surface);border:1px solid var(--oa-border);border-radius:4px;padding:.05em .3em}
.oa-status a{margin-top:1rem;color:var(--oa-accent);font-size:.75rem;text-decoration:none}
.oa-status a:hover{text-decoration:underline;text-underline-offset:2px}
.oa-status a:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-status-guidance{margin:.5rem 0 0;max-width:28rem;color:var(--oa-muted);font-size:.75rem;line-height:1.5}
.oa-status-actions{display:flex;align-items:center;justify-content:center;gap:.75rem;flex-wrap:wrap;margin-top:1rem}
.oa-status-actions .oa-status-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:8rem;min-height:44px;padding:0 .875rem;border:1px solid var(--oa-border);border-radius:6px;background:var(--oa-surface);color:var(--oa-fg);font:inherit;font-size:.75rem;text-decoration:none;cursor:pointer;transition:border-color .15s,color .15s}
.oa-status-actions .oa-status-btn:hover{border-color:var(--oa-accent);color:var(--oa-accent);text-decoration:none}
.oa-status-actions .oa-status-btn:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
`;

const DARK_CONSOLE_STATUS_CSS = `
:root[data-status-theme="dark-console"]{color-scheme:dark;--oa-bg:#050505;--oa-fg:#e5e5e5;--oa-muted:#949494;--oa-border:#1f1f1f;--oa-surface:#0d0d0d;--oa-accent:#3c7bff;--oa-accent-on:#050505;--oa-focus-ring:0 0 0 2px var(--oa-bg),0 0 0 4px var(--oa-accent)}
.oa-status-branded{position:relative;isolation:isolate;background-color:var(--oa-bg);background-image:radial-gradient(circle,#303030 0.7px,transparent 0.8px);background-size:18px 18px}
.oa-status-branded::before{position:absolute;inset:0;z-index:-1;background:linear-gradient(to bottom,transparent,rgba(5,5,5,.86) 74%);content:"";pointer-events:none}
.oa-status-branded .oa-mark{width:32px;height:32px;margin-bottom:1rem}
.oa-status-branded .oa-status-brand{margin-bottom:.35rem;color:var(--oa-accent);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9px;font-weight:500;letter-spacing:.12em;line-height:1.5;text-transform:uppercase}
.oa-status-branded h1{font-family:var(--oa-font);font-size:1.25rem;font-weight:600;letter-spacing:-.02em}
.oa-status-branded .oa-status-actions .oa-status-btn{margin-top:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.oa-status-branded .oa-status-guidance{color:var(--oa-muted)}
`;

// Minimal, on-brand page for the states that don't render an artifact
// (missing artifact, invalid ?v=). No header/toggle: the reset's
// prefers-color-scheme default handles the theme without any JS. The "go
// home" link names whichever brand this instance presents.
function statusPage(options: {
  title: string;
  heading: string;
  body: string;
  guidance?: string;
  brand: Brand;
  statusTheme?: StatusTheme;
  linkHref?: string;
  linkText?: string;
}): string {
  const brand = options.brand;
  const linkHref = options.linkHref ?? "/";
  const linkText = options.linkText ?? `Go to ${brand.name}`;
  const branded = options.statusTheme === "dark-console";
  const guidance = options.guidance
    ? `<p class="oa-status-guidance">${options.guidance}</p>`
    : "";
  return `<!doctype html>
<html lang="en"${branded ? ' data-status-theme="dark-console"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${RESET_CSS}${STATUS_CSS}${branded ? DARK_CONSOLE_STATUS_CSS : ""}</style>
</head>
<body>
<main class="oa-status${branded ? " oa-status-branded" : ""}">
<span class="oa-mark">${BRAND_SVG}</span>
${branded ? `<p class="oa-status-brand">${escapeHtml(brand.wordmark)} / artifact status</p>` : ""}
<h1>${options.heading}</h1>
<p>${options.body}</p>
${guidance}
<div class="oa-status-actions">
<a class="oa-status-btn" href="${escapeHtml(linkHref)}">${escapeHtml(linkText)}</a>
<button type="button" class="oa-status-btn" id="oa-status-copy">Copy link</button>
</div>
</main>
<script>(function(){var b=document.getElementById("oa-status-copy");if(!b)return;b.addEventListener("click",function(){var t=b.textContent;try{navigator.clipboard.writeText(location.href).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent=t},2000)}).catch(function(){b.textContent="Copy failed";setTimeout(function(){b.textContent=t},2000)})}catch(e){b.textContent="Copy failed";setTimeout(function(){b.textContent=t},2000)}})})();</script>
</body>
</html>
`;
}

export function notFoundPage(brand: Brand, statusTheme?: StatusTheme): string {
  return statusPage({
    title: "Artifact not found",
    heading: "Artifact not found",
    body: "This link does not exist, or the artifact it pointed to was deleted.",
    guidance:
      "If this link was shared with you, ask the owner to re-share it. If this is your artifact, it may have been deleted.",
    brand,
    statusTheme,
  });
}

export function badVersionPage(
  brand: Brand,
  statusTheme?: StatusTheme,
): string {
  return statusPage({
    title: "Invalid version",
    heading: "Invalid version",
    body: "The <code>?v=</code> parameter must be a positive integer version number.",
    guidance:
      "Try removing <code>?v=</code> from the URL to view the latest version, or check the number is correct.",
    brand,
    statusTheme,
  });
}

export function signInToViewPage(
  brand: Brand,
  statusTheme?: StatusTheme,
): string {
  return statusPage({
    title: "Sign in to view",
    heading: "Sign in to view",
    body: "This artifact is private. Sign in to check whether you have access.",
    brand,
    statusTheme,
    linkHref: "/login",
    linkText: "Sign in",
  });
}
