// Stdio MCP server that exposes the Obsidian knowledge base to ANY
// Claude Code session (or compatible MCP client — Cursor, Zed, etc.).
//
// Tools exposed:
//   obsidian_search          — full-text ranked search
//   obsidian_read            — read a single note by path
//   obsidian_list_categories — list top-level folders + note counts
//   obsidian_backlinks       — who links to a given note
//   obsidian_note_for_source — reverse lookup: source file → note
//   obsidian_indexer_status  — coverage + tier progress
//
// Connects to the running daemon's HTTP API via the resolved daemon URL
// (CLI flag → $OD_DAEMON_URL → IPC discovery → default
// http://127.0.0.1:7456) so it's stateless and reuses every existing
// route. Spawn with no daemon running and tool calls return a clear
// "daemon not reachable" error — the server itself still launches so
// the client can introspect tool schema.
//
// Wired into the `od` CLI as `od mcp obsidian`. Outer Claude Code
// (Cursor / Zed / etc.) MCP config entry:
//   {
//     "mcpServers": {
//       "obsidian": {
//         "command": "od",
//         "args": ["mcp", "obsidian"]
//       }
//     }
//   }
// Restart the MCP client after a daemon restart to pick up a new port.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'obsidian-knowledge';
const SERVER_VERSION = '0.1.0';

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOL_DEFS = [
  {
    name: 'obsidian_search',
    description: 'Full-text ranked search across the Open Design Obsidian knowledge base. Returns top hits with title, path, snippet. Prefer this over reading individual notes when you don\'t know where the topic lives.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (Ukrainian or English). Multiple words narrow the match.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Search Obsidian knowledge base' },
  },
  {
    name: 'obsidian_read',
    description: 'Read one note by vault-relative path (without `.md` extension), e.g. `Архітектура/apps-web`.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path, no extension.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Read Obsidian note' },
  },
  {
    name: 'obsidian_list_categories',
    description: 'List the top-level folders (categories) in the vault with note counts. Useful as a discovery first step.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'List Obsidian categories' },
  },
  {
    name: 'obsidian_backlinks',
    description: 'Find notes that link (via `[[wikilink]]`) to the given note path. Use to expand context around a topic.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path the backlinks target.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Find Obsidian backlinks' },
  },
  {
    name: 'obsidian_note_for_source',
    description: 'Reverse lookup: given a source-code file path (e.g. `apps/web/src/X.tsx`), find the note that describes it. Returns null if no note exists yet.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Source-file path relative to the repo root.' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Find note for source file' },
  },
  {
    name: 'obsidian_indexer_status',
    description: 'Coverage and progress of the background indexer. Use to know how much of the codebase has been digested before deciding whether to trust the knowledge base.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'Indexer status' },
  },
] as const;

function defaultDaemonUrl(): string {
  return (process.env.OD_DAEMON_URL || 'http://127.0.0.1:7456').replace(/\/$/, '');
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${url}`);
  }
  return (await resp.json()) as T;
}

function textResult(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(detail: string): { content: [{ type: 'text'; text: string }]; isError: true } {
  return {
    content: [{ type: 'text', text: detail }],
    isError: true,
  };
}

export interface ObsidianMcpStdioOptions {
  /** Resolved daemon HTTP base URL, e.g. `http://127.0.0.1:7456`. */
  daemonUrl?: string;
}

export async function runObsidianMcpStdio(options: ObsidianMcpStdioOptions = {}): Promise<void> {
  const baseUrl = (options.daemonUrl && options.daemonUrl.length > 0
    ? options.daemonUrl
    : defaultDaemonUrl()).replace(/\/$/, '');
  const apiBase = `${baseUrl}/api/downstream/obsidian/global`;

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        'Open Design Obsidian — local Markdown knowledge base maintained by a',
        'background indexer that reads the repo and writes per-file/per-module',
        'notes under `.od/obsidian-global/`. Use these tools BEFORE searching',
        'the codebase directly: a `obsidian_search` round-trip is much cheaper',
        'than a Grep+Read cycle, and the notes were written with structured',
        'wikilinks so one search often pulls a small graph of related context.',
        '',
        'Recommended flow:',
        '  1. obsidian_search("topic") → top notes with snippets.',
        '  2. obsidian_read(path) on the most relevant hit.',
        '  3. obsidian_backlinks(path) to widen the context if needed.',
        '  4. Fall back to a direct repo grep ONLY if the knowledge base',
        '     genuinely doesn\'t cover the topic (check obsidian_indexer_status).',
        '',
        'Notes are Ukrainian by convention. Tool names and outputs stay English.',
      ].join('\n'),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS as unknown as Array<{ name: string; description: string; inputSchema: unknown; annotations?: unknown }>,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params?.name;
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === 'obsidian_search') {
        const query = typeof args.query === 'string' ? args.query : '';
        const limit = typeof args.limit === 'number' ? args.limit : 10;
        if (!query.trim()) return errorResult('query is required');
        const url = `${apiBase}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        const data = await getJson<{ hits: Array<{ path: string; title: string; score: number; snippet: string }> }>(url);
        if (!data.hits.length) return textResult(`No hits for "${query}".`);
        return textResult(data.hits);
      }
      if (name === 'obsidian_read') {
        const path = typeof args.path === 'string' ? args.path : '';
        if (!path.trim()) return errorResult('path is required');
        const url = `${apiBase}/note?path=${encodeURIComponent(path)}`;
        const resp = await fetch(url);
        if (resp.status === 404) return errorResult(`Note not found: ${path}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { note: { content: string; title: string; updatedAt: string } };
        return textResult(`# ${data.note.title}\n\n_Updated: ${data.note.updatedAt}_\n\n${data.note.content}`);
      }
      if (name === 'obsidian_list_categories') {
        const data = await getJson<{ tree: Array<{ kind: string; name: string; children?: Array<unknown> }> }>(`${apiBase}/tree`);
        const categories = data.tree
          .filter((n) => n.kind === 'folder')
          .map((n) => ({ name: n.name, noteCount: (n.children ?? []).length }));
        return textResult({ categories, rootNotes: data.tree.filter((n) => n.kind === 'note').length });
      }
      if (name === 'obsidian_backlinks') {
        const path = typeof args.path === 'string' ? args.path : '';
        if (!path.trim()) return errorResult('path is required');
        const data = await getJson<{ backlinks: Array<{ path: string; title: string }> }>(
          `${apiBase}/backlinks?path=${encodeURIComponent(path)}`,
        );
        if (!data.backlinks.length) return textResult(`No notes link to ${path}.`);
        return textResult(data.backlinks);
      }
      if (name === 'obsidian_note_for_source') {
        const file = typeof args.file === 'string' ? args.file : '';
        if (!file.trim()) return errorResult('file is required');
        const data = await getJson<{ notePath: string | null }>(
          `${apiBase}/note-for-source?file=${encodeURIComponent(file)}`,
        );
        if (!data.notePath) return textResult(`No note maps to ${file}.`);
        return textResult({ notePath: data.notePath });
      }
      if (name === 'obsidian_indexer_status') {
        const data = await getJson<{ progress: unknown }>(`${apiBase}/indexer/status`);
        return textResult(data.progress);
      }
      return errorResult(`Unknown tool: ${String(name)}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return errorResult(`Tool ${String(name)} failed: ${detail}\n\nDaemon URL: ${baseUrl}\nMake sure the Open Design daemon is running and OD_DAEMON_URL points at it.`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // server.connect() only *starts* the stdio transport; it resolves
  // once the reader is wired up, not when the stream closes. Without
  // this hold the caller's `process.exit(0)` would kill the MCP
  // server immediately after handshake. Mirror the same shape the
  // sibling `od mcp` server uses.
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    transport.onclose = done;
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
}
