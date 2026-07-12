"""One-off vendor step that produces the subset CJK face embedded in the OG card.

resvg-wasm has no system fonts, so the OG rasterizer draws with fonts baked into
the Worker bundle (see scripts/vendor-fonts.mjs). Inter covers Latin; this script
produces the Simplified-Chinese face that renders CJK titles instead of the
brand-only fallback card.

Run from the repo root (writes into vendor/, which vendor-fonts.mjs then encodes
into src/generated/fonts.ts):

    curl -sL -o /tmp/notosanssc-var.ttf \\
      'https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf'
    curl -sL -o vendor/noto-sans-sc/OFL.txt \\
      'https://github.com/google/fonts/raw/main/ofl/notosanssc/OFL.txt'
    uv run --with fonttools python scripts/subset-cjk-font.py \\
      /tmp/notosanssc-var.ttf vendor/noto-sans-sc/noto-sans-sc-subset.ttf

The variable font is instanced to Medium (wght=500) — one weight the card reuses
for both title and description — and subset to the GB2312 hanzi (derived
deterministically from the encoding, no external char list) plus CJK/fullwidth
punctuation and kana. Result is ~2.2 MB. Noto Sans SC is SIL OFL 1.1; the license
travels in vendor/noto-sans-sc/OFL.txt.
"""

import sys

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

SRC, OUT = sys.argv[1], sys.argv[2]

font = TTFont(SRC)
if "fvar" in font:
    instantiateVariableFont(font, {"wght": 500}, inplace=True)

codepoints = set()
# Basic Latin + Latin-1 (safety; Inter stays the primary Latin face)
codepoints.update(range(0x20, 0x100))
# General punctuation, CJK symbols & punctuation, Hiragana/Katakana, Fullwidth
for lo, hi in [(0x2000, 0x206F), (0x3000, 0x303F), (0x3040, 0x30FF), (0xFF00, 0xFFEF)]:
    codepoints.update(range(lo, hi + 1))
# GB2312 hanzi + symbols, derived from the encoding rather than a bundled list
for high in range(0xA1, 0xFF):
    for low in range(0xA1, 0xFF):
        try:
            codepoints.add(ord(bytes([high, low]).decode("gb2312")))
        except UnicodeDecodeError:
            pass

opts = Options()
opts.hinting = False
opts.glyph_names = False
opts.legacy_kern = False
opts.name_IDs = ["*"]
opts.name_legacy = True
opts.name_languages = ["*"]
opts.layout_features = []  # drop GSUB/GPOS: the card needs no shaping features
opts.notdef_outline = True
opts.recalc_bounds = True
opts.drop_tables = ["BASE", "GSUB", "GPOS", "GDEF", "vhea", "vmtx", "VORG"]

subsetter = Subsetter(options=opts)
subsetter.populate(unicodes=codepoints)
subsetter.subset(font)
font.save(OUT)
print(f"wrote {OUT} ({len(codepoints)} codepoints requested)")
