"""Disegna icon.png dell'app per le TV Samsung: il logo e sotto il nome, come il banner
dell'app Android TV (android/make_icons.py). Serve solo se vuoi cambiarla."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "icon.png"
BG, ACCENT, INK, TEXT = (6, 10, 7), (26, 127, 69), (255, 255, 255), (242, 245, 242)
W = 512
S = 4  # disegna piu' grande e poi riduce, per bordi morbidi


def font(name, size):
    try:
        return ImageFont.truetype(f"C:/Windows/Fonts/{name}", size)
    except OSError:
        return ImageFont.load_default()


def mark(draw, x, y, size):
    """Quadrato arrotondato con il triangolo del play."""
    draw.rounded_rectangle([x, y, x + size, y + size], radius=size * 0.22, fill=ACCENT)
    draw.polygon([(x + size * 0.39, y + size * 0.28), (x + size * 0.73, y + size * 0.5),
                  (x + size * 0.39, y + size * 0.72)], fill=INK)


img = Image.new("RGB", (W * S, W * S), BG)
d = ImageDraw.Draw(img)
bold, light = font("segoeuib.ttf", 82 * S), font("segoeuil.ttf", 82 * S)
w1, w2 = d.textlength("Bunker", font=bold), d.textlength("Plex", font=light)
size = 200 * S
mark(d, (W * S - size) / 2, 104 * S, size)
x = (W * S - (w1 + w2)) / 2
d.text((x, 384 * S), "Bunker", font=bold, fill=TEXT, anchor="lm")
d.text((x + w1, 384 * S), "Plex", font=light, fill=TEXT, anchor="lm")
img.resize((W, W), Image.LANCZOS).save(OUT)
print("ok")
