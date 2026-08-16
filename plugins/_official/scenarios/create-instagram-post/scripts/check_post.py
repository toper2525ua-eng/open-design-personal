# -*- coding: utf-8 -*-
"""Перевірка ролика поза студією — порт `checkPost` зі студії на Python.

Навіщо окремо. Перевірка живе в TS усередині студії
(`apps/web/src/post-studio/post-spec.ts`), а розбір пишеться агентом ще
до того, як власник відкриє панель. Без CLI-копії агент здає роботу
непровіреною.

Ціна копії — розходження. Тому копія **звіряє свої константи з TS**
щоразу (`--spec`): розійшлись — гучна помилка й код 2, а не тихо інші
числа. Правило те саме, що для гейтів: перевірка мусить міряти те, що
справді їде в кадр.

    python check_post.py                # у теці проєкту
    python check_post.py --post post.json --spec <...>/post-spec.ts

Код виходу: 0 — чисто або лише info, 1 — є warn, 2 — константи
розійшлися з TS (числам перевірки вірити не можна).
"""
from __future__ import annotations

import argparse
import io
import json
import pathlib
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── Константи. Копія з post-spec.ts; звіряються нижче ──────────────────
STICKER_EXIT_LEAD_S = 0.4
CARD_OUT_S = 0.4
BADGE_HOLD_S = 2.6
LABEL_DELAY_S = 0.16
MIN_GAP_S = 0.25
MAX_HOLE_S = 0.5
MAX_STILL_S = 4
MAX_LIVE = 5
CARRIER_GAP_S = 0.12
BADGE_H_PX = 84
IG_SAFE_TOP_PX = 250
CANVAS_W, CANVAS_H = 1080, 1920
CARD_BUDGET = 4
# Геометрія картки колекційного (NFT_CARD_SLOT).
NFT_DROP_PX = 68
NFT_CARD_TOP_PX = 40
NFT_CARD_H_PX = 440
NFT_BADGE_GAP_PX = 23
# Пресет vibe-light.
ZONE_TOP = 0.13
CAPTION_TOP = 0.42

GUARDED = {
    "STICKER_EXIT_LEAD_S": STICKER_EXIT_LEAD_S,
    "CARD_OUT_S": CARD_OUT_S,
    "BADGE_HOLD_S": BADGE_HOLD_S,
    "LABEL_DELAY_S": LABEL_DELAY_S,
    "MIN_GAP_S": MIN_GAP_S,
    "MAX_HOLE_S": MAX_HOLE_S,
    "MAX_STILL_S": MAX_STILL_S,
    "MAX_LIVE": MAX_LIVE,
    "CARRIER_GAP_S": CARRIER_GAP_S,
    "BADGE_H_PX": BADGE_H_PX,
    "IG_SAFE_TOP_PX": IG_SAFE_TOP_PX,
}
GUARDED_SLOT = {
    "dropPx": NFT_DROP_PX,
    "cardTopPx": NFT_CARD_TOP_PX,
    "cardHeightPx": NFT_CARD_H_PX,
    "badgeGapPx": NFT_BADGE_GAP_PX,
}


# ── Звірка з TS ───────────────────────────────────────────────────────
def find_spec(start: pathlib.Path) -> pathlib.Path | None:
    """Шукає post-spec.ts угору по деревах: проєкти лежать усередині репо."""
    rel = pathlib.Path("apps/web/src/post-studio/post-spec.ts")
    for base in [start, *start.parents]:
        cand = base / rel
        if cand.exists():
            return cand
    return None


def numbers_of(src: str) -> dict[str, float]:
    """Прості числові const із файлу, включно з арифметикою над ними."""
    ns: dict[str, float] = {}
    for m in re.finditer(r"\bconst\s+([A-Za-z_]\w*)\s*=\s*([-\d.eE+*/() ]+);", src):
        try:
            ns[m.group(1)] = eval(m.group(2), {"__builtins__": {}}, dict(ns))  # noqa: S307
        except Exception:  # noqa: BLE001 — не число, нам байдуже
            pass
    return ns


def slot_fields(src: str, ns: dict[str, float]) -> dict[str, float]:
    body = re.search(r"export const NFT_CARD_SLOT = \{(.*?)\n\} as const;", src, re.S)
    if not body:
        return {}
    out: dict[str, float] = {}
    for field in GUARDED_SLOT:
        m = re.search(rf"^\s*{field}:\s*([^,\n]+),", body.group(1), re.M)
        if not m:
            continue
        try:
            out[field] = eval(m.group(1), {"__builtins__": {}}, dict(ns))  # noqa: S307
        except Exception:  # noqa: BLE001
            pass
    return out


def preset_top(src: str, block: str) -> float | None:
    """`top:` найближчий після `<block>: {` у пресеті.

    Шукаємо ВЛАСТИВІСТЬ — рядок, що починається з `top:`. Просто
    `top:\\s*число` ловило `top: 42%` із сусіднього коментаря про CSS і
    гучно «знаходило» розходження там, де його не було.
    """
    i = src.find(f"{block}: {{", src.find("export const PRESETS"))
    if i < 0:
        return None
    m = re.search(r"^\s*top:\s*([\d.]+)\s*,", src[i:i + 1600], re.M)
    return float(m.group(1)) if m else None


def guard(spec: pathlib.Path | None) -> list[str]:
    if spec is None:
        return ["ДЖЕРЕЛО НЕ ЗНАЙДЕНО: post-spec.ts — константи не звірені"]
    src = spec.read_text(encoding="utf-8")
    ns = numbers_of(src)
    bad: list[str] = []
    for name, mine in GUARDED.items():
        theirs = ns.get(name)
        if theirs is None:
            bad.append(f"{name}: у TS не знайдено")
        elif abs(theirs - mine) > 1e-9:
            bad.append(f"{name}: тут {mine}, у TS {theirs}")
    for field, theirs in slot_fields(src, ns).items():
        mine = GUARDED_SLOT[field]
        if abs(theirs - mine) > 1e-9:
            bad.append(f"NFT_CARD_SLOT.{field}: тут {mine}, у TS {theirs}")
    for block, mine in (("stickers", ZONE_TOP), ("captions", CAPTION_TOP)):
        theirs = preset_top(src, block)
        if theirs is None:
            bad.append(f"пресет {block}.top: у TS не знайдено")
        elif abs(theirs - mine) > 1e-9:
            bad.append(f"пресет {block}.top: тут {mine}, у TS {theirs}")
    return bad


# ── Дані ролика ───────────────────────────────────────────────────────
ap = argparse.ArgumentParser()
ap.add_argument("--post", default="post.json")
ap.add_argument("--spec", default=None, help="шлях до post-spec.ts (типово — пошук угору)")
ap.add_argument("--motions", default=None, help="motions.json словника рухів")
a = ap.parse_args()

post_path = pathlib.Path(a.post).resolve()
spec_path = pathlib.Path(a.spec) if a.spec else find_spec(post_path.parent)
problems = guard(spec_path)
if problems:
    print("⛔ КОНСТАНТИ РОЗІЙШЛИСЯ З post-spec.ts — числам перевірки вірити не можна:")
    for p in problems:
        print("   ·", p)
    print("   Пересунь константи вгорі цього файлу за TS і прожени ще раз.")
    raise SystemExit(2)

d = json.load(io.open(post_path, encoding="utf-8"))
root = post_path.parent
w = d["words"]
scenes = d.get("scenes", [])
stickers = d.get("stickers", [])
cards = d.get("cards", [])
at = lambda i: w[i]["start"] if 0 <= i < len(w) else 0.0  # noqa: E731
read_time = lambda t: max(1.2, 0.6 + len(t.strip()) / 14)  # noqa: E731
is_nft_card = lambda f: re.search(r"(^|/)nft-card-[^/]*\.html$", f.replace("\\", "/")) is not None  # noqa: E731


def badge_width_px(text: str) -> float:
    f = 0.043 * CANVAS_W
    return len(text.strip()) * 0.55 * f + 2 * 0.75 * f


def scene_of_word(i):
    for k, s in enumerate(scenes):
        if s["from"] <= i <= s["to"]:
            return k
    return -1


def same_thought(a_, b_):
    if a_ < 0 or b_ < 0:
        return False
    lo, hi = min(a_, b_), max(a_, b_)
    return all(scenes[k].get("continues") for k in range(lo + 1, hi + 1))


def sticker_spans():
    alive = [s for s in stickers if s["word"] < len(w) and s["hold"] > 0]
    carriers = sorted(
        [(at(s["word"]) - s.get("lead", 0), scene_of_word(s["word"])) for s in alive]
        + [(at(c["word"]), scene_of_word(c["word"])) for c in cards if c["hold"] > 0],
        key=lambda x: x[0])
    out = []
    for s in alive:
        start = max(0.0, at(s["word"]) - s.get("lead", 0))
        asked = at(s["word"]) + s["hold"]
        mine = scene_of_word(s["word"])
        nxt = next((c for c in carriers if c[0] > start and not same_thought(mine, c[1])), None)
        end = asked if nxt is None else max(start + 0.2, min(asked, nxt[0] - CARRIER_GAP_S))
        out.append((s, start, end))
    return sorted(out, key=lambda x: x[1])


F = []
add = lambda a_, lvl, what, why: F.append((a_, lvl, what, why))  # noqa: E731
spans_s = sticker_spans()
end_of = {id(s): e for s, _, e in spans_s}

# 1. Чи встигає прочитатись кожен текст.
for s in stickers:
    if s["word"] >= len(w):
        continue
    start = at(s["word"])
    end = end_of.get(id(s), start + s["hold"])
    asked = start + s["hold"]
    if end < asked - 0.05:
        add(end, "info", f"{s['id']} живе до {end:.1f} с замість {asked:.1f}", "далі заходить наступна думка")
    if s.get("label"):
        shown = end - STICKER_EXIT_LEAD_S - (start + LABEL_DELAY_S)
        need = read_time(s["label"])
        if shown < need:
            add(start, "warn", f"пігулка «{s['label']}» видима {shown:.1f} с", f"треба {need:.1f} с")
    for b in s.get("badges", []):
        born = at(b["at"])
        if born >= end:
            add(born, "warn", f"бейдж «{b['text']}» у кадр не потрапляє", f"{s['id']} живе до {end:.1f} с")
            continue
        shown = min(BADGE_HOLD_S, end - STICKER_EXIT_LEAD_S - born)
        need = read_time(b["text"])
        if shown < need:
            add(born, "warn", f"бейдж «{b['text']}» видимий {shown:.1f} с", f"треба {need:.1f} с")

# Рядки карток — з розмітки (data-reveal-at).
card_steps = {}
for c in cards:
    fp = root / c["file"]
    if not fp.exists():
        add(at(c["word"]), "warn", f"файл картки {c['file']} не знайдено", "картка в кадр не потрапить")
        continue
    html = fp.read_text(encoding="utf-8")
    card_steps[c["id"]] = [
        (int(m.group(1)), re.sub(r"<[^>]+>", "", m.group(2)).strip())
        for m in re.finditer(r'data-reveal-at="(\d+)"[^>]*>(.*?)</div>', html, re.S)]

step_events = []
for c in cards:
    end = at(c["word"]) + c["hold"]
    for widx, text in card_steps.get(c["id"], []):
        if widx >= len(w):
            continue
        step_events.append((at(widx), f"рядок «{text}»" if text else "зміна в картці"))
        shown = end - CARD_OUT_S - at(widx)
        need = read_time(text)
        if text and shown < need:
            add(at(widx), "warn", f"рядок «{text}» видимий {shown:.1f} с", f"треба {need:.1f} с")

# 2. Порожні кадри між носіями.
spans = sorted(
    [(s["id"], st, en) for s, st, en in spans_s]
    + [(c["id"], at(c["word"]), at(c["word"]) + c["hold"]) for c in cards],
    key=lambda x: x[1])
reach = 0.0
for sid, st, en in spans:
    if st - reach > MAX_HOLE_S and reach > 0:
        add(reach, "warn", f"порожньо {st - reach:.1f} с перед «{sid}»", "носій має триматись до наступного")
    reach = max(reach, en)

# 3/4/5/6. Події.
events = sorted(
    [(st, sid) for sid, st, en in spans]
    + step_events
    + [(at(b["at"]), f"бейдж «{b['text']}»") for s in stickers for b in s.get("badges", [])],
    key=lambda x: x[0])
for i in range(1, len(events)):
    gap = events[i][0] - events[i - 1][0]
    if 0 < gap < MIN_GAP_S:
        add(events[i][0], "info", f"{events[i-1][1]} і {events[i][1]} за {gap:.2f} с", "око читає це як одну подію")

moments = [0.0] + [e[0] for e in events] + [w[-1]["end"]]
for i in range(1, len(moments)):
    still = moments[i] - moments[i - 1]
    if still > MAX_STILL_S:
        add(moments[i - 1], "info", f"{still:.1f} с без жодної події", "стояча картинка читається як зависла")

for e_at, _ in events:
    live = sum(1 for _, st, en in spans if st <= e_at < en)
    if live > MAX_LIVE:
        add(e_at, "warn", f"{live} елементів у кадрі одночасно", "кадр стає шумом")

for i, x in enumerate(w):
    if not x.get("accent"):
        continue
    if not any(abs(e[0] - x["start"]) <= 0.35 for e in events):
        add(x["start"], "info", f"наголос «{x['word']}» без події в кадрі", "кадр може відповісти появою або бейджем")

# ── 7. Геометрія кадру ────────────────────────────────────────────────
# Клас «стоїть не там» доти лишався оку власника: подарунок лівіше свого
# слота, бейдж поверх картки, пара, що розʼїжджається. Числа — ті самі,
# якими кадр малюється.
nft_cards = [(c, at(c["word"]), at(c["word"]) + c["hold"])
             for c in cards if c["word"] < len(w) and c["hold"] > 0 and is_nft_card(c["file"])]

for c, c_st, c_en in nft_cards:
    inside = [(s, st, en) for s, st, en in spans_s if st < c_en and en > c_st]
    if not inside:
        add(c_st, "warn", f"картка «{c['id']}» стоїть із порожнім слотом",
            "у картці колекційного слот — головне місце; без предмета вона читається як недомальована")
    if len(inside) > 1:
        add(c_st, "warn", f"у слот картки «{c['id']}» цілять {len(inside)} предмети",
            ", ".join(s["id"] for s, _, _ in inside) + " — слот один, вони стануть один на одного")
    for s, st, en in inside:
        d_st, d_en = st - c_st, en - c_en
        if abs(d_st) > 0.05 or abs(d_en) > 0.05:
            why = f"предмет {st:.2f}–{en:.2f}, картка {c_st:.2f}–{c_en:.2f}"
            if abs(d_st) > 0.05:
                why += f" · на вході {abs(d_st):.2f} с предмет сам, потім стрибає в слот"
            if abs(d_en) > 0.05:
                why += f" · на виході {abs(d_en):.2f} с слот порожній"
            add(min(st, c_st), "warn",
                f"«{s['id']}» і картка «{c['id']}» живуть різними відрізками",
                why + " — у слоті вони одна річ, постав картці те саме слово й hold")
        # Плашки на картці йдуть конвеєром: попередня ховається ЗА неї,
        # а не відʼїжджає вбік, тож «не встиг прочитати» тут жорсткіше.
        bs = sorted([b for b in s.get("badges", []) if b["at"] < len(w)], key=lambda b: at(b["at"]))
        for i in range(len(bs) - 1):
            shown = at(bs[i + 1]["at"]) - at(bs[i]["at"])
            need = read_time(bs[i]["text"])
            if shown < need:
                add(at(bs[i]["at"]), "warn",
                    f"плашку «{bs[i]['text']}» ховає наступна за {shown:.1f} с",
                    f"на прочитання треба {need:.1f} с — на картці попередня не відʼїжджає вбік, а йде за неї")

# Інваріанти самої картки: не залежать від ролика, але видно тому, хто
# крутить dropPx. Інакше поломка виявляється аж на готовому mp4.
if nft_cards:
    card_top = ZONE_TOP * CANVAS_H + NFT_DROP_PX + NFT_CARD_TOP_PX
    card_bottom = card_top + NFT_CARD_H_PX
    band_top = CAPTION_TOP * CANVAS_H
    badge_top = card_top - NFT_BADGE_GAP_PX - BADGE_H_PX
    first = nft_cards[0][1]
    if card_bottom > band_top:
        add(first, "warn",
            f"низ картки на {card_bottom:.0f} px заходить у смугу субтитрів ({band_top:.0f})",
            f"зменш NFT_CARD_SLOT.dropPx на {card_bottom - band_top:.0f} px")
    if badge_top < IG_SAFE_TOP_PX:
        add(first, "warn",
            f"верх плашки на {badge_top:.0f} px — вище безпечної лінії Instagram ({IG_SAFE_TOP_PX})",
            f"її перекриє шапка; збільш NFT_CARD_SLOT.dropPx на {IG_SAFE_TOP_PX - badge_top:.0f} px")

# Плашка ширша за кадр обрізається з обох боків.
for s in stickers:
    for b in s.get("badges", []):
        px = badge_width_px(b["text"])
        if px > CANVAS_W * 0.9:
            fit = int((CANVAS_W * 0.9 - 2 * 0.75 * 0.043 * CANVAS_W) / (0.55 * 0.043 * CANVAS_W))
            add(at(b["at"]), "warn", f"плашка «{b['text']}» ширша за кадр (≈{px:.0f} px)",
                f"стеля ≈{CANVAS_W * 0.9:.0f} px — скороти текст приблизно до {fit} знаків")

# ── Бюджет ролика ─────────────────────────────────────────────────────
mot = pathlib.Path(a.motions) if a.motions else next(
    iter(sorted(root.glob(".od-skills/*/references/motions.json"))), None)
chosen = [(sc.get("plan") or {}).get("motion") for sc in scenes]
if mot and mot.exists():
    mids = {e["id"] for e in json.load(io.open(mot, encoding="utf-8"))["entries"]}
    for i, m in enumerate(chosen):
        if m is not None and m not in mids:
            add(at(scenes[i]["from"]), "info", f"сцена {i+1}: рух «{m}» не зі словника", "одрук в id")
for i, m in enumerate(chosen):
    if m == "hook-solo-lead" and i != 0:
        add(at(scenes[i]["from"]), "warn", f"сцена {i+1}: гак посеред ролика", "hook лише на першій сцені")


def sticker_of_scene(i):
    s = scenes[i]
    for st in stickers:
        if s["from"] <= st["word"] <= s["to"]:
            return st["id"]
    return None


for i, m in enumerate(chosen):
    if m != "ring-return":
        continue
    if i != len(scenes) - 1:
        add(at(scenes[i]["from"]), "warn", f"сцена {i+1}: кільце не на фіналі", "ring-return замикає ролик")
    op, cl = sticker_of_scene(0), sticker_of_scene(i)
    if op and cl and op != cl:
        add(at(scenes[i]["from"]), "warn", f"кільце повертає «{cl}», а відкривав «{op}»", "кільце — той самий предмет")

for i, m in enumerate(chosen):
    if m != "empty-face":
        continue
    txt = " ".join(x["word"] for x in w[scenes[i]["from"]:scenes[i]["to"] + 1])
    if i != len(scenes) - 1 and not txt.rstrip().endswith("?"):
        add(at(scenes[i]["from"]), "info", f"сцена {i+1}: пауза не на питанні й не на фіналі", "читається як недороблено")

kind = []
for s in scenes:
    if any(s["from"] <= c["word"] <= s["to"] for c in cards):
        kind.append("card")
    elif any(s["from"] <= st["word"] <= s["to"] for st in stickers):
        kind.append("sticker")
    else:
        kind.append(None)
run_kind, run_len, run_start = None, 0, 0
for i, k in enumerate(kind):
    if k is None:
        continue
    if k == run_kind:
        run_len += 1
    else:
        run_kind, run_len, run_start = k, 1, i
    if run_len == 3:
        add(at(scenes[run_start]["from"]), "warn",
            f"сцени {run_start+1}–{i+1}: три {'картки' if k == 'card' else 'стікерні носії'} підряд",
            "презентація або карусель")
if len(cards) > CARD_BUDGET:
    add(at(cards[CARD_BUDGET]["word"]), "warn",
        f"карток {len(cards)} — стеля бюджету {CARD_BUDGET}", "глядач читає, а не дивиться")

F.sort(key=lambda x: x[0])
warns = [f for f in F if f[1] == "warn"]
print(f"ЗНАХІДОК: {len(F)}  (warn {len(warns)}, info {len(F)-len(warns)})")
for a_, lvl, what, why in F:
    print(f"  [{lvl:4}] {a_:6.2f}s  {what}\n           — {why}")
if not F:
    print("  чисто")
raise SystemExit(1 if warns else 0)
