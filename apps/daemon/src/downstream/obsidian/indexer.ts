// Background repository indexer for the global Obsidian knowledge base.
//
// 3-tier indexing strategy (per user UX request):
//   • Tier 1 — "Карта проєкту" (~20-30 files): top-level READMEs,
//     AGENTS.md, package.json, each apps/<name>/, each downstream
//     feature's index. Produces high-level overview notes.
//   • Tier 2 — "Модулі" (~80-100 files): every AGENTS.md / barrel
//     file (index.ts/index.tsx) under apps/packages/tools. Produces
//     module-level notes that link back to tier 1 notes.
//   • Tier 3 — "Файли" (~300+): every remaining source file. Agent
//     is encouraged to Skip aggressively — tiers 1/2 already covered
//     the big pictures, so tier 3 only writes when a file has notable
//     standalone logic.
//
// Tiers run sequentially: tier 1 fully completes → tier 2 starts →
// tier 3. Within any tier the agent is explicitly allowed to Edit
// notes created by earlier tiers (e.g. add a missing wikilink to a
// tier 1 overview). That backtracking is part of normal flow — after
// the agent finishes its Edits, it returns the standard outcome line
// and the runner moves to the next file in the current tier.
//
// State (queue, cursor, tier, mtimes) lives in-memory; mtimes persist
// to .od/obsidian-global/.index-state.json so re-runs skip files that
// haven't changed since the previous successful pass.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { ensureVaultRoot, updateSourceMapFromNote, vaultRoot } from './storage.js';
import { seedVaultIfEmpty } from './seed.js';
import { scheduleTocRebuild } from './toc.js';

// File extensions that carry meaningful narrative — anything else is
// skipped (binaries, lockfiles, generated bundles, etc.).
const INDEXABLE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.md', '.json', '.css', '.html', '.yml', '.yaml',
  '.py', '.sh', '.toml',
]);

// Directories the walker skips entirely.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.tmp', '.od', 'dist', 'build',
  '.next', '.turbo', 'out', 'coverage', '.cache', '.pnpm-store',
  '.vscode', '.idea',
]);

const SKIP_FILE_NAMES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  '.gitignore', '.npmrc', '.nvmrc', '.editorconfig',
]);

const MAX_FILE_BYTES = 120 * 1024;
const MIN_INTERVAL_MS = 1500;

export type IndexerStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';
export type Tier = 1 | 2 | 3;
const TIERS: Tier[] = [1, 2, 3];

export interface TierProgress {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
}

export interface IndexerProgress {
  status: IndexerStatus;
  currentTier: Tier;
  tier: Record<Tier, TierProgress>;
  // Aggregate counts across all tiers — handy for the overall % bar.
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  currentFile: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

export type IndexerEvent =
  | { kind: 'state'; progress: IndexerProgress }
  | { kind: 'tier-start'; tier: Tier; total: number }
  | { kind: 'tier-done'; tier: Tier }
  | { kind: 'file-start'; file: string; tier: Tier }
  | { kind: 'file-done'; file: string; tier: Tier; notePath?: string }
  | { kind: 'file-skip'; file: string; tier: Tier; reason: string }
  | { kind: 'file-error'; file: string; tier: Tier; detail: string }
  | { kind: 'note-written'; notePath: string; tier: Tier }
  | { kind: 'finished'; progress: IndexerProgress };

// --- State ---

function emptyTierProgress(): TierProgress {
  return { total: 0, completed: 0, skipped: 0, failed: 0 };
}

const state: IndexerProgress = {
  status: 'idle',
  currentTier: 1,
  tier: { 1: emptyTierProgress(), 2: emptyTierProgress(), 3: emptyTierProgress() },
  total: 0,
  completed: 0,
  skipped: 0,
  failed: 0,
  currentFile: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

let queue: string[] = [];
let cursor = 0;
let runToken = 0;
const listeners = new Set<(event: IndexerEvent) => void>();

export function getProgress(): IndexerProgress {
  return JSON.parse(JSON.stringify(state)) as IndexerProgress;
}

export function subscribe(fn: (event: IndexerEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event: IndexerEvent): void {
  for (const fn of listeners) {
    try { fn(event); } catch { /* listener faults shouldn't kill the indexer */ }
  }
}

function emitState(): void {
  emit({ kind: 'state', progress: getProgress() });
}

function recomputeAggregates(): void {
  let total = 0, completed = 0, skipped = 0, failed = 0;
  for (const t of TIERS) {
    const p = state.tier[t];
    total += p.total;
    completed += p.completed;
    skipped += p.skipped;
    failed += p.failed;
  }
  state.total = total;
  state.completed = completed;
  state.skipped = skipped;
  state.failed = failed;
}

// --- Persistent skip-state ---

const STATE_FILENAME = '.index-state.json';
interface IndexState {
  lastFinishedAt: string | null;
  fileMtimes: Record<string, number>;
}
let indexStateCache: IndexState | null = null;

async function loadIndexState(): Promise<IndexState> {
  if (indexStateCache) return indexStateCache;
  const file = path.join(vaultRoot(), STATE_FILENAME);
  try {
    const raw = await readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<IndexState>;
    indexStateCache = {
      lastFinishedAt: typeof parsed.lastFinishedAt === 'string' ? parsed.lastFinishedAt : null,
      fileMtimes: (parsed.fileMtimes && typeof parsed.fileMtimes === 'object')
        ? parsed.fileMtimes as Record<string, number>
        : {},
    };
  } catch {
    indexStateCache = { lastFinishedAt: null, fileMtimes: {} };
  }
  return indexStateCache;
}

async function saveIndexState(): Promise<void> {
  if (!indexStateCache) return;
  await mkdir(vaultRoot(), { recursive: true });
  const file = path.join(vaultRoot(), STATE_FILENAME);
  try {
    await writeFile(file, JSON.stringify(indexStateCache, null, 2), 'utf-8');
  } catch {
    /* non-fatal */
  }
}

// --- Public API ---

export async function start(repoRoot: string): Promise<void> {
  if (state.status === 'running') return;
  await ensureVaultRoot();
  await seedVaultIfEmpty();
  await loadIndexState();

  // Pre-compute counts per tier so the coverage bar shows full totals
  // before any spawns run. We re-collect tier 1's queue first (the
  // active queue), then totals for tiers 2/3 are pre-populated so the
  // user sees "Тіер 1/3 · 0/24" + tier 2/3 totals as hints.
  const t1 = collectTierFiles(repoRoot, 1, new Set());
  const t1Set = new Set(t1);
  const t2 = collectTierFiles(repoRoot, 2, t1Set);
  const t2Set = new Set([...t1Set, ...t2]);
  const t3 = collectTierFiles(repoRoot, 3, t2Set);

  state.tier[1] = { total: t1.length, completed: 0, skipped: 0, failed: 0 };
  state.tier[2] = { total: t2.length, completed: 0, skipped: 0, failed: 0 };
  state.tier[3] = { total: t3.length, completed: 0, skipped: 0, failed: 0 };
  recomputeAggregates();

  queue = t1;
  cursor = 0;
  state.currentTier = 1;
  state.status = 'running';
  state.currentFile = null;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastError = null;
  emitState();
  emit({ kind: 'tier-start', tier: 1, total: t1.length });
  void runLoop(repoRoot, ++runToken);
}

export function pause(): void {
  if (state.status !== 'running') return;
  state.status = 'paused';
  emitState();
}

export function resume(repoRoot: string): void {
  if (state.status !== 'paused') return;
  state.status = 'running';
  emitState();
  void runLoop(repoRoot, ++runToken);
}

export function reset(): void {
  runToken++;
  queue = [];
  cursor = 0;
  state.status = 'idle';
  state.currentTier = 1;
  state.tier = { 1: emptyTierProgress(), 2: emptyTierProgress(), 3: emptyTierProgress() };
  state.currentFile = null;
  state.startedAt = null;
  state.finishedAt = null;
  state.lastError = null;
  recomputeAggregates();
  indexStateCache = { lastFinishedAt: null, fileMtimes: {} };
  void saveIndexState();
  emitState();
}

// --- File walkers ---

// Walks the whole repo using the original ext+skip rules. Returns
// sorted absolute paths. We re-use this base list to derive each
// tier's subset.
function walkAllIndexableFiles(repoRoot: string): string[] {
  const out: string[] = [];
  visit(repoRoot, out);
  out.sort();
  return out;
}

function visit(absDir: string, out: string[]): void {
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      visit(path.join(absDir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILE_NAMES.has(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!INDEXABLE_EXTS.has(ext)) continue;
    const abs = path.join(absDir, entry.name);
    try {
      const s = statSync(abs);
      if (s.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    out.push(abs);
  }
}

// Tier 1: project landmarks. Hand-picked patterns; small enough that
// the agent can build a complete project map without breaking the bank.
function collectTier1Files(repoRoot: string): string[] {
  const out: string[] = [];
  const tryAdd = (rel: string) => {
    const abs = path.join(repoRoot, rel);
    if (existsSync(abs)) out.push(abs);
  };
  // Root landmarks.
  for (const name of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'package.json']) {
    tryAdd(name);
  }
  // Each app's package + AGENTS + README.
  for (const app of safeReadDir(path.join(repoRoot, 'apps'))) {
    tryAdd(path.join('apps', app, 'package.json'));
    tryAdd(path.join('apps', app, 'AGENTS.md'));
    tryAdd(path.join('apps', app, 'README.md'));
  }
  // Each downstream feature's barrel.
  for (const app of safeReadDir(path.join(repoRoot, 'apps'))) {
    const dsAppRoot = path.join(repoRoot, 'apps', app, 'src', 'downstream');
    for (const feature of safeReadDir(dsAppRoot)) {
      for (const ext of ['ts', 'tsx', 'js']) {
        const abs = path.join(dsAppRoot, feature, `index.${ext}`);
        if (existsSync(abs)) {
          out.push(abs);
          break;
        }
      }
    }
  }
  // Per-package + per-tool top-level package.json + AGENTS.
  for (const dir of ['packages', 'tools']) {
    for (const name of safeReadDir(path.join(repoRoot, dir))) {
      tryAdd(path.join(dir, name, 'package.json'));
      tryAdd(path.join(dir, name, 'AGENTS.md'));
    }
  }
  // Top-level docs.
  for (const name of safeReadDir(path.join(repoRoot, 'docs'))) {
    if (name.endsWith('.md')) {
      out.push(path.join(repoRoot, 'docs', name));
    }
  }
  return Array.from(new Set(out)).sort();
}

// Tier 2: barrel files + AGENTS.md anywhere below apps/packages/tools.
function collectTier2Files(repoRoot: string, alreadyCovered: Set<string>): string[] {
  const all = walkAllIndexableFiles(repoRoot);
  const out: string[] = [];
  for (const abs of all) {
    if (alreadyCovered.has(abs)) continue;
    const base = path.basename(abs).toLowerCase();
    if (base === 'agents.md') {
      out.push(abs);
      continue;
    }
    // Index/barrel files in src/ trees.
    if (base === 'index.ts' || base === 'index.tsx' || base === 'index.js') {
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
      // Skip if it lives in a generated/test fixture.
      if (rel.includes('__tests__') || rel.includes('__fixtures__')) continue;
      out.push(abs);
    }
  }
  return out;
}

// Tier 3: everything else.
function collectTier3Files(repoRoot: string, alreadyCovered: Set<string>): string[] {
  const all = walkAllIndexableFiles(repoRoot);
  return all.filter((abs) => !alreadyCovered.has(abs));
}

function collectTierFiles(repoRoot: string, tier: Tier, alreadyCovered: Set<string>): string[] {
  if (tier === 1) return collectTier1Files(repoRoot);
  if (tier === 2) return collectTier2Files(repoRoot, alreadyCovered);
  return collectTier3Files(repoRoot, alreadyCovered);
}

function safeReadDir(absDir: string): string[] {
  try {
    return readdirSync(absDir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

// --- Run loop ---

async function runLoop(repoRoot: string, token: number): Promise<void> {
  const indexState = await loadIndexState();
  while (token === runToken && state.status === 'running') {
    if (cursor >= queue.length) {
      // Current tier done. Bump to next tier or finish.
      emit({ kind: 'tier-done', tier: state.currentTier });
      const next = nextTier(state.currentTier);
      if (next === null) {
        state.status = 'done';
        state.finishedAt = new Date().toISOString();
        indexState.lastFinishedAt = state.finishedAt;
        await saveIndexState();
        emitState();
        emit({ kind: 'finished', progress: getProgress() });
        return;
      }
      // Re-collect next tier's queue with the union of all earlier
      // tiers as "covered" so we never index a landmark file twice.
      const covered = new Set<string>();
      for (const earlierTier of TIERS) {
        if (earlierTier >= next) break;
        for (const f of collectTierFiles(repoRoot, earlierTier, new Set())) covered.add(f);
      }
      // collectTier1Files ignores `covered`, but tier 2's collector
      // needs the tier-1 set, and tier 3 needs tier1+tier2. The
      // start() pre-computation handled that for the initial counts;
      // here we recompute live to be safe.
      const nextQueue = collectTierFiles(repoRoot, next, covered);
      queue = nextQueue;
      cursor = 0;
      state.currentTier = next;
      state.tier[next] = state.tier[next] ?? emptyTierProgress();
      state.tier[next].total = nextQueue.length;
      recomputeAggregates();
      emitState();
      emit({ kind: 'tier-start', tier: next, total: nextQueue.length });
      continue;
    }

    const file = queue[cursor]!;
    cursor++;
    const relPath = path.relative(repoRoot, file).split(path.sep).join('/');
    const tier = state.currentTier;
    state.currentFile = relPath;
    emitState();

    // Smart skip on unchanged file.
    let mtimeMs = 0;
    try { mtimeMs = (await stat(file)).mtimeMs; } catch { mtimeMs = 0; }
    if (mtimeMs > 0 && indexState.fileMtimes[relPath] === mtimeMs) {
      state.tier[tier].skipped++;
      recomputeAggregates();
      emit({ kind: 'file-skip', file: relPath, tier, reason: 'unchanged since last index' });
      state.currentFile = null;
      emitState();
      continue;
    }

    emit({ kind: 'file-start', file: relPath, tier });
    const turnStartedAt = Date.now();
    try {
      const outcome = await indexOneFile(file, repoRoot, tier);
      if (token !== runToken) return;
      if (outcome.kind === 'skipped') {
        state.tier[tier].skipped++;
        if (mtimeMs > 0) indexState.fileMtimes[relPath] = mtimeMs;
        emit({ kind: 'file-skip', file: relPath, tier, reason: outcome.reason });
      } else if (outcome.kind === 'error') {
        state.tier[tier].failed++;
        state.lastError = outcome.detail;
        emit({ kind: 'file-error', file: relPath, tier, detail: outcome.detail });
      } else {
        state.tier[tier].completed++;
        if (mtimeMs > 0) indexState.fileMtimes[relPath] = mtimeMs;
        emit({
          kind: 'file-done',
          file: relPath,
          tier,
          ...(outcome.notePath ? { notePath: outcome.notePath } : {}),
        });
        if (outcome.notePath) {
          emit({ kind: 'note-written', notePath: outcome.notePath, tier });
          // Sync the source-map from the freshly-written note. The
          // agent wrote it via Write/Edit (not our writeNote), so we
          // have to re-read it to harvest `<!-- sourceFile: -->`
          // markers.
          await harvestSourceMapMarkers(outcome.notePath);
          // Coalesced TOC rebuild — keeps the master index current
          // throughout the indexer run.
          scheduleTocRebuild();
        }
      }
    } catch (err) {
      state.tier[tier].failed++;
      state.lastError = err instanceof Error ? err.message : String(err);
      emit({ kind: 'file-error', file: relPath, tier, detail: state.lastError });
    }
    recomputeAggregates();
    state.currentFile = null;
    emitState();
    if ((state.completed + state.skipped + state.failed) % 10 === 0) {
      await saveIndexState();
    }

    if (token !== runToken) return;
    const elapsed = Date.now() - turnStartedAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
  }
}

// Read a note written by the indexer agent + push its sourceFile
// markers into the source-map. The agent uses Write/Edit, which
// bypasses our writeNote() that normally maintains the map.
async function harvestSourceMapMarkers(notePathRaw: string): Promise<void> {
  // Agent may return either a vault-relative path or one prefixed with
  // `.od/obsidian-global/`. Normalize.
  let relInVault = notePathRaw.trim().replace(/\\/g, '/');
  const prefix = '.od/obsidian-global/';
  if (relInVault.startsWith(prefix)) relInVault = relInVault.slice(prefix.length);
  if (relInVault.toLowerCase().endsWith('.md')) {
    relInVault = relInVault.slice(0, -3);
  }
  const abs = path.join(vaultRoot(), `${relInVault}.md`);
  try {
    const content = await readFile(abs, 'utf-8');
    await updateSourceMapFromNote(relInVault, content);
  } catch {
    // Note wasn't readable — skip; map will catch up on next write.
  }
}

function nextTier(current: Tier): Tier | null {
  if (current === 1) return 2;
  if (current === 2) return 3;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Per-file claude spawn ---

type IndexOutcome =
  | { kind: 'written'; notePath?: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; detail: string };

async function indexOneFile(absFile: string, repoRoot: string, tier: Tier): Promise<IndexOutcome> {
  let content: string;
  try {
    content = await readFile(absFile, 'utf-8');
  } catch (err) {
    return { kind: 'error', detail: `read failed: ${(err as Error).message}` };
  }
  if (content.trim().length === 0) {
    return { kind: 'skipped', reason: 'empty file' };
  }
  const relPath = path.relative(repoRoot, absFile).split(path.sep).join('/');
  const prompt = buildPromptForTier(relPath, content, tier);

  return new Promise<IndexOutcome>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('claude', [
        '-p',
        '--input-format', 'text',
        '--output-format', 'text',
        '--permission-mode', 'bypassPermissions',
      ], {
        cwd: repoRoot,
        shell: process.platform === 'win32',
        env: process.env,
      });
    } catch (err) {
      resolve({ kind: 'error', detail: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.setEncoding('utf-8');
    proc.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    proc.stderr?.setEncoding('utf-8');
    proc.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', (err) => {
      resolve({ kind: 'error', detail: err.message });
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        resolve({
          kind: 'error',
          detail: `claude exit ${code}: ${stderr.slice(0, 200)}`,
        });
        return;
      }
      const noteMatch = stdout.match(/Note (?:written|updated):\s*([^\n]+)/i);
      const skipMatch = stdout.match(/Skipped:\s*([^\n]+)/i);
      if (skipMatch) {
        resolve({ kind: 'skipped', reason: skipMatch[1]!.trim() });
        return;
      }
      const out: IndexOutcome = { kind: 'written' };
      if (noteMatch && noteMatch[1]) out.notePath = noteMatch[1].trim();
      resolve(out);
    });
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}

// --- Tier-aware prompts ---

const PROJECT_ORIENTATION = [
  '## Про проєкт Open Design',
  '',
  'Open Design — Next.js 16 + Electron-додаток для AI-генерованого дизайну.',
  'Це fork (`toper2525ua-eng/open-design-personal`).',
  '',
  'Структура репо:',
  '- `apps/web/` — Next.js фронтенд (React 18). Компоненти у `src/components/`.',
  '- `apps/daemon/` — Express бекенд. Спавнить агентів (Claude Code тощо). Пише дані у `.od/`.',
  '- `apps/desktop/` — Electron-обгортка.',
  '- `packages/` — спільні модулі (contracts, sidecar, platform тощо).',
  '- `tools/` — dev/pack/pr/serve CLI (control-plane).',
  '- `docs/` — архітектурні нотатки.',
  '',
  'Downstream pattern: fork-only фічі живуть у `apps/<app>/src/downstream/<feature>/`. Це OpenRouter media-провайдер, TG Web Telegram-деплой, Obsidian (ця база знань), Auto-updater.',
  '',
  'База знань — у `.od/obsidian-global/`. Markdown-нотатки з wikilinks `[[Назва]]` (резолвиться по basename).',
].join('\n');

function buildPromptForTier(relPath: string, content: string, tier: Tier): string {
  const trimmed = content.length > 6000 ? `${content.slice(0, 6000)}\n…[trimmed]` : content;
  if (tier === 1) return buildTier1Prompt(relPath, trimmed);
  if (tier === 2) return buildTier2Prompt(relPath, trimmed);
  return buildTier3Prompt(relPath, trimmed);
}

function buildTier1Prompt(relPath: string, content: string): string {
  return [
    '# Ти — фоновий індексер бази знань Open Design (ТІЕР 1: КАРТА ПРОЄКТУ)',
    '',
    PROJECT_ORIENTATION,
    '',
    '## Поточний файл (тіер 1)',
    `\`${relPath}\``,
    '',
    '```',
    content,
    '```',
    '',
    '## Алгоритм',
    '',
    'Це **тіер 1 — карта проєкту**. Ціль: створити overview-нотатки про великі частини проєкту (apps/web, apps/daemon, кожна downstream-фіча, кожен пакет/тул). НЕ пиши деталі реалізації — це для тіерів 2 і 3.',
    '',
    '**Крок 1.** Розвідай:',
    '- `Glob ".od/obsidian-global/**/*.md"` — побачити які нотатки + категорії вже існують.',
    '- `Grep` по basename файлу у `.od/obsidian-global/` — знайти існуючу overview-нотатку якщо є.',
    '',
    '**Крок 2.** Вирішуй:',
    '- ✅ Якщо є overview-нотатка про цю область — `Edit`, додавши тільки нові факти/wikilinks.',
    '- ✅ Якщо нема — `Write` у наявну категорію (`Архітектура/`, `Downstream/`, `Розробка/`, або створи розумну якщо нема відповідної).',
    '- ❌ Якщо файл малоцінний для overview (наприклад `package.json` із самих depend-ів без коментаря) — `Skipped: <причина>`.',
    '',
    '**Крок 3.** За потреби максимум 2-3 додаткових Read/Grep. ЦЕ ОГЛЯД, не дослідження.',
    '',
    '## Формат overview-нотатки (ТІЕР 1)',
    '- Українська мова. Перший рядок: `# <Назва>`.',
    '- 4-8 пунктів. Лише головна суть. БЕЗ code blocks.',
    '- Секції: "Призначення" → "Розташування" (із relpath) → "Звʼязки" (wikilinks до пов\'язаних оверв\'юнотаток).',
    '- В кінці HTML-маркер: `<!-- sourceFile: <relPath> -->`.',
    '- `<!-- tier: 1 -->` маркер щоб тіери 2-3 знали що це overview.',
    '',
    '## Відповідь',
    'РІВНО один з рядків (на окремому рядку):',
    '- `Note written: .od/obsidian-global/<шлях>.md`',
    '- `Note updated: .od/obsidian-global/<шлях>.md`',
    '- `Skipped: <причина>`',
    '',
    'Без пояснень — це фоновий процес.',
  ].join('\n');
}

function buildTier2Prompt(relPath: string, content: string): string {
  return [
    '# Ти — фоновий індексер бази знань Open Design (ТІЕР 2: МОДУЛІ)',
    '',
    PROJECT_ORIENTATION,
    '',
    '## Поточний файл (тіер 2)',
    `\`${relPath}\``,
    '',
    '```',
    content,
    '```',
    '',
    '## Алгоритм',
    '',
    'Це **тіер 2 — модулі**. Тіер 1 уже створив overview-нотатки про великі частини. Тепер пишемо нотатки про конкретні модулі/підпапки (barrel-файли, AGENTS.md у підтеках).',
    '',
    '**Крок 1.** Розвідай:',
    '- `Glob ".od/obsidian-global/**/*.md"` — побачити структуру.',
    '- `Grep` по basename файлу та назві модуля у нотатках. Особлива увага: знайди ТІЕР-1 overview-нотатку (через `<!-- tier: 1 -->` маркер) до якої цей модуль належить.',
    '',
    '**Крок 2.** Вирішуй:',
    '- ✅ Якщо є нотатка про цей модуль — `Edit`, додай факти/wikilinks.',
    '- ✅ Якщо нема — `Write` у наявну категорію. Назва нотатки = назва модуля.',
    '- ✅ **BACKTRACK ДОЗВОЛЕНО**: якщо побачив що тіер-1 overview не лінкує до цього модуля — `Edit` overview і додай wikilink. Це нормальна частина flow.',
    '- ❌ Якщо barrel-файл просто re-exports без власної логіки — `Skipped: re-export only`.',
    '',
    '**Крок 3.** За потреби максимум 3-4 додаткових Read/Grep.',
    '',
    '## Формат module-нотатки (ТІЕР 2)',
    '- Українська мова. Заголовок `# <Назва модуля>`.',
    '- 5-10 пунктів. Опис що модуль робить + ключові експорти/файли.',
    '- Секції: "Призначення" → "Розташування" → "Ключові файли" → "Звʼязки" (wikilinks).',
    '- В кінці: `<!-- sourceFile: <relPath> -->` + `<!-- tier: 2 -->`.',
    '',
    '## Відповідь',
    'РІВНО один з рядків:',
    '- `Note written: .od/obsidian-global/<шлях>.md`',
    '- `Note updated: .od/obsidian-global/<шлях>.md`',
    '- `Skipped: <причина>`',
  ].join('\n');
}

function buildTier3Prompt(relPath: string, content: string): string {
  return [
    '# Ти — фоновий індексер бази знань Open Design (ТІЕР 3: ФАЙЛИ)',
    '',
    PROJECT_ORIENTATION,
    '',
    '## Поточний файл (тіер 3)',
    `\`${relPath}\``,
    '',
    '```',
    content,
    '```',
    '',
    '## Алгоритм',
    '',
    'Це **тіер 3 — окремі файли**. Тіери 1-2 вже покрили overview і модулі. На цьому тіері пиши нотатку ТІЛЬКИ якщо файл містить значущу самостійну логіку (важлива функція/клас/патерн/буг-фікс/архітектурне рішення). **Більшість файлів треба Skip.**',
    '',
    '**Крок 1.** Розвідай:',
    '- `Glob ".od/obsidian-global/**/*.md"` + `Grep` по basename — побачити нотатки + знайти tier-2 нотатку про модуль до якого цей файл належить.',
    '',
    '**Крок 2.** Вирішуй (будь СУВОРИМ — більшість Skip):',
    '- ✅ Якщо є нотатка ПРО ЦЕЙ файл — `Edit` тільки нові факти.',
    '- ✅ Якщо файл має значущу логіку і ще не задокументований — `Write` у наявну категорію.',
    '- ✅ **BACKTRACK ДОЗВОЛЕНО**: якщо тіер-2 module-нотатка не згадує цей файл або не має wikilink — `Edit` її, додай посилання. Це нормально.',
    '- ❌ Дрібний компонент UI / type-only файл / тривіальний хелпер / тест-fixture / локалізація — `Skipped`.',
    '- ❌ Файл просто re-exports або проста утиліта — `Skipped`.',
    '',
    '**Крок 3.** Максимум 2-3 додаткових Read/Grep. Не дослідуй надто.',
    '',
    '## Формат file-нотатки (ТІЕР 3, рідко пишемо)',
    '- Українська. `# <Назва файла або концепту>`.',
    '- 3-7 пунктів. Стисло — що файл робить, що цікавого.',
    '- В кінці: `<!-- sourceFile: <relPath> -->` + `<!-- tier: 3 -->`.',
    '',
    '## Відповідь',
    'РІВНО один з рядків:',
    '- `Note written: .od/obsidian-global/<шлях>.md`',
    '- `Note updated: .od/obsidian-global/<шлях>.md`',
    '- `Skipped: <причина>`',
  ].join('\n');
}
