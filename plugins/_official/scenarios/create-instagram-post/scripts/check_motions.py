# -*- coding: utf-8 -*-
"""Лінт словника рухів: references/motions.json проти власних правил.

Запуск із кореня плагіна або проєкту:
    python scripts/check_motions.py [шлях/до/motions.json]

Перевіряє те, що вже ламалось мовчки:
- стеля думки (continues) не ріже предмет раніше заявленого hold;
- після виходу немає мертвого хвоста до кінця циклу (0.25–0.65 с);
- кожен бейдж встигає прочитатись (≥ 0.9 с чистого часу);
- носії різних думок не перетинаються;
- біти покривають цикл, демо-картки існують, групи та id валідні.

Ці самі правила зашиті в демо: якщо лінт червоний — правити демо,
а не вимикати перевірку.
"""
import json
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TAIL = 0.25            # хвіст стелі думки, як у stickerSpans студії
EXIT_S = 0.4           # STICKER_EXIT_LEAD_S
GROUPS = {"viewer", "solo", "cards", "pause"}


def read_time(text: str) -> float:
    return max(0.9, 0.6 + len(text.strip()) / 14)


def check(path: pathlib.Path) -> int:
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data.get("entries", [])
    errors: list[str] = []

    ids = [e["id"] for e in entries]
    for i in set(ids):
        if ids.count(i) > 1:
            errors.append(f"{i}: id не унікальний")

    demo_cards_dir = path.parent / "demo-cards"

    for e in entries:
        eid = e["id"]
        if e.get("group") not in GROUPS:
            errors.append(f"{eid}: group «{e.get('group')}» не з {sorted(GROUPS)}")
        demo = e.get("demo")
        if demo is None:
            continue

        words = demo.get("words", [])
        scenes = demo.get("scenes", [])
        dur = demo.get("duration", 0)
        if not words or dur <= 0:
            errors.append(f"{eid}: демо без слів або тривалості")
            continue

        def ceiling(word_index: int) -> float | None:
            i = next((k for k, sc in enumerate(scenes)
                      if sc["from"] <= word_index <= sc["to"]), -1)
            if i < 0:
                return None
            last = i
            while last + 1 < len(scenes) and scenes[last + 1].get("continues") is True:
                last += 1
            return words[scenes[last]["to"]]["end"] + TAIL

        spans: list[tuple[float, float, str, int]] = []
        for s in demo.get("stickers", []):
            if s["word"] >= len(words):
                errors.append(f"{eid}/{s['id']}: word поза словами")
                continue
            start = words[s["word"]]["start"]
            asked = start + s["hold"]
            ceil = ceiling(s["word"])
            real = min(asked, ceil) if ceil is not None else asked
            if asked - real > 0.05:
                errors.append(f"{eid}/{s['id']}: стеля думки ріже {asked - real:.2f} с — "
                              f"постав hold ≤ {real - start:.2f} або продовж continues")
            spans.append((start, real, s["id"], s["word"]))
            for b in s.get("badges", []):
                if b["at"] >= len(words):
                    errors.append(f"{eid}: бейдж «{b['text']}» — at поза словами")
                    continue
                shown = real - EXIT_S - words[b["at"]]["start"]
                need = read_time(b["text"])
                if shown < need:
                    errors.append(f"{eid}: бейдж «{b['text']}» видно {shown:.2f} с "
                                  f"при потрібних {need:.2f}")
        for c in demo.get("cards", []):
            start = words[c["word"]]["start"]
            spans.append((start, start + c["hold"], c["id"], c["word"]))
            if not (demo_cards_dir / pathlib.Path(c["file"]).name).exists():
                errors.append(f"{eid}: демо-картки {c['file']} немає в demo-cards/")

        # думки не перетинаються (всередині continues-ланцюга — можна)
        def chain_of(word_index: int) -> int:
            i = next((k for k, sc in enumerate(scenes)
                      if sc["from"] <= word_index <= sc["to"]), -1)
            while i > 0 and scenes[i].get("continues") is True:
                i -= 1
            return i

        spans.sort()
        for (a1, b1, id1, w1), (a2, b2, id2, w2) in zip(spans, spans[1:]):
            if a2 < b1 - 0.05 and chain_of(w1) != chain_of(w2):
                errors.append(f"{eid}: {id1} і {id2} з різних думок перетинаються "
                              f"на {b1 - a2:.2f} с")

        if spans:
            last_end = max(b for _, b, _, _ in spans)
            tail = dur - last_end
            if not (0.2 <= tail <= 0.7):
                errors.append(f"{eid}: хвіст після останнього носія {tail:.2f} с "
                              f"(норма 0.25–0.65)")

        beats = demo.get("beats", [])
        if beats and abs(beats[-1]["end"] - dur) > 0.01:
            errors.append(f"{eid}: біти закінчуються на {beats[-1]['end']}, цикл {dur}")

    if errors:
        print(f"ЧЕРВОНИЙ: {len(errors)} знахідок")
        for x in errors:
            print("  ✗", x)
        return 1
    print(f"зелений: {len(entries)} записів, "
          f"{sum(1 for e in entries if e.get('demo'))} демо — усі правила тримаються")
    return 0


if __name__ == "__main__":
    default = pathlib.Path(__file__).resolve().parent.parent / "references" / "motions.json"
    target = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else default
    sys.exit(check(target))
