# -*- coding: utf-8 -*-
"""Зрізає фон зі згенерованого стікера. Кант і тінь НЕ чіпає.

Кільце малює сама модель, і робить це краще за домальовування кодом:
пробували нарощувати альфу — кільце лягало поверх намальованого,
виходило подвійним, силует розпухав, а просвіт між ногами затягувало.
Тому тут лишився один крок: прибрати біле тло навколо.

Заливка йде ВІД КРАЇВ, а не матинг-моделлю: на позах ведучого
hyperframes remove-background приймав світлу куртку за фон і з'їдав
41.5% фігури. Заливка від країв не чіпає світле всередині — і, що
важливо саме тут, зупиняється на сірій тіні під кантом, тому саме
кільце лишається цілим.
"""
import os
import sys
from collections import deque

from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
BG_MIN = 244   # min(RGB) >= цього вважаємо тлом; вище за 238 з поз, бо
               # тут треба зупинитись на блідій тіні навколо кільця


def cut_background(im, bg_min=BG_MIN):
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()

    def is_bg(x, y):
        r, g, b, _ = px[x, y]
        return min(r, g, b) >= bg_min

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not seen[y * w + x] and is_bg(x, y):
                seen[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not seen[y * w + x] and is_bg(x, y):
                seen[y * w + x] = 1
                q.append((x, y))

    while q:
        x, y = q.popleft()
        px[x, y] = (255, 255, 255, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_bg(nx, ny):
                seen[ny * w + nx] = 1
                q.append((nx, ny))

    # Пом'якшує сходинки на межі зрізу — розмивається тільки альфа.
    im.putalpha(im.getchannel("A").filter(ImageFilter.GaussianBlur(0.6)))
    return im


def main():
    # Модель не завжди віддає той самий білий: буває фон 238–247, і
    # тоді заливка з дефолтним порогом не стартує зовсім. Поріг для
    # такого файлу пишеться в його запис у stickers.json.
    args = sys.argv[1:]
    bg_min = BG_MIN
    for a in list(args):
        if a.startswith("--bg="):
            bg_min = int(a.split("=", 1)[1])
            args.remove(a)

    names = args or sorted(
        f for f in os.listdir(HERE)
        if f.endswith(".png") and not f.endswith(".raw.png") and not f.startswith("_")
    )
    for name in names:
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
            print(f"{name}: немає файлу")
            continue
        # Копія «як згенеровано»: зріз можна переробити з іншим порогом,
        # не витрачаючи ще одну генерацію.
        raw = path[:-4] + ".raw.png"
        if not os.path.exists(raw):
            Image.open(path).convert("RGB").save(raw)
        src = Image.open(raw)

        im = cut_background(src, bg_min)
        bbox = im.getbbox()
        if bbox is None:
            print(f"{name}: порожньо після зрізу")
            continue
        im = im.crop(bbox)
        im.save(path)

        opaque = sum(1 for a in im.getchannel("A").getdata() if a > 200)
        share = opaque / (im.width * im.height)
        print(f"{name}: {im.width}x{im.height}, непрозорих {share:.0%}")


if __name__ == "__main__":
    main()
