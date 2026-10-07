"""
Reference watermark renderer — the source of the parity contract (spec §2.1).

This is the Pillow implementation the web renderer must reproduce. It is kept
in the repo (rather than only in the original `watermark.py`) so the golden
image used by the browser test suite can be regenerated from a single,
readable definition.

Usage:
    python tools/watermark_reference.py render BASE.jpg OUT.jpg
    python tools/watermark_reference.py render BASE.png OUT.png --lossless

Compare the *rendered bitmap* (lossless PNG), not the JPEG: the known 4:2:0
chroma-subsampling deviation (§2.1) would otherwise confound the comparison.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

BAR_COLOR = (70, 90, 120)
PADDING = 125
ALPHA_SPLIT = 0.8
MAX_WATERMARK_WIDTH_RATIO = 0.3
JPEG_QUALITY = 92


def _round_half_up(value: float) -> int:
    """Match JavaScript's Math.round for non-negative values.

    Python's built-in round() is banker's rounding, which would differ from the
    web renderer by 1/255 on exact halves.
    """
    return int(value + 0.5)


def left_bar_alpha(y: int, height: int, alpha_split: float = ALPHA_SPLIT) -> int:
    """0 -> 255 over the top `alpha_split` of the height, then solid 255."""
    split = int(height * alpha_split)
    if split <= 0:
        return 255
    if y >= split:
        return 255
    return _round_half_up(255 * y / split)


def bottom_bar_alpha(x: int, width: int, alpha_split: float = ALPHA_SPLIT) -> int:
    """Solid 255 for the left `alpha_split` of the width, then 255 -> 0."""
    split = int(width * alpha_split)
    if x < split:
        return 255
    span = width - split
    if span <= 0:
        return 255
    return _round_half_up(255 * (1 - (x - split) / span))


def build_overlay(width: int, height: int, padding: int,
                  color=BAR_COLOR, alpha_split: float = ALPHA_SPLIT) -> Image.Image:
    """Both bars on ONE transparent overlay (the critical detail, §2.1).

    The bottom bar is written after the left bar and replaces its pixels in the
    bottom-left corner, so the corner ends up exactly the bar colour rather
    than a darker doubled value.
    """
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    if padding > 0:
        left = Image.new("RGBA", (padding, height))
        left_px = left.load()
        for y in range(height):
            a = left_bar_alpha(y, height, alpha_split)
            for x in range(padding):
                left_px[x, y] = (*color, a)
        overlay.paste(left, (0, 0))  # no mask: replaces pixels

        bottom = Image.new("RGBA", (width, padding))
        bottom_px = bottom.load()
        for x in range(width):
            a = bottom_bar_alpha(x, width, alpha_split)
            for y in range(padding):
                bottom_px[x, y] = (*color, a)
        overlay.paste(bottom, (0, height - padding))  # wins in the corner

    return overlay


def watermark_placement(base_w: int, base_h: int, wm_w: int, wm_h: int,
                        padding: int = PADDING,
                        max_ratio: float = MAX_WATERMARK_WIDTH_RATIO):
    """Bottom-left at `padding` from the left and bottom edges.

    Scaled down to exactly `max_ratio` of the base width if wider, preserving
    aspect ratio. In production this never triggers (796x854 watermark on a
    6000x4000 photo: 30% is 1800px, so the paste is 1:1).
    """
    max_w = int(base_w * max_ratio)
    w, h, scaled = wm_w, wm_h, False
    if wm_w > max_w:
        scaled = True
        w = max_w
        h = _round_half_up(wm_h * max_w / wm_w)
    return padding, base_h - padding - h, w, h, scaled


def render(base: Image.Image, watermark: Image.Image | None,
           padding: int = PADDING, color=BAR_COLOR,
           alpha_split: float = ALPHA_SPLIT) -> Image.Image:
    """Apply bars + watermark. Returns an RGB image."""
    base_rgba = base.convert("RGBA")
    w, h = base_rgba.size
    padding = max(0, min(padding, min(w, h)))

    out = Image.alpha_composite(base_rgba, build_overlay(w, h, padding, color, alpha_split))

    if watermark is not None:
        wm = watermark.convert("RGBA")
        x, y, tw, th, scaled = watermark_placement(w, h, wm.width, wm.height, padding)
        if scaled:
            wm = wm.resize((tw, th), Image.LANCZOS)
        out.paste(wm, (x, y), wm)

    return out.convert("RGB")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    r = sub.add_parser("render", help="watermark one image")
    r.add_argument("base")
    r.add_argument("out")
    r.add_argument("--watermark", default="assets/watermark.png")
    r.add_argument("--padding", type=int, default=PADDING)
    r.add_argument("--lossless", action="store_true",
                   help="write PNG regardless of the output extension")

    args = parser.parse_args(argv)

    base = Image.open(args.base)
    wm_path = Path(args.watermark)
    wm = Image.open(wm_path) if wm_path.exists() else None
    if wm is None:
        print(f"warning: no watermark at {wm_path}; rendering bars only", file=sys.stderr)

    out = render(base, wm, padding=args.padding)
    if args.lossless or args.out.lower().endswith(".png"):
        out.save(args.out, "PNG")
    else:
        # subsampling=0 is 4:4:4, what the original pipeline used. The web port
        # cannot do this (§2.1) — compare bitmaps, not JPEGs.
        out.save(args.out, "JPEG", quality=JPEG_QUALITY, subsampling=0)
    print(f"wrote {args.out} ({out.width}x{out.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
