"""Generates Claude IDE brand assets: app icon (png + icns) and editor watermark SVGs. Re-run after tweaking colors."""
import os, subprocess, shutil
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
# A "C" made of mosaic tiles (col, row) on a 3x3 grid.
TILES = [(0, 0), (1, 0), (2, 0), (0, 1), (0, 2), (1, 2), (2, 2)]
COLORS = {  # top → bottom gradient per tile: terracotta, clay, amber
    (0, 0): ('#E8895A', '#C8603A'), (1, 0): ('#F2B06A', '#E0874A'), (2, 0): ('#D9774B', '#B4532F'),
    (0, 1): ('#E07B4C', '#C05A35'), (0, 2): ('#C9673F', '#9E4526'), (1, 2): ('#D9774B', '#B4532F'), (2, 2): ('#E8895A', '#C8603A'),
}

def hex_rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

def gradient(size, top, bottom):
    w, h = size
    g = Image.new('RGB', (1, h))
    t, b = hex_rgb(top), hex_rgb(bottom)
    for y in range(h):
        k = y / max(1, h - 1)
        g.putpixel((0, y), tuple(round(t[i] + (b[i] - t[i]) * k) for i in range(3)))
    return g.resize((w, h))

def rounded_mask(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return m

def icon(px=1024):
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    s = px / 1024
    # macOS squircle-ish plate: 824px with ~100px margin
    plate_box = (int(100 * s), int(100 * s), int(924 * s), int(924 * s))
    pw = plate_box[2] - plate_box[0]
    shadow = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((plate_box[0], plate_box[1] + int(14 * s), plate_box[2], plate_box[3] + int(14 * s)), int(185 * s), fill=(0, 0, 0, 110))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(20 * s)))
    plate = gradient((pw, pw), '#2E2622', '#161211').convert('RGBA')
    plate.putalpha(rounded_mask((pw, pw), int(185 * s)))
    img.alpha_composite(plate, plate_box[:2])
    # subtle highlight border (drawn on its own layer so it blends instead of replacing pixels)
    ring = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle(plate_box, int(185 * s), outline=(255, 214, 180, 30), width=max(1, int(3 * s)))
    img.alpha_composite(ring)
    # tiles
    tile, gap = int(160 * s), int(26 * s)
    grid = 3 * tile + 2 * gap
    ox = plate_box[0] + (pw - grid) // 2
    oy = plate_box[1] + (pw - grid) // 2
    for (c, r) in TILES:
        x, y = ox + c * (tile + gap), oy + r * (tile + gap)
        sh = Image.new('RGBA', (px, px), (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle((x, y + int(10 * s), x + tile, y + tile + int(10 * s)), int(34 * s), fill=(0, 0, 0, 120))
        img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(10 * s)))
        t = gradient((tile, tile), *COLORS[(c, r)]).convert('RGBA')
        t.putalpha(rounded_mask((tile, tile), int(34 * s)))
        img.alpha_composite(t, (x, y))
        hl = Image.new('RGBA', (px, px), (0, 0, 0, 0))
        ImageDraw.Draw(hl).rounded_rectangle((x, y, x + tile, y + tile), int(34 * s), outline=(255, 235, 215, 45), width=max(1, int(3 * s)))
        img.alpha_composite(hl)
    return img

def svg(fill, opacity):
    rects = ''.join(f'<rect x="{7 + c * 30}" y="{7 + r * 30}" width="26" height="26" rx="6"/>' for c, r in TILES)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g fill="{fill}" fill-opacity="{opacity}">{rects}</g></svg>\n'

if __name__ == '__main__':
    big = icon(1024)
    big.save(os.path.join(HERE, 'icon-1024.png'))
    iconset = os.path.join(HERE, 'claude-ide.iconset')
    shutil.rmtree(iconset, ignore_errors=True); os.makedirs(iconset)
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = size * scale
            icon(px).save(os.path.join(iconset, f'icon_{size}x{size}{"@2x" if scale == 2 else ""}.png'))
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(HERE, 'claude-ide.icns')], check=True)
    shutil.rmtree(iconset)
    for name, fill, op in [('letterpress-dark.svg', '#FFFFFF', 0.07), ('letterpress-light.svg', '#000000', 0.07),
                           ('letterpress-hcDark.svg', '#FFFFFF', 0.4), ('letterpress-hcLight.svg', '#000000', 0.4)]:
        open(os.path.join(HERE, name), 'w').write(svg(fill, op))
    print('ok')
