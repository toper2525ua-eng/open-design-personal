# -*- coding: utf-8 -*-
"""
Озвучка сценарію + пословні таймкоди.

Два движки:

  edge    — edge-tts. Безкоштовний, локальний. Темп і тон застосовує сам
            TTS через SSML, таймкоди приходять з WordBoundary.
  eleven  — ElevenLabs. Платний, кращий голос. API не має ні rate, ні
            pitch, тому партитуру накладає ffmpeg уже на готове аудіо,
            а таймкоди масштабуються на той самий коефіцієнт.

Читає script.md (таблиця бітів), віддає:
  voice.mp3   — доріжка озвучки
  words.json  — [{word, start, end}] пословні таймкоди
  beats.json  — [{index, text, start, end, rate, pitch}] для стадії assets

Кожен біт озвучується окремо зі своїм темпом і тоном — це дає інтонацію,
якої не буває при озвучці суцільного тексту. Тиша обрізається тільки з
кінця біта, щоб таймкоди слів усередині лишались точними.

    python scripts/voice.py --script script.md --out .cache/voice
    python scripts/voice.py --script script.md --engine eleven

Для eleven потрібен ключ у змінній оточення ELEVENLABS_API_KEY.
"""
import argparse
import asyncio
import base64
import json
import os
import re
import subprocess
import sys

import edge_tts

VOICES = {
    "остап": "uk-UA-OstapNeural",
    "поліна": "uk-UA-PolinaNeural",
    "ostap": "uk-UA-OstapNeural",
    "polina": "uk-UA-PolinaNeural",
}
DEFAULT_VOICE = "uk-UA-OstapNeural"

ELEVEN_API = "https://api.elevenlabs.io/v1"
ELEVEN_DEFAULT_VOICE = "Taras Boyko"
# v3 звучить живіше, але timestamps на ньому підтримані не завжди —
# при відмові падаємо на multilingual_v2, там ендпоінт канонічний.
ELEVEN_MODEL = "eleven_v3"
ELEVEN_FALLBACK_MODEL = "eleven_multilingual_v2"
# Перевірений пресет власника (див. картку тулзи у vault).
ELEVEN_STABILITY = 0.39
ELEVEN_SIMILARITY = 0.45
ELEVEN_STYLE = 0.0
# Базова частота голосу — від неї рахується зсув тону в герцах.
# Партитура в beats.md писалась під чоловічий голос edge-tts.
PITCH_BASE_HZ = 120.0

SR = 44100
TRIM_TAIL = (
    "areverse,"
    "silenceremove=start_periods=1:start_duration=0:"
    "start_threshold=-50dB:detection=peak,"
    "areverse"
)


def parse_script(path):
    """Витягує голос, движок і біти з markdown-таблиці."""
    with open(path, encoding="utf-8") as f:
        raw = f.read()

    voice, engine = None, None
    fm = re.match(r"^---\n(.*?)\n---\n", raw, re.S)
    if fm:
        m = re.search(r"^voice:\s*(.+)$", fm.group(1), re.M)
        if m:
            voice = m.group(1).strip().strip("\"'")
        m = re.search(r"^engine:\s*(.+)$", fm.group(1), re.M)
        if m:
            engine = m.group(1).strip().strip("\"'").lower()

    beats = []
    for line in raw.splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 5 or not cells[0].isdigit():
            continue  # заголовок або роздільник
        beats.append({
            "text": cells[1],
            "rate": int(cells[2]),
            "pitch": int(cells[3]),
            "gap": int(cells[4]),
        })

    if not beats:
        sys.exit("script.md: не знайдено жодного біта — потрібна таблиця "
                 "| # | Фраза | Темп | Тон | Пауза |")
    return voice, engine, beats


def duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True)
    return float(out.stdout.strip())


def ffmpeg(args):
    subprocess.run(["ffmpeg", "-y", *args], check=True, capture_output=True)


# --- edge-tts ---------------------------------------------------------

async def synth_edge(text, voice, rate, pitch, mp3):
    """Темп і тон іде в сам TTS; таймкоди вже фінальні."""
    comm = edge_tts.Communicate(text, voice, rate=f"{rate:+d}%",
                                pitch=f"{pitch:+d}Hz",
                                boundary="WordBoundary")
    words = []
    with open(mp3, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / 10_000_000
                words.append({"word": chunk["text"], "start": start,
                              "end": start + chunk["duration"] / 10_000_000})
    return words


# --- ElevenLabs -------------------------------------------------------

def eleven_key():
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        sys.exit("Немає ELEVENLABS_API_KEY. Створи ключ у ElevenLabs "
                 "(Profile → API Keys) і поклади у змінну оточення:\n"
                 '  setx ELEVENLABS_API_KEY "ключ"\n'
                 "Потім перезапусти термінал.")
    return key


def resolve_voice_id(name, key):
    """Шукає voice_id за назвою голосу. Запит безкоштовний."""
    import requests
    r = requests.get(f"{ELEVEN_API}/voices", headers={"xi-api-key": key},
                     timeout=30)
    r.raise_for_status()
    voices = r.json().get("voices", [])
    needle = name.lower()
    for v in voices:
        if v.get("name", "").lower() == needle:
            return v["voice_id"], v
    for v in voices:  # часткове збігання — «Taras» знайде «Taras Boyko»
        if needle in v.get("name", "").lower():
            return v["voice_id"], v
    have = ", ".join(v.get("name", "?") for v in voices) or "(порожньо)"
    sys.exit(f"Голос «{name}» не знайдено. Доступні: {have}")


def synth_eleven(text, voice_id, key, model, mp3, prev_text, next_text):
    """
    Віддає аудіо в нейтральному темпі й посимвольний alignment.
    Партитуру накладає shape() уже після цього.
    """
    import requests
    body = {
        "text": text,
        "model_id": model,
        "voice_settings": {
            "stability": ELEVEN_STABILITY,
            "similarity_boost": ELEVEN_SIMILARITY,
            "style": ELEVEN_STYLE,
            "speed": 1.0,
        },
    }
    # Сусідні біти як контекст — модель тримає інтонацію на стиках.
    # Кредити за них не списуються, озвучується тільки text.
    if prev_text:
        body["previous_text"] = prev_text
    if next_text:
        body["next_text"] = next_text

    r = requests.post(
        f"{ELEVEN_API}/text-to-speech/{voice_id}/with-timestamps",
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        json=body, timeout=120)

    if r.status_code >= 400 and model != ELEVEN_FALLBACK_MODEL:
        print(f"  {model} не віддав timestamps ({r.status_code}), "
              f"перемикаюсь на {ELEVEN_FALLBACK_MODEL}", file=sys.stderr)
        body["model_id"] = ELEVEN_FALLBACK_MODEL
        r = requests.post(
            f"{ELEVEN_API}/text-to-speech/{voice_id}/with-timestamps",
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            json=body, timeout=120)

    if r.status_code >= 400:
        sys.exit(f"ElevenLabs {r.status_code}: {r.text[:400]}")

    data = r.json()
    with open(mp3, "wb") as f:
        f.write(base64.b64decode(data["audio_base64"]))

    return words_from_alignment(data["alignment"]), body["model_id"]


def words_from_alignment(al):
    """Склеює посимвольний alignment у слова по пробілах."""
    chars = al["characters"]
    starts = al["character_start_times_seconds"]
    ends = al["character_end_times_seconds"]

    words, cur, cs, ce = [], "", None, None
    for c, s, e in zip(chars, starts, ends):
        if c.isspace():
            if cur:
                words.append({"word": cur, "start": cs, "end": ce})
                cur, cs, ce = "", None, None
        else:
            if not cur:
                cs = s
            cur += c
            ce = e
    if cur:
        words.append({"word": cur, "start": cs, "end": ce})
    return words


def atempo_chain(t):
    """atempo приймає лише 0.5…2.0 — більше набирається каскадом."""
    parts = []
    while t < 0.5:
        parts.append("atempo=0.5")
        t /= 0.5
    while t > 2.0:
        parts.append("atempo=2.0")
        t /= 2.0
    parts.append(f"atempo={t:.6f}")
    return parts


def shape(src, dst, rate, pitch, base_hz):
    """
    Накладає партитуру на готове аудіо.

    asetrate зсуває тон і темп разом, наступний atempo повертає темп до
    потрібного — на виході рівно той тон і той темп, що в таблиці.
    Повертає підсумковий коефіцієнт прискорення, щоб на нього поділити
    таймкоди.
    """
    r = 1.0 + rate / 100.0
    p = (base_hz + pitch) / base_hz
    chain = [f"asetrate={int(SR * p)}", *atempo_chain(r / p),
             f"aresample={SR}", TRIM_TAIL]
    ffmpeg(["-i", src, "-af", ",".join(chain), "-ar", str(SR), "-ac", "1", dst])
    return r


# --- пайплайн ---------------------------------------------------------

async def run(script, outdir, engine_cli, voice_cli, base_hz):
    voice_fm, engine_fm, beats = parse_script(script)
    engine = (engine_cli or engine_fm or "edge").lower()
    if engine not in ("edge", "eleven"):
        sys.exit(f"Невідомий движок «{engine}» — буває edge або eleven.")

    name = voice_cli or voice_fm
    parts = os.path.join(outdir, "parts")
    os.makedirs(parts, exist_ok=True)

    key = voice_id = None
    model = ELEVEN_MODEL
    if engine == "eleven":
        key = eleven_key()
        voice_id, meta = resolve_voice_id(name or ELEVEN_DEFAULT_VOICE, key)
        if (meta.get("labels") or {}).get("gender") == "female":
            base_hz = base_hz or 200.0
        print(f"eleven: {meta.get('name')} ({voice_id})", file=sys.stderr)
    else:
        key_name = (name or "").lower()
        voice_id = VOICES.get(key_name, name or DEFAULT_VOICE)

    base_hz = base_hz or PITCH_BASE_HZ
    playlist, words_abs, beats_abs, cursor, chars = [], [], [], 0.0, 0

    for i, b in enumerate(beats):
        mp3 = os.path.join(parts, f"b{i:02d}.mp3")
        wav = os.path.join(parts, f"b{i:02d}.wav")

        if engine == "edge":
            words = await synth_edge(b["text"], voice_id, b["rate"],
                                     b["pitch"], mp3)
            # темп і тон уже в аудіо — лишається тільки підрізати хвіст
            ffmpeg(["-i", mp3, "-af", TRIM_TAIL, "-ar", str(SR), "-ac", "1",
                    wav])
            factor = 1.0
        else:
            words, model = synth_eleven(
                b["text"], voice_id, key, model, mp3,
                beats[i - 1]["text"] if i else None,
                beats[i + 1]["text"] if i + 1 < len(beats) else None)
            chars += len(b["text"])
            factor = shape(mp3, wav, b["rate"], b["pitch"], base_hz)

        for w in words:
            words_abs.append({"word": w["word"],
                              "start": round(cursor + w["start"] / factor, 3),
                              "end": round(cursor + w["end"] / factor, 3)})

        length = duration(wav)
        beats_abs.append({"index": i, "text": b["text"],
                          "start": round(cursor, 3),
                          "end": round(cursor + length, 3),
                          "rate": b["rate"], "pitch": b["pitch"]})
        cursor += length
        playlist.append(wav)

        if b["gap"]:
            sil = os.path.join(parts, f"s{i:02d}.wav")
            ffmpeg(["-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono",
                    "-t", str(b["gap"] / 1000.0), sil])
            playlist.append(sil)
            cursor += b["gap"] / 1000.0

    listfile = os.path.join(parts, "list.txt")
    with open(listfile, "w", encoding="utf-8") as f:
        for p in playlist:
            f.write(f"file '{os.path.abspath(p)}'\n")

    mp3_out = os.path.join(outdir, "voice.mp3")
    ffmpeg(["-f", "concat", "-safe", "0", "-i", listfile,
            "-c:a", "libmp3lame", "-q:a", "2", mp3_out])

    for fname, data in (("words.json", words_abs), ("beats.json", beats_abs)):
        with open(os.path.join(outdir, fname), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)

    report = {"engine": engine, "voice": name or voice_id,
              "beats": len(beats_abs), "words": len(words_abs),
              "duration": round(cursor, 2), "audio": mp3_out}
    if engine == "eleven":
        report["model"] = model
        report["credits"] = chars
    print(json.dumps(report, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", default="script.md")
    ap.add_argument("--out", default=".cache/voice")
    ap.add_argument("--engine", choices=["edge", "eleven"],
                    help="перекриває engine із frontmatter")
    ap.add_argument("--voice", help="перекриває voice із frontmatter")
    ap.add_argument("--pitch-base", type=float, default=0.0,
                    help="базова частота голосу, Гц (типово 120)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    asyncio.run(run(a.script, a.out, a.engine, a.voice, a.pitch_base or 0.0))


if __name__ == "__main__":
    main()
