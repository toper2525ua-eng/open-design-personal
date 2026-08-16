# -*- coding: utf-8 -*-
"""Каталог фонів і символів NFT-подарунків Telegram.

Звідки дані. Публічна сторінка колекційного подарунка
`t.me/nft/<Collection>-<N>` містить ГОТОВИЙ SVG картки: радіальний
градієнт фону (два кольори), колір символів (feFlood), саме зображення
символу (PNG у CDN) і таблицю атрибутів із назвами та рідкістю.
Іншого відкритого списку фонів немає — Bot API віддає атрибути лише
для подарунка, який отримав твій бот.

Скрипт обходить кілька номерів кількох колекцій і збирає УНІКАЛЬНІ
фони й символи. Один номер = один випадковий набір атрибутів, тож
що більше номерів, то повніший каталог; повторні запуски доповнюють
наявний файл, а не перетирають його.

    python nft_backdrops.py --out <data>/gifts/nft --collections PlushPepe,SnoopDogg --per 40

Останній рядок stdout — JSON-звіт {"backdrops": N, "symbols": M}.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


def fetch(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_page(html: str) -> dict | None:
    """Атрибути + кольори картки з HTML сторінки подарунка."""
    # Таблиця атрибутів: «Model | Pumpkin 3%» тощо. Назва може містити
    # пробіли й апострофи, тому беремо все до відсотка.
    attrs: dict[str, dict] = {}
    for key in ("Model", "Backdrop", "Symbol"):
        m = re.search(
            rf'<th>{key}</th>\s*<td>(.*?)(?:<mark[^>]*>\s*([\d.]+)%)?\s*</',
            html, re.S | re.I)
        if not m:
            continue
        name = re.sub(r"<[^>]+>", "", m.group(1)).strip()
        attrs[key.lower()] = {"name": name, "rarity": float(m.group(2)) if m.group(2) else None}
    if "backdrop" not in attrs:
        return None

    stops = re.findall(r'<stop stop-color="(#[0-9a-fA-F]{6})"', html)
    flood = re.search(r'flood-color="(#[0-9a-fA-F]{6})"', html)
    text = re.search(r'tgme_gift_number_label" style="color: (#[0-9a-fA-F]{6})', html)
    pattern = re.search(r'id="giftPattern"[^>]*xlink:href="([^"]+)"', html)
    return {
        "attrs": attrs,
        "center": stops[0] if stops else None,
        "edge": stops[1] if len(stops) > 1 else None,
        "symbolColor": flood.group(1) if flood else None,
        "textColor": text.group(1) if text else None,
        "patternUrl": pattern.group(1) if pattern else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="тека каталогу (gifts/nft)")
    ap.add_argument("--collections", required=True, help="через кому: PlushPepe,SnoopDogg")
    ap.add_argument("--per", type=int, default=30, help="скільки номерів на колекцію")
    ap.add_argument("--start", type=int, default=1, help="з якого номера починати")
    ap.add_argument("--delay", type=float, default=0.4, help="пауза між запитами, с")
    a = ap.parse_args()

    os.makedirs(f"{a.out}/symbols", exist_ok=True)
    bpath, spath = f"{a.out}/backdrops.json", f"{a.out}/symbols.json"

    def load(path: str) -> dict:
        try:
            return json.load(open(path, encoding="utf-8"))
        except Exception:  # noqa: BLE001 — файла ще немає
            return {"version": 1, "items": []}

    backdrops, symbols = load(bpath), load(spath)
    bseen = {x["name"]: x for x in backdrops["items"]}
    sseen = {x["name"]: x for x in symbols["items"]}
    added_b = added_s = 0

    for coll in [c.strip() for c in a.collections.split(",") if c.strip()]:
        for n in range(a.start, a.start + a.per):
            url = f"https://t.me/nft/{coll}-{n}"
            try:
                html = fetch(url).decode("utf-8", "replace")
            except Exception as e:  # noqa: BLE001 — номера може не бути
                print(f"  {coll}-{n}: {e}", file=sys.stderr)
                time.sleep(a.delay)
                continue
            data = parse_page(html)
            time.sleep(a.delay)
            if not data:
                continue

            b = data["attrs"]["backdrop"]
            if b["name"] and b["name"] not in bseen and data["center"] and data["edge"]:
                rec = {
                    "name": b["name"], "rarity": b["rarity"],
                    "center": data["center"], "edge": data["edge"],
                    "symbolColor": data["symbolColor"], "textColor": data["textColor"],
                    "from": f"{coll}-{n}",
                }
                bseen[b["name"]] = rec
                backdrops["items"].append(rec)
                added_b += 1
                print(f"  фон: {b['name']} {data['center']}→{data['edge']}")

            s = data["attrs"].get("symbol") or {}
            if s.get("name") and s["name"] not in sseen and data["patternUrl"]:
                png = f"{a.out}/symbols/{re.sub(r'[^a-z0-9]+', '-', s['name'].lower()).strip('-')}.png"
                try:
                    open(png, "wb").write(fetch(data["patternUrl"], timeout=25))
                except Exception as e:  # noqa: BLE001
                    print(f"  символ {s['name']}: {e}", file=sys.stderr)
                    continue
                rec = {
                    "name": s["name"], "rarity": s["rarity"],
                    "file": f"symbols/{os.path.basename(png)}",
                    "from": f"{coll}-{n}",
                }
                sseen[s["name"]] = rec
                symbols["items"].append(rec)
                added_s += 1
                print(f"  символ: {s['name']}")
                time.sleep(a.delay)

    json.dump(backdrops, open(bpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(symbols, open(spath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({
        "backdrops": len(backdrops["items"]), "symbols": len(symbols["items"]),
        "addedBackdrops": added_b, "addedSymbols": added_s,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
