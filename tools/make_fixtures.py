"""Regenerate the ground-truth accuracy fixtures in tests/fixtures/pages/.

Each page renders a fixed 189-word passage in a handwriting-style font under a
different photographic degradation, so the true word count is known exactly.
Requires: pip install opencv-python-headless numpy Pillow, plus the Windows
fonts Ink Free and Segoe Script (present by default on Windows 10/11).

Usage: python tools/make_fixtures.py
"""
import os
import random

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "fixtures", "pages")

INK_FREE = r"C:\Windows\Fonts\Inkfree.ttf"
SEGOE_SCRIPT = r"C:\Windows\Fonts\segoesc.ttf"

PASSAGE = """Today's lecture covered the basics of cognitive load theory and why working
memory limits how much new material a student can absorb in one sitting. The professor
explained that intrinsic load comes from the difficulty of the material itself, while
extraneous load comes from how the material is presented. She argued that most bad
lectures fail because they add extraneous load rather than because the topic is hard.
We discussed worked examples and why novices learn more from studying a full solution
than from struggling through a blank problem. Later we looked at the expertise reversal
effect, where the same scaffolding that helps a beginner actually slows down someone who
already knows the material. My main takeaway is that teaching decisions should depend on
who is in the room, not just on the subject. I want to reread the section on split
attention before the next seminar because I did not follow the diagram she showed near
the end of class. The reading for next week is chapter four and the short paper on
germane load, which apparently is contested and may not be a real category at all."""


def wrap_words(words, font, max_w, draw):
    lines, cur = [], []
    for w in words:
        trial = " ".join(cur + [w])
        if draw.textlength(trial, font=font) <= max_w or not cur:
            cur.append(w)
        else:
            lines.append(cur)
            cur = [w]
    if cur:
        lines.append(cur)
    return lines


def render_page(name, font_path, font_size=54, ruled=False, skew_deg=0.0,
                shadow=False, line_gap=1.9, jitter=True, seed=7):
    rng = random.Random(seed)
    W, H = 2100, 2970
    img = Image.new("RGB", (W, H), (252, 251, 247))
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(font_path, font_size)

    margin_x, margin_y = 170, 210
    max_w = W - 2 * margin_x
    lines = wrap_words(PASSAGE.split(), font, max_w, draw)
    step = int(font_size * line_gap)

    if ruled:
        for i in range(len(lines) + 2):
            y = margin_y + i * step + int(font_size * 1.05)
            draw.line([(90, y), (W - 90, y)], fill=(178, 196, 222), width=3)
        draw.line([(margin_x - 45, 60), (margin_x - 45, H - 60)], fill=(226, 174, 174), width=3)

    drawn = 0
    for i, line_words in enumerate(lines):
        y = margin_y + i * step
        x = margin_x
        if y + font_size > H - margin_y:
            break
        for w in line_words:
            dy = rng.randint(-3, 3) if jitter else 0
            draw.text((x, y + dy), w, font=font, fill=(28, 32, 68))
            x += draw.textlength(w, font=font) + draw.textlength(" ", font=font) * (
                rng.uniform(0.85, 1.25) if jitter else 1.0)
            drawn += 1

    arr = np.array(img)

    if skew_deg:
        M = cv2.getRotationMatrix2D((W / 2, H / 2), skew_deg, 1.0)
        arr = cv2.warpAffine(arr, M, (W, H), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_REPLICATE)

    if shadow:
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        grad = 1.0 - 0.42 * (xx / W) - 0.20 * (yy / H)
        vign = 1.0 - 0.30 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
        arr = np.clip(arr.astype(np.float32) * (grad * vign)[..., None], 0, 255).astype(np.uint8)

    noise = np.random.default_rng(seed).normal(0, 3.2, arr.shape).astype(np.float32)
    arr = np.clip(arr.astype(np.float32) + noise, 0, 255).astype(np.uint8)

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name + ".jpg")
    cv2.imwrite(path, cv2.cvtColor(arr, cv2.COLOR_RGB2BGR), [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    return path, drawn


def render_large_loose_line(name, seed=13):
    """Reproduces a real-photo failure: the last line written noticeably larger
    and looser than the rest, landing near 2.6-2.9x the page's median letter
    height. An earlier 2.5x band-height cap rejected exactly such a line."""
    rng = random.Random(seed)
    lines = [
        ("Deo is my mentor. Deo is kinda", 62),
        ("cool. I guess. In his free time, he", 62),
        ("likes to play card games and League of", 62),
        ("Legends. He is a nerd. Wow! So cool.", 104),
    ]
    W = 2100
    img = Image.new("RGB", (W, 780), (214, 211, 205))
    d = ImageDraw.Draw(img)
    y = 40
    for text, size in lines:
        font = ImageFont.truetype(r"C:\Windows\Fonts\segoesc.ttf", size)
        d.text((40 + rng.randint(0, 14), y + rng.randint(-4, 4)), text, font=font, fill=(24, 22, 30))
        y += int(size * 1.75)
    arr = np.array(img)
    M = cv2.getRotationMatrix2D((W / 2, 390), 1.2, 1.0)
    arr = cv2.warpAffine(arr, M, (W, 780), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    noise = np.random.default_rng(seed).normal(0, 4.0, arr.shape).astype(np.float32)
    arr = np.clip(arr.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    path = os.path.join(OUT, name + ".jpg")
    cv2.imwrite(path, cv2.cvtColor(arr, cv2.COLOR_RGB2BGR), [int(cv2.IMWRITE_JPEG_QUALITY), 86])
    return path


def render_illustration(name, seed=11):
    """Busy line-art scene with no handwriting — buildings, poles, clouds and a
    vertical glyph sign, mimicking the user-reported anime-illustration input.
    The correct word count for this page is exactly 0."""
    rng = random.Random(seed)
    W, H = 1500, 2600
    img = Image.new("RGB", (W, H), (238, 234, 248))
    d = ImageDraw.Draw(img)

    for _ in range(26):  # cloud blobs
        x, y = rng.randint(-150, W), rng.randint(0, H // 2)
        w, h = rng.randint(140, 460), rng.randint(60, 190)
        d.ellipse([x, y, x + w, y + h], fill=(250, 248, 253), outline=(180, 170, 210), width=3)

    bx = W - 640  # building with window grid
    d.rectangle([bx, 300, W - 40, H - 200], fill=(246, 243, 252), outline=(60, 50, 90), width=6)
    for row in range(12):
        for col in range(4):
            wx = bx + 50 + col * 140
            wy = 380 + row * 175
            d.rectangle([wx, wy, wx + 95, wy + 120], outline=(60, 50, 90), width=4)

    d.line([300, 150, 310, H - 150], fill=(50, 42, 80), width=14)  # pole
    d.line([650, 400, 655, H - 150], fill=(50, 42, 80), width=10)
    for i in range(9):  # wires
        y0 = rng.randint(180, 700)
        d.arc([120, y0, W - 100, y0 + rng.randint(120, 380)], 190, 350, fill=(70, 60, 100), width=4)

    sx, sy = bx - 210, 800  # vertical sign with glyph-like marks (non-Latin look)
    d.rounded_rectangle([sx, sy, sx + 150, sy + 760], radius=24, fill=(252, 250, 254), outline=(60, 50, 90), width=6)
    gy = sy + 40
    for _ in range(6):
        for _ in range(rng.randint(4, 7)):
            x1 = sx + rng.randint(22, 70)
            y1 = gy + rng.randint(0, 70)
            d.line([x1, y1, x1 + rng.randint(20, 60), y1 + rng.randint(-18, 30)], fill=(60, 50, 90), width=6)
            d.line([x1 + rng.randint(0, 40), y1 - 12, x1 + rng.randint(10, 50), y1 + 44], fill=(60, 50, 90), width=5)
        gy += 120

    for _ in range(120):  # foreground foliage hatching
        x, y = rng.randint(0, W // 2), rng.randint(H - 700, H)
        d.arc([x, y, x + rng.randint(60, 220), y + rng.randint(40, 160)],
              rng.randint(0, 180), rng.randint(180, 360), fill=(90, 80, 120), width=4)

    arr = np.array(img)
    noise = np.random.default_rng(seed).normal(0, 3.0, arr.shape).astype(np.float32)
    arr = np.clip(arr.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name + ".jpg")
    cv2.imwrite(path, cv2.cvtColor(arr, cv2.COLOR_RGB2BGR), [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    return path


CASES = [
    ("01_clean_print_like", dict(font_path=INK_FREE, ruled=False, skew_deg=0.0, shadow=False, line_gap=1.9)),
    ("02_ruled_notebook",   dict(font_path=INK_FREE, ruled=True,  skew_deg=0.0, shadow=False, line_gap=1.9)),
    ("03_skewed_photo",     dict(font_path=INK_FREE, ruled=False, skew_deg=3.5, shadow=False, line_gap=1.9)),
    ("04_shadow_lighting",  dict(font_path=INK_FREE, ruled=False, skew_deg=0.0, shadow=True,  line_gap=1.9)),
    ("05_cramped_lines",    dict(font_path=INK_FREE, ruled=False, skew_deg=0.0, shadow=False, line_gap=1.35)),
    ("06_cursive_script",   dict(font_path=SEGOE_SCRIPT, ruled=False, skew_deg=0.0, shadow=False, line_gap=1.9)),
    ("07_realistic_combo",  dict(font_path=INK_FREE, ruled=True,  skew_deg=2.5, shadow=True,  line_gap=1.7)),
]

if __name__ == "__main__":
    for name, kw in CASES:
        path, drawn = render_page(name, **kw)
        print(f"{name}: {drawn} words -> {path}")
    ipath = render_illustration("08_illustration")
    print(f"08_illustration: 0 words -> {ipath}")
    lpath = render_large_loose_line("09_large_loose_line")
    print(f"09_large_loose_line: 31 words -> {lpath}")
