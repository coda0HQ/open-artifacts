import type { ArtifactFormat, EncryptionParams } from "./domain";
import { MARKED_SOURCE } from "./generated/marked-source";

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

export function contentSecurityPolicy(options: { sandbox: boolean }): string {
  const directives = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ];
  if (options.sandbox) {
    directives.unshift(
      "sandbox allow-scripts allow-modals allow-forms allow-popups",
    );
  }
  return directives.join("; ");
}

export function userContentHeaders(options: {
  sandbox: boolean;
  contentType: string;
}): Headers {
  return new Headers({
    "content-type": options.contentType,
    "content-security-policy": contentSecurityPolicy({
      sandbox: options.sandbox,
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
:root{color-scheme:light dark;--oa-bg:#ffffff;--oa-fg:#18181b;--oa-muted:#71717a;--oa-border:#e4e4e7;--oa-surface:#f8f8f8}
@media (prefers-color-scheme: dark){:root{--oa-bg:#131316;--oa-fg:#e7e7ea;--oa-muted:#9a9aa2;--oa-border:#2e2e33;--oa-surface:#1c1c21}}
:root[data-theme="light"]{color-scheme:light;--oa-bg:#ffffff;--oa-fg:#18181b;--oa-muted:#71717a;--oa-border:#e4e4e7;--oa-surface:#f8f8f8}
:root[data-theme="dark"]{color-scheme:dark;--oa-bg:#131316;--oa-fg:#e7e7ea;--oa-muted:#9a9aa2;--oa-border:#2e2e33;--oa-surface:#1c1c21}
/* Header height is measured at runtime and exposed as --oa-header-h so
   anchor scroll-offset stays correct without author effort. The header is
   sticky (in-flow), so body content is never obscured — only anchor jumps
   need the offset. */
:root{--oa-header-h:2.5rem}
[id]{scroll-margin-top:calc(var(--oa-header-h) + .5rem)}
.oa-header{position:sticky;top:0;z-index:2147483646;display:flex;align-items:center;gap:.75rem;padding:.5rem 1rem;background:color-mix(in oklab,var(--oa-bg),transparent 8%);backdrop-filter:blur(10px);border-bottom:1px solid var(--oa-border);font-size:.8rem}
.oa-header .oa-title{flex:1;min-width:0;font-weight:600;color:var(--oa-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oa-header .oa-title .oa-fav{margin-right:.4rem}
.oa-header #oa-theme-toggle{width:30px;height:30px;border-radius:50%;border:1px solid var(--oa-border);background:var(--oa-surface);color:var(--oa-fg);font-size:14px;line-height:1;cursor:pointer;opacity:.7;transition:opacity .15s;flex-shrink:0}
.oa-header #oa-theme-toggle:hover{opacity:1}
.oa-brand{display:inline-flex;align-items:center;gap:.35rem;text-decoration:none;color:var(--oa-muted);font-size:.75rem;flex-shrink:0;padding:.25rem .5rem;border-radius:6px;transition:color .15s,background .15s}
.oa-brand:hover{color:var(--oa-fg);background:var(--oa-surface)}
.oa-brand svg{width:14px;height:14px}
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

const SUN_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 18C8.68629 18 6 15.3137 6 12C6 8.68629 8.68629 6 12 6C15.3137 6 18 8.68629 18 12C18 15.3137 15.3137 18 12 18ZM12 16C14.2091 16 16 14.2091 16 12C16 9.79086 14.2091 8 12 8C9.79086 8 8 9.79086 8 12C8 14.2091 9.79086 16 12 16ZM11 1H13V4H11V1ZM11 20H13V23H11V20ZM3.51472 4.92893L4.92893 3.51472L7.05025 5.63604L5.63604 7.05025L3.51472 4.92893ZM16.9497 18.364L18.364 16.9497L20.4853 19.0711L19.0711 20.4853L16.9497 18.364ZM19.0711 3.51472L20.4853 4.92893L18.364 7.05025L16.9497 5.63604L19.0711 3.51472ZM5.63604 16.9497L7.05025 18.364L4.92893 20.4853L3.51472 19.0711L5.63604 16.9497ZM23 11V13H20V11H23ZM4 11V13H1V11H4Z"/></svg>';
const MOON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M10 7C10 10.866 13.134 14 17 14C18.9584 14 20.729 13.1957 21.9995 11.8995C22 11.933 22 11.9665 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C12.0335 2 12.067 2 12.1005 2.00049C10.8043 3.27098 10 5.04157 10 7ZM4 12C4 16.4183 7.58172 20 12 20C15.0583 20 17.7158 18.2839 19.062 15.7621C18.3945 15.9187 17.7035 16 17 16C12.0294 16 8 11.9706 8 7C8 6.29648 8.08133 5.60547 8.2379 4.938C5.71611 6.28423 4 8.9417 4 12Z"/></svg>';

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
  function measure(){if(!h)return;document.documentElement.style.setProperty('--oa-header-h',h.getBoundingClientRect().height+'px')}
  // Push author-authored sticky elements (e.g. an in-page nav) below the
  // service header so they stick under it instead of being obscured. Run
  // once on load; cheap enough since only sticky elements get touched.
  function offsetSticky(){
    if(!h)return;
    var els=document.body.children;
    for(var i=0;i<els.length;i++){
      var el=els[i];
      if(el===h||el.classList&&el.classList.contains('oa-header'))continue;
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
  var runOffset=function(){offsetSticky()};
  if(window.requestIdleCallback){requestIdleCallback(runOffset,{timeout:500})}
  else{setTimeout(runOffset,1)}
  if(window.ResizeObserver&&h){new ResizeObserver(measure).observe(h)}
  window.addEventListener('resize',measure,{passive:true});
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
  /** "Powered by Open Artifacts" link URL; omit to hide the brand entry. */
  brandUrl?: string | null;
}

const OG_CARD_W = 1200;
const OG_CARD_H = 630;

// A self-contained SVG OG card built from the artifact's emoji favicon and
// title. Returned by GET /og/:id and referenced via og:image. Social crawlers
// fetch this URL independently of the artifact page, so it is not constrained
// by the page CSP — but it is itself a single SVG with no external requests.
export function ogCardSvg(options: {
  title: string;
  favicon: string;
  description: string;
}): string {
  const { title, favicon, description } = options;
  // Wrap the title to ~26 chars/line, up to 4 lines, escaping for XML.
  const wrapTitle = (text: string): string[] => {
    const words = escapeHtml(text).split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      if (`${line} ${w}`.trim().length > 26 && line) {
        lines.push(line);
        line = w;
      } else {
        line = `${line} ${w}`.trim();
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  };
  const titleLines = wrapTitle(title);
  const desc = description ? escapeHtml(description).slice(0, 120) : "";
  const linesY = 320 - ((titleLines.length - 1) * 52) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_CARD_W}" height="${OG_CARD_H}" viewBox="0 0 ${OG_CARD_W} ${OG_CARD_H}">
<rect width="${OG_CARD_W}" height="${OG_CARD_H}" fill="#131316"/>
<rect x="0" y="0" width="${OG_CARD_W}" height="8" fill="#6457f0"/>
<text x="80" y="180" font-size="120" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" dominant-baseline="middle">${escapeHtml(favicon)}</text>
${titleLines.map((l, i) => `<text x="80" y="${linesY + i * 72}" font-size="56" font-weight="700" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" fill="#e7e7ea">${l}</text>`).join("\n")}
${desc ? `<text x="80" y="${linesY + titleLines.length * 72 + 20}" font-size="28" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" fill="#9a9aa2">${desc}</text>` : ""}
<text x="80" y="580" font-size="24" font-family="ui-monospace,Menlo,monospace" fill="#71717a" letter-spacing="1">OPEN ARTIFACTS</text>
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
    brandUrl,
  } = options;
  const body =
    format === "markdown"
      ? `<main class="oa-md" id="oa-content"></main>
<script>${escapeInlineScript(MARKED_SOURCE)}</script>
<script>
document.getElementById("oa-content").innerHTML=marked.parse(${jsonForInlineScript(content)});
</script>`
      : content;

  const ogDescription = description || title;
  const brandHtml = brandUrl
    ? `<a class="oa-brand" href="${escapeHtml(brandUrl)}" target="_blank" rel="noopener noreferrer" title="Made with Open Artifacts"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M20.0833 15.1999L21.2854 15.9212C21.5221 16.0633 21.5989 16.3704 21.4569 16.6072C21.4146 16.6776 21.3557 16.7365 21.2854 16.7787L12.5144 22.0412C12.1977 22.2313 11.8021 22.2313 11.4854 22.0412L2.71451 16.7787C2.47772 16.6366 2.40093 16.3295 2.54301 16.0927C2.58523 16.0223 2.64413 15.9634 2.71451 15.9212L3.9166 15.1999L11.9999 20.0499L20.0833 15.1999ZM20.0833 10.4999L21.2854 11.2212C21.5221 11.3633 21.5989 11.6704 21.4569 11.9072C21.4146 11.9776 21.3557 12.0365 21.2854 12.0787L11.9999 17.6499L2.71451 12.0787C2.47772 11.9366 2.40093 11.6295 2.54301 11.3927C2.58523 11.3223 2.64413 11.2634 2.71451 11.2212L3.9166 10.4999L11.9999 15.3499L20.0833 10.4999ZM12.5144 1.30864L21.2854 6.5712C21.5221 6.71327 21.5989 7.0204 21.4569 7.25719C21.4146 7.32757 21.3557 7.38647 21.2854 7.42869L11.9999 12.9999L2.71451 7.42869C2.47772 7.28662 2.40093 6.97949 2.54301 6.7427C2.58523 6.67232 2.64413 6.61343 2.71451 6.5712L11.4854 1.30864C11.8021 1.11864 12.1977 1.11864 12.5144 1.30864ZM11.9999 3.33233L5.88723 6.99995L11.9999 10.6676L18.1126 6.99995L11.9999 3.33233Z"/>"/></svg><span class="oa-brand-text">Open Artifacts</span></a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(ogDescription)}">
<link rel="icon" href="${faviconDataUri(favicon)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(ogDescription)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:type" content="image/svg+xml">
<meta property="og:image:width" content="${OG_CARD_W}">
<meta property="og:image:height" content="${OG_CARD_H}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(ogDescription)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
<style>${RESET_CSS}${format === "markdown" ? MARKDOWN_CSS : ""}</style>
</head>
<body>
<header class="oa-header">
  <span class="oa-title"><span class="oa-fav">${escapeHtml(favicon)}</span>${escapeHtml(title)}</span>
  ${brandHtml}
  <button id="oa-theme-toggle" type="button" aria-label="Toggle theme"></button>
</header>
${body}
<script>${THEME_SCRIPT}</script>
<script>${LAYOUT_SCRIPT}</script>
</body>
</html>
`;
}

const CONTENT_SLOT = "__OA_CONTENT_SLOT__";

const UNLOCK_CSS = `
.oa-unlock{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.25rem}
.oa-card{width:100%;max-width:22rem;border:1px solid var(--oa-border);border-radius:10px;padding:2rem;background:var(--oa-surface)}
.oa-card .oa-emoji{font-size:2rem;margin-bottom:.5rem}
.oa-card h1{font-size:1.1rem;margin:0 0 .25rem}
.oa-card p{margin:0 0 1.25rem;color:var(--oa-muted);font-size:.9rem}
.oa-card input{width:100%;padding:.55rem .7rem;border:1px solid var(--oa-border);border-radius:6px;background:var(--oa-bg);color:var(--oa-fg);font-size:1rem}
.oa-card button{width:100%;margin-top:.75rem;padding:.55rem .7rem;border:none;border-radius:6px;background:var(--oa-fg);color:var(--oa-bg);font-size:1rem;cursor:pointer}
.oa-card button:disabled{opacity:.6;cursor:wait}
.oa-error{color:#c93c3c;font-size:.85rem;min-height:1.2em;margin-top:.6rem}
#oa-frame{position:fixed;inset:0;width:100%;height:100%;border:0;display:none}
`;

export interface UnlockShellOptions {
  title: string;
  description: string;
  favicon: string;
  format: ArtifactFormat;
  url: string;
  ogImage: string;
  brandUrl?: string | null;
  envelope: EncryptionParams & { ciphertext: string };
}

export function unlockShell(options: UnlockShellOptions): string {
  const {
    title,
    description,
    favicon,
    format,
    url,
    ogImage,
    brandUrl,
    envelope,
  } = options;
  const template = wrapDocument({
    title,
    description,
    favicon,
    format,
    content: CONTENT_SLOT,
    url,
    ogImage,
    brandUrl,
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
    error.textContent="Wrong password. Decryption failed.";
    button.disabled=false;
    button.textContent="Unlock";
  }
});
input.focus();
`;

  const ogDescription = description || title;
  const brandHtml = brandUrl
    ? `<a class="oa-brand" href="${escapeHtml(brandUrl)}" target="_blank" rel="noopener noreferrer" title="Made with Open Artifacts"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M20.0833 15.1999L21.2854 15.9212C21.5221 16.0633 21.5989 16.3704 21.4569 16.6072C21.4146 16.6776 21.3557 16.7365 21.2854 16.7787L12.5144 22.0412C12.1977 22.2313 11.8021 22.2313 11.4854 22.0412L2.71451 16.7787C2.47772 16.6366 2.40093 16.3295 2.54301 16.0927C2.58523 16.0223 2.64413 15.9634 2.71451 15.9212L3.9166 15.1999L11.9999 20.0499L20.0833 15.1999ZM20.0833 10.4999L21.2854 11.2212C21.5221 11.3633 21.5989 11.6704 21.4569 11.9072C21.4146 11.9776 21.3557 12.0365 21.2854 12.0787L11.9999 17.6499L2.71451 12.0787C2.47772 11.9366 2.40093 11.6295 2.54301 11.3927C2.58523 11.3223 2.64413 11.2634 2.71451 11.2212L3.9166 10.4999L11.9999 15.3499L20.0833 10.4999ZM12.5144 1.30864L21.2854 6.5712C21.5221 6.71327 21.5989 7.0204 21.4569 7.25719C21.4146 7.32757 21.3557 7.38647 21.2854 7.42869L11.9999 12.9999L2.71451 7.42869C2.47772 7.28662 2.40093 6.97949 2.54301 6.7427C2.58523 6.67232 2.64413 6.61343 2.71451 6.5712L11.4854 1.30864C11.8021 1.11864 12.1977 1.11864 12.5144 1.30864ZM11.9999 3.33233L5.88723 6.99995L11.9999 10.6676L18.1126 6.99995L11.9999 3.33233Z"/>"/></svg><span class="oa-brand-text">Open Artifacts</span></a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(ogDescription)}">
<link rel="icon" href="${faviconDataUri(favicon)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(ogDescription)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:type" content="image/svg+xml">
<meta property="og:image:width" content="${OG_CARD_W}">
<meta property="og:image:height" content="${OG_CARD_H}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(ogDescription)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
<style>${RESET_CSS}${UNLOCK_CSS}</style>
</head>
<body>
<header class="oa-header">
  <span class="oa-title"><span class="oa-fav">${escapeHtml(favicon)}</span>${escapeHtml(title)}</span>
  ${brandHtml}
  <button id="oa-theme-toggle" type="button" aria-label="Toggle theme"></button>
</header>
<div class="oa-unlock">
  <form class="oa-card" id="oa-form">
    <div class="oa-emoji">${escapeHtml(favicon)}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>This artifact is password protected. It is decrypted in your browser (PBKDF2 + AES-GCM); the server never sees the password.</p>
    <input id="oa-password" type="password" autocomplete="current-password" placeholder="Password" required>
    <button id="oa-submit" type="submit">Unlock</button>
    <div class="oa-error" id="oa-error" role="alert"></div>
  </form>
</div>
<iframe id="oa-frame" sandbox="allow-scripts allow-modals" title="${escapeHtml(title)}"></iframe>
<script>${unlockScript}</script>
<script>${THEME_SCRIPT}</script>
<script>${LAYOUT_SCRIPT}</script>
</body>
</html>
`;
}

export function notFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifact not found</title>
<style>${RESET_CSS}.oa-nf{min-height:100dvh;display:flex;align-items:center;justify-content:center;color:var(--oa-muted)}</style>
</head>
<body><div class="oa-nf"><p>This artifact does not exist or was deleted.</p></div></body>
</html>
`;
}

export function badVersionPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invalid version</title>
<style>${RESET_CSS}.oa-nf{min-height:100dvh;display:flex;align-items:center;justify-content:center;color:var(--oa-muted)}</style>
</head>
<body><div class="oa-nf"><p>The <code>?v=</code> parameter must be a positive integer version number.</p></div></body>
</html>
`;
}
