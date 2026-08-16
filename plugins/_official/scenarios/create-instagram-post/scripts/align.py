# -*- coding: utf-8 -*-
"""
Таймкоди для вручну залитої озвучки.

Коли доріжку зробив voice.py, таймкоди приходять разом з аудіо. Коли
власник згенерував її у вебі ElevenLabs і залив готовий mp3 — таймкодів
немає, а пословні субтитри без них не збудувати. Цей скрипт закриває
саме цю дірку: віддає аудіо разом із текстом у forced alignment і
повертає той самий words.json, що й voice.py.

    python scripts/align.py --audio voice.mp3 --script script.md
    python scripts/align.py --audio voice.mp3 --text "суцільний текст"

Потрібен ELEVENLABS_API_KEY. Ендпоінт доступний і на Free-плані —
на відміну від озвучки library-голосом, яка вимагає платного.
"""
import argparse
import json
import os
import re
import subprocess
import sys

import requests

API = "https://api.elevenlabs.io/v1/forced-alignment"
# Вище цього значення вирівнювання вважаємо ненадійним. Модель віддає
# loss на кожне слово; великий loss майже завжди означає, що текст і
# аудіо розійшлись — переписаний біт, проковтнуте слово, зайва фраза.
LOSS_WARN = 1.5


def key():
    k = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not k:
        sys.exit("Немає ELEVENLABS_API_KEY у змінних оточення.")
    return k


def text_from_script(path):
    """Склеює фрази з таблиці бітів у суцільний текст для alignment."""
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    parts = []
    for line in raw.splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2 or not cells[0].isdigit():
            continue
        parts.append(cells[1])
    if not parts:
        sys.exit(f"{path}: не знайдено таблиці бітів "
                 "| # | Фраза | Темп | Тон | Пауза |")
    return " ".join(parts), parts


def duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True)
    return float(out.stdout.strip())


def align(audio, text, api_key):
    with open(audio, "rb") as f:
        r = requests.post(
            API,
            headers={"xi-api-key": api_key},
            files={"file": (os.path.basename(audio), f, "audio/mpeg")},
            data={"text": text},
            timeout=600)
    if r.status_code >= 400:
        sys.exit(f"forced-alignment {r.status_code}: {r.text[:400]}")
    return r.json()


def text_from_post(path):
    """
    Дістає текст із post.json — так працює ручний режим.

    Власник генерує озвучку у вебі ElevenLabs своїм текстом, який зі
    script.md не збігається (там партитура під авто-озвучку). Студія
    кладе фактичний текст у post.json, і вирівнюємось саме по ньому.
    """
    with open(path, encoding="utf-8") as f:
        post = json.load(f)
    text = (post.get("script") or "").strip()
    if not text:
        sys.exit(f"{path}: поле script порожнє — встав текст озвучки "
                 "у блоці «Транскрипція» і повтори")
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="mp3/wav з озвучкою")
    ap.add_argument("--script", default="script.md",
                    help="таблиця бітів; використовується, якщо немає --post/--text")
    ap.add_argument("--post", help="post.json — узяти текст із поля script")
    ap.add_argument("--text", help="текст напряму")
    ap.add_argument("--out", default=".cache/voice")
    a = ap.parse_args()

    if not os.path.exists(a.audio):
        sys.exit(f"нема файлу {a.audio}")

    # Пріоритет: явний текст → post.json → таблиця бітів. Біти відомі
    # лише в останньому випадку, тому beats.json пишемо тільки там.
    beats_text = None
    if a.text:
        text = a.text
    elif a.post:
        text = text_from_post(a.post)
    elif os.path.exists("post.json") and not os.path.exists(a.script):
        text = text_from_post("post.json")
    else:
        text, beats_text = text_from_script(a.script)

    os.makedirs(a.out, exist_ok=True)
    data = align(a.audio, text, key())

    # Модель віддає і пробіли окремими токенами — у субтитрах вони не
    # потрібні, лишаємо тільки значущі слова.
    words = []
    worst = 0.0
    for w in data.get("words", []):
        token = (w.get("text") or "").strip()
        if not token:
            continue
        worst = max(worst, float(w.get("loss") or 0))
        words.append({"word": token,
                      "start": round(float(w["start"]), 3),
                      "end": round(float(w["end"]), 3)})

    if not words:
        sys.exit("alignment повернувся порожнім — перевір, що текст "
                 "відповідає аудіо")

    words_path = os.path.join(a.out, "words.json")
    with open(words_path, "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False, indent=1)

    # beats.json відновлюємо лише коли знаємо межі фраз: кожен біт
    # закінчується на своєму останньому слові. Без script.md біти
    # відновити нізвідки — тоді лишаємо саме слова.
    beats_written = 0
    if beats_text:
        beats, cursor = [], 0
        for i, phrase in enumerate(beats_text):
            count = len([t for t in re.split(r"\s+", phrase.strip()) if t])
            chunk = words[cursor:cursor + count]
            if not chunk:
                break
            beats.append({"index": i, "text": phrase,
                          "start": chunk[0]["start"],
                          "end": chunk[-1]["end"]})
            cursor += count
        if cursor == len(words):
            with open(os.path.join(a.out, "beats.json"), "w",
                      encoding="utf-8") as f:
                json.dump(beats, f, ensure_ascii=False, indent=1)
            beats_written = len(beats)
        else:
            print(f"  біти не зійшлися зі словами ({cursor} з {len(words)}) — "
                  "beats.json не пишу", file=sys.stderr)

    report = {"audio": a.audio, "duration": round(duration(a.audio), 2),
              "words": len(words), "beats": beats_written,
              "worst_loss": round(worst, 3), "out": words_path}
    if worst > LOSS_WARN:
        report["warning"] = ("високий loss — текст, схоже, розходиться "
                             "з аудіо; звір script.md з озвучкою")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
