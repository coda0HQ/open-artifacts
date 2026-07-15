import type { ArtifactFormat, EncryptionParams } from "./domain";
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
    directives.unshift(
      webFonts
        ? "sandbox allow-scripts allow-modals allow-forms allow-popups allow-same-origin"
        : "sandbox allow-scripts allow-modals allow-forms allow-popups",
    );
  }
  return directives.join("; ");
}

export function userContentHeaders(options: {
  sandbox: boolean;
  contentType: string;
  webFonts?: boolean;
}): Headers {
  return new Headers({
    "content-type": options.contentType,
    "content-security-policy": contentSecurityPolicy({
      sandbox: options.sandbox,
      webFonts: options.webFonts,
    }),
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
.oa-header #oa-theme-toggle,.oa-header #oa-feedback-toggle{position:relative;width:28px;height:28px;border-radius:6px;border:1px solid var(--oa-border);background:var(--oa-surface);color:var(--oa-fg);font-size:13px;line-height:1;cursor:pointer;opacity:.8;transition:opacity .15s,border-color .15s,background .15s;flex-shrink:0}
.oa-header #oa-theme-toggle::before,.oa-header #oa-feedback-toggle::before{content:"";position:absolute;inset:-6px}
.oa-header #oa-theme-toggle:focus-visible,.oa-header #oa-feedback-toggle:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-header #oa-theme-toggle:active,.oa-header #oa-feedback-toggle:active{transform:translateY(1px)}
.oa-header #oa-theme-toggle svg,.oa-header #oa-feedback-toggle svg{display:block}
.oa-brand{position:relative;display:inline-flex;align-items:center;gap:.35rem;min-height:28px;text-decoration:none;color:var(--oa-muted);font-size:.75rem;flex-shrink:0;padding:.2rem .5rem;border-radius:6px;transition:color .15s,background .15s}
.oa-brand::before{content:"";position:absolute;inset:-6px 0}
.oa-brand:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-brand:active{transform:translateY(1px)}
.oa-brand svg{display:block;width:14px;height:14px}
@media (hover:hover) and (pointer:fine){.oa-header #oa-theme-toggle:hover,.oa-header #oa-feedback-toggle:hover{opacity:1;border-color:color-mix(in oklab,var(--oa-border),var(--oa-fg) 25%)}.oa-brand:hover{color:var(--oa-fg);background:var(--oa-surface)}}
@media (max-width:30rem){.oa-brand .oa-brand-text{display:none}}
`;

// Project-change (type 2) feedback control. Lives in the host chrome (same
// origin as the Worker, so it can POST), never inside the sandboxed iframe
// (connect-src 'none', opaque origin — no fetch). The iframe may only
// postMessage the host to open the panel. Dual-theme via the shared tokens;
// keyboard-accessible (focusable fieldset, visible focus rings, Escape to
// close). No decorative motion.
const FEEDBACK_CSS = `
.oa-feedback-backdrop{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;background:color-mix(in oklab,#000,transparent 60%);padding:1.25rem}
.oa-feedback-backdrop[data-open]{display:flex}
.oa-feedback-card{width:100%;max-width:26rem;border:1px solid var(--oa-border);border-radius:12px;padding:1.5rem;background:var(--oa-surface)}
.oa-feedback-card h2{font-size:1rem;line-height:1.3;margin:0 0 .3rem;color:var(--oa-fg)}
.oa-feedback-card p{margin:0 0 1rem;color:var(--oa-muted);font-size:.85rem;line-height:1.55}
.oa-feedback-card .oa-label{display:block;margin:0 0 .4rem;color:var(--oa-fg);font-size:.8rem;font-weight:600}
.oa-feedback-card input,.oa-feedback-card textarea{width:100%;min-height:44px;padding:.55rem .7rem;border:1px solid var(--oa-border);border-radius:8px;background:var(--oa-bg);color:var(--oa-fg);font-size:.925rem;font-family:inherit;transition:border-color .15s,box-shadow .15s}
.oa-feedback-card textarea{min-height:96px;resize:vertical}
.oa-feedback-card input:focus-visible,.oa-feedback-card textarea:focus-visible{outline:none;border-color:var(--oa-accent);box-shadow:var(--oa-focus-ring)}
.oa-feedback-row{display:flex;gap:.5rem;margin-top:1rem}
.oa-feedback-card button{flex:1;min-height:44px;padding:.55rem .75rem;border:1px solid var(--oa-border);border-radius:8px;background:var(--oa-bg);color:var(--oa-fg);font-size:.925rem;font-weight:600;cursor:pointer;transition:background .15s,box-shadow .15s,opacity .15s}
.oa-feedback-card button:focus-visible{outline:none;box-shadow:var(--oa-focus-ring)}
.oa-feedback-card button[type=submit]{background:var(--oa-fg);color:var(--oa-bg);border-color:var(--oa-fg)}
.oa-feedback-card button:active:not(:disabled){transform:translateY(1px)}
.oa-feedback-card button:disabled{opacity:.6;cursor:wait}
.oa-feedback-status{min-height:1.2em;margin-top:.7rem;font-size:.85rem;font-weight:500;color:var(--oa-muted)}
.oa-feedback-status[data-error]{color:var(--oa-danger)}
.oa-feedback-status[data-ok]{color:var(--oa-accent)}
@media (hover:hover) and (pointer:fine){.oa-feedback-card button:not([type=submit]):hover:not(:disabled){background:color-mix(in oklab,var(--oa-surface),var(--oa-fg) 8%)}.oa-feedback-card button[type=submit]:hover:not(:disabled){background:color-mix(in oklab,var(--oa-fg),var(--oa-bg) 14%)}}
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

const SUN_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 18C8.68629 18 6 15.3137 6 12C6 8.68629 8.68629 6 12 6C15.3137 6 18 8.68629 18 12C18 15.3137 15.3137 18 12 18ZM12 16C14.2091 16 16 14.2091 16 12C16 9.79086 14.2091 8 12 8C9.79086 8 8 9.79086 8 12C8 14.2091 9.79086 16 12 16ZM11 1H13V4H11V1ZM11 20H13V23H11V20ZM3.51472 4.92893L4.92893 3.51472L7.05025 5.63604L5.63604 7.05025L3.51472 4.92893ZM16.9497 18.364L18.364 16.9497L20.4853 19.0711L19.0711 20.4853L16.9497 18.364ZM19.0711 3.51472L20.4853 4.92893L18.364 7.05025L16.9497 5.63604L19.0711 3.51472ZM5.63604 16.9497L7.05025 18.364L4.92893 20.4853L3.51472 19.0711L5.63604 16.9497ZM23 11V13H20V11H23ZM4 11V13H1V11H4Z"/></svg>';
const MOON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M10 7C10 10.866 13.134 14 17 14C18.9584 14 20.729 13.1957 21.9995 11.8995C22 11.933 22 11.9665 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C12.0335 2 12.067 2 12.1005 2.00049C10.8043 3.27098 10 5.04157 10 7ZM4 12C4 16.4183 7.58172 20 12 20C15.0583 20 17.7158 18.2839 19.062 15.7621C18.3945 15.9187 17.7035 16 17 16C12.0294 16 8 11.9706 8 7C8 6.29648 8.08133 5.60547 8.2379 4.938C5.71611 6.28423 4 8.9417 4 12Z"/></svg>';
const BRAND_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M20.0833 15.1999L21.2854 15.9212C21.5221 16.0633 21.5989 16.3704 21.4569 16.6072C21.4146 16.6776 21.3557 16.7365 21.2854 16.7787L12.5144 22.0412C12.1977 22.2313 11.8021 22.2313 11.4854 22.0412L2.71451 16.7787C2.47772 16.6366 2.40093 16.3295 2.54301 16.0927C2.58523 16.0223 2.64413 15.9634 2.71451 15.9212L3.9166 15.1999L11.9999 20.0499L20.0833 15.1999ZM20.0833 10.4999L21.2854 11.2212C21.5221 11.3633 21.5989 11.6704 21.4569 11.9072C21.4146 11.9776 21.3557 12.0365 21.2854 12.0787L11.9999 17.6499L2.71451 12.0787C2.47772 11.9366 2.40093 11.6295 2.54301 11.3927C2.58523 11.3223 2.64413 11.2634 2.71451 11.2212L3.9166 10.4999L11.9999 15.3499L20.0833 10.4999ZM12.5144 1.30864L21.2854 6.5712C21.5221 6.71327 21.5989 7.0204 21.4569 7.25719C21.4146 7.32757 21.3557 7.38647 21.2854 7.42869L11.9999 12.9999L2.71451 7.42869C2.47772 7.28662 2.40093 6.97949 2.54301 6.7427C2.58523 6.67232 2.64413 6.61343 2.71451 6.5712L11.4854 1.30864C11.8021 1.11864 12.1977 1.11864 12.5144 1.30864ZM11.9999 3.33233L5.88723 6.99995L11.9999 10.6676L18.1126 6.99995L11.9999 3.33233Z"/></svg>';

// A quiet speech-bubble for the project-change feedback control.
const FEEDBACK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

function headerHtml(
  favicon: string,
  title: string,
  hostname: string,
  brandUrl?: string | null,
  showFeedback = true,
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
  // The feedback toggle is only rendered when the panel + script are too
  // (showFeedback). The encrypted iframe srcdoc template is built with
  // feedback:false, so the inner iframe never shows a dead button.
  const feedbackButton = showFeedback
    ? `<button id="oa-feedback-toggle" type="button" aria-label="Open project-change feedback" aria-haspopup="dialog" aria-expanded="false">${FEEDBACK_SVG}</button>`
    : "";
  return `<header class="oa-header">
  <span class="oa-header-title"><span class="oa-header-fav">${escapeHtml(favicon)}</span>${escapeHtml(title)}</span>
  ${chip}
  ${feedbackButton}
  <button id="oa-theme-toggle" type="button" aria-label="Toggle theme"></button>
</header>`;
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

// Host-chrome project-change (type 2) feedback control. The host is same-origin
// with the Worker, so it can POST; the sandboxed iframe cannot (connect-src
// 'none', opaque origin), so it may only postMessage the host to open the
// panel. projectRef is inlined at serve time — runtime fetching is impossible
// inside the sandbox, so the host chrome carries it from the start. When no
// projectRef was inlined, the field is left blank for manual entry (the
// documented fallback for artifacts created without source-project metadata).
const FEEDBACK_SCRIPT = `
(function(){
  var OA={artifactId:__OA_ARTIFACT_ID__,projectRef:__OA_PROJECT_REF__};
  var toggle=document.getElementById("oa-feedback-toggle");
  var backdrop=document.getElementById("oa-feedback-backdrop");
  if(!toggle||!backdrop)return;
  var form=backdrop.querySelector("#oa-feedback-form");
  var projectInput=backdrop.querySelector("#oa-feedback-project");
  var bodyInput=backdrop.querySelector("#oa-feedback-body");
  var submit=backdrop.querySelector("#oa-feedback-submit");
  var cancel=backdrop.querySelector("#oa-feedback-cancel");
  var status=backdrop.querySelector("#oa-feedback-status");
  var lastFocused=null;
  if(OA.projectRef)projectInput.value=OA.projectRef;
  function open(){
    lastFocused=document.activeElement;
    backdrop.setAttribute("data-open","");
    toggle.setAttribute("aria-expanded","true");
    if(!OA.projectRef){projectInput.focus();}else{bodyInput.focus();}
  }
  function close(){
    backdrop.removeAttribute("data-open");
    toggle.setAttribute("aria-expanded","false");
    if(lastFocused&&lastFocused.focus)lastFocused.focus();
  }
  toggle.addEventListener("click",open);
  cancel.addEventListener("click",close);
  backdrop.addEventListener("click",function(e){if(e.target===backdrop)close();});
  document.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&backdrop.hasAttribute("data-open"))close();
  });
  // The sandboxed iframe may postMessage the host to open the panel — it has
  // no other channel (no fetch, no storage). Only accept from the in-page
  // frame; origin is opaque, so the type is the gate, not the origin.
  window.addEventListener("message",function(e){
    if(e.data&&typeof e.data==="object"&&e.data.__oa_feedback==="open")open();
  });
  form.addEventListener("submit",async function(e){
    e.preventDefault();
    status.textContent="";
    status.removeAttribute("data-error");
    status.removeAttribute("data-ok");
    var body=bodyInput.value.trim();
    if(!body){
      status.textContent="Describe the project change first.";
      status.setAttribute("data-error","");
      bodyInput.focus();
      return;
    }
    submit.disabled=true;
    submit.textContent="Sending\\u2026";
    try{
      var res=await fetch("/api/artifacts/"+OA.artifactId+"/feedback",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectRef:projectInput.value.trim()||null,body:body})});
      if(res.status===201){
        status.textContent="Feedback sent. The owner can act on it.";
        status.setAttribute("data-ok","");
        bodyInput.value="";
        bodyInput.focus();
      }else{
        var j={};try{j=await res.json()}catch(e){}
        status.textContent="Failed ("+res.status+"): "+(j.error||res.statusText);
        status.setAttribute("data-error","");
      }
    }catch(err){
      status.textContent="Network error: "+err.message;
      status.setAttribute("data-error","");
    }finally{
      submit.disabled=false;
      submit.textContent="Send";
    }
  });
})();
`;

export interface WrapOptions {
  title: string;
  description: string;
  favicon: string;
  format: ArtifactFormat;
  content: string;
  url: string;
  ogImage: string;
  /** Request hostname; selects the coda0 vs. Open Artifacts identity. */
  hostname: string;
  /** "Powered by Open Artifacts" link URL; omit to hide the brand entry. */
  brandUrl?: string | null;
  /**
   * Source-project reference inlined at serve time so the host chrome's
   * feedback control can attach it to a project-change (type 2) note. The
   * artifact itself has no source-project field, so when this is null the
   * feedback form falls back to a manual project-path input.
   */
  projectRef?: string | null;
  /**
   * Whether to render the host-chrome feedback panel. Defaults to true for the
   * normal viewer path. The encrypted unlock shell passes false for the
   * iframe srcdoc template it builds via wrapDocument — the iframe is sandboxed
   * with connect-src 'none', so a panel inside it could never POST; the outer
   * unlock page renders its own functioning panel instead.
   */
  feedback?: boolean;
}

const FEEDBACK_ARTIFACT_ID_SLOT = "__OA_ARTIFACT_ID__";
const FEEDBACK_PROJECT_REF_SLOT = "__OA_PROJECT_REF__";

function feedbackPanelHtml(): string {
  return `<div class="oa-feedback-backdrop" id="oa-feedback-backdrop" role="dialog" aria-modal="true" aria-labelledby="oa-feedback-heading">
  <form class="oa-feedback-card" id="oa-feedback-form">
    <h2 id="oa-feedback-heading">Project change</h2>
    <p>Send the owner of this artifact a note about the source project. It is queued for the owning agent to act on — not posted publicly.</p>
    <label class="oa-label" for="oa-feedback-project">Project path</label>
    <input id="oa-feedback-project" type="text" autocomplete="off" placeholder="src/path/to/project">
    <label class="oa-label" for="oa-feedback-body" style="margin-top:.75rem">What should change?</label>
    <textarea id="oa-feedback-body" required></textarea>
    <div class="oa-feedback-row">
      <button type="button" id="oa-feedback-cancel">Cancel</button>
      <button type="submit" id="oa-feedback-submit">Send</button>
    </div>
    <div class="oa-feedback-status" id="oa-feedback-status" role="status"></div>
  </form>
</div>`;
}

function feedbackScript(artifactId: string, projectRef: string | null): string {
  // Use replacer FUNCTIONS, not string replacements: String.replace treats $-patterns
  // ($&, $', $`, $1...) specially in a string replacement, and projectRef is
  // user-controlled — a value containing e.g. "$&" would splice template text into
  // the generated script. A replacer function returns the value verbatim.
  return FEEDBACK_SCRIPT.replace(FEEDBACK_ARTIFACT_ID_SLOT, () =>
    jsonForInlineScript(artifactId),
  ).replace(FEEDBACK_PROJECT_REF_SLOT, () => jsonForInlineScript(projectRef));
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

export function wrapDocument(options: WrapOptions): string {
  const {
    title,
    description,
    favicon,
    format,
    content,
    url,
    ogImage,
    hostname,
    brandUrl,
    projectRef,
  } = options;
  const artifactId = url.split("/a/").pop() ?? "";
  const body =
    format === "markdown"
      ? `<main class="oa-md" id="oa-content"></main>
<script>${escapeInlineScript(MARKED_SOURCE)}</script>
<script>
document.getElementById("oa-content").innerHTML=marked.parse(${jsonForInlineScript(content)});
</script>`
      : content;

  const brand = brandFor(hostname);
  const ogDescription = description || title;
  const showFeedback = options.feedback !== false;
  const feedbackPanel = showFeedback ? feedbackPanelHtml() : "";
  const feedbackScriptBody = showFeedback
    ? feedbackScript(artifactId, projectRef ?? null)
    : "";
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
<style>${RESET_CSS}${FEEDBACK_CSS}${format === "markdown" ? MARKDOWN_CSS : ""}</style>
</head>
<body>
${headerHtml(favicon, title, hostname, brandUrl, showFeedback)}
${body}
${feedbackPanel}
<script>${THEME_SCRIPT}</script>
<script>${LAYOUT_SCRIPT}</script>
<script>${escapeInlineScript(feedbackScriptBody)}</script>
</body>
</html>
`;
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
#oa-frame{position:fixed;inset:0;width:100%;height:100%;border:0;display:none}
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
  projectRef?: string | null;
  envelope: EncryptionParams & { ciphertext: string };
  webFonts?: boolean;
}

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
    projectRef,
    envelope,
    webFonts,
  } = options;
  const artifactId = url.split("/a/").pop() ?? "";
  const template = wrapDocument({
    title,
    description,
    favicon,
    format,
    content: CONTENT_SLOT,
    url,
    ogImage,
    hostname,
    brandUrl,
    projectRef,
    // The iframe srcdoc built from this template is sandboxed with
    // connect-src 'none' — a feedback panel inside it could never POST. The
    // outer unlock page renders its own functioning panel instead.
    feedback: false,
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
<style>${RESET_CSS}${FEEDBACK_CSS}${UNLOCK_CSS}</style>
</head>
<body>
${headerHtml(favicon, title, hostname, brandUrl)}
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
${feedbackPanelHtml()}
<iframe id="oa-frame" sandbox="allow-scripts allow-modals${webFonts ? " allow-same-origin" : ""}" title="${escapeHtml(title)}"></iframe>
<script>${unlockScript}</script>
<script>${feedbackScript(artifactId, projectRef ?? null)}</script>
<script>${THEME_SCRIPT}</script>
<script>${LAYOUT_SCRIPT}</script>
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
