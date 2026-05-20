import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { Icon } from '../../components/Icon';
import { fetchProjectFileText } from '../../providers/registry';
import {
  fetchTgWebConfig,
  fetchTgWebDeploy,
  startTgWebDeploy,
  type TgWebPersistedConfig,
} from './api';

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type State =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'deploying'; deployId: string }
  | { kind: 'success'; until: number }
  | { kind: 'error'; message: string };

const POLL_MS = 8000;

export function TgWebQuickDeploy({
  projectId,
  fileName,
  filesRefreshKey,
}: {
  projectId: string;
  fileName: string;
  filesRefreshKey: number;
}) {
  const t = useT();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const configRef = useRef<TgWebPersistedConfig | null>(null);
  const lastCheckedHashRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deployPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(async () => {
    const config = await fetchTgWebConfig(projectId, fileName);
    configRef.current = config;
    // Treat the badge as invisible until the user has configured TG Web
    // for this file. The setup panel itself surfaces the empty state.
    if (!config || !config.repoPath || !config.designPath || !config.miniAppUrl) {
      setState((prev) => (prev.kind === 'deploying' ? prev : { kind: 'idle' }));
      return;
    }
    const source = await fetchProjectFileText(projectId, fileName, { cacheBustKey: Date.now() });
    if (source === null) {
      // File not ready / fetch failed — don't surface a noisy error on the
      // chrome bar. Stay idle.
      return;
    }
    const hash = await sha256Hex(source);
    lastCheckedHashRef.current = hash;
    const isDirty = !config.lastDeployedHash || config.lastDeployedHash !== hash;
    setState((prev) => {
      if (prev.kind === 'deploying') return prev;
      if (prev.kind === 'success' && prev.until > Date.now()) return prev;
      return isDirty ? { kind: 'dirty' } : { kind: 'idle' };
    });
  }, [projectId, fileName]);

  // Initial check + on file-save-driven refresh signal from FileViewer.
  useEffect(() => {
    void check();
  }, [check, filesRefreshKey]);

  // Periodic poll while not actively deploying.
  useEffect(() => {
    if (state.kind === 'deploying') return;
    pollRef.current = setTimeout(() => { void check(); }, POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = null;
    };
  }, [state, check]);

  // Poll deploy status while running.
  useEffect(() => {
    if (state.kind !== 'deploying') return;
    let cancelled = false;
    const poll = async () => {
      const rec = await fetchTgWebDeploy(state.deployId);
      if (cancelled) return;
      if (!rec) {
        deployPollRef.current = setTimeout(poll, 2000);
        return;
      }
      if (rec.status === 'running') {
        deployPollRef.current = setTimeout(poll, 2000);
        return;
      }
      if (rec.status === 'success') {
        setState({ kind: 'success', until: Date.now() + 3000 });
        // Refresh config so the new lastDeployedHash hides the badge.
        void check();
      } else {
        setState({ kind: 'error', message: `exit ${rec.exitCode ?? '?'}` });
      }
    };
    deployPollRef.current = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      if (deployPollRef.current) clearTimeout(deployPollRef.current);
      deployPollRef.current = null;
    };
  }, [state, check]);

  // Auto-clear the green "success" pill after the hold window.
  useEffect(() => {
    if (state.kind !== 'success') return;
    const remaining = Math.max(0, state.until - Date.now());
    const id = setTimeout(() => setState({ kind: 'idle' }), remaining);
    return () => clearTimeout(id);
  }, [state]);

  const handleDeploy = useCallback(async () => {
    const config = configRef.current;
    if (!config || !config.repoPath || !config.designPath || !config.miniAppUrl) return;
    setState({ kind: 'deploying', deployId: '' });
    const source = await fetchProjectFileText(projectId, fileName, { cacheBustKey: Date.now() });
    if (source === null) {
      setState({ kind: 'error', message: 'read failed' });
      return;
    }
    const result = await startTgWebDeploy({
      projectId,
      fileName,
      repoPath: config.repoPath,
      designPath: config.designPath,
      sourceHtml: source,
    });
    if (!result.ok) {
      setState({ kind: 'error', message: result.error });
      return;
    }
    setState({ kind: 'deploying', deployId: result.deployId });
  }, [projectId, fileName]);

  if (state.kind === 'idle') return null;

  const label =
    state.kind === 'dirty'
      ? t('tgWeb.quickDeployReady')
      : state.kind === 'deploying'
        ? t('tgWeb.updating')
        : state.kind === 'success'
          ? t('tgWeb.deployStatusSuccess')
          : t('tgWeb.deployStatusFailed');

  const className = `tg-web-quick-deploy tg-web-quick-${state.kind}`;
  const disabled = state.kind === 'deploying' || state.kind === 'success';
  const titleText = state.kind === 'error' ? `${label}: ${state.message}` : label;

  return (
    <button
      type="button"
      className={className}
      onClick={state.kind === 'dirty' || state.kind === 'error' ? handleDeploy : undefined}
      disabled={disabled}
      title={titleText}
      aria-label={titleText}
    >
      <Icon
        name={state.kind === 'success' ? 'check' : state.kind === 'deploying' ? 'spinner' : 'arrow-up'}
        size={12}
      />
    </button>
  );
}
