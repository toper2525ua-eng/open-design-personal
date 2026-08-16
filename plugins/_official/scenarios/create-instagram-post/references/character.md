# Ведучий

Один персонаж у всіх роликах. Впізнаваність важливіша за різноманіття.

## Де він живе

Пози лежать у **спільній бібліотеці Open Design**, а не всередині
проєкту. Тому доступні звідусіль — з будь-якого проєкту, навіть де цей
плагін не підключений.

```bash
od library search reels-host                    # усі пози ведучого
od library list --tag "reels-host,shrug"        # конкретна поза
od library apply <asset-id> --project <proj-id> # покласти в проєкт
```

Копії файлів лежать поруч у `assets/character/` — це резерв і джерело
для переімпорту, якщо бібліотеку доведеться відновлювати:

```bash
od library import <file> --kind image --tag "reels-host,<pose-id>"
```

Тег складається з двох частин через кому — `--tag` не накопичується,
кожен наступний затирає попередній, тому обидві ознаки йдуть одним
значенням.

## Реєстр

`assets/character/poses.json`:

```json
{
  "base_prompt": "...",
  "style_lock": "...",
  "poses": [
    { "id": "wave", "file": "wave.png", "use": "вітання, перший кадр" }
  ]
}
```

Перед генерацією чогось нового — прочитай реєстр. Позу, яка в ньому
вже є, не генеруй повторно ніколи.

## Яку модель брати

Персонаж і стікери — **`openrouter/google/gemini-2.5-flash-image`**. Вона
найкраще тримає одне обличчя між генераціями, якщо посилатися на
затверджений кадр. Не міняй модель між позами: різні моделі дають різне
обличчя навіть на однаковий промпт.

Запасні, якщо основна не відповідає: `openrouter/black-forest-labs/flux-1.1-pro`
(різкіший, гірша консистентність) або `openrouter/recraft/recraft-v3`
(добрий для пласких стікерів).

## Bootstrap (тільки перший запуск)

Згенеруй базовий кадр:

```
Clean flat vector illustration of a young Ukrainian man, short dark
hair, trimmed beard, beige jacket over grey t-shirt, friendly smile,
waving at camera. Anime-influenced but semi-realistic proportions.
Thick clean outlines, soft cel shading, plain white background,
full body, centered, portrait orientation.
```

Покажи власнику. Доки він не підтвердив — далі не йди: цей кадр
зафіксує обличчя на всі наступні ролики.

Після підтвердження запиши промпт у `base_prompt` і згенеруй стартовий
набір, кожен раз посилаючись на затверджений кадр:

| id | Запит на генерацію | Для чого |
|---|---|---|
| `wave` | базовий кадр | вітання, відкриття |
| `point-up` | `same character, pointing up with index finger` | акцент, теза |
| `arms-crossed` | `same character, arms crossed, confident` | висновок, фінал |
| `shrug` | `same character, shrugging, confused` | питання, проблема |
| `facepalm` | `same character, facepalm, frustrated` | помилка, біль |
| `thumbs-up` | `same character, thumbs up, smiling` | рішення спрацювало |

Шість поз закривають майже будь-який сценарій. Сьому додавай лише
під конкретну потребу.

## Пози генеруються ТІЛЬКИ з референсом

**Ніколи не генеруй позу з самого тексту.** Модель щоразу малює обличчя
заново — виходить інша людина: інший колір очей, інша шкіра, інша
товщина контурів. Перевірено на практиці.

Кожна поза — це image-to-image від затвердженого базового кадру:

- вхідне зображення: файл з `poses[0].file` (базовий кадр)
- промпт описує **лише зміну**: жест, вираз обличчя
- не переописуй зовнішність, одяг чи стиль — вони приходять з референсу

```text
Keep the exact same character, face, hairstyle, beard, eye color, outfit
and art style as the reference image. Change only the pose: <жест>.
Plain flat white background. Match the reference framing: same figure
scale, jacket hem reaching the bottom edge, no gap under the figure.
```

**Не пиши в промпті «transparent background» або «alpha channel».**
Модель малює пікселі — і у відповідь на таке прохання вона малює
шахматку прозорості як звичайну картинку. Перевірено: `v6` і `v7`
вийшли з `pix_fmt=rgb24`, тобто без альфи взагалі, зате з намальованою
шахівницею.

Проси рівний білий фон, а прозорість роби окремим кроком:

```bash
npx hyperframes remove-background <file> -o <file>
ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of csv=p=0 <file>
```

На виході має бути `rgba`. Якщо ні — крок не спрацював.

Якщо провайдер не приймає вхідне зображення — зупинись і скажи
власнику. Згенерувати «схоже за описом» гірше, ніж не згенерувати:
розсинхрон обличчя видно в кадрі одразу.

Після кожної пози звір з базовим кадром: колір очей, тон шкіри,
товщина ліній. Не збіглось — перегенеруй, не додавай у реєстр.

## Використання

Поза — не декорація, а пунктуація. Міняй її на зламах думки: проблема
→ причина → рішення → доказ. Усередині однієї думки поза стоїть.

Перехід між позами — cut, не crossfade. М'який перехід тут читається
як помилка монтажу.
