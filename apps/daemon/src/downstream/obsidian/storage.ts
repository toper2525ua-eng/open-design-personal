// Filesystem storage for the global Obsidian knowledge base.
//
// All notes live as plain `.md` files under `<cwd>/.od/obsidian-global/`.
// The daemon writes here whether running via tools-dev (cwd = project
// root → `.od/` is the workspace junction onto packaged data) or
// packaged (cwd = packaged data root). This mirrors tg-web's storage
// convention so the data ends up where the user expects.
//
// Every public path the API accepts is a vault-relative POSIX-style
// string like `Архітектура/apps-web`. We normalize + validate at the
// boundary (resolveSafePath) so a malicious `../..` can't escape the
// vault root. Note paths never include the `.md` extension — the
// storage layer adds and strips it.

import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const VAULT_DIRNAME = path.join('.od', 'obsidian-global');
const ATTACHMENTS_DIRNAME = '.attachments';
const NOTE_EXT = '.md';

export interface ObsidianNoteRecord {
  path: string;
  title: string;
  content: string;
  updatedAt: string;
}

export type ObsidianTreeNode =
  | { kind: 'folder'; name: string; path: string; children: ObsidianTreeNode[] }
  | { kind: 'note'; name: string; path: string };

export function vaultRoot(): string {
  return path.resolve(process.cwd(), VAULT_DIRNAME);
}

export function attachmentsRoot(): string {
  return path.join(vaultRoot(), ATTACHMENTS_DIRNAME);
}

export async function ensureVaultRoot(): Promise<string> {
  const root = vaultRoot();
  await mkdir(root, { recursive: true });
  return root;
}

export async function ensureAttachmentsRoot(): Promise<string> {
  const root = attachmentsRoot();
  await mkdir(root, { recursive: true });
  return root;
}

// Resolve a vault-relative path to an absolute filesystem path, ensuring
// the result is inside the vault root. Throws an Error tagged with
// `code: 'VAULT_OUT_OF_BOUNDS'` if a `..` segment would escape — callers
// translate that to HTTP 400.
export function resolveSafePath(notePath: string): string {
  const root = vaultRoot();
  if (typeof notePath !== 'string' || notePath.trim().length === 0) {
    throw outOfBounds('path is required');
  }
  // Convert any backslashes from a callers that built a Windows-style
  // path; vault paths are always POSIX-style on the wire.
  const normalized = notePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw outOfBounds('path may not contain .. or . segments');
  }
  const abs = path.resolve(root, `${normalized}${NOTE_EXT}`);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw outOfBounds('resolved path escapes the vault root');
  }
  return abs;
}

function outOfBounds(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = 'VAULT_OUT_OF_BOUNDS';
  return err;
}

// Derive the vault-relative path (without extension) from an absolute
// path. Used when walking the tree.
function relPath(abs: string): string {
  const root = vaultRoot();
  const rel = path.relative(root, abs);
  // Strip .md extension if present (notes only). Folders stay as-is.
  if (rel.toLowerCase().endsWith(NOTE_EXT)) {
    return rel.slice(0, -NOTE_EXT.length).split(path.sep).join('/');
  }
  return rel.split(path.sep).join('/');
}

// Title heuristic: first markdown H1 if present, else basename.
function titleFromContent(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+?)\s*$/m);
  if (match && match[1]) return match[1].trim();
  return fallback;
}

export async function readNote(notePath: string): Promise<ObsidianNoteRecord | null> {
  const abs = resolveSafePath(notePath);
  let content: string;
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    content = await readFile(abs, 'utf-8');
    stats = await stat(abs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
  const baseName = path.basename(abs, NOTE_EXT);
  return {
    path: notePath,
    title: titleFromContent(content, baseName),
    content,
    updatedAt: stats.mtime.toISOString(),
  };
}

export async function writeNote(notePath: string, content: string): Promise<ObsidianNoteRecord> {
  const abs = resolveSafePath(notePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
  const stats = await stat(abs);
  const baseName = path.basename(abs, NOTE_EXT);
  // Keep the source-map in sync so reverse lookups (file → note)
  // continue working without a manual reindex step.
  await updateSourceMapFromNote(notePath, content);
  // Coalesced master TOC rebuild — the agent reads it as its first
  // grounding step so it must reflect every write within ~500ms.
  // Avoid recursive rebuild if THIS write is the TOC itself.
  if (notePath !== 'README') {
    // Lazy-require to avoid a static import cycle (toc.ts imports
    // listAllNotes from this file).
    void import('./toc.js').then((m) => m.scheduleTocRebuild()).catch(() => undefined);
  }
  return {
    path: notePath,
    title: titleFromContent(content, baseName),
    content,
    updatedAt: stats.mtime.toISOString(),
  };
}

export async function deleteNote(notePath: string): Promise<boolean> {
  const abs = resolveSafePath(notePath);
  try {
    await rm(abs);
    await pruneSourceMapForNote(notePath);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return false;
    throw err;
  }
}

export async function listTree(): Promise<ObsidianTreeNode[]> {
  await ensureVaultRoot();
  return readDir(vaultRoot());
}

async function readDir(absDir: string): Promise<ObsidianTreeNode[]> {
  const entries = await readdir(absDir, { withFileTypes: true });
  const out: ObsidianTreeNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      const children = await readDir(abs);
      out.push({
        kind: 'folder',
        name: entry.name,
        path: relPath(abs),
        children,
      });
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(NOTE_EXT)) continue;
    const noteName = entry.name.slice(0, -NOTE_EXT.length);
    out.push({
      kind: 'note',
      name: noteName,
      path: relPath(abs),
    });
  }
  // Folders first, then files, both alphabetical — matches Obsidian's
  // default sidebar sort.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'uk');
  });
  return out;
}

// --- Source-map (P2) ---
//
// Reverse lookup table: source-file path → note path. Populated by the
// indexer + by manual note saves (via updateSourceMapFromNote below).
// Persisted to `.od/obsidian-global/.source-map.json` so a daemon
// restart doesn't lose it. Exposed via /note-for-source endpoint and
// the obsidian_note_for_source MCP tool.

const SOURCE_MAP_FILENAME = '.source-map.json';
let sourceMapCache: Record<string, string> | null = null;

function sourceMapPath(): string {
  return path.join(vaultRoot(), SOURCE_MAP_FILENAME);
}

async function loadSourceMap(): Promise<Record<string, string>> {
  if (sourceMapCache) return sourceMapCache;
  try {
    const raw = await readFile(sourceMapPath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    sourceMapCache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, string>
      : {};
  } catch {
    sourceMapCache = {};
  }
  return sourceMapCache;
}

async function saveSourceMap(): Promise<void> {
  if (!sourceMapCache) return;
  try {
    await mkdir(vaultRoot(), { recursive: true });
    await writeFile(sourceMapPath(), JSON.stringify(sourceMapCache, null, 2), 'utf-8');
  } catch {
    // Best-effort.
  }
}

export async function readNotePathForSource(sourceFile: string): Promise<string | null> {
  const map = await loadSourceMap();
  const normalized = sourceFile.replace(/\\/g, '/').replace(/^\.\//, '');
  return map[normalized] ?? null;
}

// Parse a note body for `<!-- sourceFile: X -->` markers and add them
// to the source-map. Called whenever a note is written (manual save
// via UI OR via the indexer agent's Write/Edit).
export async function updateSourceMapFromNote(notePath: string, content: string): Promise<void> {
  const map = await loadSourceMap();
  const re = /<!--\s*sourceFile:\s*([^\s>][^>]*?)\s*-->/g;
  let match: RegExpExecArray | null;
  let changed = false;
  while ((match = re.exec(content)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const src = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (map[src] !== notePath) {
      map[src] = notePath;
      changed = true;
    }
  }
  if (changed) await saveSourceMap();
}

// Drop source-map entries that point to a deleted note. Used by
// deleteNote so orphan map entries don't accumulate.
export async function pruneSourceMapForNote(notePath: string): Promise<void> {
  const map = await loadSourceMap();
  let changed = false;
  for (const [src, target] of Object.entries(map)) {
    if (target === notePath) {
      delete map[src];
      changed = true;
    }
  }
  if (changed) await saveSourceMap();
}

export async function isVaultEmpty(): Promise<boolean> {
  await ensureVaultRoot();
  const entries = await readdir(vaultRoot());
  return entries.filter((e) => !e.startsWith('.')).length === 0;
}

// Walk the whole vault and return every note's path + content. Used by
// the /graph endpoint to extract wikilink edges; cheap-enough for the
// ~10-note hand-written vault and the ~100-note auto-indexed vault we
// expect once Phase D ships. If we ever cross ~10k notes we'll cache
// the parsed graph in SQLite.
export async function listAllNotes(): Promise<ObsidianNoteRecord[]> {
  await ensureVaultRoot();
  const out: ObsidianNoteRecord[] = [];
  await walk(vaultRoot(), out);
  return out;
}

// Lightweight full-text search across the vault. Splits the query
// into tokens, scores notes by keyword frequency in title + content,
// returns top N with a snippet around the first match. Cheap enough
// for the ~hundreds-to-thousands-of-notes scale we target before
// needing a real index (BM25 / embeddings — Phase E2).
export interface SearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

export async function searchNotes(query: string, limit = 10): Promise<SearchHit[]> {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const notes = await listAllNotes();
  const hits: SearchHit[] = [];
  for (const note of notes) {
    const haystack = `${note.title}\n${note.content}`.toLowerCase();
    let score = 0;
    let firstMatchIndex = -1;
    for (const token of tokens) {
      const occurrences = countOccurrences(haystack, token);
      if (occurrences === 0) continue;
      // Title hits weigh extra — same convention as the rest of the
      // codebase's heuristics.
      const titleHits = countOccurrences(note.title.toLowerCase(), token);
      score += occurrences + titleHits * 3;
      if (firstMatchIndex < 0) {
        firstMatchIndex = haystack.indexOf(token);
      }
    }
    if (score > 0) {
      hits.push({
        path: note.path,
        title: note.title,
        score,
        snippet: makeSnippet(note.content, firstMatchIndex),
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) >= 0) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function makeSnippet(content: string, position: number): string {
  if (position < 0) return content.slice(0, 160);
  const start = Math.max(0, position - 60);
  const end = Math.min(content.length, position + 120);
  let snip = content.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snip = '…' + snip;
  if (end < content.length) snip = snip + '…';
  return snip;
}

async function walk(absDir: string, out: ObsidianNoteRecord[]): Promise<void> {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(NOTE_EXT)) continue;
    const content = await readFile(abs, 'utf-8');
    const stats = await stat(abs);
    const notePath = relPath(abs);
    out.push({
      path: notePath,
      title: titleFromContent(content, path.basename(abs, NOTE_EXT)),
      content,
      updatedAt: stats.mtime.toISOString(),
    });
  }
}
