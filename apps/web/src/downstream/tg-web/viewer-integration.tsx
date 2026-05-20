// FileViewer chrome integration for the TgWeb feature. Mounted via a
// single line in apps/web/src/components/FileViewer.tsx so the upstream
// file stays nearly untouched.
//
// Two surfaces:
//   * `TgWebChromeButton` — the "TG Web" button in the file chrome plus
//     the quick-deploy badge that appears next to it.
//   * `TgWebPanelMount` — the slide-in side panel itself.
//
// FileViewer wires them via shared open/close state.

import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';

import { TgWebPanel } from './TgWebPanel';
import { TgWebQuickDeploy } from './TgWebQuickDeploy';

export function TgWebChromeButton({
  projectId,
  fileName,
  filesRefreshKey,
  onOpen,
}: {
  projectId: string;
  fileName: string;
  filesRefreshKey: number;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <div className="chrome-tg-web-group">
      <button
        type="button"
        className="chrome-action chrome-action-secondary"
        onClick={onOpen}
        title={t('fileViewer.tgWeb')}
      >
        <Icon name="send" size={13} />
        <span>{t('fileViewer.tgWeb')}</span>
      </button>
      <TgWebQuickDeploy
        projectId={projectId}
        fileName={fileName}
        filesRefreshKey={filesRefreshKey}
      />
    </div>
  );
}

export function TgWebPanelMount({
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
  return (
    <TgWebPanel
      projectId={projectId}
      fileName={fileName}
      open={open}
      onClose={onClose}
    />
  );
}
