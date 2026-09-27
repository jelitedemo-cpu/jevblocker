"""Generates the extension's PNG icons with no third-party dependencies.

Chrome needs real PNG files for the toolbar icon, and this repo has no image
library available. Writing the encoder directly keeps the build reproducible
from source rather than committing opaque binaries.

    python tools/make_icons.py
"""

import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "extension" / "icons"

SIZES = (16, 48, 128)
BACKGROUND = (0x0F, 0x6E, 0x56)
FOREGROUND = (0xFF, 0xFF, 0xFF)

# Shield outline in normalised coordinates, y pointing down.
SHIELD = [
    (0.22, 0.25),
    (0.78, 0.25),
    (0.78, 0.52),
    (0.50, 0.82),
    (0.22, 0.52),
]


def in_rounded_square(x, y, size, radius):
    if x < 0.0 or y < 0.0 or x > size or y > size:
        return False
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= radius * radius


def in_polygon(x, y, points):
    inside = False
    count = len(points)
    j = count - 1
    for i in range(count):
        xi, yi = points[i]
        xj, yj = points[j]
        if (yi > y) != (yj > y):
            slope = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < slope:
                inside = not inside
        j = i
    return inside


def render(size, supersample=6):
    radius = size * 0.22
    polygon = [(px * size, py * size) for px, py in SHIELD]
    step = 1.0 / supersample
    samples = supersample * supersample
    rows = []

    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(supersample):
                y = py + (sy + 0.5) * step
                for sx in range(supersample):
                    x = px + (sx + 0.5) * step
                    if not in_rounded_square(x, y, size, radius):
                        continue
                    if in_polygon(x, y, polygon):
                        acc_r += FOREGROUND[0]
                        acc_g += FOREGROUND[1]
                        acc_b += FOREGROUND[2]
                    else:
                        acc_r += BACKGROUND[0]
                        acc_g += BACKGROUND[1]
                        acc_b += BACKGROUND[2]
                    acc_a += 255.0

            if acc_a <= 0:
                row.extend((0, 0, 0, 0))
                continue

            # Average only over covered samples so edge pixels keep their hue
            # and fade out in alpha instead of darkening toward black.
            covered = acc_a / 255.0
            row.extend(
                (
                    round(acc_r / covered),
                    round(acc_g / covered),
                    round(acc_b / covered),
                    round(acc_a / samples),
                )
            )
        rows.append(row)

    return rows


def write_png(path, width, height, rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    compressed = zlib.compress(raw, 9)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", compressed)
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        rows = render(size)
        path = OUT_DIR / f"icon{size}.png"
        write_png(path, size, size, rows)
        print(f"{path.relative_to(ROOT)}  {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
