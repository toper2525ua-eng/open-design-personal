# -*- coding: utf-8 -*-
"""Транскрипція референсного ролика: URL → mp3 → текст із таймкодами.

    python scripts/ingest_reference.py <url> [ще url ...]
        [--model large-v3|medium|small]  точність/швидкість (типово large-v3)
        [--cookies chrome|firefox|edge]  коли Instagram просить логін
        [--out <тека>]                   типово references/reference-scripts

Виходить markdown на кожен ролик: метадані, суцільний текст і сегменти
з таймкодами + порожня секція «Розбір» — її заповнює аналіз прийомів.

Це сирці для сценарної бібліотеки. Мета — зняти ПРИЙОМИ (гак, ритм,
злам, кільце), а не тексти: дослівне копіювання чужого сценарію не
навчання, а плагіат, і в бібліотеку воно не потрапляє.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent.parent


def slugify(text: str, fallback: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE).strip().lower()
    s = re.sub(r"[\s_]+", "-", s)[:60].strip("-")
    return s or fallback


def download(url: str, workdir: Path, cookies: str | None) -> tuple[Path, dict]:
    """Тягне аудіо і метадані. Повертає (mp3, info)."""
    out = workdir / "clip.%(ext)s"
    cmd = [sys.executable, "-m", "yt_dlp",
           "-x", "--audio-format", "mp3",
           "--no-playlist",
           "--write-info-json",
           "-o", str(out)]
    if cookies:
        cmd += ["--cookies-from-browser", cookies]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        tail = (r.stderr or "").strip().splitlines()[-3:]
        hint = ""
        if any("login" in x.lower() or "cookies" in x.lower() or "rate" in x.lower() for x in tail):
            hint = "\n  → Instagram просить логін: додай --cookies chrome (візьме сесію з браузера)"
        raise SystemExit(f"yt-dlp не стягнув {url}:\n  " + "\n  ".join(tail) + hint)
    mp3 = next(workdir.glob("clip.mp3"))
    info_file = next(workdir.glob("clip.info.json"), None)
    info = json.loads(info_file.read_text(encoding="utf-8")) if info_file else {}
    return mp3, info


def transcribe(mp3: Path, model_name: str) -> tuple[str, list[dict]]:
    from faster_whisper import WhisperModel

    print(f"  транскрибую ({model_name}; перший запуск тягне ваги — це довго)…")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(str(mp3), vad_filter=True)
    segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
            for s in segments]
    lang = getattr(info, "language", "?")
    print(f"  мова: {lang} · сегментів: {len(segs)}")
    return lang, segs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="+")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--cookies", default=None,
                    help="chrome|firefox|edge — сесія браузера для Instagram")
    ap.add_argument("--out", default=str(HERE / "references" / "reference-scripts"))
    a = ap.parse_args()

    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    for url in a.urls:
        print(f"» {url}")
        with tempfile.TemporaryDirectory() as tmp:
            mp3, info = download(url, Path(tmp), a.cookies)
            lang, segs = transcribe(mp3, a.model)

        author = info.get("uploader") or info.get("channel") or "unknown"
        vid = info.get("id") or "clip"
        title = info.get("title") or ""
        duration = info.get("duration") or (segs[-1]["end"] if segs else 0)
        views = info.get("view_count")
        likes = info.get("like_count")

        full = " ".join(s["text"] for s in segs)
        name = f"{slugify(author, 'ref')}-{vid}.md"
        lines = [
            "---",
            f"source: {url}",
            f"author: {author}",
            f"duration: {duration}",
            f"language: {lang}",
            f"views: {views if views is not None else 'невідомо'}",
            f"likes: {likes if likes is not None else 'невідомо'}",
            "status: raw   # raw → analyzed, коли розбір заповнено",
            "---",
            "",
            f"# {title or vid}",
            "",
            "## Текст суцільно",
            "",
            full,
            "",
            "## Сегменти",
            "",
        ]
        for s in segs:
            lines.append(f"- `{s['start']:6.2f}–{s['end']:6.2f}` {s['text']}")
        lines += [
            "",
            "## Розбір (заповнити)",
            "",
            "- **Гак (перші 2 с):** чим зупиняє скрол — питання / число / заперечення?",
            "- **Структура:** розкласти на блоки з таймкодами (біль → злам → інструкція → кільце?)",
            "- **Ритм:** довжини фраз, де паузи, де темп зростає",
            "- **Прийоми:** що можна зняти ЯК ПРИЙОМ (не як текст) у script-library",
            "- **Чому працює / що не переносити:**",
            "",
        ]
        path = out_dir / name
        path.write_text("\n".join(lines), encoding="utf-8")
        print(f"  → {path.relative_to(HERE) if path.is_relative_to(HERE) else path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
