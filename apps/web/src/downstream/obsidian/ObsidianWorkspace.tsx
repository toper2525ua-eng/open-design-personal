// Right-hand workspace card. Mirrors the project view's structure:
// a tab strip on top (Файл | Граф | <opened notes>) with the project's
// `.ws-tabs-*` classes, a viewer-toolbar below (view-mode pills, only
// shown when the active tab is a markdown-bearing one), then the
// active tab's body.
//
// Tab kinds:
//   - 'file'  — vault tree + content for `activePath` (pinned)
//   - 'graph' — force-directed graph view (pinned)
//   - { kind: 'note', path } — single-note tab opened from a graph
//     click or wikilink. Has an ✕ close button and disappears on
//     close.
//
// Clicking a wikilink inside any note opens it in a new note tab,
// mirroring Obsidian's "open in new leaf" behavior. The tree-pane
// click on Файл keeps replacing the file-tab's activePath as before.

import { useCallback, useMemo, useState } from 'react';

import { Icon } from '../../components/Icon';
import { MOCK_NOTES } from './mock-data';
import { ObsidianGraph } from './ObsidianGraph';
import {
  ObsidianNoteBody,
  ObsidianVault,
  type ObsidianViewMode,
} from './ObsidianVault';

type WorkspaceTab =
  | { kind: 'file' }
  | { kind: 'graph' }
  | { kind: 'note'; path: string };

const INITIAL_TABS: WorkspaceTab[] = [{ kind: 'file' }, { kind: 'graph' }];

interface Props {
  activePath: string;
  onSelect: (path: string) => void;
}

export function ObsidianWorkspace({ activePath, onSelect }: Props) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>(INITIAL_TABS);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mode, setMode] = useState<ObsidianViewMode>('preview');

  const activeTab: WorkspaceTab = tabs[activeIndex] ?? tabs[0]!;

  // Open a note in a dedicated tab. If a tab already exists for this
  // path we just activate it; otherwise we push a new one after the
  // last existing tab and focus it.
  const openNoteTab = useCallback((path: string) => {
    setTabs((current) => {
      const existing = current.findIndex(
        (tab) => tab.kind === 'note' && tab.path === path,
      );
      if (existing >= 0) {
        setActiveIndex(existing);
        return current;
      }
      const next: WorkspaceTab[] = [...current, { kind: 'note', path }];
      setActiveIndex(next.length - 1);
      return next;
    });
  }, []);

  const closeNoteTab = useCallback((indexToClose: number) => {
    setTabs((current) => {
      if (indexToClose < 0 || indexToClose >= current.length) return current;
      const target = current[indexToClose];
      if (!target || target.kind !== 'note') return current;
      const next = current.filter((_, i) => i !== indexToClose);
      setActiveIndex((currentActive) => {
        if (currentActive < indexToClose) return currentActive;
        if (currentActive === indexToClose) {
          // Closing the active tab — fall back to the previous tab
          // (which is always at least Граф since it's pinned).
          return Math.max(0, indexToClose - 1);
        }
        return currentActive - 1;
      });
      return next;
    });
  }, []);

  const onSelectTreeNode = useCallback(
    (path: string) => {
      onSelect(path);
    },
    [onSelect],
  );

  // The path that owns the currently visible viewer-toolbar (Файл uses
  // activePath, note tabs use their own path).
  const toolbarPath: string | null = useMemo(() => {
    if (activeTab.kind === 'file') return activePath;
    if (activeTab.kind === 'note') return activeTab.path;
    return null;
  }, [activeTab, activePath]);

  return (
    <section className="workspace obsidian-workspace" aria-label="Робоча область">
      <div className="ws-tabs-shell obsidian-workspace__tabs">
        <div
          className="ws-tabs-bar"
          role="tablist"
          aria-label="Вкладки робочої області"
        >
          {tabs.map((tab, index) => {
            const isActive = index === activeIndex;
            const key = tabKey(tab, index);
            const label = tabLabel(tab);
            const iconName = tabIconName(tab);
            const closeable = tab.kind === 'note';
            return (
              <div
                key={key}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                className={`ws-tab${isActive ? ' active' : ''}`}
                title={label}
                onClick={() => setActiveIndex(index)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActiveIndex(index);
                  }
                }}
              >
                <span className="tab-icon" aria-hidden>
                  <Icon name={iconName} size={13} />
                </span>
                <span className="ws-tab-label">{label}</span>
                {closeable ? (
                  <button
                    type="button"
                    className="ws-tab-close"
                    aria-label={`Закрити ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeNoteTab(index);
                    }}
                  >
                    <Icon name="close" size={11} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {activeTab.kind === 'graph' ? (
        <ObsidianGraph activePath={activePath} onOpenNote={openNoteTab} />
      ) : (
        <>
          <div className="viewer-toolbar">
            <div className="viewer-toolbar-left">
              <button
                type="button"
                className="icon-only"
                title="Оновити (Фаза B)"
                aria-label="Оновити"
                disabled
              >
                <Icon name="reload" size={14} />
              </button>
              <span className="viewer-meta">
                {toolbarPath ? `${toolbarPath}.md` : '—'}
              </span>
            </div>
            <div className="viewer-toolbar-actions">
              <div className="viewer-tabs">
                <button
                  type="button"
                  className={`viewer-tab${mode === 'preview' ? ' active' : ''}`}
                  onClick={() => setMode('preview')}
                >
                  Перегляд
                </button>
                <button
                  type="button"
                  className={`viewer-tab${mode === 'source' ? ' active' : ''}`}
                  onClick={() => setMode('source')}
                >
                  Джерело
                </button>
                <button
                  type="button"
                  className={`viewer-tab${mode === 'edit' ? ' active' : ''}`}
                  onClick={() => setMode('edit')}
                >
                  Редагувати
                </button>
              </div>
              <span className="viewer-divider" aria-hidden />
              <button
                type="button"
                className="icon-only"
                title="Видалити нотатку (Фаза B)"
                aria-label="Видалити"
                disabled
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
          {activeTab.kind === 'file' ? (
            <ObsidianVault
              activePath={activePath}
              onSelectTreeNode={onSelectTreeNode}
              onOpenWikilink={openNoteTab}
              mode={mode}
            />
          ) : (
            <ObsidianNoteBody
              path={activeTab.path}
              mode={mode}
              onOpenWikilink={openNoteTab}
            />
          )}
        </>
      )}
    </section>
  );
}

function tabKey(tab: WorkspaceTab, index: number): string {
  if (tab.kind === 'note') return `note:${tab.path}`;
  return `${tab.kind}:${index}`;
}

function tabLabel(tab: WorkspaceTab): string {
  if (tab.kind === 'file') return 'Файл';
  if (tab.kind === 'graph') return 'Граф';
  return MOCK_NOTES[tab.path]?.title ?? tab.path;
}

function tabIconName(tab: WorkspaceTab): 'file' | 'link' {
  if (tab.kind === 'graph') return 'link';
  return 'file';
}
