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
import type { Brand } from "./home";
import {
  escapeHtml,
  faviconDataUri,
  jsonForInlineScript,
} from "./viewer/shared/escape";

export { escapeHtml, faviconDataUri, jsonForInlineScript };

import {
  ACCOUNT_CSS,
  ACCOUNT_SCRIPT,
  COMMENTS_CSS,
  COMMENTS_SCRIPT,
  DOCK_CSS,
  DOCK_SCRIPT,
  FRAME_ANCHOR_CSS,
  FRAME_ANCHOR_SCRIPT,
  FRAME_BRIDGE_SCRIPT,
  FRAME_HANDOFF_PLAY_SCRIPT,
  FRAME_HANDOFF_RECORD_SCRIPT,
  FRAME_LIVE_PICKER_SCRIPT,
  FRAME_TEXT_CSS,
  HEADER_SCRIPT,
  HOST_FRAME_CSS,
  LAYOUT_SCRIPT,
  LIVE_CSS,
  MARKDOWN_CSS,
  STATUS_CSS,
  TOAST_CSS,
  TOAST_SCRIPT,
  UNLOCK_CSS,
  VERSION_SCRIPT,
  VISIBILITY_SCRIPT,
} from "./generated/viewer-runtime";
import { FRAME_TEXT_SCRIPT } from "./viewer/frame/text-runtime";
import { openCommentsCount } from "./viewer/host/comments";
import {
  commentsDataScript,
  HOST_UI_SCRIPT,
  hostBridgeScript,
} from "./viewer/host/comments-runtime";
import {
  BRAND_SVG,
  COMMENT_SVG,
  DONE_CHECK_SVG,
  FILTER_SVG,
  LIVE_SVG,
  MORE_DOTS_SVG,
} from "./viewer/host/icons";
import { LIVE_SCRIPT } from "./viewer/host/live-runtime";
import { THEME_SCRIPT } from "./viewer/host/theme-runtime";
import { versionOptions } from "./viewer/host/version";

export { FRAME_HANDOFF_PLAY_SCRIPT, FRAME_HANDOFF_RECORD_SCRIPT };

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
  const options = versionOptions(versions, currentVersion, url)
    .map((option) => {
      // The header is cramped on narrow screens, so each option's visible text
      // is the compact "v<n>" form; the version's own label (if any) is kept as
      // a tooltip via the title attribute so context is not lost.
      const title = option.title ? ` title="${escapeHtml(option.title)}"` : "";
      const selected = option.selected ? " selected" : "";
      return `<option value="${escapeHtml(option.target)}"${selected}${title}>${option.label}</option>`;
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
    ? `<button class="oa-cm-toggle" type="button" aria-label="Open comments" aria-expanded="false" aria-controls="oa-cm-drawer"${commentsCount > 0 ? ` data-count="${commentsCount}"` : ""}><span aria-hidden="true">${COMMENT_SVG}</span><span class="oa-cm-count" aria-hidden="true">${commentsCount}</span><span class="oa-header-action-label">Comments</span></button>`
    : "";
  const theme = `<button id="oa-theme-toggle" type="button" aria-label="Toggle theme"><span class="oa-header-action-label">Theme</span></button>`;
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
      ? `<button class="oa-live-toggle" type="button" data-oa-header-secondary aria-label="Open live editor" aria-expanded="false" aria-controls="oa-live-root"><span aria-hidden="true">${LIVE_SVG}</span><span class="oa-header-action-label">Live</span><span class="oa-live-connection" data-live-connection hidden>Connected</span></button>`
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
      ? `<button class="oa-handoff-toggle" type="button" data-oa-header-secondary aria-label="Open handoff recording" aria-expanded="false" aria-controls="oa-handoff-root"><span aria-hidden="true">${HANDOFF_SVG}</span><span class="oa-header-action-label">Handoff</span></button>`
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

// At compact widths, the complete right-side header trail moves into one
// floating panel so its desktop ordering remains intact beside the artifact
// identity. The panel uses the same button and focus vocabulary as desktop
// chrome; this script owns only disclosure state and keyboard/outside-click
// dismissal.

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

// Positions the embedded artifact frame below the sticky service header
// rather than covering it — the header's actual rendered height is measured
// at runtime into --oa-header-h (LAYOUT_SCRIPT); the CSS default (2.5rem)
// covers first paint. Deliberately NOT `inset:0` (R3): that would place the
// frame's top edge at the viewport top, sliding it under the header instead
// of starting beneath it.

// Account chip in the coda0 service header: provider avatar (with a name-initial
// fallback) + dropdown (dashboard / sign out), or a "Sign in" link when no
// session. Driven by a same-origin fetch('/api/me') from coda0's hosted account
// service, which returns {user:{name,picture}}. A self-host without that
// endpoint gets a non-200 and the chip stays empty.

// Fetches /api/me (same-origin, connect-src 'self') and renders an account chip
// into #oa-account-slot. Resilient: any non-200 hides the slot (a self-host with
// no /api/me keeps today's chrome). On coda0 a session returns
// {user:{name,email,picture}}; 401 renders a "Sign in" link to /login. Logout
// is POST /auth/logout (no body).

export interface FrameDocumentOptions {
  format: ArtifactFormat;
  content: string;
  /** Accessible document title for direct navigation and assistive technology. */
  title?: string;
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
// itself before the host sends anything). No crawler/OG meta, no header, no
// comments drawer, no LAYOUT_SCRIPT — those are host-page chrome that never
// enters the sandboxed, opaque-origin document.
export function frameDocument(options: FrameDocumentOptions): string {
  const {
    format,
    content,
    title = "Artifact",
    nonce,
    stampCsp,
    handoffEnabled = false,
  } = options;
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
<title>${escapeHtml(title)}</title>
<style>${RESET_CSS}${format === "markdown" ? MARKDOWN_CSS : ""}${FRAME_ANCHOR_CSS}${FRAME_TEXT_CSS}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${THEME_SCRIPT}</script>
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
  publishedVersion: number,
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
    <div id="oa-live-publication" data-phase="published" data-tone="published" tabindex="-1" role="status" aria-live="polite" aria-atomic="true">
      <span class="oa-live-publication-copy"><span id="oa-live-publication-label">Published v${publishedVersion}</span><span id="oa-live-publication-detail">Published history is immutable</span></span>
      <button id="oa-live-checkpoint" type="button" hidden>Checkpoint</button>
    </div>
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
  <script type="application/json" id="oa-live-config">${jsonForInlineScript({ wsUrl, artifactId, publishedVersion })}</script>
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
<iframe id="oa-frame" src="${escapeHtml(frameSrc)}" sandbox="allow-scripts allow-modals allow-forms allow-popups" title="${escapeHtml(title)}"></iframe>
${drawer}
${liveEnabled ? liveChromeHtml(liveWsUrl ?? "", artifactId, canManage, Number(currentVersion ?? 1)) : ""}
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

// Live element picker, running inside the sandboxed artifact frame. The host
// page cannot reach into the opaque-origin frame's DOM, so the picker lives
// here and is armed/disarmed by host postMessage. On pick, sends the element's
// context (tagName/id/classes/outerHTML/computedStyles/etc.) + its viewport
// rect so the host can float the action bar next to it — NOT a CSS selector,
// the agent matches it in source by id->class->tag. The agent edits source
// and republishes; the host reloads the frame to show the result. No variant
// cycling, no wrapper injection — Live is a one-shot edit-and-reload.

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

// Canvas comment pin: a passive freeform child of the transformed plane. The
// plane's own translate/scale pans and zooms it on the GPU for free; the pin's
// own scale(1/k) cancels the zoom so it holds a constant on-screen size (the
// collapsed-note-chip idiom), and translate(-50%,-50%) centres it. Unlike a
// note it counter-scales unconditionally at every zoom (no CHIP_K threshold).

// Frame side, canvas mode: capture a click to drop a pin (world coords, read
// once from the plane transform) and render existing point anchors as passive
// plane children. No-op on non-canvas documents (text mode is separate).

// Text-range highlight via the CSS Custom Highlight API — no DOM mutation of
// the untrusted author content. A restrained accent tint reads in both themes.
// Selection bubble (.oa-cm-sel) is the Notion-style "Comment" chip that appears
// after a text selection so the user can start a comment without arming first.

// Frame side, normal-page mode: capture a text selection into a quote selector
// (posted to the host) and highlight existing text anchors, re-resolved against
// the live document text. No-op on canvas documents (pins handle those). The
// pure matcher is injected verbatim from src/anchor.ts so tests pin its
// behaviour to the exact code that runs here.
//
// Notion-style selection UX: any non-empty text selection shows a floating
// "Comment" chip at the selection. Clicking it posts oa:anchor:new so the host
// opens compose. Armed mode still skips the chip and opens compose immediately.
// Host side: the privileged endpoint. Guards every message by window identity,
// switches over a fixed allowlist, and only ever sends the frame non-sensitive
// data (theme + a public comment list; never delete tokens). anchor:new and
// anchor:open are handled by the compose/drawer layers, which register hooks.
const CONTENT_SLOT = "__OA_CONTENT_SLOT__";

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
    title,
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
let failedAttempts=0,nextAttemptAt=0,retryTimer=null;
form.addEventListener("submit",async function(event){
  event.preventDefault();
  if(Date.now()<nextAttemptAt){
    error.textContent="Please wait before trying again.";
    return;
  }
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
    failedAttempts=0;nextAttemptAt=0;
  }catch(e){
    failedAttempts+=1;
    const delay=Math.min(8000,500*Math.pow(2,Math.min(failedAttempts-1,4)));
    nextAttemptAt=Date.now()+delay;
    error.textContent="Password incorrect. Check it and try again.";
    button.textContent="Try again shortly";
    if(retryTimer)clearTimeout(retryTimer);
    retryTimer=setTimeout(function(){button.disabled=false;button.textContent="Unlock";},delay);
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

// Minimal, on-brand page for the states that don't render an artifact
// (missing artifact, invalid ?v=). No header/toggle: the reset's
// prefers-color-scheme default handles the theme without any JS. The "go
// home" link names whichever brand this instance presents.
function statusPage(options: {
  title: string;
  heading: string;
  body: string;
  brand: Brand;
  linkHref?: string;
  linkText?: string;
}): string {
  const brand = options.brand;
  const linkHref = options.linkHref ?? "/";
  const linkText = options.linkText ?? `Go to ${brand.name}`;
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
<a href="${escapeHtml(linkHref)}">${escapeHtml(linkText)}</a>
</div>
</body>
</html>
`;
}

export function notFoundPage(brand: Brand): string {
  return statusPage({
    title: "Artifact not found",
    heading: "Artifact not found",
    body: "This link does not exist, or the artifact it pointed to was deleted.",
    brand,
  });
}

export function badVersionPage(brand: Brand): string {
  return statusPage({
    title: "Invalid version",
    heading: "Invalid version",
    body: "The <code>?v=</code> parameter must be a positive integer version number.",
    brand,
  });
}

export function signInToViewPage(brand: Brand): string {
  return statusPage({
    title: "Sign in to view",
    heading: "Sign in to view",
    body: "This artifact is private. Sign in to check whether you have access.",
    brand,
    linkHref: "/login",
    linkText: "Sign in",
  });
}
