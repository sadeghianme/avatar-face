"""Stock avatar gallery.

Six stylized portraits drawn programmatically to the SAME facial proportions
the synthetic rig assumes (see services.rig.synthetic_face_mesh): face center
at (0.5w, 0.46h), half-extents (0.32w, 0.40h), mouth at cy + 0.52*fh, eyes at
cy - 0.18*fh. That alignment is what makes the synthetic rig's lip-sync look
right on these images with no MediaPipe model installed.
"""
from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image, ImageDraw

IMAGE_SIZE = 512


@dataclass(frozen=True)
class StockStyle:
    id: str
    name: str
    skin: str
    hair: str
    hair_style: str  # "short" | "long" | "bun" | "curly" | "bald" | "side"
    background: str
    shirt: str
    has_glasses: bool = False
    has_beard: bool = False


STOCK_STYLES: list[StockStyle] = [
    StockStyle("nora", "Nora", "#f2c9a0", "#5b3a1e", "long", "#dbeafe", "#7c3aed"),
    StockStyle("amir", "Amir", "#caa07a", "#1f1b16", "short", "#dcfce7", "#0f766e", has_beard=True),
    StockStyle("june", "June", "#f7d7b6", "#0f0f10", "bun", "#fee2e2", "#be123c", has_glasses=True),
    StockStyle("kofi", "Kofi", "#8d5a3b", "#0c0a09", "curly", "#fef9c3", "#1d4ed8"),
    StockStyle("sven", "Sven", "#f4d3b3", "#d6b25e", "side", "#e0e7ff", "#374151"),
    StockStyle("rosa", "Rosa", "#e0ac7e", "#6b21a8", "curly", "#fce7f3", "#047857", has_glasses=True),
]


def render_stock_avatar(style: StockStyle, size: int = IMAGE_SIZE) -> bytes:
    w = h = size
    cx, cy = w / 2, h * 0.46
    fw, fh = w * 0.32, h * 0.40

    img = Image.new("RGB", (w, h), style.background)
    draw = ImageDraw.Draw(img)

    # Shoulders / shirt
    draw.ellipse([cx - fw * 1.7, h * 0.82, cx + fw * 1.7, h * 1.5], fill=style.shirt)
    # Neck
    draw.rectangle([cx - fw * 0.28, cy + fh * 0.8, cx + fw * 0.28, h * 0.92], fill=style.skin)

    # Hair behind the head
    if style.hair_style == "long":
        draw.ellipse([cx - fw * 1.25, cy - fh * 1.25, cx + fw * 1.25, cy + fh * 1.4],
                     fill=style.hair)
    elif style.hair_style == "curly":
        draw.ellipse([cx - fw * 1.3, cy - fh * 1.35, cx + fw * 1.3, cy + fh * 0.6],
                     fill=style.hair)

    # Head: ellipse matching the synthetic mesh's face oval
    draw.ellipse([cx - fw, cy - fh, cx + fw, cy + fh], fill=style.skin)

    # Hair on top
    if style.hair_style == "short":
        draw.chord([cx - fw * 1.02, cy - fh * 1.08, cx + fw * 1.02, cy + fh * 0.25],
                   180, 360, fill=style.hair)
    elif style.hair_style == "bun":
        draw.chord([cx - fw * 1.02, cy - fh * 1.05, cx + fw * 1.02, cy + fh * 0.1],
                   180, 360, fill=style.hair)
        draw.ellipse([cx - fw * 0.3, cy - fh * 1.35, cx + fw * 0.3, cy - fh * 0.85],
                     fill=style.hair)
    elif style.hair_style == "side":
        draw.chord([cx - fw * 1.05, cy - fh * 1.1, cx + fw * 1.05, cy + fh * 0.05],
                   200, 348, fill=style.hair)
    elif style.hair_style == "long":
        draw.chord([cx - fw * 1.02, cy - fh * 1.1, cx + fw * 1.02, cy + fh * 0.2],
                   180, 360, fill=style.hair)
    elif style.hair_style == "curly":
        for dx in (-0.8, -0.4, 0.0, 0.4, 0.8):
            draw.ellipse([cx + fw * dx - fw * 0.35, cy - fh * 1.18,
                          cx + fw * dx + fw * 0.35, cy - fh * 0.55], fill=style.hair)

    # Eyes at cy - 0.18*fh, spaced 0.42*fw — exactly where the rig expects them
    eye_y = cy - fh * 0.18
    for sign in (-1, 1):
        ex = cx + sign * fw * 0.42
        draw.ellipse([ex - fw * 0.16, eye_y - fh * 0.06, ex + fw * 0.16, eye_y + fh * 0.06],
                     fill="white")
        draw.ellipse([ex - fw * 0.055, eye_y - fh * 0.045, ex + fw * 0.055, eye_y + fh * 0.045],
                     fill="#2b2017")
        # Brow
        draw.line([ex - fw * 0.2, cy - fh * 0.36, ex + fw * 0.2, cy - fh * 0.33],
                  fill=style.hair if style.hair_style != "bald" else "#6b7280", width=max(3, size // 100))

    if style.has_glasses:
        stroke = max(3, size // 110)
        for sign in (-1, 1):
            ex = cx + sign * fw * 0.42
            draw.ellipse([ex - fw * 0.24, eye_y - fh * 0.12, ex + fw * 0.24, eye_y + fh * 0.12],
                         outline="#1f2937", width=stroke)
        draw.line([cx - fw * 0.18, eye_y, cx + fw * 0.18, eye_y], fill="#1f2937", width=stroke)

    # Nose: line down to cy + 0.30*fh
    draw.line([cx, cy - fh * 0.05, cx, cy + fh * 0.30], fill=_darken(style.skin), width=max(3, size // 120))
    draw.arc([cx - fw * 0.09, cy + fh * 0.24, cx + fw * 0.09, cy + fh * 0.36], 0, 180,
             fill=_darken(style.skin), width=max(3, size // 140))

    if style.has_beard:
        draw.chord([cx - fw * 0.95, cy - fh * 0.1, cx + fw * 0.95, cy + fh * 1.02],
                   20, 160, fill=style.hair)
        # Re-draw the mouth area over the beard
        draw.ellipse([cx - fw * 0.5, cy + fh * 0.38, cx + fw * 0.5, cy + fh * 0.68],
                     fill=style.skin)

    # Mouth at cy + 0.52*fh, half-width 0.42*fw — matches the synthetic rig
    mouth_y = cy + fh * 0.52
    draw.ellipse([cx - fw * 0.42, mouth_y - fh * 0.10, cx + fw * 0.42, mouth_y + fh * 0.10],
                 fill="#b4524b")
    draw.line([cx - fw * 0.40, mouth_y, cx + fw * 0.40, mouth_y],
              fill="#7f3330", width=max(2, size // 170))

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def _darken(hex_color: str, factor: float = 0.72) -> str:
    hex_color = hex_color.lstrip("#")
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (0, 2, 4))
    return f"#{int(r * factor):02x}{int(g * factor):02x}{int(b * factor):02x}"


_cache: dict[str, bytes] = {}


def get_stock_image(style_id: str) -> bytes | None:
    style = next((s for s in STOCK_STYLES if s.id == style_id), None)
    if style is None:
        return None
    if style_id not in _cache:
        _cache[style_id] = render_stock_avatar(style)
    return _cache[style_id]
