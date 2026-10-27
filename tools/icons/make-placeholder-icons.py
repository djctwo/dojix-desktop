#!/usr/bin/env python3
"""Draws the placeholder 1024x1024 source icon for each brand (stdlib only).

Usage: python3 tools/icons/make-placeholder-icons.py
Then:  pnpm --filter @dojix-desktop/desktop tauri icon brands/<brand>/icon-source.png -o brands/<brand>/icons

These are placeholders until final artwork exists: a dark rounded tile with the brand accent.
Dojix gets a ring with a gap, Greenwick gets three rising bars.
"""
import math
import struct
import zlib
from pathlib import Path

SIZE = 1024
SS = 3  # supersampling per axis for anti-aliased edges

BRANDS = {
    "dojix": {"bg": (0x14, 0x13, 0x10), "accent": (0xE8, 0xB4, 0x4C), "mark": "ring"},
    "greenwick": {"bg": (0x10, 0x12, 0x14), "accent": (0x00, 0xD4, 0xAA), "mark": "bars"},
}


def in_rounded_square(x, y, inset, radius):
    lo, hi = inset, SIZE - inset
    if x < lo or x > hi or y < lo or y > hi:
        return False
    cx = min(max(x, lo + radius), hi - radius)
    cy = min(max(y, lo + radius), hi - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def in_ring(x, y):
    c = SIZE / 2
    r = math.hypot(x - c, y - c)
    if not (210 <= r <= 330):
        return False
    angle = math.degrees(math.atan2(y - c, x - c))  # 0 = east, 90 = south
    return not (-62 <= angle <= -18)  # gap at the upper right


def in_bars(x, y):
    base = 760
    bars = [(268, 392, 560), (450, 574, 430), (632, 756, 290)]  # x0, x1, top
    return any(x0 <= x <= x1 and top <= y <= base for x0, x1, top in bars)


def pixel(brand, x, y):
    """Returns (r, g, b, a) for one output pixel, averaging SS*SS samples."""
    acc = [0, 0, 0, 0]
    spec = BRANDS[brand]
    mark = in_ring if spec["mark"] == "ring" else in_bars
    for i in range(SS):
        for j in range(SS):
            sx = x + (i + 0.5) / SS
            sy = y + (j + 0.5) / SS
            if not in_rounded_square(sx, sy, 64, 200):
                continue
            colour = spec["accent"] if mark(sx, sy) else spec["bg"]
            acc[0] += colour[0]
            acc[1] += colour[1]
            acc[2] += colour[2]
            acc[3] += 255
    n = SS * SS
    alpha = acc[3] / n
    if alpha == 0:
        return (0, 0, 0, 0)
    covered = acc[3] / 255
    return (round(acc[0] / covered), round(acc[1] / covered), round(acc[2] / covered), round(alpha))


def write_png(path, rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in rows)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    root = Path(__file__).resolve().parents[2]
    for brand in BRANDS:
        rows = [[pixel(brand, x, y) for x in range(SIZE)] for y in range(SIZE)]
        out = root / "brands" / brand / "icon-source.png"
        write_png(out, rows)
        print(f"wrote {out.relative_to(root)}")


if __name__ == "__main__":
    main()
