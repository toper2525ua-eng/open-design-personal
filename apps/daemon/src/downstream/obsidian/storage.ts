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

export async function ensureVaultRoot(): Promise<string> {
  const root = vaultRoot();
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
