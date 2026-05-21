// HTTP routes for the global Obsidian knowledge base.
//
// All endpoints are namespaced under `/api/downstream/obsidian/global/`.
// The trailing `/global/` segment leaves room for a future
// `/api/downstream/obsidian/projects/<id>/` family for per-project
// vaults (Phase E) without re-shaping the URL space.
//
// Note paths on the wire are vault-relative POSIX strings without the
// `.md` extension (e.g. `Архітектура/apps-web`). storage.ts validates
// every path against the vault root — `..` segments are rejected.
//
// Seeding: the first request to `/tree` (or any handler that touches
// the vault) lazily seeds the 10 starter notes if the folder is empty.
// This means the vault always has content for new users without
// requiring an explicit "init" step.

import type { Express, Request, Response } from 'express';

import {
  deleteNote,
  listAllNotes,
  listTree,
  readNote,
  writeNote,
  type ObsidianNoteRecord,
} from './storage.js';
import { seedVaultIfEmpty } from './seed.js';

const ROUTE_PREFIX = '/api/downstream/obsidian/global';

// Re-entrant lazy seed. Called by every handler; the underlying check is
// a cheap readdir + length comparison so it's safe to call freely.
let seedPromise: Promise<void> | null = null;
async function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      try {
        await seedVaultIfEmpty();
      } catch (err) {
        // If seeding fails (read-only fs, etc.) we reset so a later
        // request can retry — never poison the cached promise.
        seedPromise = null;
        throw err;
      }
    })();
  }
  return seedPromise;
}

function sendOutOfBounds(res: Response, err: unknown): boolean {
  if (
    err instanceof Error &&
    (err as Error & { code?: string }).code === 'VAULT_OUT_OF_BOUNDS'
  ) {
    res.status(400).json({ error: 'out_of_bounds', detail: err.message });
    return true;
  }
  return false;
}

function sendError(res: Response, err: unknown): void {
  if (sendOutOfBounds(res, err)) return;
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[obsidian] route error:', msg);
  res.status(500).json({ error: 'internal', detail: msg });
}

function getPathParam(req: Request, res: Response): string | null {
  const raw = req.query.path;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    res.status(400).json({ error: 'missing_path' });
    return null;
  }
  return raw;
}

export function registerObsidianRoutes(app: Express): void {
  // List the full vault tree (folders + notes, sorted alphabetically,
  // folders first). Lazily seeds on first call.
  app.get(`${ROUTE_PREFIX}/tree`, async (_req, res) => {
    try {
      await ensureSeeded();
      const tree = await listTree();
      res.json({ tree });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Precomputed graph: nodes (one per note) and undirected edges (one
  // per resolved wikilink, deduped). Saves the UI from doing N parallel
  // fetches just to parse `[[name]]` references out of every body.
  app.get(`${ROUTE_PREFIX}/graph`, async (_req, res) => {
    try {
      await ensureSeeded();
      const notes = await listAllNotes();
      res.json(buildGraph(notes));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Read a single note by vault-relative path (no `.md` extension).
  // 404 if missing; 400 if path is invalid.
  app.get(`${ROUTE_PREFIX}/note`, async (req, res) => {
    const notePath = getPathParam(req, res);
    if (notePath === null) return;
    try {
      await ensureSeeded();
      const note = await readNote(notePath);
      if (!note) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ note });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Create-or-update a note. Body is JSON { content: string }; path
  // comes from the query string for symmetry with GET/DELETE. JSON
  // (rather than raw text) keeps us inside the express.json middleware
  // the daemon already mounts globally — no extra body parser needed.
  app.put(`${ROUTE_PREFIX}/note`, async (req, res) => {
    const notePath = getPathParam(req, res);
    if (notePath === null) return;
    const body = (req.body ?? {}) as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content : '';
    try {
      await ensureSeeded();
      const note = await writeNote(notePath, content);
      res.json({ note });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Create a new note from a JSON body { path, content }. Fails if the
  // file already exists — use PUT for upsert.
  app.post(`${ROUTE_PREFIX}/note`, async (req, res) => {
    const body = (req.body ?? {}) as { path?: unknown; content?: unknown };
    const notePath = typeof body.path === 'string' ? body.path : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (!notePath.trim()) {
      res.status(400).json({ error: 'missing_path' });
      return;
    }
    try {
      await ensureSeeded();
      const existing = await readNote(notePath);
      if (existing) {
        res.status(409).json({ error: 'already_exists' });
        return;
      }
      const note = await writeNote(notePath, content);
      res.status(201).json({ note });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Delete a note. 204 on success, 404 if it didn't exist.
  app.delete(`${ROUTE_PREFIX}/note`, async (req, res) => {
    const notePath = getPathParam(req, res);
    if (notePath === null) return;
    try {
      await ensureSeeded();
      const removed = await deleteNote(notePath);
      if (!removed) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });
}

interface GraphResponse {
  nodes: { id: string; label: string; degree: number }[];
  edges: { source: string; target: string }[];
}

// Resolve a wikilink target (e.g. `apps-web` or `apps/web`) against the
// list of known notes. Same semantics as the UI's resolveWikilink so
// the rendered links match the graph edges.
function resolveWikilink(name: string, byPath: Set<string>): string | null {
  const target = name.trim();
  if (!target) return null;
  if (byPath.has(target)) return target;
  const lowered = target.toLowerCase();
  for (const candidate of byPath) {
    const last = candidate.split('/').pop() ?? candidate;
    if (last.toLowerCase() === lowered) return candidate;
  }
  return null;
}

function buildGraph(notes: ObsidianNoteRecord[]): GraphResponse {
  const byPath = new Set(notes.map((n) => n.path));
  const nodes = notes.map((n) => ({ id: n.path, label: n.title, degree: 0 }));
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
  const edgeKeys = new Set<string>();
  const edges: GraphResponse['edges'] = [];
  const linkRe = /\[\[([^\]]+)\]\]/g;
  for (const note of notes) {
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(note.content)) !== null) {
      const name = match[1];
      if (!name) continue;
      const resolved = resolveWikilink(name, byPath);
      if (!resolved || resolved === note.path) continue;
      const a = note.path < resolved ? note.path : resolved;
      const b = note.path < resolved ? resolved : note.path;
      const key = `${a} ${b}`;
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
