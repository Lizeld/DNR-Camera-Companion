"""
Generate every binary fixture the app and its test suite need.

    python tools/make_fixtures.py

Produces:
    assets/watermark.png                 placeholder logo (replace in production)
    tests/fixtures/base.png              synthetic 24-bit base image
    tests/fixtures/watermark-small.png   300x200, so the 30% rule does NOT trigger
    tests/fixtures/expected.png          golden render (§8 parity target)
    tests/fixtures/label-0000646.png     Code 128 label, normal contrast
    tests/fixtures/label-lowcontrast-0000646.png
                                         forces the 2.5x contrast retry (§2.2)
    tests/fixtures/manifest.json

The golden render deliberately uses a watermark small enough that the paste is
1:1. Scaling would drag Pillow's LANCZOS resampler into the comparison, and the
30% rule never triggers in production anyway (§2.1).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from watermark_reference import render, PADDING

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FIXTURES = ROOT / "tests" / "fixtures"

SKU = "0000646"  # the SKU used in the spec's §4 example


# ---------------------------------------------------------------------------
# Code 128 encoder (mirrors src/core/code128.js)
# ---------------------------------------------------------------------------

PATTERNS = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
    "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
    "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
    "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
    "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
    "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
    "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
    "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
    "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
    "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
    "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
    "211214", "211232", "2331112",
]

START_C = 105
STOP = 106


def encode_code128_widths(digits: str) -> list[int]:
    """Encode digits in subset C, with a B-subset tail for an odd count."""
    values = [START_C]
    i = 0
    while len(digits) - i >= 2:
        values.append(int(digits[i:i + 2]))
        i += 2
    if i < len(digits):
        values.append(100)                      # Code C -> Code B
        values.append(ord(digits[i]) - 32)

    checksum = values[0] + sum(v * k for k, v in enumerate(values[1:], start=1))
    values.append(checksum % 103)
    values.append(STOP)

    widths: list[int] = []
    for v in values:
        widths.extend(int(c) for c in PATTERNS[v])
    return widths


def draw_barcode(draw: ImageDraw.ImageDraw, x: int, y: int, module: int, height: int,
                 widths: list[int], dark: tuple[int, int, int]) -> int:
    """Draw the bar pattern. Element 0 is a bar; elements alternate."""
    cursor = x
    for index, w in enumerate(widths):
        run = w * module
        if index % 2 == 0:
            draw.rectangle([cursor, y, cursor + run - 1, y + height - 1], fill=dark)
        cursor += run
    return cursor - x


# ---------------------------------------------------------------------------
# Assets
# ---------------------------------------------------------------------------

def _font(size: int):
    for name in ("arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_watermark() -> Image.Image:
    """Placeholder logo at the production asset's dimensions (796x854).

    Replace `assets/watermark.png` with the real artwork; nothing in the code
    depends on these pixels.
    """
    w, h = 796, 854
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([18, 18, w - 18, h - 18], radius=56,
                        fill=(255, 255, 255, 26), outline=(255, 255, 255, 210), width=10)

    big = _font(250)
    d.text((w // 2, 300), "DNR", font=big, fill=(255, 255, 255, 240), anchor="mm")
    d.line([90, 470, w - 90, 470], fill=(255, 255, 255, 190), width=8)
    d.text((w // 2, 560), "AUTO PARTS", font=_font(78), fill=(255, 255, 255, 225), anchor="mm")
    d.text((w // 2, 700), "PLACEHOLDER", font=_font(46), fill=(255, 255, 255, 150), anchor="mm")
    return img


def make_small_watermark() -> Image.Image:
    """300x200 — under 30% of the 1200px-wide base, so the paste is 1:1."""
    img = Image.new("RGBA", (300, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([4, 4, 295, 195], radius=18,
                        fill=(255, 255, 255, 40), outline=(255, 255, 255, 220), width=5)
    d.text((150, 78), "DNR", font=_font(84), fill=(255, 255, 255, 245), anchor="mm")
    d.text((150, 148), "AUTO PARTS", font=_font(28), fill=(255, 255, 255, 220), anchor="mm")
    # A hard checker patch: alpha compositing errors show up here immediately.
    for i in range(6):
        for j in range(3):
            if (i + j) % 2 == 0:
                d.rectangle([20 + i * 12, 20 + j * 12, 31 + i * 12, 31 + j * 12],
                            fill=(255, 255, 255, 255))
    return img


def make_base() -> Image.Image:
    """A base image built to make blending errors visible.

    Diagonal gradient plus saturated blocks and hairlines: any mistake in the
    alpha ramp, the corner compositing, or the bar geometry shows up as a
    visible seam rather than a subtle shift.
    """
    w, h = 1200, 800
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (
                (x * 255) // (w - 1),
                (y * 255) // (h - 1),
                (int(128 + 127 * math.sin(x / 37.0) * math.cos(y / 53.0))) & 0xFF,
            )

    d = ImageDraw.Draw(img)
    for i, colour in enumerate([(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255), (0, 0, 0)]):
        d.rectangle([40 + i * 70, 40, 100 + i * 70, 100], fill=colour)
    # Hairlines crossing both bar regions and the corner.
    for i in range(0, h, 40):
        d.line([0, i, 260, i], fill=(255, 255, 0), width=1)
    for i in range(0, w, 40):
        d.line([i, h - 260, i, h - 1], fill=(0, 255, 255), width=1)
    return img


def make_label(sku: str, dark=(0, 0, 0), light=(255, 255, 255), rotate=0) -> Image.Image:
    """A product label: white card, Code 128 barcode, human-readable digits."""
    widths = encode_code128_widths(sku)
    module = 4
    quiet = 12 * module
    bar_w = sum(widths) * module
    bar_h = 150

    w = bar_w + quiet * 2
    h = bar_h + 130
    img = Image.new("RGB", (w, h), light)
    d = ImageDraw.Draw(img)
    draw_barcode(d, quiet, 40, module, bar_h, widths, dark)
    d.text((w // 2, bar_h + 78), sku, font=_font(46), fill=dark, anchor="mm")

    # Sit the label on a larger, noisier scene so the scan has to find it.
    scene = Image.new("RGB", (1400, 1000), (118, 122, 130))
    sd = ImageDraw.Draw(scene)
    for i in range(0, 1400, 23):
        sd.line([i, 0, i - 400, 1000], fill=(104, 108, 118), width=2)
    if rotate:
        img = img.rotate(rotate, expand=True, fillcolor=light)
    scene.paste(img, ((1400 - img.width) // 2, (1000 - img.height) // 2))
    return scene


# ---------------------------------------------------------------------------

def main() -> int:
    ASSETS.mkdir(parents=True, exist_ok=True)
    FIXTURES.mkdir(parents=True, exist_ok=True)

    watermark = make_watermark()
    watermark.save(ASSETS / "watermark.png")

    base = make_base()
    base.save(FIXTURES / "base.png")

    small = make_small_watermark()
    small.save(FIXTURES / "watermark-small.png")

    expected = render(base, small, padding=PADDING)
    expected.save(FIXTURES / "expected.png")

    make_label(SKU).save(FIXTURES / f"label-{SKU}.png")
    # Contrast 30/255 — below the scanner's 40 threshold, so pass 1 must fail
    # and the 2.5x greyscale boost must rescue it (§2.2).
    make_label(SKU, dark=(120, 120, 120), light=(150, 150, 150)).save(
        FIXTURES / f"label-lowcontrast-{SKU}.png")
    make_label(SKU, rotate=90).save(FIXTURES / f"label-rotated-{SKU}.png")

    manifest = {
        "sku": SKU,
        "padding": PADDING,
        "base": {"file": "base.png", "width": base.width, "height": base.height},
        "watermark": {"file": "watermark-small.png", "width": small.width, "height": small.height},
        "expected": "expected.png",
        "labels": {
            "normal": f"label-{SKU}.png",
            "lowContrast": f"label-lowcontrast-{SKU}.png",
            "rotated": f"label-rotated-{SKU}.png",
        },
        "note": "Regenerate with: python tools/make_fixtures.py",
    }
    (FIXTURES / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"watermark asset : {ASSETS / 'watermark.png'} ({watermark.width}x{watermark.height})")
    print(f"golden base     : {base.width}x{base.height}")
    print(f"golden expected : {expected.width}x{expected.height}")
    print(f"labels          : SKU {SKU}, normal / low-contrast / rotated")
    print(f"fixtures in     : {FIXTURES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
