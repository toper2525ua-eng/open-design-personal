# -*- coding: utf-8 -*-
"""Каталог подарунків Telegram → довідник, який читає агент.

Навіщо. Самі подарунки живуть у даних демона (`<data>/gifts/gifts.json`),
куди агент не бачить: він працює в теці ролика. Через це він знав ПРАВИЛО
(«впиши id подарунка, студія довезе спрайт»), але не знав жодного
справжнього id — і вигадував правдоподібні на кшталт `gift-collectible`.
У кадрі це давало порожню рамку замість подарунка, причому мовчки.

Тому список їде довідником поруч зі скілом. Файл генерується, а не
пишеться руками: каталог росте (наборами `t.me/addemoji/…`), і руками
він розійшовся б із даними за тиждень.

    python gen_gifts_catalog.py                 # знайде дані сам
    python gen_gifts_catalog.py --data <шлях до теки gifts>

Пише `references/gifts-catalog.md` поруч зі скілом.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def find_data(start: Path) -> Path | None:
    """Тека `gifts` демона: шукаємо вгору по деревах від скрипта."""
    for base in [start, *start.parents]:
        cand = base / ".od" / "gifts" / "gifts.json"
        if cand.exists():
            return cand.parent
    return None


def rows(items: list[dict], kind: str) -> list[str]:
    out = []
    for x in items:
        if x.get("kind") != kind:
            continue
        use = (x.get("use") or "").replace("|", "·").strip()
        out.append(f"| `{x['slug']}` | {x['title']} | {use} |")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=None, help="тека gifts демона")
    ap.add_argument("--out", default=None, help="куди писати довідник")
    a = ap.parse_args()

    here = Path(__file__).resolve().parent
    data = Path(a.data) if a.data else find_data(here)
    if data is None or not (data / "gifts.json").exists():
        print("не знайшов gifts.json — передай --data")
        return 1

    items = json.loads((data / "gifts.json").read_text(encoding="utf-8"))["items"]
    nft = rows(items, "nft")
    star = rows(items, "star")

    # Моделі: у подарунка можуть бути варіанти (Плюшевий Пепе — 50).
    models: list[str] = []
    vdir = data / "variants"
    if vdir.exists():
        for d in sorted(vdir.iterdir()):
            vfile = d / "variants.json"
            if not vfile.exists():
                continue
            doc = json.loads(vfile.read_text(encoding="utf-8"))
            title = next((x["title"] for x in items if x["slug"] == d.name), d.name)
            ids = ", ".join(f"`{d.name}-{v['slug']}`" for v in doc["items"][:6])
            models.append(
                f"- **{title}** (`{d.name}`) — {len(doc['items'])} моделей: "
                f"{ids} … і далі до `{d.name}-{doc['items'][-1]['slug']}`"
            )

    text = f"""# Подарунки Telegram — повний список id

> Файл **генерується** (`scripts/gen_gifts_catalog.py`) з каталогу
> демона. Руками не правити: наступна генерація перетре.

Це єдине джерело id для `post.json`. **Вигадувати id заборонено** —
студія довозить спрайт лише для того, що справді є в каталозі, а на
неіснуючий id у кадрі з'явиться порожня рамка, і жодної помилки при
цьому не буде.

Як користуватись: знайди рядок за колонкою «для чого», візьми id з
першої колонки, впиши в `post.json` як звичайний стікер — `file` і
`sprite` не потрібні, студія допише їх сама.

## Колекційні (NFT) — {len(nft)}

| id | назва | для чого брати |
|---|---|---|
{chr(10).join(nft)}

## За зірки — {len(star)}

| id | назва | для чого брати |
|---|---|---|
{chr(10).join(star)}

## Моделі

Колекційний подарунок має моделі — той самий предмет у різних
розфарбуваннях. Id моделі: `<подарунок>-<модель>`.

{chr(10).join(models) if models else "_Наборів моделей поки немає._"}
"""

    out = Path(a.out) if a.out else here.parent / "references" / "gifts-catalog.md"
    out.write_text(text, encoding="utf-8", newline="")
    print(f"записано: {out}")
    print(f"  колекційних: {len(nft)} · за зірки: {len(star)} · наборів моделей: {len(models)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
