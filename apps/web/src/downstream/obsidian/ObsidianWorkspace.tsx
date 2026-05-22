// Right-hand workspace card. Owns the tabs strip + active-tab state +
// per-note caching + draft state, and dispatches between the file
// tree, single-note tabs, and the graph view.
//
// Tab kinds:
//   - 'file'  — vault tree + content for `activePath` (pinned)
//   - 'graph' — force-directed graph view (pinned)
//   - { kind: 'note', path } — single-note tab opened from a graph
//     click or wikilink. Has an ✕ close button.
//
// Data lifecycle:
//   - Tree + graph fetched once on mount and after every save/delete.
//   - Notes fetched on first access, cached in a Map for the session.
//   - When entering edit mode, we snapshot the content into a per-tab
//     draft. Save → PUT → cache update + draft cleared. Cancel reverts.
//
// Wikilinks resolve against the live tree by basename match (same
// algorithm as the daemon-side graph builder), so clicking
// `[[apps-web]]` jumps to `Архітектура/apps-web` even when the writer
// used a short name.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../../components/Icon';
import {
  fetchGraph,
  fetchNote,
  fetchTree,
  saveNote,
  subscribeIndexer,
  type ObsidianGraphPayload,
  type ObsidianNote,
  type ObsidianTreeNode,
} from './api';
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
const DEFAULT_NOTE_PATH = 'README';

export function ObsidianWorkspace() {
  // Data state — pulled from the daemon.
  const [tree, setTree] = useState<ObsidianTreeNode[]>([]);
  const [graph, setGraph] = useState<ObsidianGraphPayload>({ nodes: [], edges: [] });
  const [treeError, setTreeError] = useState<string | null>(null);
  const noteCache = useRef<Map<string, ObsidianNote>>(new Map());
  const [, setCacheVersion] = useState(0); // bumps to force re-render after cache writes
  const [noteLoading, setNoteLoading] = useState<Set<string>>(new Set());
  const [noteErrors, setNoteErrors] = useState<Map<string, string>>(new Map());

  // UI state — tabs, mode, draft.
  const [activePath, setActivePath] = useState<string>(DEFAULT_NOTE_PATH);
  const [tabs, setTabs] = useState<WorkspaceTab[]>(INITIAL_TABS);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mode, setMode] = useState<ObsidianViewMode>('preview');
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const activeTab: WorkspaceTab = tabs[activeIndex] ?? tabs[0]!;

  // Initial tree + graph load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, g] = await Promise.all([fetchTree(), fetchGraph()]);
        if (cancelled) return;
        setTree(t);
        setGraph(g);
        setTreeError(null);
      } catch (err) {
        if (cancelled) return;
        setTreeError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live-refresh tree + graph whenever the background indexer writes a
  // new note. Throttled internally via the EventSource (one event per
  // file completion is fine) — heavy fetches are coalesced by the
  // browser. We don't tear down + reconnect on every tab switch
  // because the parent ObsidianView keeps this component mounted.
  useEffect(() => {
    const off = subscribeIndexer((event) => {
      if (event.kind !== 'note-written' && event.kind !== 'finished') return;
      void (async () => {
        try {
          const [t, g] = await Promise.all([fetchTree(), fetchGraph()]);
          setTree(t);
          setGraph(g);
        } catch {
          // Best-effort live refresh — ignore transient errors.
        }
      })();
    });
    return off;
  }, []);

  // Resolve all paths that need loading — currently the active note for
  // Файл tab, plus the path of any open note tab. Naive but correct:
  // each path fetched once, cached for the session.
  const pathsToLoad = useMemo(() => {
    const out = new Set<string>();
    if (activeTab.kind === 'file' && activePath) out.add(activePath);
    for (const tab of tabs) {
      if (tab.kind === 'note') out.add(tab.path);
    }
    return out;
  }, [tabs, activeTab, activePath]);

  useEffect(() => {
    const cache = noteCache.current;
    for (const p of pathsToLoad) {
      if (cache.has(p)) continue;
      if (noteLoading.has(p)) continue;
      void loadNote(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsToLoad]);

  const loadNote = useCallback(async (notePath: string) => {
    setNoteLoading((prev) => {
      const next = new Set(prev);
      next.add(notePath);
      return next;
    });
    try {
      const note = await fetchNote(notePath);
      if (note) {
        noteCache.current.set(notePath, note);
        setNoteErrors((prev) => {
          if (!prev.has(notePath)) return prev;
          const next = new Map(prev);
          next.delete(notePath);
          return next;
        });
        setCacheVersion((v) => v + 1);
      } else {
        setNoteErrors((prev) => {
          const next = new Map(prev);
          next.set(notePath, 'Нотатка не знайдена');
          return next;
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setNoteErrors((prev) => {
        const next = new Map(prev);
        next.set(notePath, detail);
        return next;
      });
    } finally {
      setNoteLoading((prev) => {
        if (!prev.has(notePath)) return prev;
        const next = new Set(prev);
        next.delete(notePath);
        return next;
      });
    }
  }, []);

  // Resolve a wikilink name → real path. Matches the daemon's graph
  // builder so the rendered links agree with the graph edges.
  const resolveWikilink = useCallback(
    (name: string): string | null => {
      const target = name.trim();
      if (!target) return null;
      // Collect every note path in the tree.
      const paths: string[] = [];
      const visit = (node: ObsidianTreeNode) => {
        if (node.kind === 'note') paths.push(node.path);
        else for (const child of node.children) visit(child);
      };
      for (const node of tree) visit(node);
      if (paths.includes(target)) return target;
      const lowered = target.toLowerCase();
      for (const p of paths) {
        const last = p.split('/').pop() ?? p;
        if (last.toLowerCase() === lowered) return p;
      }
      return null;
    },
    [tree],
  );

  const openNoteTab = useCallback((rawName: string) => {
    const resolved = resolveWikilink(rawName);
    if (!resolved) return; // broken link — silently skip; could show toast later
    setTabs((current) => {
      const existing = current.findIndex(
        (tab) => tab.kind === 'note' && tab.path === resolved,
      );
      if (existing >= 0) {
        setActiveIndex(existing);
        return current;
      }
      const next: WorkspaceTab[] = [...current, { kind: 'note', path: resolved }];
      setActiveIndex(next.length - 1);
      return next;
    });
  }, [resolveWikilink]);

  const closeNoteTab = useCallback((indexToClose: number) => {
    setTabs((current) => {
      if (indexToClose < 0 || indexToClose >= current.length) return current;
      const target = current[indexToClose];
      if (!target || target.kind !== 'note') return current;
      const next = current.filter((_, i) => i !== indexToClose);
      setActiveIndex((currentActive) => {
        if (currentActive < indexToClose) return currentActive;
        if (currentActive === indexToClose) return Math.max(0, indexToClose - 1);
        return currentActive - 1;
      });
      // Drop any unsaved draft for this tab so it doesn't leak into a
      // future tab opened to the same path.
      if (target.kind === 'note') {
        setDrafts((prev) => {
          if (!prev.has(target.path)) return prev;
          const m = new Map(prev);
          m.delete(target.path);
          return m;
        });
      }
      return next;
    });
  }, []);

  // The path that owns the currently-visible viewer-toolbar.
  const toolbarPath: string | null = useMemo(() => {
    if (activeTab.kind === 'file') return activePath;
    if (activeTab.kind === 'note') return activeTab.path;
    return null;
  }, [activeTab, activePath]);

  const activeNote = toolbarPath ? noteCache.current.get(toolbarPath) ?? null : null;
  const isActiveNoteLoading = toolbarPath ? noteLoading.has(toolbarPath) : false;
  const activeNoteError = toolbarPath ? noteErrors.get(toolbarPath) ?? null : null;
  const activeDraft = toolbarPath ? drafts.get(toolbarPath) ?? null : null;
  const isDirty = activeDraft !== null && activeNote !== null && activeDraft !== activeNote.content;

  const onChangeDraft = useCallback(
    (next: string) => {
      if (!toolbarPath) return;
      setDrafts((prev) => {
        const m = new Map(prev);
        m.set(toolbarPath, next);
        return m;
      });
    },
    [toolbarPath],
  );

  const handleModeChange = useCallback(
    (next: ObsidianViewMode) => {
      // Entering edit mode pre-seeds the draft from the loaded content.
      if (next === 'edit' && toolbarPath && !drafts.has(toolbarPath) && activeNote) {
        setDrafts((prev) => {
          const m = new Map(prev);
          m.set(toolbarPath, activeNote.content);
          return m;
        });
      }
      setSaveError(null);
      setMode(next);
    },
    [toolbarPath, activeNote, drafts],
  );

  const handleSave = useCallback(async () => {
    if (!toolbarPath || activeDraft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveNote(toolbarPath, activeDraft);
      noteCache.current.set(toolbarPath, saved);
      setCacheVersion((v) => v + 1);
      setDrafts((prev) => {
        if (!prev.has(toolbarPath)) return prev;
        const m = new Map(prev);
        m.delete(toolbarPath);
        return m;
      });
      // Refresh tree + graph in case a new H1 changed the title or new
      // wikilinks appeared.
      try {
        const [t, g] = await Promise.all([fetchTree(), fetchGraph()]);
        setTree(t);
        setGraph(g);
      } catch {
        // Non-fatal — UI still shows updated note from cache.
      }
      setMode('preview');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [toolbarPath, activeDraft]);

  const handleDiscard = useCallback(() => {
    if (!toolbarPath) return;
    setDrafts((prev) => {
      if (!prev.has(toolbarPath)) return prev;
      const m = new Map(prev);
      m.delete(toolbarPath);
      return m;
    });
    setSaveError(null);
    setMode('preview');
  }, [toolbarPath]);

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
            const label = tabLabel(tab, noteCache.current);
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
        <ObsidianGraph graph={graph} onOpenNote={(p) => openNoteTab(p)} />
      ) : (
        <>
          <div className="viewer-toolbar">
            <div className="viewer-toolbar-left">
              <button
                type="button"
                className="icon-only"
                title="Перечитати"
                aria-label="Перечитати"
                onClick={() => {
                  if (toolbarPath) void loadNote(toolbarPath);
                }}
              >
                <Icon name="reload" size={14} />
              </button>
              <span className="viewer-meta">
                {toolbarPath ? `${toolbarPath}.md` : '—'}
                {isDirty ? ' · змінено' : ''}
              </span>
            </div>
            <div className="viewer-toolbar-actions">
              <div className="viewer-tabs">
                <button
                  type="button"
                  className={`viewer-tab${mode === 'preview' ? ' active' : ''}`}
                  onClick={() => handleModeChange('preview')}
                >
                  Перегляд
                </button>
                <button
                  type="button"
                  className={`viewer-tab${mode === 'source' ? ' active' : ''}`}
                  onClick={() => handleModeChange('source')}
                >
                  Джерело
                </button>
                <button
                  type="button"
                  className={`viewer-tab${mode === 'edit' ? ' active' : ''}`}
                  onClick={() => handleModeChange('edit')}
                >
                  Редагувати
                </button>
              </div>
              {mode === 'edit' ? (
                <>
                  <span className="viewer-divider" aria-hidden />
                  <button
                    type="button"
                    className="viewer-action"
                    onClick={handleDiscard}
                    disabled={saving || !isDirty}
                  >
                    Скасувати
                  </button>
                  <button
                    type="button"
                    className="viewer-action primary"
                    onClick={() => void handleSave()}
                    disabled={saving || !isDirty}
                  >
                    {saving ? 'Збереження…' : 'Зберегти'}
                  </button>
                </>
              ) : null}
            </div>
          </div>
          {treeError ? (
            <main className="obsidian-content">
              <div className="obsidian-content__scroll">
                <article className="obsidian-content__body">
                  <p style={{ color: 'var(--accent)' }}>
                    Помилка завантаження сховища: {treeError}
                  </p>
                </article>
              </div>
            </main>
          ) : activeTab.kind === 'file' ? (
            <ObsidianVault
              tree={tree}
              activePath={activePath}
              activeNote={activeNote}
              noteLoading={isActiveNoteLoading}
              noteError={activeNoteError}
              onSelectTreeNode={setActivePath}
              onOpenWikilink={openNoteTab}
              mode={mode}
              draft={activeDraft}
              saving={saving}
              saveError={saveError}
              onChangeDraft={onChangeDraft}
            />
          ) : (
            <ObsidianNoteBody
              path={activeTab.path}
              note={activeNote}
              loading={isActiveNoteLoading}
              error={activeNoteError}
              mode={mode}
              draft={activeDraft}
              saving={saving}
              saveError={saveError}
              onChangeDraft={onChangeDraft}
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

function tabLabel(tab: WorkspaceTab, cache: Map<string, ObsidianNote>): string {
  if (tab.kind === 'file') return 'Файл';
  if (tab.kind === 'graph') return 'Граф';
  return cache.get(tab.path)?.title ?? tab.path;
}

function tabIconName(tab: WorkspaceTab): 'file' | 'link' {
  if (tab.kind === 'graph') return 'link';
  return 'file';
}
