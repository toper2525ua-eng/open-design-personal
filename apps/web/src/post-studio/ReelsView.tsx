import { useEffect, useMemo, useState } from 'react';

import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@open-design/components';

import { fetchProjectFiles } from '../providers/registry';
import type { Project } from '../types';
import './reels-view.css';

interface ReelsViewProps {
  projects: readonly Project[];
  loading?: boolean;
  onOpenProject: (id: string) => Promise<boolean> | boolean | void;
  onCreate: () => void;
  onDelete: (id: string) => Promise<boolean | void> | boolean | void;
}

/**
 * Кадр із готового ролика замість сірої заглушки.
 *
 * Час — 0.1 с, а не нуль: на нульовій секунді кадр ще порожній (перший
 * предмет заходить пізніше), і всі картки виглядали б однаково білими.
 * Позицію ставимо в onLoadedMetadata, а не тільки через `#t=`: фрагмент
 * розуміють не всі рушії, і там, де його ігнорують, лишався б той самий
 * порожній нуль.
 *
 * Ролика може ще не бути — проєкт створений, але не відрендерений. Тоді
 * onError лишає заглушку, а не показує зламану іконку.
 */
function ReelFrame({ projectId }: { projectId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchProjectFiles(projectId).then((files) => {
      if (!alive) return;
      const clips = files.filter((f) => /\.mp4$/i.test(f.name));
      if (clips.length === 0) {
        setFailed(true);
        return;
      }
      // Готовий ролик зветься post.mp4; у старших проєктах — як завгодно,
      // тому запасний варіант — найсвіжіший файл, а не перший за абеткою.
      const pick = clips.find((f) => f.name === 'post.mp4')
        ?? [...clips].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0]!;
      const path = pick.name.split('/').map(encodeURIComponent).join('/');
      setSrc(`/api/projects/${encodeURIComponent(projectId)}/raw/${path}#t=0.1`);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  if (failed || !src) return <span className="reels-card__frame" aria-hidden />;
  return (
    <video
      className="reels-card__frame"
      src={src}
      preload="metadata"
      muted
      playsInline
      aria-hidden
      onLoadedMetadata={(e) => {
        e.currentTarget.currentTime = 0.1;
      }}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Список роликів — вхід у пост-режим із лівої панелі.
 *
 * Показує тільки відео-проєкти, а не всі підряд: сюди приходять робити
 * рілс, і решта проєктів тут була б шумом. Сам режим (превʼю + блоки)
 * живе всередині проєкту — цей екран лише вибирає, який відкрити.
 */
export function ReelsView({
  projects,
  loading = false,
  onOpenProject,
  onCreate,
  onDelete,
}: ReelsViewProps) {
  // Порядок — за датою СТВОРЕННЯ, найновіші зверху. За часом останньої
  // зміни картки перестрибували від самого лише відкриття проєкту: зайшов
  // подивитись — і ролик поїхав на початок, а список щоразу інший.
  const reels = useMemo(
    () => projects
      .filter((p) => p.metadata?.kind === 'video')
      .slice()
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [projects],
  );
  const [confirmTarget, setConfirmTarget] = useState<Project | null>(null);

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
            // Картка — не <button>: усередині живе кнопка видалення, а
            // кнопка в кнопці недійсна в розмітці й ламає клавіатуру.
            <div key={project.id} className="reels-card">
              <button
                type="button"
                className="reels-card__open"
                onClick={() => void onOpenProject(project.id)}
              >
                <ReelFrame projectId={project.id} />
                <span className="reels-card__name">{project.name}</span>
              </button>
              <button
                type="button"
                className="reels-card__del"
                title="Видалити ролик"
                aria-label={`Видалити ролик «${project.name}»`}
                onClick={() => setConfirmTarget(project)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {confirmTarget ? (
        <Dialog
          className="modal-confirm"
          role="alertdialog"
          onClose={() => setConfirmTarget(null)}
          ariaLabelledBy="reels-delete-title"
        >
          <DialogTitle id="reels-delete-title">Видалити ролик?</DialogTitle>
          <DialogDescription className="modal-confirm-message">
            «{confirmTarget.name}» піде разом з усім, що в ньому: звуком, розміткою
            і готовим файлом. Скасувати не вийде.
          </DialogDescription>
          <DialogFooter className="row">
            <button type="button" onClick={() => setConfirmTarget(null)}>Скасувати</button>
            <button
              type="button"
              className="primary danger"
              autoFocus
              onClick={() => {
                const id = confirmTarget.id;
                setConfirmTarget(null);
                void Promise.resolve(onDelete(id)).catch((err) => {
                  console.warn('Failed to delete reel project', err);
                });
              }}
            >
              Видалити
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </div>
  );
}
