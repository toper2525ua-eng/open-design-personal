// Initial vault content for `.od/obsidian-global/`. Written ONCE on
// first run (when the folder is empty), then the user owns the
// content — we never overwrite. Notes describe Open Design's
// architecture, downstream features, and dev workflow; they double as
// a working example of the wikilink + markdown rendering and as the
// seed that future Claude-Code agents will read/extend.

import { isVaultEmpty, writeNote } from './storage.js';

const README = `# Open Design — база знань

Це глобальний обсидіан-вʼюер для всієї програми. Тут зібрана структурована
інформація про код, downstream-фічі, робочий процес та інше — щоб клод (і
ти) могли швидко знайти що де знаходиться.

## Швидка навігація

- [[apps-web]] — Next.js 16 веб-рантайм
- [[apps-daemon]] — локальний демон, /api/* + спавн агентів
- [[apps-desktop]] — Electron-оболонка
- [[OpenRouter]] — даунстрім media-провайдер
- [[TG Web]] — інтеграція з Telegram Mini App
- [[Auto-updater]] — кастомний оновлювач у обхід Smart App Control
- [[Workflow]] — \`tools-dev\` + пакетні релізи

## Як працювати з цим вʼюером

- Зліва — чат, де можна запитати клода про будь-який вузол бази
- Посередині — дерево + контент активної нотатки
- Праворуч — граф звʼязків (буде в наступній фазі)
`;

const APPS_WEB = `# apps/web

Веб-рантайм. Next.js 16 App Router + React 18.

## Ключові директорії

- \`apps/web/src/components/\` — Reactівські компоненти
- \`apps/web/src/downstream/\` — fork-only фічі: [[OpenRouter]], [[TG Web]], [[Obsidian]]
- \`apps/web/src/i18n/\` — 18 локалей
- \`apps/web/src/state/\` — клієнтський стан (проєкти, налаштування)

## Звʼязки

- Звертається до [[apps-daemon]] через HTTP API на порту \`OD_PORT\`
- НЕ імпортує з \`apps/daemon/src/\` напряму
`;

const APPS_DAEMON = `# apps/daemon

Локальний демон і CLI \`od\`. Володіє \`/api/*\`, спавном агентів, скілами,
дизайн-системами, артефактами.

## Ключові директорії

- \`apps/daemon/src/runtimes/\` — оболонки агентів (Claude Code, codex, тощо)
- \`apps/daemon/src/downstream/\` — fork-only бекенд: [[OpenRouter]], [[TG Web]]
- \`apps/daemon/src/prompts/\` — system-промпти для агентів
- \`apps/daemon/src/server.ts\` — основний HTTP-сервер

## Звʼязки

- Зберігає дані у \`.od/\`: SQLite \`app.sqlite\`, проєкти у \`projects/<id>/\`
- [[Workflow]] описує як запускати локально
`;

const APPS_DESKTOP = `# apps/desktop

Electron-оболонка. Запускає [[apps-daemon]] як sidecar і відкриває
[[apps-web]] у вікні.

## Ключові файли

- \`apps/desktop/src/main/index.ts\` — main процес, IPC, меню
- \`apps/desktop/src/main/downstream/\` — fork-only: [[Auto-updater]], TG-web folder picker

## Особливості

- Веб-URL береться через sidecar IPC, а НЕ через гадання портів
- [[Auto-updater]] не використовує стандартний electron-updater (SAC блокує його)
`;

const OPENROUTER = `# OpenRouter media-provider

Downstream-фіча: додає OpenRouter як media-провайдер для image/video
генерації, поряд із наявними OpenAI / fal / Veo.

## Розташування

- \`apps/daemon/src/downstream/openrouter/\` — бекенд: provider, models, env-keys
- \`apps/web/src/downstream/openrouter/\` — фронтенд: реєстрація моделей

## Інтеграція

Через \`downstreamProvidersWeb\` спред у \`apps/web/src/downstream/index.ts\`.
Upstream-touch: один import + один spread у \`apps/web/src/media/models.ts\`.
`;

const TG_WEB = `# TG Web

Downstream-фіча: деплой готового дизайн-файлу у репозиторій Telegram-бота
для прев'ю як Mini App.

## Розташування

- \`apps/web/src/downstream/tg-web/\` — UI-панель, i18n, viewer-кнопка
- \`apps/daemon/src/downstream/tg-web/routes.ts\` — деплой-роути
- \`apps/desktop/src/main/downstream/tg-web/folder-picker.ts\` — нативний пікер теки

## Інтеграція

Кнопка у chrome \`FileViewer\` (один import + один рендер).
Має власний підпростір i18n: \`tgWeb.*\` ключі.
`;

const OBSIDIAN_NOTE = `# Obsidian (downstream)

Downstream-фіча: вбудована Markdown-база знань всередині Open Design.

## Розташування

- \`apps/web/src/downstream/obsidian/\` — UI: ObsidianView, ObsidianVault, ObsidianGraph, ObsidianWorkspace
- \`apps/daemon/src/downstream/obsidian/\` — API: storage.ts, routes.ts, seed.ts

## Фази

- **Фаза A** ✓ візуальний скелет, 3-панельне розкладання, граф з force-сімуляцією
- **Фаза B** (поточна): daemon API, реальні файли в \`.od/obsidian-global/\`, редагування
- **Фаза C**: Claude Code CLI як чат-бекенд + tools для пошуку в коді
- **Фаза D**: фоновий індексер репозиторію + смужка покриття

## Інтеграція

Окремий top-level route \`{ kind: 'obsidian' }\` (НЕ entry sub-view).
Кнопка \`navigate({ kind: 'obsidian' })\` в [[EntryNavRail]] + dispatch у App.tsx.
`;

const AUTO_UPDATER = `# Auto-updater

Кастомний оновлювач для Windows — обходить Smart App Control без code-signing.

## Як працює

- Опитує GitHub Releases раз на 30 хв
- При виявленні нової версії пропонує оновлення через діалог
- Завантажує \`win-unpacked.zip\` (не \`.exe\` — SAC блокує downloaded executables)
- Через robocopy замінює лише \`resources/\` (\`.exe\` залишається той самий → SAC trust зберігається)

## Розташування

- \`apps/desktop/src/main/downstream/auto-updater.ts\`

## Стан між запусками

Якщо натиснути "Пізніше" — теґ зберігається у \`<userData>/auto-updater-state.json\`,
щоб після перезапуску одразу не питати знову. Нові релізи завжди викликають діалог.

## Звʼязки

- [[Workflow]] описує \`pnpm tools-pack win build\` як шлях створення \`.zip\`
`;

const WORKFLOW = `# Робочий процес (Workflow)

## Два режими

1. **Активна розробка**: \`pnpm tools-dev\` — HMR, ~100ms перезавантаження UI
2. **Релізи**: GitHub Actions \`release.yml\` будує NSIS + zip → [[Auto-updater]] полить

## Junction .od/

\`.od/\` — це Windows directory junction на
\`%APPDATA%\\Open Design\\namespaces\\default\\data\\\`. Дає змогу dev-серверу
ділити дані з пакетним додатком.

⚠️ **Не запускай tools-dev і пакетний застосунок одночасно** — SQLite WAL
тримає ексклюзивний лок.

## Звʼязки

- [[apps-daemon]] пише у \`.od/\`
- [[Build]] описує пакетні білди
`;

const BUILD = `# Build

\`pnpm tools-pack\` — control-plane для пакетних білдів.

## Windows

\`\`\`
pnpm tools-pack win build --to nsis
pnpm tools-pack win install
\`\`\`

Потрібно:
- Node 24 (не 22 — \`better-sqlite3\` ламається)
- pnpm 10.33.2
- Visual Studio Build Tools 2022+
- Dev Mode увімкнутий (для symlinks)

## Звʼязки

- [[Workflow]] — щоденний цикл
- [[Auto-updater]] — як build стає оновленням
`;

const SEED: { path: string; content: string }[] = [
  { path: 'README', content: README },
  { path: 'Архітектура/apps-web', content: APPS_WEB },
  { path: 'Архітектура/apps-daemon', content: APPS_DAEMON },
  { path: 'Архітектура/apps-desktop', content: APPS_DESKTOP },
  { path: 'Downstream/OpenRouter', content: OPENROUTER },
  { path: 'Downstream/TG Web', content: TG_WEB },
  { path: 'Downstream/Obsidian', content: OBSIDIAN_NOTE },
  { path: 'Downstream/Auto-updater', content: AUTO_UPDATER },
  { path: 'Розробка/Workflow', content: WORKFLOW },
  { path: 'Розробка/Build', content: BUILD },
];

export async function seedVaultIfEmpty(): Promise<{ seeded: boolean; count: number }> {
  if (!(await isVaultEmpty())) {
    return { seeded: false, count: 0 };
  }
  for (const note of SEED) {
    await writeNote(note.path, note.content);
  }
  return { seeded: true, count: SEED.length };
}
