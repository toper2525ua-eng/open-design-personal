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

import { mkdir, readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { atomicWriteFile, ensureVaultRoot, listAllNotes, updateSourceMapFromNote, vaultRoot } from './storage.js';
import { seedVaultIfEmpty } from './seed.js';
import { flushTocRebuild, scheduleTocRebuild } from './toc.js';

// Upper bound for a single per-file claude spawn. Beyond this we assume
// the agent hung on auth-prompt / network stall / internal deadlock,
// SIGTERM it, and record an error so the file is retried on the next
// run. Without this cap a single hung spawn freezes the entire loop and
// Pause/Reset have no effect.
const SPAWN_TIMEOUT_MS = 5 * 60_000;

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

// Single-flight guard on start/resume/reset. Double clicks from the UI
// can race the HTTP handlers; without this two runLoop() instances
// could read the same queue, double-process files, and double-bill
// the user. Held only across the synchronous portion of each public
// entry point, NOT across the long-running runLoop itself.
let lifecycleBusy = false;

// The currently-running child process, if any. Tracked at module
// scope so Pause/Reset can SIGTERM it instead of waiting for the
// in-flight spawn to time out naturally.
let activeProc: ChildProcess | null = null;

function killActiveProc(): void {
  if (!activeProc) return;
  try { activeProc.kill('SIGTERM'); } catch { /* already gone */ }
  activeProc = null;
}

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

// --- Persistent indexer config (model choice) ---

const CONFIG_FILENAME = '.indexer-config.json';
export type IndexerModel = 'sonnet' | 'opus';
interface IndexerConfig {
  model: IndexerModel;
}
let indexerConfigCache: IndexerConfig | null = null;

async function loadIndexerConfig(): Promise<IndexerConfig> {
  if (indexerConfigCache) return indexerConfigCache;
  try {
    const raw = await readFile(path.join(vaultRoot(), CONFIG_FILENAME), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<IndexerConfig>;
    const model: IndexerModel = parsed.model === 'opus' ? 'opus' : 'sonnet';
    indexerConfigCache = { model };
  } catch {
    // Default to Sonnet — cheaper than Opus and quality is fine for
    // classify+short-note workloads. User can flip via the UI.
    indexerConfigCache = { model: 'sonnet' };
  }
  return indexerConfigCache;
}

async function saveIndexerConfig(): Promise<void> {
  if (!indexerConfigCache) return;
  try {
    await mkdir(vaultRoot(), { recursive: true });
    await atomicWriteFile(path.join(vaultRoot(), CONFIG_FILENAME), JSON.stringify(indexerConfigCache, null, 2));
  } catch {
    /* non-fatal — config falls back to default on next load */
  }
}

export async function getIndexerConfig(): Promise<IndexerConfig> {
  return { ...(await loadIndexerConfig()) };
}

export async function setIndexerModel(model: IndexerModel): Promise<IndexerConfig> {
  const cfg = await loadIndexerConfig();
  cfg.model = model;
  indexerConfigCache = cfg;
  await saveIndexerConfig();
  return { ...cfg };
}

// --- Persistent skip-state ---

const STATE_FILENAME = '.index-state.json';
interface IndexState {
  lastFinishedAt: string | null;
  // Mtime fast-path: file unchanged across runs → instant skip without
  // reading the file. Invalidated by auto-updater (every bundled file
  // gets a fresh mtime on install) so we keep a hash fallback.
  fileMtimes: Record<string, number>;
  // Content hash fallback: short SHA-1 prefix per file (16 hex chars).
  // Used when mtime mismatches: if the hash still matches, treat the
  // file as unchanged (e.g. copied-with-new-timestamp by auto-updater)
  // and SKIP without spawning claude. Same total work as a read+hash
  // (~10ms / file) vs ~5-9k tokens for a claude spawn.
  fileHashes: Record<string, string>;
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
      fileHashes: (parsed.fileHashes && typeof parsed.fileHashes === 'object')
        ? parsed.fileHashes as Record<string, string>
        : {},
    };
  } catch {
    indexStateCache = { lastFinishedAt: null, fileMtimes: {}, fileHashes: {} };
  }
  return indexStateCache;
}

// Short content fingerprint — SHA-1, first 16 hex chars. Plenty of
// entropy for ~10^4 files and stays small in the JSON state file.
async function computeFileHash(absFile: string): Promise<string | null> {
  try {
    const buf = await readFile(absFile);
    return createHash('sha1').update(buf).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// Chain writes so two concurrent saveIndexState() calls don't collide
// on the same temp-file. The atomic helper itself is safe per call
// (unique tmp name), but mtime-tracking guarantees mean we want the
// LAST snapshot to win, not whoever finishes the rename last.
let indexStateWriteChain: Promise<void> = Promise.resolve();

async function saveIndexState(): Promise<void> {
  if (!indexStateCache) return;
  const snapshot = JSON.stringify(indexStateCache, null, 2);
  indexStateWriteChain = indexStateWriteChain.then(async () => {
    try {
      await mkdir(vaultRoot(), { recursive: true });
      await atomicWriteFile(path.join(vaultRoot(), STATE_FILENAME), snapshot);
    } catch {
      /* non-fatal */
    }
  });
  return indexStateWriteChain;
}

// --- Public API ---

// Walk every note, harvest `<!-- sourceFile: X -->` markers, and
// pre-populate the mtime cache so files that already have notes get
// instant-skipped on next runLoop. Idempotent — running this on every
// start() is cheap (~10ms / note) and means any prior daemon run
// (including pre-cache-feature versions) gets its work picked up.
//
// Why this matters in practice: every auto-update bumps the mtime of
// every bundled file, invalidating the fast-path. Even with the
// hash-fallback this still has to read+hash each file. Harvesting at
// startup is the cheapest possible recovery — we read the notes we
// already wrote, learn which source files they describe, and trust
// that history.
async function harvestExistingNotes(repoRoot: string): Promise<void> {
  const state = await loadIndexState();
  let notes: Awaited<ReturnType<typeof listAllNotes>>;
  try { notes = await listAllNotes(); }
  catch { return; }
  for (const note of notes) {
    if (note.path === 'README' || note.path.startsWith('.')) continue;
    try { await updateSourceMapFromNote(note.path, note.content); }
    catch { /* per-note errors don't kill startup */ }
    const re = /<!--\s*sourceFile:\s*([^\s]+)\s*-->/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(note.content)) !== null) {
      const rel = m[1]!.trim();
      const absFile = path.join(repoRoot, rel);
      try {
        const st = await stat(absFile);
        if (st.mtimeMs > 0) state.fileMtimes[rel] = st.mtimeMs;
      } catch { /* source file gone — leave cache as is */ }
    }
  }
  await saveIndexState();
}

export async function start(repoRoot: string): Promise<void> {
  if (lifecycleBusy) return;
  lifecycleBusy = true;
  try {
    if (state.status === 'running') return;
    await ensureVaultRoot();
    await seedVaultIfEmpty();
    await loadIndexState();
    // Cheap recovery — read existing notes, learn what they cover,
    // backfill cache. Runs before queue collection so the smart-skip
    // sees the freshly-populated mtimes on the very first iteration.
    await harvestExistingNotes(repoRoot);

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
  } finally {
    lifecycleBusy = false;
  }
}

export function pause(): void {
  if (state.status !== 'running') return;
  state.status = 'paused';
  // Don't wait for the in-flight spawn to finish — kill it. The runLoop
  // will see runToken matches and resolve the outcome as error, but
  // the next iteration will check state.status and exit the loop.
  killActiveProc();
  emitState();
}

export function resume(repoRoot: string): void {
  if (lifecycleBusy) return;
  lifecycleBusy = true;
  try {
    if (state.status !== 'paused') return;
    state.status = 'running';
    emitState();
    void runLoop(repoRoot, ++runToken);
  } finally {
    lifecycleBusy = false;
  }
}

export function reset(): void {
  runToken++;
  killActiveProc();
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
  indexStateCache = { lastFinishedAt: null, fileMtimes: {}, fileHashes: {} };
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

// Patterns that are virtually never worth a tier-3 note. Skipping them
// at the QUEUE level (not via claude-spawn-then-skip) is pure savings:
// every spawn would cost 5-9k tokens just for claude to read the file
// and tell us what we already know — that minified/bundled/generated
// output isn't worth documenting. Most of the user's 2400+ packaged-
// app tier-3 queue was webpack chunks; this prunes them.
const TIER3_SKIP_PATH_PATTERNS = [
  // Webpack-style hashed chunks: `chunks/chunk-AB12CD34.mjs` etc.
  /[\\/]chunks[\\/]chunk-[A-Z0-9]+\.(m?js|cjs)$/i,
  // Feature chunks with content-hash suffix: `browser-open-42BVXORX.mjs`.
  /[\\/]chunks[\\/][^\\/]+-[A-Z0-9]{8}\.(m?js|cjs)$/,
  // Type-declaration files — schema, not behavior.
  /\.d\.ts$/i,
  // Source maps — generated, never narrative.
  /\.(m?js|css)\.map$/i,
  // Minified / pre-bundled outputs.
  /\.min\.(m?js|css)$/i,
  // Vite/Rollup-style hashed assets in production output.
  /[\\/]assets[\\/][^\\/]+-[a-zA-Z0-9_-]{8,12}\.(m?js|css)$/,
  // Vendored code copied into the tree — third-party, not the
  // user's program. Hits dirs like `<template>/scripts/lib/vendor/`.
  /[\\/]vendor[\\/]/,
  // JSON / TS schemas — these are shape declarations, not behavior.
  /\.schema\.(ts|tsx|js|mjs|cjs|json)$/i,
  // Rendered design-system component catalogs and design-template
  // example renders — output, not source. `components.html` lives
  // under each design-system; templates ship example HTML beside
  // their script files.
  /[\\/]design-systems[\\/][^\\/]+[\\/]components\.html$/i,
  /[\\/]design-templates[\\/].+\.html$/i,
  // Storybook artifacts and rendered preview pages, if any.
  /[\\/]storybook-static[\\/]/,
  // Common test scaffolding — fixtures and snapshots. Tier 2 already
  // skips these in some collectors, but tier 3 walked them.
  /[\\/]__fixtures__[\\/]/,
  /[\\/]__snapshots__[\\/]/,
  /[\\/]__mocks__[\\/]/,
  // Locale dictionaries — translated copy strings, not narrative.
  /[\\/]locales[\\/][a-z]{2}([-_][A-Z]{2})?\.json$/,
];

function isTier3Skippable(abs: string): boolean {
  const posix = abs.replace(/\\/g, '/');
  return TIER3_SKIP_PATH_PATTERNS.some((rx) => rx.test(posix));
}

// Tier 3: everything else, minus the obvious-junk patterns above.
function collectTier3Files(repoRoot: string, alreadyCovered: Set<string>): string[] {
  const all = walkAllIndexableFiles(repoRoot);
  return all.filter((abs) => !alreadyCovered.has(abs) && !isTier3Skippable(abs));
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
      // Current tier done. Bump to next tier or finish. Flush the
      // master TOC at every tier boundary (and on full finish) so we
      // have a durable on-disk snapshot at well-defined checkpoints,
      // not just whenever the debounce timer happens to fire.
      emit({ kind: 'tier-done', tier: state.currentTier });
      try { await flushTocRebuild(); } catch { /* TOC is best-effort */ }
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
    //
    //   Fast path: mtime matches the cached value → skip with zero I/O.
    //   Fallback: mtime mismatches but content hash matches the cached
    //     hash → skip + refresh mtime so subsequent runs hit the fast
    //     path again. This branch is the auto-updater immunity: every
    //     bundled file gets a new mtime on install but content is the
    //     same, so the hash check rescues all of them without burning
    //     claude spawns.
    let mtimeMs = 0;
    try { mtimeMs = (await stat(file)).mtimeMs; } catch { mtimeMs = 0; }
    if (mtimeMs > 0 && indexState.fileMtimes[relPath] === mtimeMs) {
      state.tier[tier].skipped++;
      recomputeAggregates();
      emit({ kind: 'file-skip', file: relPath, tier, reason: 'unchanged since last index (mtime)' });
      state.currentFile = null;
      emitState();
      continue;
    }
    const cachedHash = indexState.fileHashes[relPath];
    if (cachedHash) {
      const currentHash = await computeFileHash(file);
      if (currentHash && currentHash === cachedHash) {
        // Content unchanged but mtime drifted (e.g. auto-update). Skip
        // and refresh mtime so the fast path hits next time.
        if (mtimeMs > 0) indexState.fileMtimes[relPath] = mtimeMs;
        state.tier[tier].skipped++;
        recomputeAggregates();
        emit({ kind: 'file-skip', file: relPath, tier, reason: 'unchanged since last index (hash)' });
        state.currentFile = null;
        emitState();
        continue;
      }
    }

    emit({ kind: 'file-start', file: relPath, tier });
    const turnStartedAt = Date.now();
    try {
      const outcome = await indexOneFile(file, repoRoot, tier);
      if (token !== runToken) return;
      // Helper to record mtime + content hash on a successful outcome.
      // Called for both 'skipped' (agent decided this file isn't worth
      // a note) and 'written' (agent wrote/edited a note). Failed
      // outcomes don't touch the cache so they retry on next run.
      const recordSuccess = async () => {
        if (mtimeMs > 0) indexState.fileMtimes[relPath] = mtimeMs;
        const h = await computeFileHash(file);
        if (h) indexState.fileHashes[relPath] = h;
      };
      if (outcome.kind === 'skipped') {
        state.tier[tier].skipped++;
        await recordSuccess();
        emit({ kind: 'file-skip', file: relPath, tier, reason: outcome.reason });
      } else if (outcome.kind === 'error') {
        state.tier[tier].failed++;
        state.lastError = outcome.detail;
        emit({ kind: 'file-error', file: relPath, tier, detail: outcome.detail });
      } else {
        state.tier[tier].completed++;
        await recordSuccess();
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

  // Choose model per the user's coverage-bar dropdown. Sonnet is the
  // default (~5× cheaper than Opus for this classify+short-note task,
  // quality is fine); the user can flip to Opus when they want max
  // judgment on a hard codebase.
  const cfg = await loadIndexerConfig();
  return new Promise<IndexOutcome>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn('claude', [
        '-p',
        '--input-format', 'text',
        '--output-format', 'text',
        '--permission-mode', 'bypassPermissions',
        '--model', cfg.model,
      ], {
        cwd: repoRoot,
        shell: process.platform === 'win32',
        env: process.env,
      });
    } catch (err) {
      resolve({ kind: 'error', detail: (err as Error).message });
      return;
    }
    // settle/timer/activeProc plumbing follows; we don't call resolve
    // directly past this point.
    activeProc = proc;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    }, SPAWN_TIMEOUT_MS);
    const settle = (outcome: IndexOutcome) => {
      clearTimeout(timer);
      if (activeProc === proc) activeProc = null;
      resolve(outcome);
    };
    let stdout = '';
    let stderr = '';
    proc.stdout?.setEncoding('utf-8');
    proc.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    proc.stderr?.setEncoding('utf-8');
    proc.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', (err) => {
      settle({ kind: 'error', detail: err.message });
    });
    proc.on('exit', (code, signal) => {
      if (timedOut) {
        settle({ kind: 'error', detail: `timeout after ${Math.round(SPAWN_TIMEOUT_MS / 1000)}s (SIGTERM)` });
        return;
      }
      if (signal === 'SIGTERM') {
        // External kill (Pause/Reset). Treat as transient — no mtime
        // save, retry on next run.
        settle({ kind: 'error', detail: 'cancelled (SIGTERM)' });
        return;
      }
      if (code !== 0) {
        // Claude sometimes exits 1 with empty stderr — capture stdout
        // too so the UI shows whatever the agent did say before it
        // bailed out (rate-limit message, auth prompt, internal
        // error, etc.). Helps figure out why a whole tier is failing
        // instead of staring at a bare exit code.
        const stderrSnip = stderr.trim().slice(0, 200);
        const stdoutSnip = stdout.trim().slice(0, 200);
        const detail = [
          `claude exit ${code}`,
          stderrSnip ? `stderr: ${stderrSnip}` : null,
          stdoutSnip ? `stdout: ${stdoutSnip}` : null,
          (!stderrSnip && !stdoutSnip) ? '(no output — auth, rate limit, or PATH issue likely)' : null,
        ].filter(Boolean).join(' | ');
        settle({ kind: 'error', detail });
        return;
      }
      const noteMatch = stdout.match(/Note (?:written|updated):\s*([^\n]+)/i);
      const skipMatch = stdout.match(/Skipped:\s*([^\n]+)/i);
      if (skipMatch) {
        settle({ kind: 'skipped', reason: skipMatch[1]!.trim() });
        return;
      }
      const out: IndexOutcome = { kind: 'written' };
      if (noteMatch && noteMatch[1]) out.notePath = noteMatch[1].trim();
      settle(out);
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
