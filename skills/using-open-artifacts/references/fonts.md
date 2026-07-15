# Web fonts (opt-in, same-origin)

This is the catalog-and-contract reference for the opt-in web-font surface. It
sits beside `design.md`'s installed-font voice table — reach for that table
first (it costs nothing and works everywhere), and reach for a web font only
when an installed face cannot carry the voice the page needs.

## Opt-in caveat (read first)

Web fonts only render on deploys that set the Worker env var
`OPEN_ARTIFACTS_WEB_FONTS="1"`. On a deploy that has not opted in:

- the `/fonts/*` routes return 404,
- the sandbox keeps its opaque origin (no `allow-same-origin`),
- `font-src` stays `data:`, and no external font CDN is reachable.

So a web font is only worth choosing when the **fallback** installed-face stack
is acceptable on its own — the `<link>` 404s and the page falls back to the
next face in your `--font-display` / `--font-body` stack. Never let a web font
be load-bearing for legibility; let it carry character the fallback can't.

The opt-in trade-off is documented in `design.md`'s Hard constraints: opening
the sandbox with `allow-same-origin` so the browser can cache fonts ends the
opaque-origin guarantee. A malicious artifact on such a deploy can read the host
origin's `localStorage`/`cookies`. `connect-src` stays `'none'`, so direct
`fetch` exfiltration is still blocked, but DOM/side-channel reads become
reachable. Self-hosters who do not want that surface simply leave the flag unset.

## Two delivery paths

There are two sanctioned ways to get a web font into an opt-in artifact, kept
distinct because they have different trust and availability profiles:

1. **Same-origin proxy** (`/fonts/<family>--<weight>[--italic]` — see "The
   contract" below). The Worker fetches the woff2 server-side, caches it in R2,
   and serves it same-origin. Use this for any family whose foundry page is a
   download page (Behance/Gumroad/most Awwwards-listed foundries) — those never
   serve woff2 over a CDN, so they cannot be allowlisted and must be proxied.
2. **Allowlisted font CDN** — `@font-face` `src` / `@import` pointing directly at
   `cdn.fontshare.com`, `fonts.gstatic.com`, or the `fonts.googleapis.com` CSS
   host. Use this only for families that are *already* on one of these stable
   CDNs (Fontshare families, Google Fonts families, Vercel/Geist). The CSP
   allowlist is bounded to exactly these hosts; no other external font host is
   reachable, and the build gate rejects any `@font-face src` / `@import` off
   the list.

**The rule that governs both:** never allowlist a foundry/marketplace download
page (behance.net, gumroad.com, a foundry's own site). Those don't serve font
files — they serve zips/HTML — and allowlisting them widens the CSP for no font
gain. If the family isn't on Fontshare or Google Fonts, self-host it through the
`/fonts` proxy.

## The contract

Declare a web font by writing **one** `<link>` in your theme fragment:

```css
@import url("/fonts/general-sans--400.css");
```

or, equivalently, a `@font-face` whose `src` points at the proxy:

```css
@font-face {
  font-family: "General Sans";
  src: url("/fonts/general-sans--400.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

Prefer the `.css` shim — the Worker derives the `@font-face` from the slug, so
you author one line and the Worker picks the right file URL, weight, and style.
The `.woff2` form is for when you need an explicit `font-family` name that
differs from the slug, or want `font-display`/`unicode-range` control.

**Slug grammar:** `<family>--<weight>[--italic]`

- `family` — the Fontshare family token, lowercase, hyphenated, e.g.
  `general-sans`, `clash-display`, `cabinet-grotesk`.
- `weight` — the numeric CSS font-weight: `200`, `300`, `400`, `500`, `600`,
  `700`.
- `italic` — literal `italic` for the italic instance; omit for upright.

Examples: `general-sans--400`, `clash-display--600`, `general-sans--400--italic`.

The Worker resolves the slug against the Fontshare API *server-side*, fetches
the `.woff2` from `cdn.fontshare.com` *outside the sandbox*, caches the bytes in
R2 under `fonts/<slug>.woff2`, and serves it same-origin. No third-party host
ever appears in the artifact CSP; `connect-src` stays `'none'`. First load
lazily materializes the font; subsequent loads serve from R2 / browser cache.

## Discipline

- **Display first.** Most Fontshare families are display faces — strong
  personality, weak legibility at body size. Use a web font for headings and
  let the installed-face stack (see `design.md`'s voice table) carry body. Only
  promote a web font to body when the family ships a readable text weight
  (General Sans, Satoshi, Panchang).
- **Always pair with a fallback stack.** `--font-display` and `--font-body`
  must still resolve on a non-opt-in deploy. Put the web font first, the
  installed-face stack second:
  ```css
  :root {
    --font-display: "Clash Display", "Avenir Next", system-ui, sans-serif;
    --font-body: "General Sans", -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  ```
- **Honor the dark-mode compensation.** Light-on-dark reads thinner and
  tighter; when a web font carries body copy in a dark block, apply the same
  +0.05–0.1 line-height and 0.01–0.02em letter-spacing, and bump the body
  weight one step, as for installed faces (`design.md` "Dark-mode depth").
- **One web font per page, ideally.** Each family is a fetch + a render
  expense; two display faces on one page reads as indecision.

## Voice → Fontshare family (navigate, don't enumerate)

Fontshare's catalog is open-ended — browse it at fontshare.com by register, then
come back here to confirm the family has the weight you need. These are
starting points for the common registers, each paired with the installed-face
fallback it degrades to on a non-opt-in deploy:

| Voice (target register) | Fontshare family | Fallback installed stack |
| --- | --- | --- |
| Geometric sans display | `clash-display` (600) | `'Avenir Next',Avenir,...,sans-serif` |
| Editorial sans body | `general-sans` (400/500) | `-apple-system,'Segoe UI',system-ui,sans-serif` |
| Neutral neo-grotesk body | `satoshi` (400/500) | `system-ui,-apple-system,'Segoe UI',sans-serif` |
| Tech mono | `jetbrains-mono` (400) | `ui-monospace,'SF Mono',Menlo,Consolas,monospace` |
| Serif display | `pinewood` / `ducati` (700) | `'Iowan Old Style','Charter',Georgia,serif` |

Confirm the exact family token and available weights at
`https://api.fontshare.com/v2/fonts?search=<token>` before shipping — the
catalog grows and the canonical slug is the source of truth, not this table.

## Awwwards free-font collection

The [Awwwards free-fonts collection](https://www.awwwards.com/awwwards/collections/free-fonts/)
is a good register reference — browse it for direction — but most entries point
to foundry/marketplace *download pages* (Behance, Gumroad, the foundry's own
site), not stable font-file CDNs. That distinction decides which delivery path
a family uses:

- **On Fontshare or Google Fonts** → use the allowlisted-CDN path. Declare it
  directly. For a Fontshare family, the `/fonts` proxy is cleaner (one slug,
  R2-cached). For a Google Fonts family, use the `@import`/`@font-face` directly:

  ```css
  /* Google Fonts — served from fonts.gstatic.com (woff2) + fonts.googleapis.com (CSS) */
  @import url("https://fonts.googleapis.com/css2?family=Fraunces:wght@600&display=swap");
  :root { --font-display: "Fraunces", Georgia, serif; }
  ```

  Awwwards-listed families that are also on Google Fonts include Absans,
  Junicode, and several variable faces — check `fonts.google.com` before
  assuming a CDN. Vercel/Geist self-hosts on Vercel's domain; if the opt-in
  allowlist doesn't cover it, self-host via the `/fonts` proxy.

- **Foundry/marketplace only (no CDN)** → self-host via the `/fonts` proxy.
  Download the woff2 from the foundry, drop it under `vendor/<family>/` in the
  open-artifacts repo, and add a proxy entry — or, for a one-off, inline the
  face as a `@font-face` `data:` URI. Do **not** allowlist the foundry page.

### Voice → Awwwards family (register map)

Use this to translate an Awwwards-listed family into the right path. The
"delivery" column is the decision:

| Register | Awwwards-listed family | On a allowlisted CDN? | Delivery |
| --- | --- | --- | --- |
| Geometric / brutalist display | Pangram Sans, PP Mori | Fontshare (some) / foundry | proxy if foundry-only; Fontshare slug if listed |
| Editorial serif display | Bigilla Display, Junicode Bold Cond | Google Fonts (Junicode) / foundry | Google Fonts `@import` / proxy |
| Neo-grotesk / humanist sans | Ranade, Absans, HK Grotesk | Fontshare (Ranade) / Google (Absans) | Fontshare slug / Google `@import` |
| Variable display | Mango Grotesque, Melody | Gumroad (marketplace) | proxy (self-host the woff2) |
| Tech mono | OffBit, Vercetti | foundry | proxy |

When in doubt: if the family isn't on Fontshare or Google Fonts, it goes
through the `/fonts` proxy. Confirm the exact CDN or download page before
shipping — the Awwwards collection rotates and a family's hosting can change.

## License & attribution

Fontshare families are published under the ITF Free Font License (itf_ffl) and
are free for commercial use. The license does not require attribution in the
rendered page, but the foundry and family name are the family's identity —
mention them in prose when a face is load-bearing to a brand direction, the way
you would credit an installed face. Do not redistribute the raw `.woff2`
outside this proxy; the same-origin route is the sanctioned channel.
