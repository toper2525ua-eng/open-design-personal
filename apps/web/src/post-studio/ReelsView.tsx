import { useMemo } from 'react';

import type { Project } from '../types';
import './reels-view.css';

interface ReelsViewProps {
  projects: readonly Project[];
  loading?: boolean;
  onOpenProject: (id: string) => Promise<boolean> | boolean | void;
  onCreate: () => void;
}

/**
 * Список роликів — вхід у пост-режим із лівої панелі.
 *
 * Показує тільки відео-проєкти, а не всі підряд: сюди приходять робити
 * рілс, і решта проєктів тут була б шумом. Сам режим (превʼю + блоки)
 * живе всередині проєкту — цей екран лише вибирає, який відкрити.
 */
export function ReelsView({ projects, loading = false, onOpenProject, onCreate }: ReelsViewProps) {
  const reels = useMemo(
    () => projects.filter((p) => p.metadata?.kind === 'video'),
    [projects],
  );

  return (
    <div className="entry-section">
      <header className="entry-section__head">
        <h1 className="entry-section__title">Пост Instagram</h1>
        <button type="button" className="btn" onClick={onCreate}>Новий ролик</button>
      </header>

      {loading ? (
        <div className="post-ws__hint">Читаю проєкти…</div>
      ) : reels.length === 0 ? (
        <div className="post-ws__hint" style={{ maxWidth: 460, lineHeight: 1.6 }}>
          Роликів ще немає. Створи перший — усередині будуть звук, транскрипція, ведучий
          і стікери, а Клод працюватиме з тим самим станом, що бачиш ти.
        </div>
      ) : (
        <div className="reels-grid">
          {reels.map((project) => (
            <button
              key={project.id}
              type="button"
              className="reels-card"
              onClick={() => void onOpenProject(project.id)}
            >
              <span className="reels-card__frame" aria-hidden />
              <span className="reels-card__name">{project.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
