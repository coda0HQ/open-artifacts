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
#oa-theme-toggle{position:fixed;right:14px;bottom:14px;z-index:2147483647;width:36px;height:36px;border-radius:50%;border:1px solid var(--oa-border);background:var(--oa-surface);color:var(--oa-fg);font-size:16px;line-height:1;cursor:pointer;opacity:.55;transition:opacity .15s}
#oa-theme-toggle:hover{opacity:1}
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

const THEME_SCRIPT = `
(function(){
  var root=document.documentElement,KEY="oa-theme",saved=null;
  try{saved=localStorage.getItem(KEY)}catch(e){}
  if(saved==="light"||saved==="dark")root.setAttribute("data-theme",saved);
  var btn=document.createElement("button");
  btn.id="oa-theme-toggle";
  btn.setAttribute("aria-label","Toggle theme");
  function paint(){
    var t=root.getAttribute("data-theme");
    btn.textContent=t==="light"?"\\u2600":t==="dark"?"\\u263D":"\\u25D0";
    btn.title="Theme: "+(t||"auto");
  }
  btn.addEventListener("click",function(){
    var t=root.getAttribute("data-theme");
    var next=t===null?"light":t==="light"?"dark":null;
    if(next===null){root.removeAttribute("data-theme")}else{root.setAttribute("data-theme",next)}
    try{if(next===null){localStorage.removeItem(KEY)}else{localStorage.setItem(KEY,next)}}catch(e){}
    paint();
  });
  paint();
  document.body.appendChild(btn);
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
  const { title, description, favicon, format, content, url, ogImage } =
    options;
  const body =
    format === "markdown"
      ? `<main class="oa-md" id="oa-content"></main>
<script>${escapeInlineScript(MARKED_SOURCE)}</script>
<script>
document.getElementById("oa-content").innerHTML=marked.parse(${jsonForInlineScript(content)});
</script>`
      : content;

  const ogDescription = description || title;

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
${body}
<script>${THEME_SCRIPT}</script>
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
  envelope: EncryptionParams & { ciphertext: string };
}

export function unlockShell(options: UnlockShellOptions): string {
  const { title, description, favicon, format, url, ogImage, envelope } =
    options;
  const template = wrapDocument({
    title,
    description,
    favicon,
    format,
    content: CONTENT_SLOT,
    url,
    ogImage,
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
