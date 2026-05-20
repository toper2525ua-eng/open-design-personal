// Placeholder view for the Obsidian integration. The button + route slot
// are wired up so future functionality (notes sync, vault picker, deploy
// to Obsidian, etc.) can land without touching the upstream EntryNavRail
// or EntryShell again. Copy is Ukrainian-only by design — this is a
// fork-specific feature and the upstream i18n contract is not extended.

export function ObsidianView() {
  return (
    <div className="entry-section">
      <header className="entry-section__head">
        <h1 className="entry-section__title">Обсидіан</h1>
      </header>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px 24px',
          textAlign: 'center',
          color: 'var(--text-muted)',
        }}
      >
        <div style={{ fontSize: 56, marginBottom: 16 }}>🪨</div>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
          Скоро
        </h2>
        <p style={{ maxWidth: 480, fontSize: 14, lineHeight: 1.5, margin: 0 }}>
          Тут зʼявиться інтеграція з Obsidian — синхронізація нотаток, пікер сховища
          (vault), деплой Markdown-файлів з ваших Open Design-проєктів у заметки.
          Функціонал буде доданий пізніше.
        </p>
      </div>
    </div>
  );
}
