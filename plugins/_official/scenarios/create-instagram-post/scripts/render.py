"""
Рендер ролика: знімаємо КАДР СТУДІЇ покадрово і склеюємо в mp4.

Чому саме так, а не окремою композицією. Композиція, зібрана заново за
post.json, — це другий кадр, зроблений удруге: він розходиться з превʼю
на першій же правці, і розходження помічається аж у готовому файлі.
Увесь рух у студії — чиста функція часу (seek-safe), тож достатньо
перемотати кадр на потрібну секунду й зняти. Тоді mp4 не «схожий» на
превʼю, а є ним.

Запуск:
    python scripts/render.py --url http://127.0.0.1:PORT --project <id>

Порт бере `pnpm tools-dev status`. Готовий файл — post.mp4 у проєкті.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

# Консоль Windows за замовчуванням у cp1251 і падає на «×» із рядка
# прогресу — помилка виглядає як збій рендера, хоч рендер уже минув.
# Лагодимо тут, а не змінною оточення: скрипт не має залежати від того,
# хто і як його викликав.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

CANVAS_W, CANVAS_H = 1080, 1920


def render(url: str, project: str, out_dir: Path, audio: Path | None, fps: int, speed: float) -> Path:
    from playwright.sync_api import sync_playwright

    frames_dir = out_dir / ".frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": CANVAS_W, "height": CANVAS_H})
        page.goto(f"{url}/projects/{project}", wait_until="networkidle")

        # Чекаємо, поки студія віддасть керування часом: до цього моменту
        # дані ще вантажаться, і перші кадри вийшли б порожніми.
        page.wait_for_function("() => window.__postStudio?.ready === true", timeout=60_000)

        # Режим зйомки вмикаємо командою, а не адресою: застосунок
        # редиректить на адресу розмови й губить query-параметри.
        page.evaluate("() => window.__postStudio.setShot(true)")
        page.wait_for_timeout(300)
        duration = page.evaluate("() => window.__postStudio.duration")
        if not duration:
            raise SystemExit("у ролика немає доріжки — нема чого рендерити")
        if speed <= 0:
            speed = page.evaluate("() => window.__postStudio.speed") or 1.0

        # Прискорення стискає ЧАС: кадр на секунді t готового файлу бере
        # секунду t*speed у доріжці. Анімації персонажа при цьому не
        # прискорюються — вони живуть у власному часі, як і в превʼю.
        out_duration = duration / speed
        total = int(out_duration * fps)
        print(f"кадрів: {total} ({out_duration:.1f} с на {speed}×, вихідна доріжка {duration:.1f} с)")

        for i in range(total):
            t = (i / fps) * speed
            page.evaluate("(t) => window.__postStudio.setTime(t)", t)
            # Один тік на застосування стану: усе малюється синхронно з
            # часу, тож більше чекати нема чого.
            page.wait_for_timeout(0)
            page.screenshot(path=str(frames_dir / f"{i:05d}.png"))
            if i % (fps * 5) == 0:
                print(f"  {t:5.1f} с / {duration:.1f}")

        browser.close()

    out = out_dir / "post.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", str(frames_dir / "%05d.png"),
    ]
    if audio and audio.exists():
        # Стерео 48 кГц — те, що очікує Instagram. Моно частина плеєрів
        # кладе в один канал, і глядач у навушниках чує голос збоку.
        cmd += ["-i", str(audio), "-c:a", "aac", "-b:a", "192k",
                "-ac", "2", "-ar", "48000", "-shortest"]
        if abs(speed - 1.0) > 0.001:
            # atempo тримає висоту голосу; проста зміна частоти дискретизації
            # підняла б тон і зробила диктора мультяшним. Фільтр працює в
            # межах 0.5–2.0, а наші швидкості саме звідти.
            cmd += ["-filter:a", f"atempo={speed:.3f}"]
    cmd += [
        "-c:v", "libx264",
        # RGB→YUV swscale рахує за BT.601, якщо не сказати інакше, а телефон
        # читає HD-відео як BT.709. Через це жовта плашка й синій втрачали
        # насиченість. Конвертуємо за 709 І позначаємо файл як 709 — самих
        # тегів мало, вони б лише перейменували 601-дані.
        "-vf", "scale=out_color_matrix=bt709:out_range=tv",
        "-pix_fmt", "yuv420p",
        # Теги пишемо ДВІЧІ. Самих опцій ffmpeg мало: у файл лягає тільки
        # colorspace, а primaries і transfer лишаються unknown — фільтр
        # scale задає матрицю й не чіпає решту. x264-params кладе всі
        # чотири в SPS самого потоку, звідки їх бере плеєр.
        "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",
        "-colorspace", "bt709",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-color_range", "tv",
        # Ролик дивляться в стрічці на телефоні: crf 18 тримає чисті краї
        # плашок і субтитрів, на яких стиснення видно найперше.
        "-crf", "18",
        "-preset", "slow",
        # Заголовок наперед: без цього прев'ю не стартує, поки не
        # завантажиться весь файл.
        "-movflags", "+faststart",
        str(out),
    ]
    print("ffmpeg…")
    subprocess.run(cmd, check=True)
    shutil.rmtree(frames_dir)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="адреса web студії, напр. http://127.0.0.1:59187")
    ap.add_argument("--project", required=True, help="id проєкту")
    ap.add_argument("--out", default=".", help="куди покласти post.mp4")
    ap.add_argument("--audio", default=None, help="доріжка mp3")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument(
        "--speed",
        type=float,
        default=0,
        help="прискорення; 0 — узяти те, що вибране в студії",
    )
    a = ap.parse_args()

    out_dir = Path(a.out).resolve()
    audio = Path(a.audio).resolve() if a.audio else None
    # Помилка, а не тихий німий mp4: колись `if audio.exists()` мовчки
    # збирав ролик без звуку, і брак доріжки виявлявся аж на перегляді.
    if audio is not None and not audio.exists():
        raise SystemExit(f"нема доріжки: {audio} — перевір шлях у --audio")
    result = render(a.url.rstrip("/"), a.project, out_dir, audio, a.fps, a.speed)
    print(f"готово: {result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
