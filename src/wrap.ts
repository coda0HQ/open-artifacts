import type { ArtifactFormat, CommentMeta, EncryptionParams } from "./domain";
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

// Web fonts + runtime libraries are an opt-in per-deploy surface (env var
// OPEN_ARTIFACTS_WEB_FONTS). When enabled, the sandbox gains allow-same-origin
// so the browser can cache fonts, font-src widens to 'self' plus a bounded
// allowlist of font CDNs (Fontshare + Google Fonts, the two that serve woff2
// over a stable CDN for Awwwards-listed families), style-src gains 'self' plus
// the Google Fonts CSS host (so the same-origin /fonts/<slug>.css shim and
// Google Fonts @import load), and script-src gains 'self' cdn.jsdelivr.net so
// allowlisted
// runtime libraries (mermaid) load directly from jsdelivr. The trade-off:
// artifacts lose the opaque-origin guarantee and can read the host origin's
// localStorage/cookies, and an artifact can pull fonts from the allowlisted
// CDNs (passive font bytes, not executable). Default (webFonts=false) keeps the
// strict opaque-origin sandbox and font-src/script-src of a self-hosted deploy.
const WEB_FONT_CSP = {
  fontSrc: "'self' data: cdn.fontshare.com fonts.gstatic.com",
  styleSrc: "'self' 'unsafe-inline' fonts.googleapis.com",
  scriptSrc: "'self' 'unsafe-inline' cdn.jsdelivr.net",
};
export function contentSecurityPolicy(options: {
  sandbox: boolean;
  webFonts?: boolean;
  // Forces a strict sandbox (no allow-same-origin) even when webFonts is on.
  // The artifact frame (GET /a/:id/frame) must never become same-origin with
  // the privileged host page (R1) — allow-same-origin on a sandboxed frame
  // grants it the response URL's origin, which would let it read the host
  // page's localStorage/cookies across the air-gap. Web-font CSP directives
  // (style-src/font-src/script-src) still widen so fonts load as ordinary
  // cross-origin subresources; only the sandbox token is affected.
  frameSandbox?: boolean;
}): string {
  const webFonts = options.webFonts === true;
  const directives = [
    "default-src 'none'",
    `script-src ${webFonts ? WEB_FONT_CSP.scriptSrc : "'unsafe-inline'"}`,
    `style-src ${webFonts ? WEB_FONT_CSP.styleSrc : "'unsafe-inline'"}`,
    "img-src data: blob:",
    `font-src ${webFonts ? WEB_FONT_CSP.fontSrc : "data:"}`,
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
}): Headers {
  return new Headers({
    "content-type": options.contentType,
    "content-security-policy": contentSecurityPolicy({
      sandbox: options.sandbox,
      webFonts: options.webFonts,
      frameSandbox: options.frameSandbox,
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
export function hostContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
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

export function hostHeaders(): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": hostContentSecurityPolicy(),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-cache",
  });
}

const RESET_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;line-height:1.5;background:var(--oa-bg);color:var(--oa-fg)}
img,video,canvas{max-width:100%}
:root{color-scheme:light dark;--oa-bg:#ffffff;--oa-fg:#18181b;--oa-muted:#71717a;--oa-border:#e4e4e7;--oa-surface:#f8f8f8;--oa-accent:#6457f0;--oa-danger:#b42318;--oa-focus-ring:0 0 0 2px var(--oa-bg),0 0 0 4px var(--oa-accent)}
@media (prefers-color-scheme: dark){:root{--oa-bg:#131316;--oa-fg:#e7e7ea;--oa-muted:#9a9aa2;--oa-border:#2e2e33;--oa-surface:#1c1c21;--oa-accent:#8d82f5;--oa-danger:#ff8f85}}
:root[data-theme="light"]{color-scheme:light;--oa-bg:#ffffff;--oa-fg:#18181b;--oa-muted:#71717a;--oa-border:#e4e4e7;--oa-surface:#f8f8f8;--oa-accent:#6457f0;--oa-danger:#b42318}
:root[data-theme="dark"]{color-scheme:dark;--oa-bg:#131316;--oa-fg:#e7e7ea;--oa-muted:#9a9aa2;--oa-border:#2e2e33;--oa-surface:#1c1c21;--oa-accent:#8d82f5;--oa-danger:#ff8f85}
/* Header height is measured at runtime and exposed as --oa-header-h so
   anchor scroll-offset stays correct without author effort. The header is
   sticky (in-flow), so body content is never obscured — only anchor jumps
   need the offset. */
:root{--oa-header-h:2.5rem}
[id]{scroll-margin-top:calc(var(--oa-header-h) + .5rem)}
.oa-header{position:sticky;top:0;z-index:2147483646;display:flex;align-items:center;gap:.6rem;padding:.375rem 1rem;background:color-mix(in oklab,var(--oa-bg),transparent 8%);backdrop-filter:blur(10px);border-bottom:1px solid var(--oa-border);font-size:.8rem}
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
.oa-cm-toggle .oa-cm-count{position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;padding:0 3px;border-radius:8px;background:var(--oa-accent);color:#fff;font-size:9px;font-weight:600;line-height:15px;text-align:center;display:none}
.oa-cm-toggle[data-count] .oa-cm-count{display:block}
.oa-cm-drawer{position:fixed;top:0;right:0;height:100dvh;width:100%;max-width:24rem;transform:translateX(100%);transition:transform .18s ease;display:flex;flex-direction:column;background:var(--oa-bg);border-left:1px solid var(--oa-border);z-index:2147483645}
.oa-cm-drawer[data-open]{transform:translateX(0)}
.oa-cm-drawer .oa-cm-head{display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;border-bottom:1px solid var(--oa-border);font-size:.8rem;flex-shrink:0}
.oa-cm-drawer .oa-cm-head h2{flex:1;margin:0;font-size:.8rem;font-weight:600;color:var(--oa-fg)}
.oa-cm-drawer .oa-cm-close{width:28px;height:28px;border-radius:6px;border:1px solid var(--oa-border);background:var(--oa-surface);color:var(--oa-fg);font-size:14px;cursor:pointer;flex-shrink:0}
.oa-cm-drawer .oa-cm-close:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-cm-list{flex:1;min-height:0;overflow-y:auto;padding:.75rem;display:flex;flex-direction:column;gap:.6rem}
.oa-cm-empty{color:var(--oa-muted);font-size:.85rem;text-align:center;margin-top:1.5rem}
.oa-cm-item{border:1px solid var(--oa-border);border-radius:8px;padding:.55rem .7rem;background:var(--oa-surface)}
.oa-cm-item .oa-cm-meta{display:flex;gap:.4rem;align-items:baseline;margin-bottom:.2rem}
.oa-cm-item .oa-cm-author{font-size:.8rem;font-weight:600;color:var(--oa-fg)}
.oa-cm-item .oa-cm-anon{font-size:.8rem;font-style:italic;color:var(--oa-muted)}
.oa-cm-item .oa-cm-time{font-size:.7rem;color:var(--oa-muted)}
.oa-cm-item .oa-cm-text{font-size:.9rem;line-height:1.5;color:var(--oa-fg);white-space:pre-wrap;word-break:break-word}
@media (hover:hover) and (pointer:fine){.oa-header .oa-cm-toggle:hover{opacity:1;border-color:color-mix(in oklab,var(--oa-border),var(--oa-fg) 25%)}}
@media (max-width:30rem){.oa-cm-drawer{max-width:100%}}
`;

const SUN_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 18C8.68629 18 6 15.3137 6 12C6 8.68629 8.68629 6 12 6C15.3137 6 18 8.68629 18 12C18 15.3137 15.3137 18 12 18ZM12 16C14.2091 16 16 14.2091 16 12C16 9.79086 14.2091 8 12 8C9.79086 8 8 9.79086 8 12C8 14.2091 9.79086 16 12 16ZM11 1H13V4H11V1ZM11 20H13V23H11V20ZM3.51472 4.92893L4.92893 3.51472L7.05025 5.63604L5.63604 7.05025L3.51472 4.92893ZM16.9497 18.364L18.364 16.9497L20.4853 19.0711L19.0711 20.4853L16.9497 18.364ZM19.0711 3.51472L20.4853 4.92893L18.364 7.05025L16.9497 5.63604L19.0711 3.51472ZM5.63604 16.9497L7.05025 18.364L4.92893 20.4853L3.51472 19.0711L5.63604 16.9497ZM23 11V13H20V11H23ZM4 11V13H1V11H4Z"/></svg>';
const MOON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M10 7C10 10.866 13.134 14 17 14C18.9584 14 20.729 13.1957 21.9995 11.8995C22 11.933 22 11.9665 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C12.0335 2 12.067 2 12.1005 2.00049C10.8043 3.27098 10 5.04157 10 7ZM4 12C4 16.4183 7.58172 20 12 20C15.0583 20 17.7158 18.2839 19.062 15.7621C18.3945 15.9187 17.7035 16 17 16C12.0294 16 8 11.9706 8 7C8 6.29648 8.08133 5.60547 8.2379 4.938C5.71611 6.28423 4 8.9417 4 12Z"/></svg>';

const COMMENT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const BRAND_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M20.0833 15.1999L21.2854 15.9212C21.5221 16.0633 21.5989 16.3704 21.4569 16.6072C21.4146 16.6776 21.3557 16.7365 21.2854 16.7787L12.5144 22.0412C12.1977 22.2313 11.8021 22.2313 11.4854 22.0412L2.71451 16.7787C2.47772 16.6366 2.40093 16.3295 2.54301 16.0927C2.58523 16.0223 2.64413 15.9634 2.71451 15.9212L3.9166 15.1999L11.9999 20.0499L20.0833 15.1999ZM20.0833 10.4999L21.2854 11.2212C21.5221 11.3633 21.5989 11.6704 21.4569 11.9072C21.4146 11.9776 21.3557 12.0365 21.2854 12.0787L11.9999 17.6499L2.71451 12.0787C2.47772 11.9366 2.40093 11.6295 2.54301 11.3927C2.58523 11.3223 2.64413 11.2634 2.71451 11.2212L3.9166 10.4999L11.9999 15.3499L20.0833 10.4999ZM12.5144 1.30864L21.2854 6.5712C21.5221 6.71327 21.5989 7.0204 21.4569 7.25719C21.4146 7.32757 21.3557 7.38647 21.2854 7.42869L11.9999 12.9999L2.71451 7.42869C2.47772 7.28662 2.40093 6.97949 2.54301 6.7427C2.58523 6.67232 2.64413 6.61343 2.71451 6.5712L11.4854 1.30864C11.8021 1.11864 12.1977 1.11864 12.5144 1.30864ZM11.9999 3.33233L5.88723 6.99995L11.9999 10.6676L18.1126 6.99995L11.9999 3.33233Z"/></svg>';

function headerHtml(
  favicon: string,
  title: string,
  hostname: string,
  brandUrl?: string | null,
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
  return `<header class="oa-header">
  <span class="oa-header-title"><span class="oa-header-fav">${escapeHtml(favicon)}</span>${escapeHtml(title)}</span>
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
        .map(
          (c) =>
            `<div class="oa-cm-item"><div class="oa-cm-meta">${c.author ? `<span class="oa-cm-author">${escapeHtml(c.author)}</span>` : '<span class="oa-cm-anon">anonymous</span>'}<span class="oa-cm-time">${escapeHtml(c.createdAt)}</span></div><div class="oa-cm-text">${escapeHtml(c.body)}</div></div>`,
        )
        .join("")
    : '<p class="oa-cm-empty">No comments yet.</p>';
  return `<aside class="oa-cm-drawer" id="oa-cm-drawer" aria-label="Comments" aria-hidden="true" data-artifact-id="${escapeHtml(artifactId)}">
  <div class="oa-cm-head">
    <h2>Comments</h2>
    <button class="oa-cm-close" type="button" aria-label="Close comments" aria-controls="oa-cm-drawer">&times;</button>
  </div>
  <div class="oa-cm-list" id="oa-cm-list">${items}</div>
</aside>`;
}

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
#oa-frame{position:fixed;top:var(--oa-header-h);inset-inline:0;bottom:0;width:100%;border:0}
`;

export interface FrameDocumentOptions {
  format: ArtifactFormat;
  content: string;
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
// the primary air-gap, so it stays at the strictest baseline.
const FRAME_META_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

// The inner ARTIFACT FRAME document: just the artifact body plus enough head
// to render it (reset/markdown CSS, a theme script so the frame can paint
// itself before the host sends anything). No og/title meta, no header, no
// comments drawer, no LAYOUT_SCRIPT — those are host-page chrome that never
// enters the sandboxed, opaque-origin document.
export function frameDocument(options: FrameDocumentOptions): string {
  const { format, content, stampCsp } = options;
  const body =
    format === "markdown"
      ? `<main class="oa-md" id="oa-content"></main>
<script>${escapeInlineScript(MARKED_SOURCE)}</script>
<script>
document.getElementById("oa-content").innerHTML=marked.parse(${jsonForInlineScript(content)});
</script>`
      : content;
  const cspMeta = stampCsp
    ? `<meta http-equiv="Content-Security-Policy" content="${FRAME_META_CSP}">\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${RESET_CSS}${format === "markdown" ? MARKDOWN_CSS : ""}</style>
</head>
<body>
${body}
<script>${THEME_SCRIPT}</script>
<script>${FRAME_BRIDGE_SCRIPT}</script>
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
${headerHtml(favicon, title, hostname, brandUrl, artifactId, commentsList.length)}
<iframe id="oa-frame" src="${escapeHtml(frameSrc)}" sandbox="allow-scripts allow-modals allow-forms allow-popups" title="${escapeHtml(title)}"></iframe>
${drawer}
${commentsDataScript(commentsList)}
<script>${THEME_SCRIPT}</script>
<script>${LAYOUT_SCRIPT}</script>
<script>${escapeInlineScript(COMMENTS_SCRIPT)}</script>
<script>${escapeInlineScript(hostBridgeScript(artifactId))}</script>
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
// so it can never fetch; it asks the host over postMessage and the host — the
// only party with network access — performs the request. The contract is a
// FIXED allowlist mapped to a FIXED route table keyed on the serve-time id; the
// frame never supplies a URL, method, or host, so the relay can't become an
// open proxy. Messages are authenticated by window identity (event.source),
// not origin, because a sandboxed opaque-origin frame reports origin "null".

// Pure route table (exported for unit testing and reuse by the host script's
// fetch path). Only ever produces /api/artifacts/:id/comments[/:commentId].
export function bridgeRoute(
  type: string,
  id: string,
  commentId?: string,
): { method: string; path: string } | null {
  const base = `/api/artifacts/${id}/comments`;
  if (type === "comments:list") return { method: "GET", path: base };
  if (type === "comments:create") return { method: "POST", path: base };
  if (type === "comments:delete") {
    if (commentId && /^[a-z0-9]+$/i.test(commentId))
      return { method: "DELETE", path: `${base}/${commentId}` };
    return null;
  }
  return null;
}

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
    }else if(msg.type==="oa:arm"){
      window.__oaArmed=msg.mode||null;
      if(typeof window.__oaOnArm==="function")window.__oaOnArm(window.__oaArmed);
    }else if(msg.type==="oa:comments"){
      window.__oaComments=Array.isArray(msg.list)?msg.list:[];
      window.__oaViewedVersion=typeof msg.viewedVersion==="number"?msg.viewedVersion:1;
      if(typeof window.__oaRenderMarkers==="function")window.__oaRenderMarkers(window.__oaComments);
    }
  });
  send({type:"oa:ready"});
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
      post({type:"oa:theme",theme:theme()});
      post({type:"oa:comments",list:inlined(),viewedVersion:window.__oaViewedVersion||1});
    }else if(msg.type==="oa:anchor:new"){
      if(typeof window.__oaOnAnchorNew==="function")window.__oaOnAnchorNew(msg);
    }else if(msg.type==="oa:anchor:open"){
      if(typeof window.__oaOnAnchorOpen==="function")window.__oaOnAnchorOpen(msg);
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
    createdAt: cm.createdAt,
  }));
  return `<script type="application/json" id="oa-cm-data">${jsonForInlineScript(
    publicList,
  )}</script>`;
}

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
  } = options;
  // stampCsp: true — a srcdoc'd document has no HTTP response of its own, so
  // the CSP meta tag is the only thing re-asserting connect-src 'none' (R2)
  // once the plaintext lands inside it.
  const template = frameDocument({
    format,
    content: CONTENT_SLOT,
    stampCsp: true,
  });

  const unlockScript = `
const OA = {
  envelope: ${jsonForInlineScript(envelope)},
  format: ${jsonForInlineScript(format)},
  template: ${jsonForInlineScript(template)},
  slot: ${jsonForInlineScript(CONTENT_SLOT)},
};
function fromB64(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})}
function jsonEmbed(s){return JSON.stringify(s).replace(/</g,"\\\\u003c")}
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
      : OA.template.split(OA.slot).join(content);
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
${headerHtml(favicon, title, hostname, brandUrl, artifactId, commentsList.length)}
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
<script>${unlockScript}</script>
<script>${THEME_SCRIPT}</script>
<script>${LAYOUT_SCRIPT}</script>
<script>${escapeInlineScript(COMMENTS_SCRIPT)}</script>
<script>${escapeInlineScript(hostBridgeScript(artifactId))}</script>
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
