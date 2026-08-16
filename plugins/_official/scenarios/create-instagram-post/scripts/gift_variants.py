# -*- coding: utf-8 -*-
"""Набір варіантів подарунка (t.me/addemoji/<set>) → каталог варіантів.

Качає всі емодзі набору, розпаковує TGS у Lottie, рендерить статичні
прев'ю (rlottie) і пише variants.json. Викликається демоном із кнопки
«Завантажити набір» у підменю подарунка.

    python gift_variants.py --set PlushPepeGifts_by_EmojiRu_Bot --out <data>/gifts/variants/gift-118

Токен бота — зі змінної середовища TG_BOT_TOKEN (демон передає сам).
Останній рядок stdout — JSON-звіт {"count": N}.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True, help="назва набору з t.me/addemoji/<set>")
    ap.add_argument("--out", required=True, help="тека варіантів подарунка")
    a = ap.parse_args()

    tok = os.environ.get("TG_BOT_TOKEN", "").strip()
    if not tok:
        raise SystemExit("TG_BOT_TOKEN не заданий — демон мусить передати токен")

    from rlottie_python import LottieAnimation
    from PIL import Image

    os.makedirs(f"{a.out}/lottie", exist_ok=True)
    os.makedirs(f"{a.out}/preview", exist_ok=True)

    r = json.load(urllib.request.urlopen(
        f"https://api.telegram.org/bot{tok}/getStickerSet?name={a.set}", timeout=30))
    if not r.get("ok"):
        raise SystemExit(f"набір не читається: {r}")
    stickers = r["result"]["stickers"]
    title = r["result"].get("title", a.set)
    print(f"набір «{title}»: {len(stickers)} емодзі")

    items = []
    for i, st in enumerate(stickers):
        slug = f"v{i:03d}"
        lot = f"{a.out}/lottie/{slug}.json"
        prev = f"{a.out}/preview/{slug}.png"
        if not os.path.exists(lot):
            ok = False
            for attempt in range(3):
                try:
                    fr = json.load(urllib.request.urlopen(
                        f"https://api.telegram.org/bot{tok}/getFile?file_id={st['file_id']}",
                        timeout=25))
                    data = urllib.request.urlopen(
                        f"https://api.telegram.org/file/bot{tok}/{fr['result']['file_path']}",
                        timeout=45).read()
                    raw = gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
                    json.loads(raw)  # валідність lottie
                    open(lot, "wb").write(raw)
                    ok = True
                    break
                except Exception as e:  # noqa: BLE001 — ретраї мережі
                    if attempt == 2:
                        print(f"пропускаю {slug}: {e}", file=sys.stderr)
                    time.sleep(1.2)
            if not ok:
                continue
        if not os.path.exists(prev):
            try:
                anim = LottieAnimation.from_file(lot)
                total = anim.lottie_animation_get_totalframe()
                buf = anim.lottie_animation_render(frame_num=max(total // 3, 0), width=160, height=160)
                Image.frombytes("RGBA", (160, 160), buf, "raw", "BGRA").save(prev)
                anim.lottie_animation_destroy()
            except Exception as e:  # noqa: BLE001
                print(f"прев'ю {slug}: {e}", file=sys.stderr)
        items.append({
            "slug": slug,
            "emoji": st.get("emoji"),
            "customEmojiId": st.get("custom_emoji_id"),
            "title": "",
            "lottie": f"lottie/{slug}.json",
            "preview": f"preview/{slug}.png",
        })
        if (i + 1) % 20 == 0:
            print(f"  {i + 1}/{len(stickers)}")

    json.dump({"version": 1, "set": a.set, "setTitle": title, "items": items},
              open(f"{a.out}/variants.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(json.dumps({"count": len(items)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
