// Phase A: top-level Obsidian page. Rendered directly from App.tsx
// when `route.kind === 'obsidian'`, OUTSIDE of EntryShell — same
// shell pattern as ProjectView so the entry nav rail unmounts and
// the view fills the viewport edge-to-edge.
//
//   ┌───────────────────────────────────────────────────────────────┐
//   │ AppChromeHeader: ← back · Обсидіан · база знань               │
//   ├───────────────────────────────────────────────────────────────┤
//   │ .split (chat-width · 8px resize handle · 1fr workspace)       │
//   │ ┌──────────────┬──┬──────────────────────────────────────┐    │
//   │ │ chat (.pane) │  │ workspace (.workspace)               │    │
//   │ │              │  │  [Файл]  [Граф]  [...notes]          │    │
//   │ │              │  │  toolbar (Файл/Note tabs only)       │    │
//   │ │              │  │  body (vault / note / graph)         │    │
//   │ └──────────────┴──┴──────────────────────────────────────┘    │
//   └───────────────────────────────────────────────────────────────┘
//
// Reuses the project `.app` + `.split` + `.split-chat-slot` + `.pane`
// + `.workspace` CSS classes so the visual matches the rest of the
// app verbatim. The resize handle drags the chat-width via window-
// level pointer listeners (same pattern as the graph node drag) and
// persists to localStorage so the layout survives reloads.
//
// Copy is Ukrainian-only by design — this is a fork-specific feature
// and the upstream i18n contract is not extended.

import { useCallback, useRef, useState } from 'react';

import { AppChromeHeader } from '../../components/AppChromeHeader';
import { navigate } from '../../router';
import { ObsidianChatStub } from './ObsidianChatStub';
import { ObsidianWorkspace } from './ObsidianWorkspace';

const DEFAULT_NOTE_PATH = 'README';
const RESIZE_HANDLE_WIDTH = 8;
const CHAT_MIN_WIDTH = 280;
const CHAT_MAX_WIDTH = 720;
const CHAT_DEFAULT_WIDTH = 460;
const CHAT_WIDTH_STORAGE_KEY = 'open-design:obsidian-chat-width:v1';

function readSavedChatWidth(): number {
  if (typeof window === 'undefined') return CHAT_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY);
    if (!raw) return CHAT_DEFAULT_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return CHAT_DEFAULT_WIDTH;
    return clampChatWidth(parsed);
  } catch {
    return CHAT_DEFAULT_WIDTH;
  }
}

function clampChatWidth(w: number): number {
  if (w < CHAT_MIN_WIDTH) return CHAT_MIN_WIDTH;
  if (w > CHAT_MAX_WIDTH) return CHAT_MAX_WIDTH;
  return Math.round(w);
}

export function ObsidianView() {
  const [activePath, setActivePath] = useState<string>(DEFAULT_NOTE_PATH);
  const [chatWidth, setChatWidth] = useState<number>(readSavedChatWidth);
  const [resizing, setResizing] = useState(false);
  // Refs let the global pointer listeners see the latest start state
  // without re-attaching on every render.
  const resizeOriginRef = useRef<{ x: number; width: number } | null>(null);
  const dragHandlersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
  } | null>(null);

  const detachResizeListeners = useCallback(() => {
    const handlers = dragHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener('pointermove', handlers.move);
    window.removeEventListener('pointerup', handlers.up);
    window.removeEventListener('pointercancel', handlers.up);
    dragHandlersRef.current = null;
  }, []);

  const onResizeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      detachResizeListeners();
      resizeOriginRef.current = { x: e.clientX, width: chatWidth };
      setResizing(true);
      const move = (ev: PointerEvent) => {
        const origin = resizeOriginRef.current;
        if (!origin) return;
        const dx = ev.clientX - origin.x;
        setChatWidth(clampChatWidth(origin.width + dx));
      };
      const up = () => {
        detachResizeListeners();
        resizeOriginRef.current = null;
        setResizing(false);
        try {
          window.localStorage.setItem(
            CHAT_WIDTH_STORAGE_KEY,
            String(clampChatWidth(chatWidth)),
          );
        } catch {
          // Storage may be unavailable (private mode, quota); fall
          // back to in-memory width only.
        }
      };
      dragHandlersRef.current = { move, up };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [chatWidth, detachResizeListeners],
  );

  return (
    <div className="app">
      <AppChromeHeader
        showTrafficSpace={false}
        onBack={() => navigate({ kind: 'home', view: 'home' })}
        backLabel="До головної"
      >
        <div className="app-project-title">
          <span className="app-project-title-line">
            <span className="title">Обсидіан</span>
            <span className="meta">База знань Open Design</span>
          </span>
        </div>
      </AppChromeHeader>
      <div
        className={`split${resizing ? ' is-resizing-chat' : ''}`}
        style={{
          gridTemplateColumns: `${chatWidth}px ${RESIZE_HANDLE_WIDTH}px minmax(400px, 1fr)`,
        }}
      >
        <div className="split-chat-slot">
          <ObsidianChatStub />
        </div>
        <div
          className="split-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Змінити ширину чату"
          onPointerDown={onResizeDown}
        />
        <ObsidianWorkspace activePath={activePath} onSelect={setActivePath} />
      </div>
    </div>
  );
}
