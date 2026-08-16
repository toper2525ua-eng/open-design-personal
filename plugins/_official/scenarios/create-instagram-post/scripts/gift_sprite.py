# -*- coding: utf-8 -*-
"""Lottie-подарунок → спрайт-аркуш у теці проєкту.

Telegram-емодзі приходять як TGS (стиснений Lottie), і `lottie-web`
малює їх ПОРОЖНІМИ: файл вантажиться, шейпів нуль. Тому кадри
рендеряться заздалегідь (rlottie) і клеяться в один PNG; студія бере
кадр із віку предмета, тож рендер збігається з прев'ю.

Запуск (демон робить це сам із кнопки «Взяти в ролик»):
    python gift_sprite.py --src <lottie.json> --out <assets/stickers/<id>.sprite.png> [--cell 256] [--step 2]

Друкує JSON-звіт останнім рядком: {"frames":…, "cols":…, "rows":…, "fps":…}
"""
from __future__ import annotations

import argparse
import json
import math
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="lottie json подарунка")
    ap.add_argument("--out", required=True, help="куди покласти спрайт-аркуш")
    ap.add_argument("--cell", type=int, default=256, help="сторона кадру, px")
    ap.add_argument("--step", type=int, default=2, help="брати кожен N-й кадр")
    a = ap.parse_args()

    from rlottie_python import LottieAnimation
    from PIL import Image

    anim = LottieAnimation.from_file(a.src)
    total = anim.lottie_animation_get_totalframe()
    fps_src = anim.lottie_animation_get_framerate()
    step = max(1, a.step)
    frames = list(range(0, total, step))
    if not frames:
        raise SystemExit("у файлі немає кадрів")

    cols = math.ceil(math.sqrt(len(frames)))
    rows = math.ceil(len(frames) / cols)
    sheet = Image.new("RGBA", (cols * a.cell, rows * a.cell), (0, 0, 0, 0))
    for k, fr in enumerate(frames):
        buf = anim.lottie_animation_render(frame_num=fr, width=a.cell, height=a.cell)
        img = Image.frombytes("RGBA", (a.cell, a.cell), buf, "raw", "BGRA")
        sheet.paste(img, ((k % cols) * a.cell, (k // cols) * a.cell))
    anim.lottie_animation_destroy()
    sheet.save(a.out, optimize=True)

    # Звіт останнім рядком — демон читає саме його і кладе в sprite.
    print(json.dumps({
        "frames": len(frames), "cols": cols, "rows": rows,
        "fps": round(fps_src / step, 3),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
