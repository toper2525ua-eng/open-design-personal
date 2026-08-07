import { describe, expect, it } from 'vitest';

import {
  SCENE_MAX_S,
  sceneAt,
  sceneSpan,
  sceneText,
  sliceScenes,
  stickerLayout,
  stickerSpans,
  type WordTiming,
} from '../../src/post-studio/post-spec';

/** Рівна мова: слова по `dur` секунд із паузою `gap` після кожного. */
function track(spec: { word: string; gap?: number }[], dur = 0.4): WordTiming[] {
  const out: WordTiming[] = [];
  let t = 0;
  for (const s of spec) {
    out.push({ word: s.word, start: t, end: t + dur });
    t += dur + (s.gap ?? 0.05);
  }
  return out;
}

describe('sliceScenes', () => {
  it('порожня доріжка не дає жодного речення', () => {
    expect(sliceScenes([])).toEqual([]);
  });

  it('покриває всі слова без дірок і накладань', () => {
    // Головний інваріант: кожне слово належить рівно одному реченню.
    // Дірка означає слово, яке не побачить жоден підбір картинки.
    const words = track([
      { word: 'один' }, { word: 'два' }, { word: 'три' }, { word: 'чотири', gap: 0.6 },
      { word: 'пʼять' }, { word: 'шість' }, { word: 'сім' }, { word: 'вісім', gap: 0.6 },
      { word: 'девʼять' }, { word: 'десять' },
    ]);
    const scenes = sliceScenes(words);
    expect(scenes[0]!.from).toBe(0);
    expect(scenes[scenes.length - 1]!.to).toBe(words.length - 1);
    for (let i = 1; i < scenes.length; i += 1) {
      expect(scenes[i]!.from).toBe(scenes[i - 1]!.to + 1);
    }
  });

  it('ріже там, де диктор тримає паузу', () => {
    const words = track([
      { word: 'перше' }, { word: 'речення' }, { word: 'думки' }, { word: 'кінець', gap: 0.7 },
      { word: 'друге' }, { word: 'речення' },
    ]);
    const scenes = sliceScenes(words);
    expect(scenes).toHaveLength(2);
    expect(scenes[0]!.to).toBe(3);
  });

  it('не ріже на дрібній паузі всередині думки', () => {
    const words = track([
      { word: 'слово' }, { word: 'ще', gap: 0.12 }, { word: 'одне' }, { word: 'і' },
    ]);
    expect(sliceScenes(words)).toHaveLength(1);
  });

  it('не робить реченням одне слово перед короткою паузою', () => {
    // Пунктуація сама по собі не межа: диктор проскакує крапку, коли
    // фраза йде на одному подиху.
    const words = track([
      { word: 'Так.', gap: 0.3 }, { word: 'далі' }, { word: 'думка' }, { word: 'триває' },
    ]);
    expect(sliceScenes(words)[0]!.from).toBe(0);
    expect(sliceScenes(words)).toHaveLength(1);
  });

  it('розриває надто довгу думку примусово', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ word: `сл${i}` }));
    const words = track(many);
    const scenes = sliceScenes(words);
    expect(scenes.length).toBeGreaterThan(1);
    for (const sc of scenes.slice(0, -1)) {
      const { start, end } = sceneSpan(sc, words);
      expect(end - start).toBeLessThanOrEqual(SCENE_MAX_S + 1);
    }
  });
});

describe('sceneSpan / sceneText / sceneAt', () => {
  const words = track([
    { word: 'думка' }, { word: 'перша', gap: 0.7 }, { word: 'думка' }, { word: 'друга' },
  ]);
  const scenes = sliceScenes(words);

  it('час і текст виводяться зі слів, а не зберігаються', () => {
    const span = sceneSpan(scenes[0]!, words);
    expect(span.start).toBe(words[0]!.start);
    expect(span.end).toBe(words[scenes[0]!.to]!.end);
    expect(sceneText(scenes[0]!, words)).toBe('думка перша');
  });

  it('знаходить, яка думка звучить зараз', () => {
    expect(sceneAt(scenes, words, 0.1)?.index).toBe(0);
    expect(sceneAt(scenes, words, 999)).toBeNull();
  });
});

describe('stickerLayout', () => {
  const words: WordTiming[] = [
    { word: 'а', start: 0, end: 0.4 },
    { word: 'б', start: 1, end: 1.4 },
  ];

  it('двоє в кадрі помітно дрібніші за одного', () => {
    // Один предмет це подія, двоє це вже схема: схему око охоплює
    // цілком, і її частини мають бути меншими, інакше кадр розпирає.
    const one = stickerLayout(
      stickerSpans([{ id: 'a', word: 0, hold: 3 }], words), 0.5, 0.42);
    const two = stickerLayout(
      stickerSpans([{ id: 'a', word: 0, hold: 3 }, { id: 'b', word: 1, hold: 3 }], words), 1.5, 0.42);
    expect(two).toHaveLength(2);
    expect(two[0]!.width).toBeLessThan(one[0]!.width * 0.95);
  });

  it('усі вміщаються в кадр із проміжками', () => {
    const many = [0, 1].map((w, i) => ({ id: `s${i}`, word: w, hold: 3 }));
    const live = stickerLayout(stickerSpans(many, words), 1.5, 0.42);
    const last = live[live.length - 1]!;
    expect(live[0]!.left).toBeGreaterThan(0);
    expect(last.left + last.width).toBeLessThan(1);
  });
});

describe('lead', () => {
  it('дозволяє стати в кадр раніше за своє слово', () => {
    // Перше слово ролика звучить не на нулі, і поки до нього дійде,
    // глядач уже бачив порожній кадр.
    const words: WordTiming[] = [{ word: 'Ти', start: 0.14, end: 0.26 }];
    const [span] = stickerSpans([{ id: 'you', word: 0, hold: 4, lead: 0.2 }], words);
    expect(span!.start).toBe(0);
  });
});
