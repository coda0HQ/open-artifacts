import { initWasm, Resvg } from "@resvg/resvg-wasm";
// Statically imported so Wrangler compiles it to a WebAssembly.Module at
// bundle time — the Workers runtime forbids compiling Wasm from raw bytes at
// runtime, so this cannot be loaded from the DB or fetched.
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import {
  INTER_REGULAR_TTF_BASE64,
  INTER_SEMIBOLD_TTF_BASE64,
  NOTO_SANS_SC_TTF_BASE64,
} from "./generated/fonts";
import type { Brand } from "./home";
import { ogCardSvg } from "./wrap";

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Inter draws Latin; Noto Sans SC is the fallback face resvg reaches for when a
// glyph (CJK, kana, fullwidth punctuation) is absent from Inter, so mixed and
// fully-CJK titles rasterize instead of dropping to the brand-only card.
const FONT_BUFFERS = [
  decodeBase64(INTER_REGULAR_TTF_BASE64),
  decodeBase64(INTER_SEMIBOLD_TTF_BASE64),
  decodeBase64(NOTO_SANS_SC_TTF_BASE64),
];

// initWasm throws if called more than once, so memoize the first call and
// await it on every render. On failure the memo is cleared so a transient
// error does not poison the isolate.
let wasmReady: Promise<unknown> | undefined;
function ensureWasm(): Promise<unknown> {
  if (!wasmReady) {
    wasmReady = initWasm(resvgWasm).catch((error) => {
      wasmReady = undefined;
      throw error;
    });
  }
  return wasmReady;
}

// Rasterize the OG card to PNG. Social crawlers ignore SVG og:image, so the
// self-contained card SVG is rendered to a 1200x630 PNG with the embedded
// Inter fonts (resvg has no access to system fonts).
export async function renderOgCardPng(options: {
  title: string;
  description: string;
  brand: Brand;
}): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(ogCardSvg(options), {
    fitTo: { mode: "width", value: 1200 },
    font: {
      loadSystemFonts: false,
      fontBuffers: FONT_BUFFERS,
      defaultFontFamily: "Inter",
    },
  });
  // Wasm-side allocations are not garbage collected; free them explicitly or
  // a long-lived isolate leaks a full render's memory per request.
  try {
    const rendered = resvg.render();
    try {
      return rendered.asPng();
    } finally {
      rendered.free();
    }
  } finally {
    resvg.free();
  }
}
