// Coverage bar — sits at the top of the chat pane and shows how much
// of the project the indexer has crawled. Click the status chip to
// open Start/Pause/Resume/Reset controls.
//
// State is sourced live via an EventSource subscription. On mount we
// also fetch the snapshot so a freshly-loaded UI doesn't show "idle"
// for a tick before the first SSE frame arrives.

import { useCallback, useEffect, useState } from 'react';

import { Icon } from '../../components/Icon';
import {
  controlIndexer,
  fetchIndexerStatus,
  subscribeIndexer,
  type IndexerEvent,
  type IndexerProgress,
  type IndexerStatus,
  type IndexerTier,
} from './api';

const EMPTY_TIER = { total: 0, completed: 0, skipped: 0, failed: 0 };

const EMPTY: IndexerProgress = {
  status: 'idle',
  currentTier: 1,
  tier: {
    1: { ...EMPTY_TIER },
    2: { ...EMPTY_TIER },
    3: { ...EMPTY_TIER },
  },
  total: 0,
  completed: 0,
  skipped: 0,
  failed: 0,
  currentFile: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

// Backfill missing fields so the component survives an older daemon
// build that doesn't yet emit `tier`/`currentTier` (pre-3-tier shape),
// or any partially-populated response. Avoids a runtime crash while we
// wait for the daemon process to be restarted with the new dist.
function normalizeProgress(raw: Partial<IndexerProgress> | null | undefined): IndexerProgress {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const rawTier = (raw.tier ?? {}) as Partial<Record<IndexerTier, Partial<typeof EMPTY_TIER>>>;
  const currentTier: IndexerTier =
    raw.currentTier === 2 || raw.currentTier === 3 ? raw.currentTier : 1;
  return {
    status: raw.status ?? 'idle',
    currentTier,
    tier: {
      1: { ...EMPTY_TIER, ...(rawTier[1] ?? {}) },
      2: { ...EMPTY_TIER, ...(rawTier[2] ?? {}) },
      3: { ...EMPTY_TIER, ...(rawTier[3] ?? {}) },
    },
    total: raw.total ?? 0,
    completed: raw.completed ?? 0,
    skipped: raw.skipped ?? 0,
    failed: raw.failed ?? 0,
    currentFile: raw.currentFile ?? null,
    startedAt: raw.startedAt ?? null,
    finishedAt: raw.finishedAt ?? null,
    lastError: raw.lastError ?? null,
  };
}

export function ObsidianCoverageBar() {
  const [progress, setProgress] = useState<IndexerProgress>(EMPTY);
  const [working, setWorking] = useState<'start' | 'pause' | 'resume' | 'reset' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await fetchIndexerStatus();
        if (!cancelled) setProgress(normalizeProgress(snap));
      } catch {
        // Ignore; SSE will populate.
      }
    })();
    const off = subscribeIndexer((event: IndexerEvent) => {
      if (event.kind === 'state' || event.kind === 'finished') {
        setProgress(normalizeProgress(event.progress));
      }
    });
    return () => { cancelled = true; off(); };
  }, []);

  // Auto-dismiss an action error after a few seconds so a transient
  // failure (e.g. a stale daemon process serving 404 until restart)
  // doesn't permanently camp on the coverage bar.
  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(t);
  }, [actionError]);

  const handle = useCallback(
    async (action: 'start' | 'pause' | 'resume' | 'reset') => {
      setWorking(action);
      setActionError(null);
      try {
        const next = await controlIndexer(action);
        setProgress(normalizeProgress(next));
      } catch (err) {
        // Don't propagate to the Next.js error overlay: a 404 here
        // usually means the daemon process is older than the web
        // bundle and hasn't been restarted yet. Show inline instead.
        const detail = err instanceof Error ? err.message : String(err);
        setActionError(`Дія "${action}" не вдалася: ${detail}. Перезапусти daemon (pnpm tools-dev restart daemon).`);
      } finally {
        setWorking(null);
      }
    },
    [],
  );

  const handled = progress.completed + progress.skipped + progress.failed;
  const percent = progress.total > 0
    ? Math.min(100, Math.round((handled / progress.total) * 100))
    : 0;
  const tierProgress = progress.tier[progress.currentTier] ?? EMPTY_TIER;
  const tierHandled = tierProgress.completed + tierProgress.skipped + tierProgress.failed;

  return (
    <div className={`obsidian-coverage obsidian-coverage--${progress.status}`} role="status">
      <div className="obsidian-coverage__row">
        <span className={`obsidian-coverage__dot obsidian-coverage__dot--${progress.status}`} aria-hidden />
        <span className="obsidian-coverage__label">
          {statusLabel(progress.status)}
          {progress.status !== 'idle' ? (
            <>
              {' · '}
              <span className="obsidian-coverage__tier">
                Тіер {progress.currentTier}/3
              </span>
              {' · '}
              <span className="obsidian-coverage__count">
                {tierHandled}/{tierProgress.total || '?'}
              </span>
              {progress.total > 0 ? (
                <>
                  {' · загалом '}
                  <span className="obsidian-coverage__percent">{percent}% ({handled}/{progress.total})</span>
                </>
              ) : null}
            </>
          ) : null}
          {progress.currentFile ? (
            <span className="obsidian-coverage__current" title={progress.currentFile}>
              {' · '}{shortPath(progress.currentFile)}
            </span>
          ) : null}
        </span>
        <div className="obsidian-coverage__actions">
          {progress.status === 'idle' || progress.status === 'done' ? (
            <button
              type="button"
              className="obsidian-coverage__btn"
              onClick={() => void handle('start')}
              disabled={working !== null}
              title="Почати індексацію"
            >
              <Icon name="play" size={12} /> Старт
            </button>
          ) : null}
          {progress.status === 'running' ? (
            <button
              type="button"
              className="obsidian-coverage__btn"
              onClick={() => void handle('pause')}
              disabled={working !== null}
              title="Призупинити"
            >
              <Icon name="stop" size={12} /> Пауза
            </button>
          ) : null}
          {progress.status === 'paused' ? (
            <button
              type="button"
              className="obsidian-coverage__btn"
              onClick={() => void handle('resume')}
              disabled={working !== null}
              title="Продовжити"
            >
              <Icon name="play" size={12} /> Далі
            </button>
          ) : null}
          {progress.status !== 'idle' ? (
            <button
              type="button"
              className="obsidian-coverage__btn obsidian-coverage__btn--ghost"
              onClick={() => void handle('reset')}
              disabled={working !== null}
              title="Скинути"
            >
              <Icon name="refresh" size={12} />
            </button>
          ) : null}
        </div>
      </div>
      {progress.total > 0 ? (
        <div className="obsidian-coverage__track">
          <div
            className="obsidian-coverage__fill"
            style={{ width: `${percent}%` }}
            aria-hidden
          />
        </div>
      ) : null}
      {actionError ? (
        <div className="obsidian-coverage__error" title={actionError}>
          {actionError}
        </div>
      ) : null}
      {progress.lastError ? (
        <div className="obsidian-coverage__error" title={progress.lastError}>
          {progress.lastError}
        </div>
      ) : null}
    </div>
  );
}

function statusLabel(status: IndexerStatus): string {
  switch (status) {
    case 'idle':    return 'База знань: не запущено';
    case 'running': return 'Індексую';
    case 'paused':  return 'Призупинено';
    case 'done':    return 'Готово';
    case 'error':   return 'Помилка';
  }
}

function shortPath(p: string): string {
  return p.length > 50 ? '…' + p.slice(-50) : p;
}
