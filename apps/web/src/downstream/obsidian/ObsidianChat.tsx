// Global Obsidian chat. Visual layout mirrors ProjectView's ChatPane
// pixel-for-pixel by reusing its CSS classes (.chat-log-wrap, .msg.user,
// .msg.assistant, .role, .assistant-flow, .op-waiting,
// .assistant-footer, .chat-empty-wrap, .chat-examples) — same look the
// user already knows from project chats.
//
// The BACKEND is our own slim daemon (see chat.ts on the daemon side):
// each user message re-spawns `claude -p` with the full conversation
// history fed as prompt. Conversations persist as JSON files under
// `.od/obsidian-global/.conversations/`.
//
// Mount-time behavior: always lands on empty state (suggestion chips).
// Old conversations are still reachable via the 🕐 history popover.
// New chat via the ➕ button creates an empty conversation in storage.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../../components/Icon';
import { renderMarkdown } from '../../runtime/markdown';
import {
  createConversation,
  deleteConversation,
  fetchConversation,
  fetchConversations,
  streamMessage,
  uploadAttachments,
  type ChatAttachment,
  type ChatConversation,
  type ChatConversationSummary,
  type ChatMessage,
  type ChatStreamEvent,
} from './api';
import { ObsidianCoverageBar } from './ObsidianCoverageBar';

// Local render-state for the active conversation. Adds streaming
// scaffolding (pendingAssistant, pendingTools, footer stats) on top of
// the persisted shape.
interface RenderConversation extends ChatConversation {
  pendingAssistant: string | null;
  pendingTools: PendingToolEntry[];
  streamError: string | null;
  // Wall-clock timestamps for the latest in-flight assistant turn so
  // the WaitingPill + footer can show elapsed seconds.
  pendingStartedAt: number | null;
  pendingFinishedAt: number | null;
}

interface PendingToolEntry {
  id: string;
  toolName: string;
  hint: string;
}

const SUGGESTIONS = [
  { title: 'Які downstream-фічі є зараз?', tag: 'огляд' },
  { title: 'Де описана auto-updater логіка?', tag: 'архітектура' },
  { title: 'Як працює tg-web деплой?', tag: 'фіча' },
  { title: 'Куди писати нові API-роути даемона?', tag: 'розробка' },
];

// sessionStorage key for the currently-open conversation id. Survives
// tab switches within the same browser session (Обсидіан ↔ project) so
// the chat reappears as the user left it. Cleared on browser close so
// each new session starts fresh.
const ACTIVE_CONV_STORAGE_KEY = 'open-design:obsidian-chat:active-conv';

function readPersistedActiveId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(ACTIVE_CONV_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistActiveId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.sessionStorage.setItem(ACTIVE_CONV_STORAGE_KEY, id);
    else window.sessionStorage.removeItem(ACTIVE_CONV_STORAGE_KEY);
  } catch {
    // Quota or privacy mode — fall back to in-memory only.
  }
}

export function ObsidianChat() {
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  // Rehydrate the active conversation id from sessionStorage so a
  // round-trip to a project tab and back preserves the chat. First
  // open of a fresh session lands on `null` → empty state.
  const [activeId, setActiveId] = useState<string | null>(() => readPersistedActiveId());
  const [active, setActive] = useState<RenderConversation | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Initial list load. activeId comes from sessionStorage (see useState
  // initializer above) so within a session the chat survives Project
  // ↔ Обсидіан tab switches. Across sessions / + button we land on
  // the empty state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchConversations();
        if (cancelled) return;
        setConversations(list);
      } catch {
        // Empty list is acceptable.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Keep sessionStorage in sync whenever activeId changes (whether
  // from + button, history pick, delete, or initial rehydrate).
  useEffect(() => {
    persistActiveId(activeId);
  }, [activeId]);

  // Detect an in-flight assistant turn when the user returns to the
  // tab mid-stream. The original SSE was tied to the prior mount so we
  // can't reattach to it — but the daemon keeps running and will
  // eventually append the assistant message to the conversation file.
  // If the latest message is from the user AND was recent (<5 min)
  // AND we're not the ones currently sending, poll the conversation
  // every 3s so the assistant message + footer appear without a
  // manual refresh, and show a "Думає…" pill in the meantime.
  const lastMessage = active?.messages[active.messages.length - 1] ?? null;
  const looksInflight = !!active
    && !sending
    && lastMessage?.role === 'user'
    && Date.now() - Date.parse(lastMessage.createdAt) < 5 * 60 * 1000;

  useEffect(() => {
    if (!looksInflight || !activeId) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const fresh = await fetchConversation(activeId);
        if (!fresh || cancelled) return;
        // Stop polling once the assistant has replied.
        const last = fresh.messages[fresh.messages.length - 1];
        if (last && last.role === 'assistant') {
          setActive(toRender(fresh));
          window.clearInterval(id);
        }
      } catch {
        // Network blip; keep trying.
      }
    }, 3000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [looksInflight, activeId]);

  // Load full conversation when activeId changes (after user picks one
  // from the popover OR after we create a new one via ➕). The
  // length-guard prevents the refetch from clobbering local optimistic
  // updates we may have already applied.
  useEffect(() => {
    if (!activeId) {
      setActive(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const conv = await fetchConversation(activeId);
        if (cancelled) return;
        setActive((prev) => {
          if (
            prev &&
            prev.id === conv?.id &&
            prev.messages.length >= (conv?.messages.length ?? 0)
          ) {
            return prev;
          }
          return conv ? toRender(conv) : null;
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeId]);

  // Autoscroll the log to the bottom on new content. Naive but matches
  // project chat behavior — we'll add scroll-detach later if needed.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active?.messages.length, active?.pendingAssistant, active?.pendingTools.length]);

  const refreshList = useCallback(async () => {
    try {
      const list = await fetchConversations();
      setConversations(list);
    } catch {
      // Best-effort.
    }
  }, []);

  const handleNew = useCallback(async () => {
    setHistoryOpen(false);
    try {
      const conv = await createConversation('');
      setActive(null);
      setActiveId(conv.id);
      setActive(toRender(conv));
      await refreshList();
    } catch {
      // Silent.
    }
  }, [refreshList]);

  const handleSwitch = useCallback((id: string) => {
    if (id === activeId) {
      setHistoryOpen(false);
      return;
    }
    setActive(null);
    setActiveId(id);
    setHistoryOpen(false);
  }, [activeId]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteConversation(id);
    if (activeId === id) {
      setActive(null);
      setActiveId(null);
    }
    await refreshList();
  }, [activeId, refreshList]);

  const ingestFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await uploadAttachments(files);
      setPendingAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  const removeAttachment = useCallback((path: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  // Compose the final message body: user text followed by an
  // attachment manifest the agent can grep / Read. Plain text — no
  // markdown image embedding because Claude Code only opens files via
  // its Read tool, not from inline image URLs.
  const composeMessageBody = useCallback(
    (text: string, attachments: ChatAttachment[]): string => {
      if (attachments.length === 0) return text;
      const lines = [text.trim(), '', 'Прикріплено (доступно через Read у `.od/obsidian-global/`):'];
      for (const a of attachments) {
        lines.push(`- \`${a.path}\` — ${a.name}`);
      }
      return lines.join('\n');
    },
    [],
  );

  const send = useCallback(async (content: string) => {
    const text = content.trim();
    if ((!text && pendingAttachments.length === 0) || sending) return;
    setSending(true);
    setDraft('');
    const attachmentsForThisTurn = pendingAttachments;
    setPendingAttachments([]);
    try {
      const finalBody = composeMessageBody(text, attachmentsForThisTurn);

      let convId = activeId;
      let baseConv = active;
      if (!convId) {
        const created = await createConversation(text.slice(0, 60) || 'Без назви');
        convId = created.id;
        baseConv = toRender(created);
        setActiveId(convId);
        setActive(baseConv);
        await refreshList();
      }
      if (!baseConv) {
        const fresh = await fetchConversation(convId);
        if (!fresh) {
          setSending(false);
          return;
        }
        baseConv = toRender(fresh);
        setActive(baseConv);
      }

      // Optimistic user message so the bubble shows immediately even
      // before the daemon round-trip confirms.
      const optimistic: ChatMessage = {
        id: `pending-${Date.now()}`,
        role: 'user',
        content: finalBody,
        createdAt: new Date().toISOString(),
      };
      setActive((prev) => prev
        ? {
            ...prev,
            messages: [...prev.messages, optimistic],
            pendingAssistant: '',
            pendingTools: [],
            streamError: null,
            pendingStartedAt: Date.now(),
            pendingFinishedAt: null,
          }
        : prev,
      );

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      await streamMessage(convId, finalBody, (event) => {
        setActive((prev) => prev ? applyEvent(prev, event, optimistic.id) : prev);
      }, ctrl.signal);
      // Reconcile final state from server so we pick up the persisted
      // assistant id + auto-title.
      const fresh = await fetchConversation(convId);
      if (fresh) {
        setActive((prev) => prev
          ? { ...toRender(fresh), pendingFinishedAt: prev.pendingFinishedAt, pendingStartedAt: prev.pendingStartedAt }
          : toRender(fresh),
        );
      }
      await refreshList();
    } catch (err) {
      setActive((prev) => prev
        ? {
            ...prev,
            streamError: err instanceof Error ? err.message : String(err),
            pendingFinishedAt: Date.now(),
          }
        : prev,
      );
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [activeId, active, sending, refreshList, pendingAttachments, composeMessageBody]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    void send(draft);
  }, [draft, send]);

  const empty = !active || active.messages.length === 0;
  const visibleMessages = useMemo(
    () => (active ? active.messages : []),
    [active],
  );
  const streaming = sending && active?.pendingFinishedAt == null;

  return (
    <section className="pane obsidian-chat" aria-label="Чат з Клодом">
      <ObsidianCoverageBar />
      <div className="obsidian-chat__head">
        <span className="obsidian-chat__head-title">
          {active?.title ?? 'Чат · Глобальна база'}
        </span>
        <div className="obsidian-chat__head-actions">
          <button
            type="button"
            className="icon-only obsidian-chat__head-btn"
            title="Історія розмов"
            aria-label="Історія розмов"
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <Icon name="history" size={15} />
          </button>
          <button
            type="button"
            className="icon-only obsidian-chat__head-btn"
            title="Нова розмова"
            aria-label="Нова розмова"
            onClick={() => void handleNew()}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
      </div>
      {historyOpen ? (
        <>
          <div
            className="obsidian-chat__history-backdrop"
            onClick={() => setHistoryOpen(false)}
            aria-hidden
          />
          <div className="obsidian-chat__history-popover" role="menu">
            <div className="obsidian-chat__history-head">
              <span className="obsidian-chat__history-head-title">Розмови</span>
              <button
                type="button"
                className="obsidian-chat__history-new"
                onClick={() => void handleNew()}
              >
                <Icon name="plus" size={11} />
                <span>Нова</span>
              </button>
            </div>
            <div className="obsidian-chat__history-list">
              {conversations.length === 0 ? (
                <div className="obsidian-chat__history-empty">Ще немає розмов.</div>
              ) : (
                conversations.map((c) => (
                  <div
                    key={c.id}
                    className={`obsidian-chat__history-row${c.id === activeId ? ' is-active' : ''}`}
                  >
                    <button
                      type="button"
                      className="obsidian-chat__history-pick"
                      onClick={() => handleSwitch(c.id)}
                    >
                      <span className="obsidian-chat__history-title">
                        {c.title || 'Untitled conversation'}
                      </span>
                      <span className="obsidian-chat__history-meta">
                        {relativeTime(c.updatedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="obsidian-chat__history-delete"
                      title="Видалити"
                      aria-label="Видалити розмову"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDelete(c.id);
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}
      <div className="chat-log-wrap">
        <div className="chat-log" ref={logRef}>
          {loading && !active ? (
            <div className="chat-empty-wrap">
              <div className="chat-empty">
                <span className="chat-empty-hint">Завантаження…</span>
              </div>
            </div>
          ) : empty ? (
            <div className="chat-empty-wrap">
              <div className="chat-empty">
                <span className="chat-empty-title">Запитай про програму</span>
                <span className="chat-empty-hint">
                  Клод шукає в обсидіан-базі, фолбекне на код, і за потреби
                  запише нову нотатку. Перший раз може повільно — він читає
                  кілька файлів.
                </span>
              </div>
              <div className="chat-examples" role="list">
                {SUGGESTIONS.map((s, i) => (
                  <button
                    key={s.title}
                    type="button"
                    role="listitem"
                    className="chat-example"
                    style={{ animationDelay: `${i * 70}ms` }}
                    onClick={() => void send(s.title)}
                    title="Натисни щоб поставити це питання"
                  >
                    <span className="chat-example-body">
                      <span className="chat-example-head">
                        <span className="chat-example-title">{s.title}</span>
                        <span className="chat-example-tag">{s.tag}</span>
                      </span>
                    </span>
                    <span className="chat-example-cta" aria-hidden>↵</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {visibleMessages.map((m) => (
                <MessageRow key={m.id} message={m} />
              ))}
              {streaming ? (
                <AssistantStreamingRow
                  pendingAssistant={active.pendingAssistant}
                  pendingTools={active.pendingTools}
                  startedAt={active.pendingStartedAt}
                />
              ) : looksInflight && lastMessage ? (
                <AssistantStreamingRow
                  pendingAssistant={null}
                  pendingTools={[]}
                  startedAt={Date.parse(lastMessage.createdAt)}
                />
              ) : null}
              {active?.streamError ? (
                <div className="msg error">{active.streamError}</div>
              ) : null}
            </>
          )}
        </div>
      </div>
      <form
        className={`obsidian-chat__composer${dropTarget ? ' is-drop-target' : ''}`}
        onSubmit={handleSubmit}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault();
            setDropTarget(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDropTarget(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length > 0) void ingestFiles(files);
        }}
      >
        {pendingAttachments.length > 0 || uploading || uploadError ? (
          <div className="obsidian-chat__attachments">
            {pendingAttachments.map((a) => (
              <AttachmentChip
                key={a.path}
                attachment={a}
                onRemove={() => removeAttachment(a.path)}
              />
            ))}
            {uploading ? (
              <span className="obsidian-chat__attach-status">Завантажую…</span>
            ) : null}
            {uploadError ? (
              <span className="obsidian-chat__attach-error">{uploadError}</span>
            ) : null}
          </div>
        ) : null}
        <div className="obsidian-chat__composer-row">
          <button
            type="button"
            className="icon-only obsidian-chat__head-btn obsidian-chat__attach-btn"
            title="Прикріпити файл"
            aria-label="Прикріпити файл"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Icon name="attach" size={15} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) void ingestFiles(files);
              // Reset value so picking the same file twice still fires onChange.
              e.target.value = '';
            }}
          />
          <textarea
            className="obsidian-chat__textarea"
            placeholder="Запитай про код, файли, фічі…"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData.items);
              const files: File[] = [];
              for (const item of items) {
                if (item.kind === 'file') {
                  const f = item.getAsFile();
                  if (f) files.push(f);
                }
              }
              if (files.length > 0) {
                e.preventDefault();
                void ingestFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            aria-label="Повідомлення для Клода"
            disabled={sending}
          />
          <button
            type="submit"
            className="obsidian-chat__send"
            aria-label={sending ? 'Зупинити' : 'Надіслати'}
            title={sending ? 'Зупинити' : 'Надіслати'}
            disabled={
              !sending &&
              draft.trim().length === 0 &&
              pendingAttachments.length === 0
            }
          >
            <Icon name={sending ? 'stop' : 'send'} size={16} />
          </button>
        </div>
        {dropTarget ? (
          <div className="obsidian-chat__drop-hint" aria-hidden>
            Відпустіть щоб прикріпити
          </div>
        ) : null}
      </form>
    </section>
  );
}

// User or completed-assistant message row — uses the project chat
// classes so it inherits the same bubble look + role/timestamp header.
// Completed assistant messages render the "Готово · 25с · 632 токени"
// footer using ChatPane's `.assistant-footer` markup.
function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="role">
        <span>{isUser ? 'Ви' : 'Claude'}</span>
        <span className="msg-time">{relativeTime(message.createdAt)}</span>
      </div>
      {isUser ? (
        <div className="user-text">{message.content}</div>
      ) : (
        <div className="assistant-flow">
          <div className="prose-block">
            {message.content
              ? renderMarkdown(message.content)
              : '(порожня відповідь)'}
          </div>
          {message.elapsedMs != null || message.outputTokens != null ? (
            <div className="assistant-footer" data-unfinished="false">
              <span className="dot" data-active="false" />
              <span className="assistant-label">
                {message.content ? 'Готово' : 'Порожня відповідь'}
              </span>
              <span className="assistant-stats">
                {[
                  message.elapsedMs != null ? formatElapsedMs(message.elapsedMs) : null,
                  message.outputTokens != null ? `${message.outputTokens} токенів` : null,
                ].filter(Boolean).join(' · ')}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function formatElapsedMs(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}с`;
  if (seconds < 60) return `${Math.round(seconds)}с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}хв`;
  return `${Math.round(seconds / 3600)}год`;
}

// Live-streaming assistant row — shows WaitingPill until the first
// text arrives, then a growing ProseBlock. Tool-use rows are inline
// inside the .assistant-flow so they visually belong to the agent's
// turn, matching ChatPane's layout. The whole row re-renders every
// 250ms while in flight so the elapsed-seconds counter in the footer
// actually ticks (the older WaitingPill-only ticker left the footer
// frozen at "0.0с").
function AssistantStreamingRow({
  pendingAssistant,
  pendingTools,
  startedAt,
}: {
  pendingAssistant: string | null;
  pendingTools: PendingToolEntry[];
  startedAt: number | null;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startedAt == null) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const hasText = (pendingAssistant ?? '').length > 0;
  return (
    <div className="msg assistant">
      <div className="role">
        <span>Claude</span>
        <span className="msg-time">just now</span>
      </div>
      <div className="assistant-flow">
        {!hasText ? (
          <div className="op-waiting">
            <span className="op-waiting-dot" aria-hidden />
            <span className="op-waiting-label">Думає…</span>
          </div>
        ) : null}
        {pendingTools.map((t) => (
          <ToolRow key={t.id} entry={t} />
        ))}
        {hasText ? (
          <div className="prose-block">{renderMarkdown(pendingAssistant ?? '')}</div>
        ) : null}
        <div className="assistant-footer" data-unfinished="false">
          <span className="dot" data-active="true" />
          <span className="assistant-label">Працює</span>
          <span className="assistant-stats">{elapsedLabel(startedAt)}</span>
        </div>
      </div>
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) {
  const isImage = (attachment.mimeType ?? '').startsWith('image/');
  return (
    <span className={`obsidian-chat__chip${isImage ? ' is-image' : ''}`} title={attachment.path}>
      <Icon name={isImage ? 'image' : 'file'} size={12} />
      <span className="obsidian-chat__chip-name">{attachment.name}</span>
      <button
        type="button"
        className="obsidian-chat__chip-remove"
        onClick={onRemove}
        aria-label="Прибрати"
        title="Прибрати"
      >
        <Icon name="close" size={10} />
      </button>
    </span>
  );
}

function ToolRow({ entry }: { entry: PendingToolEntry }) {
  return (
    <div className="obsidian-chat__tool-row" title={entry.toolName}>
      <Icon name="search" size={11} />
      <span>{entry.hint}</span>
    </div>
  );
}

function toRender(conv: ChatConversation): RenderConversation {
  return {
    ...conv,
    pendingAssistant: null,
    pendingTools: [],
    streamError: null,
    pendingStartedAt: null,
    pendingFinishedAt: null,
  };
}

function applyEvent(
  state: RenderConversation,
  event: ChatStreamEvent,
  optimisticUserId: string,
): RenderConversation {
  switch (event.kind) {
    case 'user-message-saved': {
      const hasOptimistic = state.messages.some((m) => m.id === optimisticUserId);
      if (hasOptimistic) {
        return {
          ...state,
          messages: state.messages.map((m) => m.id === optimisticUserId ? event.message : m),
        };
      }
      return { ...state, messages: [...state.messages, event.message] };
    }
    case 'text-delta':
      return {
        ...state,
        pendingAssistant: (state.pendingAssistant ?? '') + (event.text ?? ''),
      };
    case 'tool-use': {
      const hint = describeToolUse(event.toolName, event.toolInput);
      const entry: PendingToolEntry = {
        id: `tool-${Date.now()}-${state.pendingTools.length}`,
        toolName: event.toolName,
        hint,
      };
      return { ...state, pendingTools: [...state.pendingTools, entry] };
    }
    case 'tool-result':
      return state;
    case 'done':
      return {
        ...state,
        pendingTools: [],
        pendingAssistant: null,
        pendingFinishedAt: Date.now(),
      };
    case 'error':
      return {
        ...state,
        streamError: event.detail ?? 'unknown error',
        pendingFinishedAt: Date.now(),
      };
    default:
      return state;
  }
}

function describeToolUse(name: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  if (name === 'Read' && typeof inp.file_path === 'string') {
    return `Читає ${shortenPath(inp.file_path)}`;
  }
  if (name === 'Grep' && typeof inp.pattern === 'string') {
    return `Шукає "${inp.pattern}"`;
  }
  if (name === 'Glob' && typeof inp.pattern === 'string') {
    return `Дивиться файли ${inp.pattern}`;
  }
  if (name === 'Edit' && typeof inp.file_path === 'string') {
    return `Редагує ${shortenPath(inp.file_path)}`;
  }
  if (name === 'Write' && typeof inp.file_path === 'string') {
    return `Записує ${shortenPath(inp.file_path)}`;
  }
  return name;
}

function shortenPath(p: string): string {
  return p.length > 60 ? '…' + p.slice(-60) : p;
}

function elapsedLabel(startedAt: number | null): string {
  if (startedAt == null) return '';
  const seconds = Math.max(0, (Date.now() - startedAt) / 1000);
  if (seconds < 10) return `${seconds.toFixed(1)}с`;
  if (seconds < 60) return `${Math.round(seconds)}с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}хв`;
  return `${Math.round(seconds / 3600)}год`;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diff = Math.max(0, (Date.now() - then) / 1000);
  if (diff < 60) return `${Math.max(1, Math.round(diff))}с`;
  if (diff < 3600) return `${Math.round(diff / 60)}хв`;
  if (diff < 86400) return `${Math.round(diff / 3600)}год`;
  return `${Math.round(diff / 86400)}д`;
}
