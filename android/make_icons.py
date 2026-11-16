"""Disegna icona e banner dell'app (serve solo se vuoi cambiarli)."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "app/src/main/res/drawable-nodpi"
OUT.mkdir(parents=True, exist_ok=True)
BG, ACCENT, INK, TEXT = (11, 15, 26), (255, 107, 74), (26, 13, 8), (238, 241, 247)
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


# Icona 432x432
img = Image.new("RGB", (432 * S, 432 * S), BG)
mark(ImageDraw.Draw(img), 76 * S, 76 * S, 280 * S)
img.resize((432, 432), Image.LANCZOS).save(OUT / "ic_launcher.png")

# Banner Android TV 640x360
img = Image.new("RGB", (640 * S, 360 * S), BG)
d = ImageDraw.Draw(img)
bold, light = font("segoeuib.ttf", 84 * S), font("segoeuil.ttf", 84 * S)
w1, w2 = d.textlength("Franco", font=bold), d.textlength("Plex", font=light)
size, gap = 104 * S, 26 * S
x = (640 * S - (size + gap + w1 + w2)) / 2
mark(d, x, 128 * S, size)
d.text((x + size + gap, 180 * S), "Franco", font=bold, fill=ACCENT, anchor="lm")
d.text((x + size + gap + w1, 180 * S), "Plex", font=light, fill=TEXT, anchor="lm")
img.resize((640, 360), Image.LANCZOS).save(OUT / "banner.png")
print("ok")
