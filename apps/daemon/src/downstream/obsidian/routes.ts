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
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  attachmentsRoot,
  deleteNote,
  ensureAttachmentsRoot,
  listAllNotes,
  listTree,
  readNote,
  readNotePathForSource,
  searchNotes,
  writeNote,
  type ObsidianNoteRecord,
} from './storage.js';
import { seedVaultIfEmpty } from './seed.js';
import {
  appendUserMessage,
  createConversation,
  deleteConversation,
  listConversations,
  readConversation,
  streamAssistantReply,
} from './chat.js';
import {
  getProgress as getIndexerProgress,
  pause as pauseIndexer,
  reset as resetIndexer,
  resume as resumeIndexer,
  start as startIndexer,
  subscribe as subscribeIndexer,
  type IndexerEvent,
} from './indexer.js';

const ROUTE_PREFIX = '/api/downstream/obsidian/global';

// Multer instance scoped to obsidian-chat attachments. Each upload is
// renamed `<uuid>-<safeName>` so two files with the same name don't
// collide. 25 MB cap covers screenshots + small docs comfortably; we
// reject anything bigger so a misclick on a video doesn't fill `.od/`.
const SAFE_NAME_RE = /[^a-zA-Z0-9._-]+/g;
function safeFileName(name: string): string {
  const trimmed = name.normalize('NFKC').replace(SAFE_NAME_RE, '_').slice(-180);
  return trimmed.length > 0 ? trimmed : 'file';
}

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        mkdirSync(attachmentsRoot(), { recursive: true });
        cb(null, attachmentsRoot());
      } catch (err) {
        cb(err as Error, attachmentsRoot());
      }
    },
    filename: (_req, file, cb) => {
      cb(null, `${randomUUID()}-${safeFileName(file.originalname)}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

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

  // Full-text search across vault. Backs the obsidian_search MCP tool
  // and any future in-UI search field. Returns ranked hits with
  // snippets so callers don't need to read every match.
  app.get(`${ROUTE_PREFIX}/search`, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 10;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10;
    if (!q.trim()) {
      res.status(400).json({ error: 'missing_q' });
      return;
    }
    try {
      await ensureSeeded();
      const hits = await searchNotes(q, limit);
      res.json({ hits });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Reverse lookup: which note (if any) was created for a given
  // source file. Reads the .source-map.json the indexer maintains.
  app.get(`${ROUTE_PREFIX}/note-for-source`, async (req, res) => {
    const file = typeof req.query.file === 'string' ? req.query.file : '';
    if (!file.trim()) {
      res.status(400).json({ error: 'missing_file' });
      return;
    }
    try {
      const notePath = await readNotePathForSource(file);
      res.json({ notePath });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Backlinks: which notes contain a wikilink that resolves to the
  // given path. Helps "what links here" navigation.
  app.get(`${ROUTE_PREFIX}/backlinks`, async (req, res) => {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).json({ error: 'missing_path' });
      return;
    }
    try {
      await ensureSeeded();
      const notes = await listAllNotes();
      const targetBase = target.split('/').pop()?.toLowerCase() ?? '';
      const out: { path: string; title: string }[] = [];
      const re = /\[\[([^\]]+)\]\]/g;
      for (const note of notes) {
        if (note.path === target) continue;
        let match: RegExpExecArray | null;
        let hit = false;
        while ((match = re.exec(note.content)) !== null) {
          const name = (match[1] ?? '').trim();
          if (!name) continue;
          if (name === target || name.toLowerCase() === targetBase) {
            hit = true;
            break;
          }
        }
        re.lastIndex = 0;
        if (hit) out.push({ path: note.path, title: note.title });
      }
      res.json({ backlinks: out });
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

  // --- Chat ---

  app.get(`${ROUTE_PREFIX}/chat/conversations`, async (_req, res) => {
    try {
      const conversations = await listConversations();
      res.json({ conversations });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post(`${ROUTE_PREFIX}/chat/conversations`, async (req, res) => {
    const body = (req.body ?? {}) as { title?: unknown };
    const title = typeof body.title === 'string' ? body.title : '';
    try {
      const conv = await createConversation(title);
      res.status(201).json({ conversation: conv });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get(`${ROUTE_PREFIX}/chat/conversations/:id`, async (req, res) => {
    try {
      const conv = await readConversation(req.params.id);
      if (!conv) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ conversation: conv });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete(`${ROUTE_PREFIX}/chat/conversations/:id`, async (req, res) => {
    try {
      const removed = await deleteConversation(req.params.id);
      if (!removed) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });

  // Upload chat attachments (paste/drop/file-picker from the composer).
  // Saves to `.od/obsidian-global/.attachments/<uuid>-<name>` and
  // returns the vault-relative path so the chat layer can paste it
  // into the next user message. Multer field name is `files` for
  // symmetry with the project upload endpoint.
  app.post(
    `${ROUTE_PREFIX}/chat/upload`,
    attachmentUpload.array('files', 8),
    async (req, res) => {
      try {
        await ensureAttachmentsRoot();
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        const root = attachmentsRoot();
        const out = files.map((f) => ({
          name: f.originalname,
          // path relative to the vault root so the agent can Read it
          // with `.od/obsidian-global/.attachments/...` directly.
          path: path
            .join('.attachments', path.relative(root, f.path))
            .split(path.sep)
            .join('/'),
          size: f.size,
          mimeType: f.mimetype,
        }));
        res.json({ files: out });
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // --- Indexer ---

  app.get(`${ROUTE_PREFIX}/indexer/status`, (_req, res) => {
    res.json({ progress: getIndexerProgress() });
  });

  app.post(`${ROUTE_PREFIX}/indexer/start`, async (_req, res) => {
    try {
      await startIndexer(process.cwd());
      res.json({ progress: getIndexerProgress() });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post(`${ROUTE_PREFIX}/indexer/pause`, (_req, res) => {
    pauseIndexer();
    res.json({ progress: getIndexerProgress() });
  });

  app.post(`${ROUTE_PREFIX}/indexer/resume`, (_req, res) => {
    resumeIndexer(process.cwd());
    res.json({ progress: getIndexerProgress() });
  });

  app.post(`${ROUTE_PREFIX}/indexer/reset`, (_req, res) => {
    resetIndexer();
    res.json({ progress: getIndexerProgress() });
  });

  // Long-poll SSE stream for live indexer events (state transitions,
  // per-file start/done/skip/error, note writes). The UI subscribes
  // here to refresh the coverage bar + live-update the graph view.
  app.get(`${ROUTE_PREFIX}/indexer/events`, (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();
    let alive = true;
    const cleanup = () => {
      if (!alive) return;
      alive = false;
      clearInterval(heartbeat);
      try { unsubscribe(); } catch { /* idempotent */ }
    };
    // Prime the stream with the current state so a freshly-connected
    // client immediately renders the right values, even mid-run. If
    // the write throws (client already closed), trip cleanup so the
    // listener doesn't leak into the global Set, broadcasting to a
    // dead socket forever.
    const writeEvent = (event: IndexerEvent) => {
      if (!alive) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        cleanup();
      }
    };
    writeEvent({ kind: 'state', progress: getIndexerProgress() });
    const unsubscribe = subscribeIndexer(writeEvent);
    // Heartbeat every 25s — some proxies time out idle SSE
    // connections, and we want the client to detect the death fast.
    const heartbeat = setInterval(() => {
      if (!alive) return;
      try { res.write(': heartbeat\n\n'); } catch { cleanup(); }
    }, 25_000);
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  // Send a user message and stream the assistant's reply back as SSE.
  // Body: { content: string }. Caller must keep the connection open
  // until the 'done' event arrives.
  app.post(`${ROUTE_PREFIX}/chat/conversations/:id/messages`, async (req, res) => {
    const body = (req.body ?? {}) as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) {
      res.status(400).json({ error: 'empty_content' });
      return;
    }
    try {
      const appended = await appendUserMessage(req.params.id, content);
      if (!appended) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.flushHeaders?.();
      const writeEvent = (event: unknown) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      writeEvent({ kind: 'user-message-saved', message: appended.message });
      let clientClosed = false;
      req.on('close', () => { clientClosed = true; });
      const repoRoot = process.cwd();
      for await (const event of streamAssistantReply(appended.conv, repoRoot)) {
        if (clientClosed) break;
        writeEvent(event);
      }
      res.end();
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
