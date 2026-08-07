import type { MediaExecutionPolicy } from '@open-design/contracts';
import type { ProjectMetadata } from '../types';

function cleanModel(model: unknown): string {
  return typeof model === 'string' ? model.trim() : '';
}

export function mediaExecutionPolicyForProjectMetadata(
  metadata: ProjectMetadata | null | undefined,
): MediaExecutionPolicy | undefined {
  if (!metadata) return undefined;
  if (metadata.kind === 'image') {
    const model = cleanModel(metadata.imageModel);
    return model
      ? { mode: 'enabled', allowedSurfaces: ['image'], allowedModels: [model] }
      : { mode: 'enabled', allowedSurfaces: ['image'] };
  }
  if (metadata.kind === 'video') {
    const video = cleanModel(metadata.videoModel);
    const image = cleanModel(metadata.imageModel);
    // Відеопроєкту картинки потрібні за визначенням: ведучий, стікери,
    // кадри-вставки. Заборона image-surface означає, що ролик зі
    // згенерованих елементів не зібрати взагалі — генерація падає з
    // MEDIA_SURFACE_DENIED ще до звернення до провайдера.
    const allowedSurfaces: MediaExecutionPolicy['allowedSurfaces'] = ['video', 'image'];
    // Список моделей звужує дозвіл, тому обмежуємо лише коли відомі
    // обидві. Інакше одна відеомодель у списку заблокує будь-яку
    // генерацію картинок — та сама помилка, тільки на рівні моделі.
    return video && image
      ? { mode: 'enabled', allowedSurfaces, allowedModels: [video, image] }
      : { mode: 'enabled', allowedSurfaces };
  }
  if (metadata.kind === 'audio') {
    const model = cleanModel(metadata.audioModel);
    return model
      ? { mode: 'enabled', allowedSurfaces: ['audio'], allowedModels: [model] }
      : { mode: 'enabled', allowedSurfaces: ['audio'] };
  }
  return undefined;
}
