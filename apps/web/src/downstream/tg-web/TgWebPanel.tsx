import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useT } from '../../i18n';
import { Icon } from '../../components/Icon';
import { fetchProjectFileText } from '../../providers/registry';
import {
  cancelTgWebDeploy,
  fetchTgWebConfig,
  fetchTgWebDeploy,
  fetchTgWebDeploys,
  openTgWebFolderInExplorer,
  saveTgWebConfig,
  startTgWebDeploy,
  type TgWebDeployRecord,
  type TgWebDeployStatus,
  type TgWebPersistedConfig,
} from './api';

export type TgWebConfig = TgWebPersistedConfig;

function emptyConfig(): TgWebConfig {
  return { repoPath: '', designPath: 'webapp/index.html', miniAppUrl: '', botToken: '' };
}

function isConfigComplete(config: TgWebConfig | null): boolean {
  if (!config) return false;
  return config.repoPath.trim() !== '' && config.designPath.trim() !== '' && config.miniAppUrl.trim() !== '';
}

type BotStatus = { kind: 'unknown' } | { kind: 'online'; username: string } | { kind: 'offline' };

async function fetchBotStatus(token: string, signal: AbortSignal): Promise<BotStatus> {
  if (!token.trim()) return { kind: 'unknown' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token.trim())}/getMe`, {
      method: 'GET',
      signal,
    });
    if (!res.ok) return { kind: 'offline' };
    const json = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    if (!json.ok || !json.result?.username) return { kind: 'offline' };
    return { kind: 'online', username: json.result.username };
  } catch {
    return { kind: 'offline' };
  }
}

export function TgWebPanel({
  projectId,
  fileName,
  open,
  onClose,
}: {
  projectId: string;
  fileName: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [config, setConfig] = useState<TgWebConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TgWebConfig>(emptyConfig());
  const [botStatus, setBotStatus] = useState<BotStatus>({ kind: 'unknown' });
  const [activeDeploy, setActiveDeploy] = useState<TgWebDeployRecord | null>(null);
  const [deployHistory, setDeployHistory] = useState<TgWebDeployRecord[]>([]);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [commitNote, setCommitNote] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchTgWebConfig(projectId, fileName).then((next) => {
      if (cancelled) return;
      setConfig(next);
      if (!isConfigComplete(next)) {
        setEditing(true);
        setDraft(next ?? emptyConfig());
      } else {
        setEditing(false);
      }
    });
    return () => { cancelled = true; };
  }, [open, projectId, fileName]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || editing) {
      setBotStatus({ kind: 'unknown' });
      return;
    }
    if (!config?.botToken) {
      setBotStatus({ kind: 'unknown' });
      return;
    }
    const ctrl = new AbortController();
    void fetchBotStatus(config.botToken, ctrl.signal).then(setBotStatus);
    return () => ctrl.abort();
  }, [open, editing, config?.botToken]);

  const refreshDeployHistory = useCallback(() => {
    void fetchTgWebDeploys(projectId, fileName).then(setDeployHistory);
  }, [projectId, fileName]);

  useEffect(() => {
    if (!open || editing) return;
    refreshDeployHistory();
  }, [open, editing, refreshDeployHistory]);

  useEffect(() => {
    if (!activeDeploy || activeDeploy.status !== 'running') {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const next = await fetchTgWebDeploy(activeDeploy.deployId);
      if (cancelled) return;
      if (next) {
        setActiveDeploy(next);
        if (next.status !== 'running') {
          refreshDeployHistory();
          return;
        }
      }
      pollTimerRef.current = setTimeout(poll, 2000);
    };
    pollTimerRef.current = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [activeDeploy, refreshDeployHistory]);

  const configured = isConfigComplete(config);

  const handleDeploy = useCallback(async () => {
    if (!config || !isConfigComplete(config)) return;
    setDeployError(null);
    setDeploying(true);
    try {
      const sourceHtml = await fetchProjectFileText(projectId, fileName, { cacheBustKey: Date.now() });
      if (sourceHtml === null) {
        setDeployError('Could not read current design file');
        return;
      }
      const trimmedNote = commitNote.trim();
      const result = await startTgWebDeploy({
        projectId,
        fileName,
        repoPath: config.repoPath,
        designPath: config.designPath,
        sourceHtml,
        ...(trimmedNote ? { commitMessage: trimmedNote } : {}),
      });
      if (!result.ok) {
        setDeployError(result.error);
        return;
      }
      const initial: TgWebDeployRecord = {
        deployId: result.deployId,
        status: 'running',
        exitCode: null,
        startedAt: Date.now(),
        endedAt: null,
        logTail: '',
      };
      setActiveDeploy(initial);
      setCommitNote('');
    } finally {
      setDeploying(false);
    }
  }, [config, projectId, fileName, commitNote]);

  const handleCancelDeploy = useCallback(async () => {
    if (!activeDeploy || activeDeploy.status !== 'running') return;
    await cancelTgWebDeploy(activeDeploy.deployId);
  }, [activeDeploy]);

  const handleEdit = useCallback(() => {
    setDraft(config ?? emptyConfig());
    setEditing(true);
  }, [config]);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const handleSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const next: TgWebConfig = {
        repoPath: draft.repoPath.trim(),
        designPath: draft.designPath.trim() || 'webapp/index.html',
        miniAppUrl: draft.miniAppUrl.trim(),
        botToken: draft.botToken.trim(),
      };
      setSaving(true);
      setSaveError(null);
      try {
        const result = await saveTgWebConfig(projectId, fileName, next);
        if (!result.ok) {
          setSaveError(result.error);
          return;
        }
        setConfig(result.config);
        setEditing(false);
      } finally {
        setSaving(false);
      }
    },
    [draft, projectId, fileName],
  );

  const handleCancel = useCallback(() => {
    if (configured) {
      setEditing(false);
    } else {
      onClose();
    }
  }, [configured, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="tg-web-backdrop" onClick={onClose} aria-hidden />
      <aside className="tg-web-panel" role="dialog" aria-label={t('tgWeb.panelTitle')}>
        <header className="tg-web-header">
          <div className="tg-web-header-title">
            <Icon name="send" size={14} />
            <span>{t('tgWeb.panelTitle')}</span>
          </div>
          <button
            type="button"
            className="tg-web-close"
            onClick={onClose}
            aria-label={t('tgWeb.close')}
            title={t('tgWeb.close')}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="tg-web-body">
          {editing || !config || !isConfigComplete(config) ? (
            <SetupForm
              draft={draft}
              onChange={setDraft}
              onSave={handleSave}
              onCancel={handleCancel}
              canCancel={configured}
              saving={saving}
              saveError={saveError}
            />
          ) : (
            <StatusView
              botStatus={botStatus}
              activeDeploy={activeDeploy}
              deployHistory={deployHistory}
              deploying={deploying}
              deployError={deployError}
              commitNote={commitNote}
              onCommitNoteChange={setCommitNote}
              onEdit={handleEdit}
              onDeploy={handleDeploy}
              onCancelDeploy={handleCancelDeploy}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function SetupForm({
  draft,
  onChange,
  onSave,
  onCancel,
  canCancel,
  saving,
  saveError,
}: {
  draft: TgWebConfig;
  onChange: (next: TgWebConfig) => void;
  onSave: (e: FormEvent) => void;
  onCancel: () => void;
  canCancel: boolean;
  saving: boolean;
  saveError: string | null;
}) {
  const t = useT();
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const updateField = (field: keyof TgWebConfig) => (e: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...draft, [field]: e.target.value });
  };
  const canSubmit = draft.repoPath.trim() !== '' && draft.designPath.trim() !== '' && draft.miniAppUrl.trim() !== '';

  const [browsedOnce, setBrowsedOnce] = useState(false);
  const handleBrowse = async () => {
    setBrowsing(true);
    setBrowseError(null);
    try {
      const electronPicker = typeof window !== 'undefined' ? window.electronAPI?.tgWebPickFolder : undefined;
      if (electronPicker) {
        const result = await electronPicker({ initial: draft.repoPath || null });
        if ('path' in result) {
          onChange({ ...draft, repoPath: result.path });
        }
        return;
      }
      const fallback = await openTgWebFolderInExplorer(draft.repoPath || undefined);
      if ('error' in fallback) {
        setBrowseError(fallback.error);
      } else {
        setBrowsedOnce(true);
      }
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <form className="tg-web-setup" onSubmit={onSave}>
      <h3 className="tg-web-section-title">{t('tgWeb.setupTitle')}</h3>
      <p className="tg-web-hint">{t('tgWeb.setupHint')}</p>

      <label className="tg-web-field">
        <span className="tg-web-field-label">{t('tgWeb.repoPathLabel')}</span>
        <div className="tg-web-input-row">
          <input
            type="text"
            className="tg-web-input"
            value={draft.repoPath}
            onChange={updateField('repoPath')}
            placeholder={t('tgWeb.repoPathPlaceholder')}
            spellCheck={false}
            autoFocus
          />
          <button
            type="button"
            className="tg-web-btn tg-web-btn-ghost tg-web-browse-btn"
            onClick={handleBrowse}
            disabled={browsing}
            title={t('tgWeb.browseFolder')}
          >
            <Icon name="folder" size={13} />
            <span>{browsing ? t('tgWeb.browsing') : t('tgWeb.browseFolder')}</span>
          </button>
        </div>
        {browsedOnce && !browseError ? (
          <span className="tg-web-field-hint">{t('tgWeb.browseCopyHint')}</span>
        ) : null}
        {browseError ? <span className="tg-web-field-hint tg-web-field-error">{browseError}</span> : null}
      </label>

      <label className="tg-web-field">
        <span className="tg-web-field-label">{t('tgWeb.designPathLabel')}</span>
        <input
          type="text"
          className="tg-web-input"
          value={draft.designPath}
          onChange={updateField('designPath')}
          placeholder={t('tgWeb.designPathPlaceholder')}
          spellCheck={false}
        />
      </label>

      <label className="tg-web-field">
        <span className="tg-web-field-label">{t('tgWeb.miniAppUrlLabel')}</span>
        <input
          type="url"
          className="tg-web-input"
          value={draft.miniAppUrl}
          onChange={updateField('miniAppUrl')}
          placeholder={t('tgWeb.miniAppUrlPlaceholder')}
          spellCheck={false}
        />
      </label>

      <label className="tg-web-field">
        <span className="tg-web-field-label">{t('tgWeb.botTokenLabel')}</span>
        <input
          type="password"
          className="tg-web-input"
          value={draft.botToken}
          onChange={updateField('botToken')}
          placeholder="123456:ABC-DEF…"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="tg-web-field-hint">{t('tgWeb.botTokenHint')}</span>
      </label>

      {saveError ? <div className="tg-web-deploy-error">{saveError}</div> : null}
      <div className="tg-web-actions">
        {canCancel ? (
          <button type="button" className="tg-web-btn tg-web-btn-ghost" onClick={onCancel} disabled={saving}>
            {t('tgWeb.cancel')}
          </button>
        ) : null}
        <button type="submit" className="tg-web-btn tg-web-btn-primary" disabled={!canSubmit || saving}>
          {t('tgWeb.save')}
        </button>
      </div>
    </form>
  );
}

function StatusView({
  botStatus,
  activeDeploy,
  deployHistory,
  deploying,
  deployError,
  commitNote,
  onCommitNoteChange,
  onEdit,
  onDeploy,
  onCancelDeploy,
}: {
  botStatus: BotStatus;
  activeDeploy: TgWebDeployRecord | null;
  deployHistory: TgWebDeployRecord[];
  deploying: boolean;
  deployError: string | null;
  commitNote: string;
  onCommitNoteChange: (next: string) => void;
  onEdit: () => void;
  onDeploy: () => void;
  onCancelDeploy: () => void;
}) {
  const t = useT();
  const botUsername = botStatus.kind === 'online' ? botStatus.username : null;
  const telegramDeepLink = botUsername ? `https://t.me/${botUsername}` : null;
  const statusLabel =
    botStatus.kind === 'online'
      ? `${t('tgWeb.statusOnline')} · @${botStatus.username}`
      : botStatus.kind === 'offline'
        ? t('tgWeb.statusOffline')
        : t('tgWeb.statusUnknown');
  const statusClass = `tg-web-status-value tg-web-status-${botStatus.kind}`;
  const lastDeploy = activeDeploy ?? deployHistory[0] ?? null;
  const lastDeployText = lastDeploy ? formatRelativeTime(lastDeploy.startedAt) : t('tgWeb.never');
  const isRunning = activeDeploy?.status === 'running';
  return (
    <div className="tg-web-status">
      <section className="tg-web-status-card">
        <div className="tg-web-status-row">
          <span className="tg-web-status-label">{t('tgWeb.statusLabel')}</span>
          <span className={statusClass}>{statusLabel}</span>
        </div>
        <div className="tg-web-status-row">
          <span className="tg-web-status-label">{t('tgWeb.lastDeployLabel')}</span>
          <span className="tg-web-status-value">{lastDeployText}</span>
        </div>
        {!isRunning ? (
          <input
            type="text"
            className="tg-web-input tg-web-commit-note"
            value={commitNote}
            onChange={(e) => onCommitNoteChange(e.target.value)}
            placeholder={t('tgWeb.commitNotePlaceholder')}
            spellCheck={false}
            maxLength={100}
            disabled={deploying}
          />
        ) : null}
        {isRunning ? (
          <button
            type="button"
            className="tg-web-btn tg-web-btn-ghost tg-web-update"
            onClick={onCancelDeploy}
          >
            <Icon name="stop" size={13} />
            <span>{t('tgWeb.cancel')}</span>
          </button>
        ) : (
          <button
            type="button"
            className="tg-web-btn tg-web-btn-primary tg-web-update"
            onClick={onDeploy}
            disabled={deploying}
            title={t('tgWeb.updateBot')}
          >
            <Icon name="send" size={13} />
            <span>{deploying ? t('tgWeb.updating') : t('tgWeb.updateBot')}</span>
          </button>
        )}
        {telegramDeepLink ? (
          <a
            className="tg-web-btn tg-web-btn-ghost tg-web-telegram-link"
            href={telegramDeepLink}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="external-link" size={13} />
            <span>{t('tgWeb.openBotInTelegram', { username: botStatus.kind === 'online' ? botStatus.username : '' })}</span>
          </a>
        ) : null}
        {deployError ? <div className="tg-web-deploy-error">{deployError}</div> : null}
        {activeDeploy && (activeDeploy.logTail ?? '').length > 0 ? (
          <pre className="tg-web-deploy-log">{activeDeploy.logTail}</pre>
        ) : null}
      </section>

      <section className="tg-web-deploys">
        <span className="tg-web-section-title">{t('tgWeb.deployLogTitle')}</span>
        {deployHistory.length === 0 && !activeDeploy ? (
          <div className="tg-web-deploys-empty">{t('tgWeb.noDeploysYet')}</div>
        ) : (
          <ul className="tg-web-deploys-list">
            {deployHistory.map((d) => (
              <li key={d.deployId} className={`tg-web-deploy-item tg-web-deploy-${d.status}`}>
                <span className="tg-web-deploy-status">{deployStatusLabel(d.status, t)}</span>
                <span className="tg-web-deploy-time">{formatRelativeTime(d.startedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <button type="button" className="tg-web-btn tg-web-btn-ghost tg-web-edit-btn" onClick={onEdit}>
        <Icon name="settings" size={13} />
        <span>{t('tgWeb.edit')}</span>
      </button>
    </div>
  );
}

function deployStatusLabel(
  status: TgWebDeployStatus,
  t: ReturnType<typeof useT>,
): string {
  if (status === 'success') return t('tgWeb.deployStatusSuccess');
  if (status === 'failed') return t('tgWeb.deployStatusFailed');
  return t('tgWeb.deployStatusPending');
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}
