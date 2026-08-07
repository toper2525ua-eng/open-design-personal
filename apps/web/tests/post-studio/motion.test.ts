import { describe, expect, it } from 'vitest';

import {
  accentPunch,
  badgePop,
  BADGE_MAX_LIVE,
  ENTER_S,
  GLOW_REST,
  liveBadges,
  stickerEnter,
  labelPop,
  LABEL_DELAY_S,
  PUNCH_DUR_S,
  stickerDrift,
  wordGlow,
  type WordTiming,
} from '../../src/post-studio/post-spec';

const word = (start: number, end: number, accent = false): WordTiming => ({
  word: 'тест',
  start,
  end,
  ...(accent ? { accent: true } : {}),
});

describe('wordGlow', () => {
  const w = word(1, 1.4);

  it('мовчить до слова і тримає одиницю поки воно звучить', () => {
    expect(wordGlow(0.9, w)).toBe(0);
    expect(wordGlow(1.3, w)).toBe(1);
  });

  it('осідає на рівень спокою, а не в нуль', () => {
    // Слід щойно сказаного — те, заради чого й потрібна обвідна: без
    // нього в рядку світиться рівно одне слово, і мова не читається.
    expect(wordGlow(5, w)).toBe(GLOW_REST);
    expect(GLOW_REST).toBeGreaterThan(0);
  });

  it('спадає монотонно від кінця слова до спокою', () => {
    const a = wordGlow(1.45, w);
    const b = wordGlow(1.6, w);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(GLOW_REST);
  });
});

describe('accentPunch', () => {
  const words = [word(0.5, 0.8), word(2, 2.4, true)];

  it('поза акцентним словом кадр стоїть', () => {
    expect(accentPunch(0.6, words)).toBe(0);
    expect(accentPunch(2 + PUNCH_DUR_S, words)).toBe(0);
  });

  it('спершу стискає, потім віддає з перельотом', () => {
    expect(accentPunch(2.05, words)).toBeLessThan(0);
    expect(accentPunch(2.16, words)).toBeGreaterThan(0);
  });

  it('не має розриву на межах фаз', () => {
    // Найдорожча помилка такої обвідної — стрибок на стику фаз: у кадрі
    // він читається не як удар, а як зрив картинки на один кадр.
    // Крок починається ДО вікна: вхід у нього — така сама межа, як стик
    // фаз усередині, і саме на ньому обвідна найлегше стрибає з нуля.
    let prev = accentPunch(1.95, words);
    for (let t = 1.95; t <= 2 + PUNCH_DUR_S + 0.02; t += 0.004) {
      const cur = accentPunch(t, words);
      expect(Math.abs(cur - prev)).toBeLessThan(0.02);
      prev = cur;
    }
    expect(prev).toBe(0);
  });

  it('не смикає кадр на звичайних словах', () => {
    expect(accentPunch(0.55, [word(0.5, 0.8)])).toBe(0);
  });
});

describe('labelPop', () => {
  it('чекає, поки прилетить картинка', () => {
    expect(labelPop(0).opacity).toBe(0);
    expect(labelPop(LABEL_DELAY_S).opacity).toBe(0);
  });

  it('доходить до повної видимості й свого розміру', () => {
    const end = labelPop(2);
    expect(end.opacity).toBe(1);
    expect(end.scale).toBeCloseTo(1, 5);
    expect(end.lift).toBe(0);
  });

  it('сідає з перельотом, а не під’їжджає рівно', () => {
    const mid = labelPop(LABEL_DELAY_S + 0.15);
    expect(mid.scale).toBeGreaterThan(0.93);
  });
});

describe('stickerDrift', () => {
  it('дає сусідам різний кут, тривалість і фазу', () => {
    const a = stickerDrift(0);
    const b = stickerDrift(1);
    expect(a.tilt).not.toBe(b.tilt);
    expect(a.dur).not.toBe(b.dur);
    expect(a.delay).not.toBe(b.delay);
  });

  it('той самий номер дає той самий дрейф', () => {
    // Розводимо таблицею, а не випадковим числом: інакше кожен прогін
    // малював би інший кадр, і рендер не збігався б із превʼю.
    expect(stickerDrift(7)).toEqual(stickerDrift(7));
  });

  it('переживає індекс поза таблицею', () => {
    expect(stickerDrift(12).tilt).toMatch(/deg$/);
  });
});

describe('stickerEnter', () => {
  it('instant стоїть із першого кадру', () => {
    // Поки перший стікер думки виростає, глядач дивиться на порожнечу —
    // а на початку речення саме ці частки секунди й вирішують.
    expect(stickerEnter('instant', 0)).toEqual({ x: 0, scale: 1, opacity: 1 });
  });

  it('pop виростає з перельотом і осідає на одиницю', () => {
    expect(stickerEnter('pop', 0).scale).toBeCloseTo(0.8, 3);
    expect(stickerEnter('pop', ENTER_S * 0.68).scale).toBeCloseTo(1.06, 3);
    expect(stickerEnter('pop', ENTER_S).scale).toBeCloseTo(1, 3);
  });

  it('бічний вхід приїжджає з-за краю і проскакує ціль', () => {
    expect(stickerEnter('from-right', 0).x).toBeGreaterThan(2);
    expect(stickerEnter('from-right', ENTER_S * 0.8).x).toBeLessThan(0);
    expect(stickerEnter('from-right', ENTER_S).x).toBeCloseTo(0, 3);
    expect(stickerEnter('from-left', 0).x).toBeLessThan(-2);
  });

  it('вхід не має розриву на стику фаз', () => {
    for (const kind of ['pop', 'from-right'] as const) {
      let prev = stickerEnter(kind, 0);
      for (let t = 0; t <= ENTER_S + 0.02; t += 0.004) {
        const cur = stickerEnter(kind, t);
        expect(Math.abs(cur.x - prev.x)).toBeLessThan(0.2);
        expect(Math.abs(cur.scale - prev.scale)).toBeLessThan(0.05);
        prev = cur;
      }
    }
  });
});

describe('liveBadges', () => {
  const words: WordTiming[] = [word(0, 0.4), word(1, 1.4), word(2, 2.4), word(3, 3.4)];
  const badges = [
    { text: '−10 хв', at: 1 },
    { text: '−10 хв', at: 2 },
    { text: '−10 хв', at: 3 },
  ];

  it('вилітають по одному і НЕ зникають', () => {
    expect(liveBadges(badges, words, 0.5)).toHaveLength(0);
    expect(liveBadges(badges, words, 1.1)).toHaveLength(1);
    expect(liveBadges(badges, words, 2.1)).toHaveLength(2);
    expect(liveBadges(badges, words, 3.1)).toHaveLength(3);
  });

  it('тримає не більше стелі — інакше стовп замість акценту', () => {
    const many = Array.from({ length: 8 }, () => ({ text: '×', at: 1 }));
    expect(liveBadges(many, words, 5)).toHaveLength(BADGE_MAX_LIVE);
  });

  it('без бейджів і без слова нічого не показує', () => {
    expect(liveBadges(undefined, words, 5)).toEqual([]);
    expect(liveBadges([{ text: 'x', at: 99 }], words, 5)).toEqual([]);
  });
});
