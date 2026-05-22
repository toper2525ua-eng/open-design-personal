// Thin fetch wrappers around the daemon's `/api/downstream/obsidian/
// global/*` endpoints. UI components import these instead of touching
// fetch directly so request shapes stay in one place and we can add
// caching, retries, or replace transports later without touching
// callers.
//
// All paths on the wire are vault-relative POSIX strings WITHOUT the
// `.md` extension (e.g. `Архітектура/apps-web`). Path encoding goes
// through encodeURIComponent because notes contain `/` segments and
// Ukrainian characters.

export type ObsidianTreeNode =
  | { kind: 'folder'; name: string; path: string; children: ObsidianTreeNode[] }
  | { kind: 'note'; name: string; path: string };

export interface ObsidianNote {
  path: string;
  title: string;
  content: string;
  updatedAt: string;
}

export interface ObsidianGraphPayload {
  nodes: { id: string; label: string; degree: number }[];
  edges: { source: string; target: string }[];
}

const BASE = '/api/downstream/obsidian/global';

function encodePath(notePath: string): string {
  // Encode each segment separately so `/` stays as a path delimiter on
  // the wire (some downstream debugging tools choke on encoded slashes
  // even though the express router accepts them).
  return notePath.split('/').map(encodeURIComponent).join('/');
}

async function jsonOrThrow<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let detail: string;
    try {
      const body = (await resp.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? `HTTP ${resp.status}`;
    } catch {
      detail = `HTTP ${resp.status}`;
    }
    throw new Error(`obsidian API: ${detail}`);
  }
  return (await resp.json()) as T;
}

export async function fetchTree(): Promise<ObsidianTreeNode[]> {
  const resp = await fetch(`${BASE}/tree`);
  const data = await jsonOrThrow<{ tree: ObsidianTreeNode[] }>(resp);
  return data.tree;
}

export async function fetchNote(notePath: string): Promise<ObsidianNote | null> {
  const resp = await fetch(`${BASE}/note?path=${encodePath(notePath)}`);
  if (resp.status === 404) return null;
  const data = await jsonOrThrow<{ note: ObsidianNote }>(resp);
  return data.note;
}

export async function fetchGraph(): Promise<ObsidianGraphPayload> {
  const resp = await fetch(`${BASE}/graph`);
  return jsonOrThrow<ObsidianGraphPayload>(resp);
}

export async function saveNote(notePath: string, content: string): Promise<ObsidianNote> {
  const resp = await fetch(`${BASE}/note?path=${encodePath(notePath)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const data = await jsonOrThrow<{ note: ObsidianNote }>(resp);
  return data.note;
}

export async function createNote(notePath: string, content: string): Promise<ObsidianNote> {
  const resp = await fetch(`${BASE}/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: notePath, content }),
  });
  const data = await jsonOrThrow<{ note: ObsidianNote }>(resp);
  return data.note;
}

export async function deleteNote(notePath: string): Promise<void> {
  const resp = await fetch(`${BASE}/note?path=${encodePath(notePath)}`, {
    method: 'DELETE',
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`obsidian API: delete failed HTTP ${resp.status}`);
  }
}

// --- Chat ---

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  // Set only on persisted assistant messages — used by the chat UI to
  // render the "Готово · 25с · 632 токени" footer.
  elapsedMs?: number;
  outputTokens?: number;
  inputTokens?: number;
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export async function fetchConversations(): Promise<ChatConversationSummary[]> {
  const resp = await fetch(`${BASE}/chat/conversations`);
  const data = await jsonOrThrow<{ conversations: ChatConversationSummary[] }>(resp);
  return data.conversations;
}

export async function fetchConversation(id: string): Promise<ChatConversation | null> {
  const resp = await fetch(`${BASE}/chat/conversations/${encodeURIComponent(id)}`);
  if (resp.status === 404) return null;
  const data = await jsonOrThrow<{ conversation: ChatConversation }>(resp);
  return data.conversation;
}

export async function createConversation(title = ''): Promise<ChatConversation> {
  const resp = await fetch(`${BASE}/chat/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await jsonOrThrow<{ conversation: ChatConversation }>(resp);
  return data.conversation;
}

export async function deleteConversation(id: string): Promise<void> {
  const resp = await fetch(`${BASE}/chat/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`obsidian API: delete conversation HTTP ${resp.status}`);
  }
}

// One streamed event from the agent reply. Shapes mirror chat.ts on
// the daemon side.
export type ChatStreamEvent =
  | { kind: 'user-message-saved'; message: ChatMessage }
  | { kind: 'text-delta'; text: string }
  | { kind: 'tool-use'; toolName: string; toolInput?: unknown }
  | { kind: 'tool-result'; toolResult?: unknown }
  | { kind: 'usage'; outputTokens?: number; inputTokens?: number }
  | { kind: 'done'; detail?: string; elapsedMs?: number; outputTokens?: number; inputTokens?: number }
  | { kind: 'error'; detail?: string };

// Send a message and stream the agent's reply. Calls onEvent for each
// SSE frame; resolves when the stream ends. abortSignal stops mid-flight.
export async function streamMessage(
  conversationId: string,
  content: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(
    `${BASE}/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal,
    },
  );
  if (!resp.ok || !resp.body) {
    throw new Error(`obsidian API: stream HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by blank lines. Each frame may contain
    // multiple `data:` lines but we always emit single-line payloads.
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const payload = parseSseFrame(frame);
      if (payload !== null) onEvent(payload);
    }
  }
  // Flush any trailing frame.
  if (buffer.trim().length > 0) {
    const payload = parseSseFrame(buffer);
    if (payload !== null) onEvent(payload);
  }
}

export interface ChatAttachment {
  name: string;
  path: string;
  size: number;
  mimeType?: string;
}

export async function uploadAttachments(files: File[]): Promise<ChatAttachment[]> {
  if (files.length === 0) return [];
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const resp = await fetch(`${BASE}/chat/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await jsonOrThrow<{ files: ChatAttachment[] }>(resp);
  return data.files;
}

// --- Indexer ---

export type IndexerStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';
export type IndexerTier = 1 | 2 | 3;

export interface IndexerTierProgress {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
}

export interface IndexerProgress {
  status: IndexerStatus;
  currentTier: IndexerTier;
  tier: Record<IndexerTier, IndexerTierProgress>;
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
  | { kind: 'tier-start'; tier: IndexerTier; total: number }
  | { kind: 'tier-done'; tier: IndexerTier }
  | { kind: 'file-start'; file: string; tier: IndexerTier }
  | { kind: 'file-done'; file: string; tier: IndexerTier; notePath?: string }
  | { kind: 'file-skip'; file: string; tier: IndexerTier; reason: string }
  | { kind: 'file-error'; file: string; tier: IndexerTier; detail: string }
  | { kind: 'note-written'; notePath: string; tier: IndexerTier }
  | { kind: 'finished'; progress: IndexerProgress };

export async function fetchIndexerStatus(): Promise<IndexerProgress> {
  const resp = await fetch(`${BASE}/indexer/status`);
  const data = await jsonOrThrow<{ progress: IndexerProgress }>(resp);
  return data.progress;
}

export async function controlIndexer(
  action: 'start' | 'pause' | 'resume' | 'reset',
): Promise<IndexerProgress> {
  const resp = await fetch(`${BASE}/indexer/${action}`, { method: 'POST' });
  const data = await jsonOrThrow<{ progress: IndexerProgress }>(resp);
  return data.progress;
}

// Per-spawn model selection. Defaults to 'sonnet' (cheaper than opus
// by ~5× for the classify+short-note workload). User flips via the
// coverage-bar dropdown; the choice persists across daemon restarts in
// .indexer-config.json.
export type IndexerModel = 'sonnet' | 'opus';
export interface IndexerConfig { model: IndexerModel }

export async function fetchIndexerConfig(): Promise<IndexerConfig> {
  const resp = await fetch(`${BASE}/indexer/config`);
  const data = await jsonOrThrow<{ config: IndexerConfig }>(resp);
  return data.config;
}

export async function updateIndexerModel(model: IndexerModel): Promise<IndexerConfig> {
  const resp = await fetch(`${BASE}/indexer/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const data = await jsonOrThrow<{ config: IndexerConfig }>(resp);
  return data.config;
}

// Open a long-lived SSE stream for indexer events. Returns a cleanup
// function that closes the connection. Reconnects are caller's
// responsibility (or just remount the component).
export function subscribeIndexer(onEvent: (event: IndexerEvent) => void): () => void {
  const source = new EventSource(`${BASE}/indexer/events`);
  source.onmessage = (e) => {
    try {
      const parsed = JSON.parse(e.data) as IndexerEvent;
      onEvent(parsed);
    } catch {
      // Ignore malformed frames.
    }
  };
  // Errors auto-reconnect by EventSource; we surface nothing for now.
  return () => source.close();
}

function parseSseFrame(frame: string): ChatStreamEvent | null {
  const lines = frame.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6)) as ChatStreamEvent;
      } catch {
        return null;
      }
    }
  }
  return null;
}
