import { describe, expect, it } from 'vitest';

import { mediaExecutionPolicyForProjectMetadata } from '../../src/media/execution-policy';

describe('media execution policy for project metadata', () => {
  it('keeps image projects without an explicit model enabled so the agent can ask', () => {
    expect(mediaExecutionPolicyForProjectMetadata({ kind: 'image' })).toEqual({
      mode: 'enabled',
      allowedSurfaces: ['image'],
    });
  });

  it('scopes media projects to their selected model when one is present', () => {
    expect(mediaExecutionPolicyForProjectMetadata({
      kind: 'image',
      imageModel: 'gpt-image-2',
    })).toEqual({
      mode: 'enabled',
      allowedSurfaces: ['image'],
      allowedModels: ['gpt-image-2'],
    });
  });

  // Ролик майже завжди складається зі згенерованих картинок — ведучий,
  // стікери, вставки. Дозвіл лише на video ламав саме цей сценарій:
  // генерація пози падала з MEDIA_SURFACE_DENIED.
  it('lets video projects generate images too', () => {
    expect(mediaExecutionPolicyForProjectMetadata({ kind: 'video' })).toEqual({
      mode: 'enabled',
      allowedSurfaces: ['video', 'image'],
    });
  });

  // Список моделей звужує дозвіл, тож одна відеомодель заблокувала б
  // генерацію картинок. Обмежуємо лише коли відомі обидві.
  it('does not narrow models when a video project has no image model', () => {
    expect(mediaExecutionPolicyForProjectMetadata({
      kind: 'video',
      videoModel: 'seedance-2.0',
    })).toEqual({
      mode: 'enabled',
      allowedSurfaces: ['video', 'image'],
    });
  });

  it('scopes a video project to both models when both are known', () => {
    expect(mediaExecutionPolicyForProjectMetadata({
      kind: 'video',
      videoModel: 'seedance-2.0',
      imageModel: 'gemini-2.5-flash-image',
    })).toEqual({
      mode: 'enabled',
      allowedSurfaces: ['video', 'image'],
      allowedModels: ['seedance-2.0', 'gemini-2.5-flash-image'],
    });
  });
});
