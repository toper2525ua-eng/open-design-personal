// Placeholder vault data used by the Phase A visual skeleton. The real
// notes will be loaded from `.od/obsidian-global/` once the daemon API
// is wired in Phase B. Until then this gives the file tree and content
// pane realistic-looking material so we can refine the visual without
// committing to a storage layer.

export type ObsidianTreeNode =
  | { kind: 'folder'; name: string; path: string; children: ObsidianTreeNode[] }
  | { kind: 'note'; name: string; path: string };

export interface ObsidianNote {
  path: string;
  title: string;
  content: string;
  updatedAt: string;
}

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

- \`apps/web/src/downstream/obsidian/\` — UI: ObsidianView, ObsidianVault, ObsidianGraph
- \`apps/daemon/src/downstream/obsidian/\` — API (буде в Фазі B)

## Фази

- **Фаза A** (поточна): візуальний скелет, 3-панельне розкладання, мок-дані
- **Фаза B**: daemon API, реальні файли в \`.od/obsidian-global/\`, редагування
- **Фаза C**: граф-вʼю, інтеграція Claude-чату, per-project обсидіан

## Інтеграція

Кнопка у [[EntryNavRail]] + route slot у EntryShell.
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

export const MOCK_NOTES: Record<string, ObsidianNote> = {
  'README': {
    path: 'README',
    title: 'README',
    content: README,
    updatedAt: '2026-05-20T17:25:00Z',
  },
  'Архітектура/apps-web': {
    path: 'Архітектура/apps-web',
    title: 'apps/web',
    content: APPS_WEB,
    updatedAt: '2026-05-20T17:25:00Z',
  },
  'Архітектура/apps-daemon': {
    path: 'Архітектура/apps-daemon',
    title: 'apps/daemon',
    content: APPS_DAEMON,
    updatedAt: '2026-05-20T17:25:00Z',
  },
  'Архітектура/apps-desktop': {
    path: 'Архітектура/apps-desktop',
    title: 'apps/desktop',
    content: APPS_DESKTOP,
    updatedAt: '2026-05-20T17:25:00Z',
  },
  'Downstream/OpenRouter': {
    path: 'Downstream/OpenRouter',
    title: 'OpenRouter',
    content: OPENROUTER,
    updatedAt: '2026-05-20T17:25:00Z',
  },
  'Downstream/TG Web': {
    path: 'Downstream/TG Web',
    title: 'TG Web',
    content: TG_WEB,
    updatedAt: '2026-05-20T17:25:00Z',
  },
  'Downstream/Obsidian': {
    path: 'Downstream/Obsidian',
    title: 'Obsidian',
    content: OBSIDIAN_NOTE,
    updatedAt: '2026-05-20T17:25:00Z',
  },
  'Downstream/Auto-updater': {
    path: 'Downstream/Auto-updater',
    title: 'Auto-updater',
    content: AUTO_UPDATER,
    updatedAt: '2026-05-20T17:25:00Z',
  },
  'Розробка/Workflow': {
    path: 'Розробка/Workflow',
    title: 'Workflow',
    content: WORKFLOW,
    updatedAt: '2026-05-20T17:25:00Z',
  },
  'Розробка/Build': {
    path: 'Розробка/Build',
    title: 'Build',
    content: BUILD,
    updatedAt: '2026-05-20T17:25:00Z',
  },
};

export const MOCK_TREE: ObsidianTreeNode[] = [
  { kind: 'note', name: 'README', path: 'README' },
  {
    kind: 'folder',
    name: 'Архітектура',
    path: 'Архітектура',
    children: [
      { kind: 'note', name: 'apps/web', path: 'Архітектура/apps-web' },
      { kind: 'note', name: 'apps/daemon', path: 'Архітектура/apps-daemon' },
      { kind: 'note', name: 'apps/desktop', path: 'Архітектура/apps-desktop' },
    ],
  },
  {
    kind: 'folder',
    name: 'Downstream',
    path: 'Downstream',
    children: [
      { kind: 'note', name: 'Auto-updater', path: 'Downstream/Auto-updater' },
      { kind: 'note', name: 'Obsidian', path: 'Downstream/Obsidian' },
      { kind: 'note', name: 'OpenRouter', path: 'Downstream/OpenRouter' },
      { kind: 'note', name: 'TG Web', path: 'Downstream/TG Web' },
    ],
  },
  {
    kind: 'folder',
    name: 'Розробка',
    path: 'Розробка',
    children: [
      { kind: 'note', name: 'Build', path: 'Розробка/Build' },
      { kind: 'note', name: 'Workflow', path: 'Розробка/Workflow' },
    ],
  },
];

// Resolve a wikilink target (e.g. `[[apps-web]]` or `[[apps/web]]`) to a
// real note path. The skeleton tolerates partial matches so authors don't
// have to type the full folder path.
export function resolveWikilink(name: string): string | null {
  const target = name.trim();
  if (!target) return null;
  if (MOCK_NOTES[target]) return target;
  // Match by basename (after the last `/`) — case-insensitive.
  const lowered = target.toLowerCase();
  for (const path of Object.keys(MOCK_NOTES)) {
    const last = path.split('/').pop() ?? path;
    if (last.toLowerCase() === lowered) return path;
  }
  return null;
}

// Pull every `[[name]]` reference out of a note body, resolving each to a
// real path via `resolveWikilink`. Unresolved links are dropped — they
// would render as broken edges and just add noise to the graph view.
export function extractWikilinks(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    if (!name) continue;
    const resolved = resolveWikilink(name);
    if (!resolved) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export interface ObsidianGraphData {
  nodes: { id: string; label: string; degree: number }[];
  edges: { source: string; target: string }[];
}

// Build a graph view of the vault: one node per note, one undirected edge
// per resolved wikilink (deduped both ways so A→B and B→A become one edge).
// `degree` drives the node radius — central hubs read as bigger circles.
export function buildGraphData(): ObsidianGraphData {
  const nodes = Object.values(MOCK_NOTES).map((note) => ({
    id: note.path,
    label: note.title,
    degree: 0,
  }));
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
  const edgeKeys = new Set<string>();
  const edges: ObsidianGraphData['edges'] = [];
  for (const note of Object.values(MOCK_NOTES)) {
    const targets = extractWikilinks(note.content);
    for (const target of targets) {
      if (target === note.path) continue;
      const a = note.path < target ? note.path : target;
      const b = note.path < target ? target : note.path;
      const key = `${a} ${b}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ source: a, target: b });
      const sourceNode = nodeIndex.get(a);
      const targetNode = nodeIndex.get(b);
      if (sourceNode) sourceNode.degree += 1;
      if (targetNode) targetNode.degree += 1;
    }
  }
  return { nodes, edges };
}
