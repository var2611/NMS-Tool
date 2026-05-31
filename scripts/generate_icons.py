#!/usr/bin/env python3
"""
SentinelNMS Icon Generator
Generates PNG and ICO icons for all platforms.
Run from project root: python scripts/generate_icons.py

Requires: pip install Pillow
"""

import os
import sys
import math

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    print("Installing Pillow...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow", "-q"])
    from PIL import Image, ImageDraw, ImageFilter


# ── Colour palette (matches app theme) ────────────────────────────────────────
NAVY_BG      = (10,  21,  32,  255)   # #0a1520 darkest background
NAVY_MID     = (14,  27,  46,  255)   # #0e1b2e circle bg
NAVY_SHIELD  = (12,  28,  55,  255)   # #0c1c37 shield fill
NAVY_INNER   = ( 7,  18,  30,  255)   # #07121e shield depth
TEAL         = (20, 184, 166,  255)   # #14b8a6 primary brand
TEAL_BRIGHT  = (45, 212, 191,  255)   # #2dd4bf highlights


def lerp(a, b, t):
    return int(a + (b - a) * t)

def lerp_color(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(4))


def create_icon(size: int) -> Image.Image:
    """Draw the SentinelNMS shield-signal icon at `size` × `size`."""

    # Work at 2× for supersampling → sharper edges when downscaled
    S = size * 2
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    cx = cy = S // 2

    # ── Background circle with radial gradient ────────────────────────────────
    bg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    bg_d = ImageDraw.Draw(bg)
    r_bg = S // 2 - 2
    for r in range(r_bg, 0, -1):
        t = r / r_bg
        col = lerp_color((22, 49, 80, 255), NAVY_BG, t)
        bg_d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    img = Image.alpha_composite(img, bg)

    # ── Shield geometry (5-point polygon) ─────────────────────────────────────
    pad    = int(S * 0.17)
    s_l    = pad                   # left
    s_r    = S - pad               # right
    s_top  = int(S * 0.13)        # top
    s_mid  = int(S * 0.58)        # where sides angle inward
    s_bot  = int(S * 0.88)        # tip

    shield = [
        (s_l, s_top),
        (s_r, s_top),
        (s_r, s_mid),
        (cx,  s_bot),
        (s_l, s_mid),
    ]

    # Shield glow layer
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd   = ImageDraw.Draw(glow)
    gd.polygon(shield, fill=(*TEAL[:3], 70))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.07))
    img  = Image.alpha_composite(img, glow)

    draw = ImageDraw.Draw(img)

    # Shield fill (dark gradient approximated with two polygons)
    draw.polygon(shield, fill=NAVY_SHIELD)
    # Inner lighter polygon for bevel feel
    inset = int(S * 0.025)
    inner = [
        (s_l + inset, s_top + inset),
        (s_r - inset, s_top + inset),
        (s_r - inset, s_mid - inset),
        (cx,          s_bot - inset * 2),
        (s_l + inset, s_mid - inset),
    ]
    draw.polygon(inner, fill=NAVY_INNER)

    # Shield border
    bw = max(3, S // 28)
    n = len(shield)
    for i in range(n):
        draw.line([shield[i], shield[(i + 1) % n]], fill=TEAL, width=bw)

    # Top highlight (brighter teal line along top edge)
    hw = max(2, S // 70)
    draw.line(
        [(s_l + bw, s_top + bw // 2), (s_r - bw, s_top + bw // 2)],
        fill=TEAL_BRIGHT, width=hw
    )

    # Corner accent dots
    dot_r = max(3, S // 40)
    for px, py in [(s_l, s_top), (s_r, s_top)]:
        draw.ellipse([px - dot_r, py - dot_r, px + dot_r, py + dot_r],
                     fill=(*TEAL[:3], 160))

    # ── Signal / wifi arcs ────────────────────────────────────────────────────
    # Arc center sits at lower-middle of shield interior
    arc_cx = cx
    arc_cy = int(S * 0.63)

    # PIL arc angles (clockwise from 3-o'clock):
    #   270° = 12-o'clock (top)  →  upper arc: start=200, end=340
    arc_lw = max(3, S // 38)

    arcs = [
        (int(S * 0.21), arc_lw - 1, (*TEAL[:3], 110)),   # large / faintest
        (int(S * 0.145), arc_lw,    (*TEAL[:3], 185)),   # medium
        (int(S * 0.080), arc_lw + 1, (*TEAL[:3], 255)),  # small / brightest
    ]

    for r, lw, color in arcs:
        if r < 4:
            continue
        bbox = [arc_cx - r, arc_cy - r, arc_cx + r, arc_cy + r]
        draw.arc(bbox, start=200, end=340, fill=color, width=lw)

    # Center dot glow
    dot_gr = int(S * 0.055)
    glow2 = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd2 = ImageDraw.Draw(glow2)
    gd2.ellipse([arc_cx - dot_gr, arc_cy - dot_gr,
                 arc_cx + dot_gr, arc_cy + dot_gr],
                fill=(*TEAL[:3], 90))
    glow2 = glow2.filter(ImageFilter.GaussianBlur(S * 0.04))
    img = Image.alpha_composite(img, glow2)
    draw = ImageDraw.Draw(img)

    # Center dot
    dr = max(4, int(S * 0.046))
    draw.ellipse([arc_cx - dr, arc_cy - dr, arc_cx + dr, arc_cy + dr],
                 fill=TEAL)
    dr2 = max(2, int(S * 0.022))
    draw.ellipse([arc_cx - dr2, arc_cy - dr2, arc_cx + dr2, arc_cy + dr2],
                 fill=TEAL_BRIGHT)

    # ── Downsample 2× → final size ────────────────────────────────────────────
    out = img.resize((size, size), Image.LANCZOS)
    return out


def save_ico(base: Image.Image, path: str):
    """Save a multi-resolution ICO file."""
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [base.resize((s, s), Image.LANCZOS).convert('RGBA')
              for s in ico_sizes]
    frames[0].save(
        path, format='ICO',
        sizes=[(s, s) for s in ico_sizes],
        append_images=frames[1:]
    )


def main():
    os.chdir(os.path.join(os.path.dirname(__file__), '..'))

    os.makedirs('desktop', exist_ok=True)
    os.makedirs('frontend/public', exist_ok=True)
    os.makedirs('frontend/src/assets', exist_ok=True)

    print("Generating SentinelNMS icons …")

    master = create_icon(512)

    # ── desktop/icon.png  (Linux tray + general)
    icon256 = master.resize((256, 256), Image.LANCZOS)
    icon256.save('desktop/icon.png', 'PNG')
    print("  [OK] desktop/icon.png")

    # ── desktop/icon_512.png  (high-res master)
    master.save('desktop/icon_512.png', 'PNG')
    print("  [OK]  desktop/icon_512.png")

    # ── desktop/icon.ico  (Windows installer)
    save_ico(master, 'desktop/icon.ico')
    print("  [OK]  desktop/icon.ico")

    # ── frontend/public/favicon.ico  (browser tab)
    fav = master.resize((32, 32), Image.LANCZOS)
    fav16 = master.resize((16, 16), Image.LANCZOS)
    fav.save('frontend/public/favicon.ico', format='ICO',
             sizes=[(32, 32), (16, 16)],
             append_images=[fav16])
    print("  [OK]  frontend/public/favicon.ico")

    # ── frontend/src/assets/logo.png  (used in React if needed)
    logo = master.resize((128, 128), Image.LANCZOS)
    logo.save('frontend/src/assets/logo.png', 'PNG')
    print("  [OK]  frontend/src/assets/logo.png")

    print()
    print("Done! All SentinelNMS icons generated.")
    print()
    print("Next steps:")
    print("  • For Mac (.icns): use iconutil or an online converter from desktop/icon_512.png")
    print("  • Build Electron: npm run build:win / npm run build:linux")


if __name__ == '__main__':
    main()
