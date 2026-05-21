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
