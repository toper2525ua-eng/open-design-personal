// Visual stub of the chat pane that mirrors ChatPane styling without
// the project-bound state. Phase A renders a fixed empty state with a
// few suggested questions; the composer is a plain textarea that does
// not send anywhere. Phase C will replace this with a real chat session
// pointed at the global Obsidian knowledge base.

import { useState } from 'react';

import { Icon } from '../../components/Icon';

interface Props {
  onPickSuggestion?: (text: string) => void;
}

const SUGGESTIONS = [
  'Де описана auto-updater логіка?',
  'Які downstream-фічі є зараз?',
  'Як працює tg-web деплой?',
  'Куди писати нові API-роути даемона?',
];

export function ObsidianChatStub({ onPickSuggestion }: Props) {
  const [draft, setDraft] = useState('');

  return (
    <section className="pane obsidian-chat" aria-label="Чат з Клодом">
      <div className="obsidian-chat__head">
        <span className="obsidian-chat__head-title">Чат · Глобальна база</span>
        <div className="obsidian-chat__head-actions">
          <button
            type="button"
            className="obsidian-chat__head-btn"
            title="Історія розмов (скоро)"
            aria-label="Історія розмов"
            disabled
          >
            <Icon name="history" size={15} />
          </button>
          <button
            type="button"
            className="obsidian-chat__head-btn"
            title="Нова розмова (скоро)"
            aria-label="Нова розмова"
            disabled
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
      </div>
      <div className="obsidian-chat__log">
        <div className="obsidian-chat__empty">
          <span className="obsidian-chat__empty-title">Запитай про програму</span>
          <span className="obsidian-chat__empty-hint">
            Клод буде читати глобальну Обсидіан-базу і відповідати, де що
            знаходиться у проєкті. Підключення — у наступній фазі.
          </span>
          <div className="obsidian-chat__suggestions" role="list">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                role="listitem"
                className="obsidian-chat__suggestion"
                onClick={() => {
                  setDraft(s);
                  onPickSuggestion?.(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
      <form
        className="obsidian-chat__composer"
        onSubmit={(e) => {
          e.preventDefault();
          // No-op in Phase A.
        }}
      >
        <textarea
          className="obsidian-chat__textarea"
          placeholder="Запитай про код, файли, фічі…"
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled
          aria-label="Повідомлення для Клода"
        />
        <button
          type="submit"
          className="obsidian-chat__send"
          aria-label="Надіслати"
          title="Надіслати (буде доступно у Фазі C)"
          disabled
        >
          <Icon name="send" size={16} />
        </button>
      </form>
    </section>
  );
}
