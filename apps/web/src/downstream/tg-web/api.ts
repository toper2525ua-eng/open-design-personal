// TgWeb HTTP client. Talks to the daemon's `/api/tg-web/*` routes
// (registered downstream — see apps/daemon/src/downstream/tg-web/routes.ts).

export type TgWebDeployStatus = 'running' | 'success' | 'failed';

export interface TgWebPersistedConfig {
  repoPath: string;
  designPath: string;
  miniAppUrl: string;
  botToken: string;
  lastDeployedHash?: string;
  lastDeployedAt?: number;
}

export async function fetchTgWebConfig(
  projectId: string,
  fileName: string,
): Promise<TgWebPersistedConfig | null> {
  try {
    const params = new URLSearchParams({ projectId, fileName });
    const resp = await fetch(`/api/tg-web/config?${params.toString()}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { config?: TgWebPersistedConfig | null };
    return json.config ?? null;
  } catch {
    return null;
  }
}

export async function saveTgWebConfig(
  projectId: string,
  fileName: string,
  config: TgWebPersistedConfig,
): Promise<{ ok: true; config: TgWebPersistedConfig } | { ok: false; error: string }> {
  try {
    const resp = await fetch('/api/tg-web/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, fileName, config }),
    });
    const json = (await resp.json()) as {
      ok?: boolean;
      config?: TgWebPersistedConfig;
      error?: string;
    };
    if (!resp.ok || !json.ok || !json.config) {
      return { ok: false, error: json.error ?? `HTTP ${resp.status}` };
    }
    return { ok: true, config: json.config };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export interface TgWebDeployStartRequest {
  projectId: string;
  fileName: string;
  repoPath: string;
  designPath: string;
  sourceHtml: string;
  commitMessage?: string;
}

export interface TgWebDeployRecord {
  deployId: string;
  status: TgWebDeployStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  logTail?: string;
}

export async function startTgWebDeploy(
  payload: TgWebDeployStartRequest,
): Promise<{ ok: true; deployId: string } | { ok: false; error: string }> {
  try {
    const resp = await fetch('/api/tg-web/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await resp.json()) as { deployId?: string; error?: string };
    if (!resp.ok || !json.deployId) {
      return { ok: false, error: json.error ?? `HTTP ${resp.status}` };
    }
    return { ok: true, deployId: json.deployId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function fetchTgWebDeploy(deployId: string): Promise<TgWebDeployRecord | null> {
  try {
    const resp = await fetch(`/api/tg-web/deploy/${encodeURIComponent(deployId)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as TgWebDeployRecord;
  } catch {
    return null;
  }
}

export async function fetchTgWebDeploys(
  projectId: string,
  fileName: string,
): Promise<TgWebDeployRecord[]> {
  try {
    const params = new URLSearchParams({ projectId, fileName });
    const resp = await fetch(`/api/tg-web/deploys?${params.toString()}`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { deploys?: TgWebDeployRecord[] };
    return Array.isArray(json.deploys) ? json.deploys : [];
  } catch {
    return [];
  }
}

export async function cancelTgWebDeploy(deployId: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/tg-web/deploy/${encodeURIComponent(deployId)}/cancel`, {
      method: 'POST',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function openTgWebFolderInExplorer(
  initial?: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    const resp = await fetch('/api/tg-web/open-explorer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initial: initial ?? null }),
    });
    const json = (await resp.json()) as { ok?: boolean; error?: string };
    if (!resp.ok) return { error: json.error ?? `HTTP ${resp.status}` };
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}
