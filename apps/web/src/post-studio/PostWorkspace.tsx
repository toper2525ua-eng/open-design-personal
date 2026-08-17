import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  isOpenDesignHostAvailable,
  openHostProjectPath,
} from '@open-design/host';

import { uploadProjectFiles } from '../providers/registry';
import { LottieSticker } from './LottieSticker';
import {
  AUDIO_RE,
  accentPunch,
  CANVAS,
  cardAt,
  cardMotion,
  cardRevealCount,
  checkPost,
  DEFAULT_PRESET,
  emptyPost,
  PRESETS,
  labelPop,
  liveBadges,
  badgePop,
  badgePopSlide,
  badgeRankFade,
  BADGE_H_PX,
  BADGE_ROOM,
  BADGE_HALF,
  BADGE_EDGE,
  postStage,
  sceneSpan,
  sceneText,
  sliceScenes,
  SPEEDS,
  STICKER_EXIT_LEAD_S,
  STICKER_MAX_LIVE,
  STICKER_RE,
  stickerDrift,
  stickerEnter,
  stickerExit,
  stickerLayout,
  stickerSpans,
  wordGlow,
  demoPost,
  MOTION_GROUPS,
  ARROW_SLOTS,
  isNftCard,
  NFT_CARD_SLOT,
  ornamentPop,
  ORNAMENT_TONE_COLOR,
  TG_PATTERN_GIFT,
  TG_CARD_RADIUS_DP,
  TG_RIBBON_SIZE_DP,
  TG_RIBBON_PATH_D,
  TG_RIBBON_TEXT_DP,
  TG_RIBBON_TEXT_MAX_W_DP,
  TG_RIBBON_HSV_SAT,
  TG_RIBBON_HSV_VAL,
  TG_ICON_STAR_D,
  tgAdaptHsv,
  prand,
  cardStickerFly,
  type Beat,
  type CardSticker,
  type CardStep,
  type MotionEntry,
  type MotionGroup,
  type PostSpec,
  type Sticker,
  type StickerOrnament,
  type StickerSprite,
  type WordTiming,
} from './post-spec';

/*
 * Стилів цей файл НЕ імпортує — post-studio.css підключений у
 * app/layout.tsx, і це навмисно.
 *
 * Fast Refresh губить стильовий чанк, коли підмінює модуль, який його
 * імпортує: після кожної правки студія розсипалась (кадр на всю ширину,
 * велетенська сітка, злиплий бар) і лікувалась тільки перезавантаженням.
 * Спершу ми списали це на два імпортери й розвели файли — не допомогло,
 * бо річ у самій підміні. Layout не підміняється ніколи, тож стилі
 * тримаються.
 *
 * Не переносьте import сюди «щоб було поруч» — симптом повернеться.
 */

interface PostFile {
  name: string;
  kind?: string;
  /** Час зміни — ним перебиваємо кеш браузера на перезаписаних картинках. */
  mtime?: number;
}

interface PostWorkspaceProps {
  projectId: string;
  files: readonly PostFile[];
  onUpload: () => void;
  onRefreshFiles: () => Promise<void> | void;
  /** Кидає готовий запит у чат — так блоки керують Клодом. */
  onAskClaude?: (prompt: string) => void;
  /** Повернутись до звичайного файлового воркспейсу. */
  onExit?: () => void;
}

const POST_FILE = 'post.json';
const WORDS_RE = /(^|[\\/])words\.json$/i;
const POSES_RE = /(^|[\\/])poses\.json$/i;
const POSE_RE = /(^|[\\/])(assets[\\/])?character[\\/].*\.(png|webp)$/i;

// Ведучий один на всі ролики, тому живе у спільній бібліотеці, а не в
// окремому проєкті. Реєстр лежить там під тегом `<TAG>,registry`, самі
// пози — під `<TAG>,<pose-id>`. Тег складений через кому навмисно:
// `od library import --tag` не накопичується, другий затирає перший.
const LIBRARY_HOST_TAG = 'reels-host';

// Те саме для НАБОРУ СТІКЕРІВ. Раніше набір жив тільки у теці свого
// проєкту, тож другий ролик відкривався з порожньою бібліотекою
// («Реєстр не знайдено»), і агент малював усе заново — щоразу в новій
// манері. Один стікер, вдаліший сам по собі, але іншого набору, псує
// кадр сильніше за посередній свій, тому набір має бути наскрізним.
const LIBRARY_STICKER_TAG = 'reels-sticker';

/**
 * Запис каталогу подарунків Telegram (`<data>/gifts/gifts.json`).
 *
 * `kind` — два види, які глядач плутає, а ролик мусить розрізняти:
 * `star` — подарунок за зірки з магазину (конвертується назад у зірки),
 * `nft` — колекційний після апгрейду (унікальний, живе на TON).
 * Довідник для сценаріїв — `references/gifts-nft.md` у плагіні.
 */
interface GiftItem {
  slug: string;
  emoji?: string;
  title?: string;
  /** Для чого брати в ролик — те саме поле, що в реєстрі стікерів. */
  use?: string;
  kind: 'star' | 'nft';
  customEmojiId?: string;
}

/** Запис із poses.json — реєстр ведучого, який росте між роликами. */
interface PoseEntry {
  id: string;
  file: string;
  /** Ассет у спільній бібліотеці; є, коли позу туди імпортували. */
  libraryId?: string;
  gesture?: string;
  /** Для чого поза: «питання до глядача», «висновок»… */
  use?: string;
  /** Нотатка про якість; «розходиться» означає дрейф від еталона. */
  quality?: string;
}

/** Картка пози в сітці — байдуже, з проєкту вона чи з бібліотеки. */
interface PoseCard {
  key: string;
  src: string;
  /** Чим адресувати позу в промпті до Клода. */
  ref: string;
  entry?: PoseEntry;
  /** Файл лежить у проєкті — таку позу можна віддати в i2i напряму. */
  inProject: boolean;
}

/**
 * Запис реєстру `assets/stickers/stickers.json`.
 *
 * Запис БЕЗ `file` — це заявка: агент шукав картинку під фразу, нічого
 * не підійшло, і він лишив бриф замість того, щоб мовчки взяти
 * приблизне. Саме такі рядки й показує блок бібліотеки окремим списком.
 */
interface RegistryEntry {
  id: string;
  file?: string;
  shows?: string;
  use?: string;
  /** object — предмет · screen — інтерфейс · avatar — глядач і його речі. */
  kind?: 'object' | 'screen' | 'avatar';
  status?: 'needed';
  brief?: string;
  folder?: string;
  /** Спрайт-аркуш (подарунки Telegram) — розкладка кадрів у PNG. */
  sprite?: StickerSprite;
  /**
   * Ассет у спільній бібліотеці. Рівно те саме поле й та сама роль, що в
   * реєстрі поз: без нього набір лишається всередині одного проєкту, і
   * НАСТУПНИЙ ролик починає з порожнього місця — а це означає нові стікери
   * в новій манері замість одного набору.
   */
  libraryId?: string;
}

/**
 * Розділи бібліотеки. Порядок — від найзагальнішого до найвужчого:
 * предмети ходять між роликами, екрани чекають переробки в сторінки,
 * аватар один на всі ролики.
 */
const KINDS = [
  {
    kind: 'object' as const,
    title: 'Предмети',
    hint: 'Річ або метафора — те, що модель малює добре.',
  },
  {
    kind: 'screen' as const,
    title: 'Екрани',
    hint: 'Інтерфейси. Кандидати на переробку в картки: розмітка читається краще за растр.',
  },
  {
    kind: 'avatar' as const,
    title: 'Глядач',
    hint: '«Ти» і твої речі. Наскрізні між роликами, дію не міняють — її дають пігулка й бейджі.',
  },
];

function rawUrl(projectId: string, filePath: string): string {
  return `/api/projects/${projectId}/raw/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

/*
 * Стан рендера з демона. Студія сама запускає рендер і сама показує
 * готовий файл — без повідомлень агенту і без «дай посилання, де файл».
 */
interface RenderStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  error: string | null;
  tail: string;
  out: { name: string; size: number; mtimeMs: number } | null;
  dir: string | null;
}

/*
 * Стан таймкодів з демона. Заливка mp3 сама запускає forced alignment —
 * обов'язковий чат-крок кожного ролика («залив mp3, зроби таймкоди»)
 * зник: рішень у ньому не було. Слова в post.json переносить демон,
 * студія підхоплює їх звичайним поллером post.json.
 */
interface AlignStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  startedAt: number | null;
  error: string | null;
  report: { words?: number; worst_loss?: number; warning?: string } | null;
}

/*
 * Прогрес — із хвоста лога: render.py пише «  12.0 с / 31.0» кожні
 * 5 с відео і «ffmpeg…» перед склейкою. Парсимо текст, а не заводимо
 * окремий протокол: лог і так пишеться, а формат рядків — наш власний.
 */
function renderProgress(tail: string): string {
  // «frame=» — прогрес самого ffmpeg: на довгій склейці рядок «ffmpeg…»
  // від render.py випадає з 4-кілобайтного хвоста, і без цієї ознаки
  // напис відкочувався б на «знімаємо кадри…».
  if (tail.includes('ffmpeg') || tail.includes('frame=')) return 'склейка mp4…';
  const marks = [...tail.matchAll(/^\s*([\d.]+) с \/ ([\d.]+)/gm)];
  const last = marks[marks.length - 1];
  if (last) {
    const num = Number(last[1]);
    const den = Number(last[2]);
    if (den > 0) return `${Math.min(99, Math.round((num / den) * 100))}%`;
  }
  return 'знімаємо кадри…';
}

// «щойно» чесніше за «0 хв тому», а після години точний час корисніший
// за «73 хв»: рендерів на день кілька, і питання завжди «це той файл?»
function fileAge(mtimeMs: number): string {
  const d = Date.now() - mtimeMs;
  if (d < 90_000) return 'щойно';
  if (d < 3_600_000) return `${Math.round(d / 60_000)} хв тому`;
  return new Date(mtimeMs).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function libraryRawUrl(assetId: string): string {
  return `/api/library/assets/${encodeURIComponent(assetId)}/raw`;
}

/*
 * Спрайт-стікер: сітка кадрів у одному PNG, кадр — чиста функція віку
 * (той самий контракт, що LottieSticker: плеєр лише перемотують).
 * Народився з Telegram-емодзі: їхні TGS lottie-web будує, але мовчки
 * малює нуль шейпів — тож кадри рендерить rlottie заздалегідь.
 */
function SpriteSticker({ src, sprite, age }: {
  src: string;
  sprite: StickerSprite;
  age: number;
}) {
  const frame = Math.floor(Math.max(age, 0) * sprite.fps) % Math.max(sprite.frames, 1);
  const col = frame % sprite.cols;
  const row = Math.floor(frame / sprite.cols);
  // Відсоткова позиція: p% зображення суміщається з p% контейнера,
  // тож col/(cols-1) дає рівно клітинку сітки при size cols*100%.
  const px = sprite.cols > 1 ? (col / (sprite.cols - 1)) * 100 : 0;
  const py = sprite.rows > 1 ? (row / (sprite.rows - 1)) * 100 : 0;
  // Кадри спрайта квадратні, а коробка предмета — не завжди: зона
  // стікерів ріже квадрат по висоті, і фон, розтягнутий на бокс,
  // плющив картинку. Клітинка тримає власний аспект (аналог
  // object-fit: contain у <img>-гілки), обгортка лише центрує.
  return (
    <div className="post-ws__sticker-sprite" aria-hidden>
      <div
        className="post-ws__sticker-sprite-cell"
        style={{
          backgroundImage: `url("${src}")`,
          backgroundSize: `${sprite.cols * 100}% ${sprite.rows * 100}%`,
          backgroundPosition: `${px}% ${py}%`,
        }}
      />
    </div>
  );
}

/*
 * Орнаменти навколо предмета — стрілки «дивись сюди» і кружечки-
 * сателіти (підглянуто в референсів). Живуть УСЕРЕДИНІ дива стікера,
 * тож вхід, вихід і прозорість предмета застосовуються до них
 * безкоштовно. Уся геометрія — чиста функція часу: перемотка в будь-
 * який бік малює той самий кадр, Math.random тут заборонений.
 */
function StickerOrnamentLayer({ ornament, age, time, seed }: {
  ornament: StickerOrnament;
  age: number;
  time: number;
  seed: number;
}) {
  const C = 90;
  if (ornament.kind === 'arrows') {
    const count = Math.min(Math.max(ornament.count ?? 4, 1), ARROW_SLOTS.length);
    return (
      <svg className="post-ws__ornament" viewBox="0 0 180 180" aria-hidden>
        {ARROW_SLOTS.slice(0, count).map((slot, i) => {
          const p = ornamentPop(age, i);
          if (p <= 0) return null;
          const aim = (Math.atan2(C - slot.y, C - slot.x) * 180) / Math.PI;
          // Легке «дихання» кута: стрілки мальовані рукою, а не
          // проштамповані — кожна гойдається у своїй фазі.
          const wob = 2.5 * Math.sin((time / 1.3) * Math.PI * 2 + i * 2.1);
          // Вигин — «назовні» від вертикалі предмета: лівим слотам дуга
          // гнеться в один бік, правим — у протилежний. Спільний напрям
          // вигину після повороту робив частину стрілок «повислими»:
          // дуга йшла проти руки, наче її малювали навиворіт.
          const bend = slot.x <= C ? 1 : -1;
          const tipAng = (Math.atan2(8 * bend, 14) * 180) / Math.PI;
          return (
            <g key={i} transform={`translate(${slot.x} ${slot.y}) rotate(${aim + wob})`}>
              {/* Проростання від хвоста до вістря — стрілку домальовують,
                  а не вмикають. pathLength нормалізує довжину, тож
                  крива може мінятись без переобчислення дашів. */}
              <path
                d={`M0 0 Q 14 ${-8 * bend}, 28 0`}
                pathLength={30}
                strokeDasharray={30}
                strokeDashoffset={30 * (1 - p)}
                className="post-ws__ornament-ink"
              />
              {/* Вістря — симетричний шеврон по дотичній кінця дуги:
                  асиметричне після повороту виглядало зламаним. */}
              <path
                d="M-8 -6 L0 0 L-8 6"
                transform={`translate(28 0) rotate(${tipAng})`}
                className="post-ws__ornament-ink"
                style={{ opacity: p > 0.7 ? (p - 0.7) / 0.3 : 0 }}
              />
            </g>
          );
        })}
      </svg>
    );
  }
  const count = Math.min(Math.max(ornament.count ?? 6, 1), 8);
  const color = ORNAMENT_TONE_COLOR[ornament.tone ?? 'info'];
  return (
    <svg className="post-ws__ornament" viewBox="0 0 180 180" aria-hidden>
      {Array.from({ length: count }, (_, i) => {
        const p = ornamentPop(age, i);
        if (p <= 0) return null;
        const jitter = prand(seed * 13.7 + i) * 24 - 12;
        const base = (360 / count) * i - 90 + jitter;
        // Повільна орбіта після розльоту: кружечки висять і живуть,
        // а не застигають рамкою навколо предмета.
        const ang = ((base + 6 * Math.sin((time / 2.6) * Math.PI * 2 + i * 1.7)) * Math.PI) / 180;
        const R = (52 + prand(seed * 7.3 + i) * 18) * p;
        return (
          <circle
            key={i}
            cx={C + Math.cos(ang) * R}
            cy={C + Math.sin(ang) * R}
            r={6.5}
            fill={color}
            stroke="#fff"
            strokeWidth={2}
            style={{ opacity: p }}
          />
        );
      })}
    </svg>
  );
}

interface LinkSpan {
  sticker: Sticker;
  start: number;
  end: number;
  left: number;
  width: number;
}

/*
 * Зв'язки МІЖ предметами: дуга «A веде до B» та іскри конфлікту.
 * Окремий шар ПІД стікерами, прив'язаний до статичних коробок
 * розкладки: дрейф предметів дугу не смикає — так і в референсі.
 * Зв'язка живе, лише поки живі ОБИДВА кінці.
 */
function StickerLinksLayer({ spans, time, zoneTop, zoneBottom }: {
  spans: readonly LinkSpan[];
  time: number;
  zoneTop: number;
  zoneBottom: number;
}) {
  const zoneH = Math.max((zoneBottom - zoneTop) * CANVAS.h, 1);
  const links = spans.flatMap((dst) => {
    const link = dst.sticker.link;
    if (!link) return [];
    const src = spans.find((o) => o.sticker.id === link.from);
    if (!src || src === dst) return [];
    const born = Math.max(src.start, dst.start);
    const gone = Math.min(src.end, dst.end);
    const grow = Math.min(Math.max((time - born - 0.3) / 0.45, 0), 1);
    const fade = 1 - Math.min(Math.max((time - (gone - 0.3)) / 0.3, 0), 1);
    if (grow <= 0 || fade <= 0) return [];
    return [{ src, dst, kind: link.kind, grow, fade }];
  });
  if (links.length === 0) return null;
  return (
    <svg
      className="post-ws__links"
      viewBox={`0 0 ${CANVAS.w} ${zoneH}`}
      style={{ top: `${zoneTop * 100}%`, height: `${(zoneBottom - zoneTop) * 100}%` }}
      aria-hidden
    >
      {links.map(({ src, dst, kind, grow, fade }, li) => {
        const leftFirst = src.left + src.width / 2 <= dst.left + dst.width / 2;
        const a = leftFirst ? src : dst;
        const b = leftFirst ? dst : src;
        const xa = (a.left + a.width * 0.86) * CANVAS.w;
        const xb = (b.left + b.width * 0.14) * CANVAS.w;
        const y = zoneH * 0.42;
        if (kind === 'sparks') {
          // Іскри посередині: три зигзаги, що спалахують по черзі.
          // Фази зсунуті простими числами — цикл не збігається сам із
          // собою і не читається як метроном.
          const xm = (xa + xb) / 2;
          return (
            <g key={li} transform={`translate(${xm} ${y})`} style={{ opacity: fade }}>
              {[0, 1, 2].map((i) => {
                const f = ((time * 2.4) + i * 0.37) % 1;
                const flash = f < 0.5 ? Math.sin((Math.PI * f) / 0.5) : 0;
                const rot = prand(i * 5.1 + 2) * 44 - 22;
                const dx = prand(i * 3.7 + 1) * 70 - 35;
                const dy = prand(i * 9.2 + 4) * 50 - 25;
                return (
                  <path
                    key={i}
                    transform={`translate(${dx} ${dy}) rotate(${rot})`}
                    d="M-30 8 L-10 -10 L4 4 L26 -12"
                    className="post-ws__links-spark"
                    style={{ opacity: flash * grow }}
                  />
                );
              })}
            </g>
          );
        }
        // Дуга летить НАД проміжком між предметами, а не крізь них:
        // хвіст — від верхнього внутрішнього кута A, вістря спиняється
        // ПЕРЕД B із зазором і дивиться вниз-у предмет по дотичній.
        // Раніше кінці стояли на середині висоти коробок — хвіст лежав
        // на самому предметі, а вістря втикалось у наліпку B.
        const axArc = (a.left + a.width * 0.9) * CANVAS.w;
        const bxArc = (b.left + b.width * 0.04) * CANVAS.w;
        const ayArc = zoneH * 0.34;
        const byArc = zoneH * 0.28;
        const cx = (axArc + bxArc) / 2;
        const cy = zoneH * 0.02;
        const head = (Math.atan2(byArc - cy, bxArc - cx) * 180) / Math.PI;
        return (
          <g key={li} style={{ opacity: fade }}>
            <path
              d={`M ${axArc} ${ayArc} Q ${cx} ${cy} ${bxArc} ${byArc}`}
              pathLength={100}
              strokeDasharray={100}
              strokeDashoffset={100 * (1 - grow)}
              className="post-ws__links-arc"
            />
            {/* Вістря — симетричний шеврон по дотичній кінця дуги;
                проявляється, коли дуга доросла до кінця. */}
            <path
              d="M-20 -12 L0 0 L-20 12"
              transform={`translate(${bxArc} ${byArc}) rotate(${head})`}
              className="post-ws__links-arc"
              style={{ opacity: grow > 0.8 ? (grow - 0.8) / 0.2 : 0 }}
            />
          </g>
        );
      })}
    </svg>
  );
}

/*
 * Місце бейджа за ПЛАВНИМ рангом. Три позиції: 0 — над предметом,
 * 1 — праворуч, 2 — ліворуч; між ними лінійна інтерполяція, тож поява
 * нового бейджа перевозить старі, а не телепортує. Бічні сидять нижче
 * (58 % проти 96 %): піднімеш їх до верхньої плашки — впруться в шапку
 * Instagram. Координати рахуються в частках КАДРУ, інакше вузький
 * предмет відкидав би плашку за край.
 */
function badgeSpot(rankSmooth: number, left: number, width: number): { centre: number; bottom: number } {
  const mid = left + width / 2;
  const right = Math.min(left + width + BADGE_HALF * 0.9, 1 - BADGE_EDGE);
  const leftSide = Math.max(left - BADGE_HALF * 0.9, BADGE_EDGE);
  const at = (i: number): { centre: number; bottom: number } => (
    i <= 0 ? { centre: mid, bottom: 96 }
      : i === 1 ? { centre: right, bottom: 58 }
        : { centre: leftSide, bottom: 58 }
  );
  const lo = Math.floor(rankSmooth);
  const k = rankSmooth - lo;
  const a = at(lo);
  const b = at(lo + 1);
  return { centre: a.centre + (b.centre - a.centre) * k, bottom: a.bottom + (b.bottom - a.bottom) * k };
}

function measureAudio(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => resolve(0);
    audio.src = url;
  });
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Індекс активного слова на позиції t.
 *
 * Не «те, чий інтервал накриває t» — на такій перевірці короткі слова
 * («вже», «це», «воду») зникали: між двома оновленнями часу їхній
 * інтервал устигав пройти цілком, і в кадр вони не потрапляли жодного
 * разу. Тому беремо останнє слово, яке вже почалось, і тримаємо його
 * до початку наступного. Так у кадрі завжди щось є, і жодне слово не
 * пропускається.
 *
 * Виняток — довга тиша: якщо після кінця слова минуло більше паузи,
 * ніж тримає формат, кадр звільняється.
 */
const CAPTION_HOLD_S = 0.6;

function wordIndexAt(words: readonly WordTiming[], t: number): number {
  let found = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i]!.start <= t) found = i;
    else break;
  }
  if (found < 0) return -1;
  const w = words[found]!;
  const next = words[found + 1];
  // Останнє слово тримаємо до кінця доріжки. Інакше фінальний кадр
  // порожніє саме там, де стоїть висновок ролика — а після нього вже
  // нічого не прозвучить, тож і звільняти кадр нема для чого.
  if (!next) return found;
  // Кінець слова позаду, наступне ще нескоро — це пауза між фразами.
  if (t > w.end + CAPTION_HOLD_S && t < next.start - CAPTION_HOLD_S) {
    return -1;
  }
  return found;
}

/**
 * Слово для кадру: без розділових знаків.
 *
 * У `words.json` вони потрібні — по них вирівнюється текст і видно межі
 * речень. Але в субтитрі кома чи тире після слова читаються як брак:
 * рядок і так розбитий на групи, паузу передає сама поява наступного
 * слова.
 *
 * Знімаємо лише з країв, тож «вайб-кодинг» лишається цілим. Слово, що
 * складається з самої пунктуації (окреме тире), перетворюється на
 * порожній рядок — такі в групу не потрапляють.
 */
// Дефіс — останнім у класі, інакше він читається як діапазон і регулярка
// не компілюється.
const CAPTION_TRIM = /^[\s.,!?;:…—–‑«»„“”"'`()[\]-]+|[\s.,!?;:…—–‑«»„“”"'`()[\]-]+$/g;

function cleanCaption(word: string): string {
  return word.replace(CAPTION_TRIM, '');
}

function wordAt(words: readonly WordTiming[], t: number): WordTiming | null {
  const i = wordIndexAt(words, t);
  return i < 0 ? null : words[i]!;
}

/**
 * Біт на позиції t. Як і зі словами, беремо останній початий і тримаємо
 * до наступного — інакше ведучий зникає у стиках між фразами.
 *
 * Окремо перший біт: він майже ніколи не починається рівно з нуля
 * (у нас 0.1 с), і на паузі перед відтворенням кадр лишався порожнім,
 * хоча поза для нього призначена.
 */
/** Частка висоти кадру під підлогою. Звідси ж береться висота коробки в
 *  розмітці — інакше пропорції viewBox розходяться з реальними. */
const FLOOR_H = 0.42;

/**
 * Підлога в перспективі, намальована точно.
 *
 * CSS-варіант (repeating-linear-gradient плюс rotateX) дає лише
 * наближення: браузер розтягує рівномірний візерунок, і крок клітинок
 * удалину виходить приблизним. Тут позиції рахуються за проєкцією, тож
 * сітка сходиться так, як мала б у реальній камері.
 *
 * Модель: спостерігач дивиться на площину, точка сходу одна — (50, Y0).
 * Точка на відстані z проєктується у y = Y0 + A/z, а бічний зсув xw — у
 * x = 50 + B·xw/z. Обидві осі ділять на ту саму z, тому світовий квадрат
 * лишається квадратом на екрані, а не перетворюється на лежачу плитку.
 *
 * Одиниці — відсотки ШИРИНИ кадру по обох осях. Це важливо: viewBox
 * рахується з реальних пропорцій коробки, а не 100×100. При квадратному
 * viewBox і preserveAspectRatio="none" браузер стискав вертикаль на
 * чверть, і кожна клітинка виходила видовженою — саме тому підлога
 * читалась як смуги, а не як плитка.
 */
function FloorGrid() {
  const W = 100;
  const H = FLOOR_H * (CANVAS.h / CANVAS.w) * 100;

  // Точка сходу над коробкою підлоги: сітка не встигає зійтись у неї, а
  // обривається на підході — так виглядає підлога кімнати, а не поле.
  const Y0 = -12;
  // y(1) = низ кадру, тобто найближчий ряд лежить рівно на нижньому краї.
  const A = H - Y0;
  // Крок світової сітки. Менший — дрібніші клітинки; 0.088 дає ближній
  // ряд по 7 % ширини кадру, тобто п'ятнадцять клітинок упоперек.
  const STEP = 0.088;
  // Робить НАЙБЛИЖЧУ клітинку точно квадратною: її висота A·s/(1+s)
  // мусить дорівнювати ширині B·s. Далі вглиб клітинки пласкішають — це
  // і є перспектива, а не помилка.
  const B = A / (1 + STEP);
  // Де обірвати сітку: коли клітинка стає пласкішою за 1:4, вона вже
  // читається не як плитка, а як штрихування.
  const MIN_ASPECT = 0.25;
  const zFar = A / (MIN_ASPECT * B) - STEP;

  const depthToY = (z: number): number => Y0 + A / z;

  /*
   * Компенсація щільності. Товщина лінії стала, а відстань між сусідами
   * удалину падає — у рядів як 1/z², у поздовжніх як 1/z. Через це біля
   * горизонту на ту саму площу лягає вдесятеро більше фарби, і сітка
   * там читається як брудна сіра смуга, а не як плитка.
   *
   * Гасимо рівно настільки, наскільки густішає: у скільки разів більше
   * ліній припадає на одиницю висоти, у стільки ж разів вони бліді.
   * Сумарний тон тоді однаковий по всій підлозі — а це і є те, що
   * бачить око. Однакова непрозорість на всіх лініях дає протилежне:
   * рівний тон зблизька і залиту пляму вдалині.
   *
   * Ряди рахуються поштучно, кожен на своїй глибині. Поздовжні —
   * градієнтом уздовж лінії, бо кожна з них перетинає всі глибини
   * одразу, і однією прозорістю не обійтись.
   */
  const rowInk = (z: number): number => (1 + STEP) / (z * (z + STEP));
  const colInkTop = -Y0 / A;

  // Поперечні: рівномірні по глибині, нерівномірні на екрані.
  const rows: { y: number; ink: number }[] = [];
  const rowCount = Math.floor((zFar - 1) / STEP);
  for (let i = 0; i <= rowCount; i += 1) {
    const z = 1 + i * STEP;
    rows.push({ y: depthToY(z), ink: rowInk(z) });
  }

  // Поздовжні: стільки, щоб НА ДАЛЬНЬОМУ краю вони дотягувались до країв
  // кадру. Раніше віяло було вужче, і біля горизонту лінії збирались у
  // середині, лишаючи по кутах порожні клини — виглядало так, ніби зліва
  // й справа підлоги немає взагалі. Унизу такі лінії йдуть далеко за
  // кадр, і це нормально: видима лишається лише їх частина.
  const maxXw = (50 * zFar) / B;
  const cols: { x1: number; x2: number }[] = [];
  const colCount = Math.ceil(maxXw / STEP);
  for (let i = -colCount; i <= colCount; i += 1) {
    const xw = i * STEP;
    cols.push({ x1: 50 + B * xw, x2: 50 + (B * xw) / zFar });
  }

  const yBottom = depthToY(1);
  const yTop = depthToY(zFar);

  // Розтушовка рівно там, де обривається сітка: на верхньому ряду вона
  // вже повністю прозора, щільність набирає за FADE одиниць нижче.
  // Раніше смуга була прив'язана до висоти коробки, а не до сітки, і
  // останній ряд лишався видимим більш ніж наполовину — клітинки не
  // танули вдалині, а впирались у рівний край.
  //
  // Смуга навмисно коротка: довга з'їдає пів підлоги, і сітка ледве
  // проступає ще там, де має бути щільною.
  const FADE = 11;
  const pct = (y: number): number => (1 - y / H) * 100;
  const mask = `linear-gradient(to top, #000 0%, #000 ${pct(yTop + FADE).toFixed(1)}%,`
    + ` transparent ${pct(yTop).toFixed(1)}%)`;

  return (
    <svg
      className="post-ws__floor"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      aria-hidden
      focusable="false"
    >
      <defs>
        {/* Прозорість уздовж поздовжньої лінії: унизу повна, вгорі —
            рівно у стільки разів менша, у скільки там тісніше стоять
            сусідні лінії. Колір той самий, що й у рядів. */}
        <linearGradient
          id="post-floor-col"
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={yBottom}
          x2={0}
          y2={0}
        >
          <stop offset="0" stopColor="var(--floor-line)" stopOpacity={1} />
          <stop offset="1" stopColor="var(--floor-line)" stopOpacity={colInkTop} />
        </linearGradient>
      </defs>
      <g className="post-ws__floor-lines">
        {cols.map((c, i) => (
          <line
            key={`c${i}`}
            x1={c.x1}
            y1={yBottom}
            x2={c.x2}
            y2={yTop}
            stroke="url(#post-floor-col)"
          />
        ))}
        {rows.map((r, i) => (
          <line
            key={`r${i}`}
            x1={0}
            y1={r.y}
            x2={W}
            y2={r.y}
            stroke="var(--floor-line)"
            strokeOpacity={r.ink}
          />
        ))}
      </g>
    </svg>
  );
}

/** Скільки триває зміна пози. Те саме число стоїть у post-studio.css. */
const POSE_SWAP_MS = 220;

/**
 * Ведучий і зміна пози.
 *
 * Просто перезаписати `src` не можна: персонаж стрибком стає іншим, і в
 * кадрі це читається як склейка відео, а не як зміна пози. Тому стара
 * поза лишається в DOM іще на час переходу — нова проявляється ПОВЕРХ
 * неї, і лише коли стала непрозорою, стара гасне під нею.
 *
 * Обгортка несе виїзд, похитування й нахил; знімки всередині — тільки
 * перехід. Якби все жило на одному елементі, анімації билися б за
 * `transform`, і остання в списку затирала б решту.
 */
function HostLayer({ src }: { src: string }) {
  // Стан оновлюється під час рендера, а не в ефекті: ефект спрацьовує
  // ПІСЛЯ кадру, тож встиг би проскочити один кадр, у якому стара поза
  // вже зникла, а перехід ще не почався.
  const [swap, setSwap] = useState<{ cur: string; prev: string | null }>({ cur: src, prev: null });
  if (swap.cur !== src) setSwap({ cur: src, prev: swap.cur });

  useEffect(() => {
    if (!swap.prev) return undefined;
    const t = setTimeout(() => setSwap((s) => ({ ...s, prev: null })), POSE_SWAP_MS);
    return () => clearTimeout(t);
  }, [swap.prev]);

  return (
    <div className="post-ws__host">
      {/* Стара — ПІД новою, і це несуча деталь переходу: поки нова
          напівпрозора, крізь неї видно стару, а не тло. Помінявши їх
          місцями, отримаєш просвіт у сітці підлоги на кожній зміні. */}
      {swap.prev ? (
        <img key={`out-${swap.prev}`} className="post-ws__host-shot is-out" src={swap.prev} alt="" />
      ) : null}
      {/*
        Проявлення вмикається лише тоді, коли є що заміняти. На першій
        появі позу виносить пружина обгортки, і фейд поверх неї
        перетворив би виїзд на розмиту пляму.
      */}
      <img
        key={`in-${swap.cur}`}
        className={`post-ws__host-shot${swap.prev ? ' is-swap' : ''}`}
        src={swap.cur}
        alt=""
      />
    </div>
  );
}

/**
 * useLayoutEffect на сервері не виконується, і React через це лається в
 * консоль на кожен рендер. Сторінка рендериться і на сервері, тому
 * підставляємо звичайний ефект там, де DOM-у ще немає.
 */
const useDomLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// Розмітка карток за src — переживає перемонтування CardLayer (деталі
// в коментарі всередині компонента).
const cardHtmlCache = new Map<string, string>();

/**
 * Картка в кадрі. Розмітку пише АГЕНТ у `assets/blocks/<id>.html`,
 * студія її лише вставляє, масштабує під кадр і відкриває рядки під мову.
 *
 * Агент малює під полотно 1080 px завширшки — у тих самих пікселях, що й
 * решта формату. Превʼю вужче, тому вміст стискається одним множником;
 * рахуємо його з реальної ширини, бо поділити довжину на довжину в CSS
 * не можна, а гадати про розмір превʼю не варто — воно ще й гумове.
 */
function CardLayer({ src, hold, start, time, top, words, sticker, stickerUrl }: {
  src: string;
  hold: number;
  start: number;
  time: number;
  top: number;
  words: readonly WordTiming[];
  sticker?: CardSticker | null;
  stickerUrl?: string | null;
}) {
  // Кеш розмітки живе поза компонентом: картка МОНТУЄТЬСЯ щоразу, коли
  // її span стає живим (у лупі демо — щоколa), і без кешу кожна поява
  // починалась із мережевого фетчу. Поки той летів, кадр стояв
  // порожній, а час ішов — картка і наліпка вискакували вже ПОСЕРЕД
  // своєї появи, телепортом. З кешем розмітка стає одразу, а свіжа
  // версія доїжджає фоном — живі правки агента не губляться.
  const [html, setHtml] = useState<string | null>(() => cardHtmlCache.get(src) ?? null);
  const [k, setK] = useState(1);
  // Висота вмісту картки в її власних (1080-пікс) координатах — без неї
  // не поставити стікер на нижній край: висоту диктує розмітка.
  const [ch, setCh] = useState(0);
  const wrap = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(cardHtmlCache.get(src) ?? null);
    void (async () => {
      try {
        const r = await fetch(src, { cache: 'no-store' });
        if (!r.ok) return;
        const text = await r.text();
        cardHtmlCache.set(src, text);
        if (!cancelled) {
          // Не смикати стан тим самим рядком: перезапис innerHTML скидає
          // CSS-анімації всередині картки на початок.
          setHtml((prev) => (prev === text ? prev : text));
        }
      } catch {
        // файлу немає — кадр просто лишиться без картки
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Замір — ДО малювання (layout-ефект): звичайний ефект виконується
  // після, і перший кадр картки встигав показатись НЕмасштабованим —
  // розмітка 1080 px на мить вставала «текстом на весь екран». Поки
  // розмітку тягнув фетч, зблиск ховався за мережевою паузою; з кешем
  // картка стає одразу — і він вилазив на кожному перемиканні демо.
  useDomLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const measure = (): void => setK(el.clientWidth / CANVAS.w);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [html]);

  // offsetHeight — розмір ДО transform-масштабу, тобто рівно в тих
  // координатах, у яких агент малює розмітку. Теж layout-ефект: інакше
  // наліпка перший кадр стояла б без місця (ch=0).
  useDomLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = (): void => setCh(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [html]);

  // Відкриття рядків — класом на вже вставлених вузлах, а не повторною
  // вставкою розмітки: інакше кожен крок скидав би CSS-анімації
  // всередині картки на початок, і вона б смикалась на кожному слові.
  //
  // useLayoutEffect, а не useEffect: звичайний ефект виконується ПІСЛЯ
  // малювання, тож перший кадр картки встигав показатись із усіма
  // рядками в закритому стані. На паузі це й лишалось назавжди —
  // порожня біла коробка, бо далі ефект нічим не будився.
  // Останній застосований стан — щоб його можна було накласти знову без
  // нового кадру. Саме цього бракувало на паузі: коли React перезаписує
  // innerHTML, класи злітають, а розбудити ефект нічим — час стоїть.
  const applyRef = useRef<() => void>(() => {});

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    // Стежимо лише за прямими дітьми: перезапис innerHTML — це саме
    // childList на цьому вузлі. Глибше не лізе навмисно, бо всередині ми
    // самі міняємо текст лічильників і зациклили б спостереження.
    const mo = new MutationObserver(() => {
      mo.disconnect();
      applyRef.current();
      mo.observe(el, { childList: true });
    });
    mo.observe(el, { childList: true });
    return () => mo.disconnect();
  }, [html]);

  useDomLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    applyRef.current = () => applyCardState(el, hold, start, time, words);
    applyRef.current();
  }, [html, hold, start, time, words]);

  if (!html) return null;
  const motion = cardMotion(time - start, hold);
  const stWord = sticker ? words[sticker.word] : undefined;
  const stickerOn = sticker && stickerUrl && ch > 0 && stWord && time >= stWord.start;
  let stickerNode: JSX.Element | null = null;
  if (stickerOn && sticker && stWord) {
    const sz = CANVAS.w * (sticker.size ?? 0.16);
    const spot = sticker.spot ?? 'br';
    // Центр — на краю/куті картки: половина наліпки навмисно виступає
    // за неї, як у референса. Кути трохи всунуті, щоб не зрізати
    // заокруглення розмітки.
    const cx = spot === 'l' ? 0
      : spot === 'r' ? CANVAS.w
        : spot === 'tl' || spot === 'bl' ? CANVAS.w * 0.09 : CANVAS.w * 0.91;
    const cy = spot === 'l' || spot === 'r' ? ch * 0.55
      : spot === 'tl' || spot === 'tr' ? 0 : ch;
    // Вліт з-за краю ЕКРАНА до місця. Дистанція — до повного зникнення
    // за кадром, тож перший кадр наліпки за екраном. Напрям — із поля
    // або за місцем: лівим spot'ам зліва, правим справа.
    const from = sticker.from
      ?? (spot === 'l' || spot === 'tl' || spot === 'bl' ? 'left' : 'right');
    const flight = cardStickerFly(time - stWord.start);
    // Для «згори» відстань рахуємо від верху КАДРУ, не картки: картка
    // стоїть нижче за topFrac, і наліпка мусить стартувати за екраном.
    const off = from === 'right'
      ? CANVAS.w + sz * 0.6 + 60 - cx
      : from === 'left'
        ? -(cx + sz * 0.6 + 60)
        : -(top * CANVAS.h + cy + sz * 0.6 + 60);
    const dx = from === 'top' ? 0 : flight * off;
    const dy = from === 'top' ? flight * off : 0;
    // Сталий нахил від слова + нахил у польоті (відкидається назад від
    // руху; згори — легке довертання) + повільне дихання. Все
    // детерміноване — перемотка малює той самий кадр.
    const lean = from === 'right' ? 14 : from === 'left' ? -14 : 10;
    const rot = (prand(sticker.word * 3.3 + 1) * 12 - 6)
      + flight * lean
      + 2 * Math.sin((time / 2.4) * Math.PI * 2);
    stickerNode = (
      <div
        className="post-ws__card-fx"
        style={{ transform: `translateX(-50%) scale(${k * motion.scale})` }}
      >
        <img
          src={stickerUrl}
          alt=""
          style={{
            left: cx - sz / 2 + dx,
            top: cy - sz / 2 + dy,
            width: sz,
            transform: `rotate(${rot}deg)`,
          }}
        />
      </div>
    );
  }
  return (
    <div
      className="post-ws__card"
      ref={wrap}
      style={{
        top: `${(top + motion.y / 100) * 100}%`,
        // Приїзд справа — зсув у відсотках ШИРИНИ кадру (motion.x),
        // тобто чиста функція часу: перемотка і рендер дають те саме.
        transform: `translateX(${motion.x}%)`,
        opacity: motion.opacity,
      }}
    >
      <div
        className="post-ws__card-in"
        ref={box}
        style={{ transform: `translateX(-50%) scale(${k * motion.scale})` }}
        // Розмітку пише агент у файлі проєкту — той самий рівень довіри,
        // що й решта файлів ролика. Скрипти через innerHTML не
        // виконуються, тож картка лишається саме розміткою.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {stickerNode}
    </div>
  );
}

/**
 * Накласти на картку стан, що відповідає моменту `time`.
 *
 * Винесено з ефекту окремо, бо викликається з двох місць: із самого
 * ефекту при зміні часу і зі спостерігача, коли розмітку перезаписали.
 * Стан завжди рахується з нуля, памʼяті про попередній тут немає —
 * інакше перший же збій лишається назавжди.
 */
function applyCardState(
  el: HTMLElement,
  hold: number,
  start: number,
  time: number,
  words: readonly WordTiming[],
): void {
  {
    // Навішуємо ЩОРАЗУ, без памʼяті про попередній стан.
    //
    // Був захисток «пропустити, якщо число рядків не змінилось» — і саме
    // він усе ламав: клас навішувався один раз, щось у DOM його зтирало,
    // а захисток вважав роботу зробленою і більше не втручався. Картка
    // назавжди лишалась порожньою. Діагностика показала це прямо:
    // «знайдено 3 · відкрито 1 · клас на 0».
    //
    // Ціна відмови від памʼяті — десяток classList.toggle на кадр. Це
    // ніщо, і воно робить стан самовідновним: хоч би хто перезаписав
    // розмітку, наступний кадр поверне класи на місце.
    const items = el.querySelectorAll<HTMLElement>('[data-reveal]');
    const n = cardRevealCount(items.length, hold, start, time);
    items.forEach((node, i) => {
      // `data-reveal-at="59"` — рядок чекає на СВОЄ слово, а не на свою
      // чергу. Для переліку це принципово: рівномірний розподіл ставить
      // третій пункт на секунду раніше, ніж його називають, і глядач
      // читає те, чого ще не почув.
      const at = Number(node.dataset.revealAt);
      const pinned = Number.isFinite(at) && words[at] != null;
      node.classList.toggle('is-shown', pinned ? time >= words[at]!.start : i < n);
    });
    // Стан лишається видимим у розмітці: коли картка знову поводитиметься
    // дивно, `data-shown="2/3"` відповідає на перше питання без здогадок.
    el.dataset.shown = `${n}/${items.length}`;

    // Безперервний хід картки — на додачу до покрокового відкриття.
    // Смуга завантаження, лічильник, стрілка: усе, що має РОСТИ, а не
    // зʼявлятись. Студія дає лише число, а що з ним робити — ширину,
    // поворот чи текст — вирішує сама картка.
    //
    // `--p` рівний, `--pe` з гальмуванням: справжнє завантаження
    // доповзає останні відсотки помітно довше, і саме це читається як
    // завантаження, а не як рівний повзунок.
    const raw = Math.min(Math.max((time - start) / Math.max(0.001, hold * 0.75), 0), 1);
    const eased = 1 - (1 - raw) ** 3;
    for (const node of el.querySelectorAll<HTMLElement>('[data-progress]')) {
      node.style.setProperty('--p', raw.toFixed(4));
      node.style.setProperty('--pe', eased.toFixed(4));
    }
    for (const node of el.querySelectorAll<HTMLElement>('[data-count]')) {
      const to = Number(node.dataset.count ?? 0);
      const from = Number(node.dataset.countFrom ?? 0);
      const value = from + (to - from) * eased;
      const dec = Number(node.dataset.countDecimals ?? 0);
      node.textContent = `${value.toFixed(dec)}${node.dataset.countSuffix ?? ''}`;
    }
  }
}

/**
 * Блок-шторка. Згорнутий до заголовка, розкривається при наведенні і
 * лишається розкритим, щойно в ньому щось натиснули — інакше панель
 * закривалась би просто від того, що курсор поїхав до чату.
 *
 * Стрілка згортає закріплений блок назад.
 */
function BlockShell({
  num,
  title,
  blockId,
  stateClass,
  open,
  pinned,
  actions,
  onEnter,
  onLeave,
  onPin,
  onToggle,
  children,
}: {
  num: number;
  title: string;
  blockId: string;
  stateClass: string;
  open: boolean;
  pinned: boolean;
  actions?: ReactNode;
  onEnter: () => void;
  onLeave: () => void;
  onPin: () => void;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section
      // Ім'я кроку в розмітці: чернетка ховає все, крім звуку й сценарію,
      // і робить це за іменем, а не за порядковим номером — інакше будь-яка
      // вставка блоку тихо змінила б, що саме видно.
      data-block={blockId}
      className={`post-block${stateClass}${open ? ' is-open' : ''}${pinned ? ' is-pinned' : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // Capture, а не bubble: клік по кнопці всередині має закріпити
      // блок ще до того, як спрацює сама кнопка й почне щось міняти.
      onPointerDownCapture={onPin}
    >
      <div className="post-block__head">
        <span className="post-block__num">{num}</span>
        <span className="post-block__title">{title}</span>
        {actions}
        <button
          type="button"
          className="post-block__toggle"
          aria-expanded={open}
          title={pinned ? 'Згорнути' : 'Закріпити розкритим'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <span className="post-block__chev" aria-hidden>⌄</span>
        </button>
      </div>
      <div className="post-block__body">
        <div className="post-block__body-inner">{children}</div>
      </div>
    </section>
  );
}

function beatAt(beats: readonly Beat[], t: number): Beat | null {
  if (beats.length === 0) return null;
  if (t < beats[0]!.start) return beats[0]!;
  let found: Beat | null = null;
  for (const b of beats) {
    if (b.start <= t) found = b;
    else break;
  }
  return found;
}

/**
 * Пост-режим: превʼю кадру й блоки-кроки замість файлового воркспейсу.
 *
 * Стан ролика — post.json у корені проєкту, тож Клод бачить рівно те саме,
 * що й ти: яка доріжка, які слова коли звучать, яка поза на якому біті.
 * Через це він може ставити стікери на конкретні слова, а не вгадувати.
 */
export function PostWorkspace({
  projectId,
  files,
  onUpload,
  onRefreshFiles,
  onAskClaude,
  onExit,
}: PostWorkspaceProps) {
  const [post, setPost] = useState<PostSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [time, setTime] = useState(0);

  /*
   * Режим зйомки. Вмикає його ЗНІМАЛЬНИК через window.__postStudio.setShot,
   * а не адреса: застосунок редиректить /projects/<id> на адресу розмови
   * і губить query, тож ?shot=1 доживав рівно до першого переходу.
   */
  const [shotMode, setShotMode] = useState(false);
  // Десять кроків із ручними правками поїхали з екрана в панель за
  // кнопкою: щодня потрібен один-два, а решта вісім забирали половину
  // ширини й ховали те, заради чого сюди заходять, — сам кадр.
  const [manualOpen, setManualOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [wordsOpen, setWordsOpen] = useState(false);

  /*
   * Конструктор анімацій.
   *
   * Словник рухів лежить у проєкті даними — assets/motions.json. Панель
   * показує записи, а клік по запису програє його demo прямо в кадрі:
   * кадр тимчасово малює синтетичний мініролик замість post.json, тим
   * самим кодом, що й справжній — тому прев'ю руху не «схоже» на те, що
   * буде в ролику, а і є ним.
   */
  const [motionsOpen, setMotionsOpen] = useState(false);
  /*
   * Каталог подарунків Telegram: 165 анімованих емодзі, спільні на всі
   * ролики (живуть у даних демона). Два види — за зірки і колекційні
   * (NFT); клік «Взяти» кладе подарунок у набір проєкту спрайт-аркушем.
   */
  /*
   * Сценарій для озвучки. Джерело — script.md (таблиця бітів із темпом,
   * тоном і паузою, яку пише агент), запасне — post.json.script. Файл
   * перечитується, поки шторка відкрита: агент дописує біти в чаті, і
   * власник має бачити свіжу версію без перезапуску.
   */
  const [scriptOpen, setScriptOpen] = useState(false);
  const [scriptMd, setScriptMd] = useState<string | null>(null);

  useEffect(() => {
    if (!scriptOpen) return undefined;
    let stopped = false;
    const pull = async (): Promise<void> => {
      try {
        const resp = await fetch(rawUrl(projectId, 'script.md'), { cache: 'no-store' });
        if (stopped) return;
        setScriptMd(resp.ok ? await resp.text() : null);
      } catch {
        if (!stopped) setScriptMd(null);
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [scriptOpen, projectId]);

  // Рядки таблиці бітів: | # | Фраза | Темп | Тон | Пауза |. Заголовок і
  // роздільник пропускаємо; шапку YAML (hook:/frame:) читаємо окремо.
  const scriptRows = useMemo(() => {
    if (!scriptMd) return [] as Array<{ n: number; text: string; tempo: number | null; tone: number | null; pause: number | null }>;
    const rows: Array<{ n: number; text: string; tempo: number | null; tone: number | null; pause: number | null }> = [];
    for (const line of scriptMd.split(/\r?\n/)) {
      const m = /^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(-?[\d.]+)?\s*\|\s*(-?[\d.]+)?\s*\|\s*(-?[\d.]+)?\s*\|/.exec(line);
      if (!m) continue;
      const num = (v: string | undefined): number | null => (v == null || v === '' ? null : Number(v));
      rows.push({ n: Number(m[1]), text: m[2] ?? '', tempo: num(m[3]), tone: num(m[4]), pause: num(m[5]) });
    }
    return rows;
  }, [scriptMd]);

  const scriptMeta = useMemo(() => {
    const hook = scriptMd ? /^hook:\s*(.+)$/m.exec(scriptMd)?.[1]?.trim() ?? '' : '';
    const frame = scriptMd ? /^frame:\s*(.+)$/m.exec(scriptMd)?.[1]?.trim() ?? '' : '';
    return { hook, frame };
  }, [scriptMd]);

  // Чистий текст для ElevenLabs: лише фрази, по одній на рядок.
  const scriptPlain = useMemo(
    () => (scriptRows.length ? scriptRows.map((r) => r.text).join('\n') : (post?.script ?? '')),
    [scriptRows, post?.script],
  );

  const [giftsOpen, setGiftsOpen] = useState(false);
  const [gifts, setGifts] = useState<GiftItem[] | null>(null);
  const [giftTake, setGiftTake] = useState<{ slug: string; state: 'running' | 'done' | 'error'; error?: string } | null>(null);

  useEffect(() => {
    if (!giftsOpen || gifts != null) return;
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch('/api/gifts', { cache: 'no-store' });
        if (!resp.ok) return;
        const doc = await resp.json() as { items?: GiftItem[] };
        if (!cancelled) setGifts(doc.items ?? []);
      } catch {
        // каталогу немає — галерея покаже порожньо
      }
    })();
    return () => { cancelled = true; };
  }, [giftsOpen, gifts]);

  const takeGift = useCallback(async (g: GiftItem, variant?: string): Promise<void> => {
    const key = variant ? `${g.slug}:${variant}` : g.slug;
    setGiftTake({ slug: key, state: 'running' });
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/gifts/take`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: g.slug,
          ...(variant ? { variant } : {}),
          id: variant ? `${g.slug}-${variant}` : g.slug,
        }),
      });
      const data = await resp.json().catch(() => null) as { error?: string } | null;
      if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
      // Рендер спрайта — секунди; поллер простий, бо дія разова.
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await fetch(`/api/projects/${encodeURIComponent(projectId)}/gifts/take`, { cache: 'no-store' })
          .then((r) => r.json() as Promise<{ state: string; error?: string }>)
          .catch(() => null);
        if (!st || st.state === 'running') continue;
        if (st.state === 'error') throw new Error(st.error ?? 'скрипт впав');
        break;
      }
      setGiftTake({ slug: key, state: 'done' });
      setNote(`подарунок «${g.title || g.slug}${variant ? ` · модель ${variant}` : ''}» у наборі`);
      await onRefreshFiles?.();
    } catch (err) {
      setGiftTake({ slug: key, state: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }, [projectId, onRefreshFiles]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [motions, setMotions] = useState<MotionEntry[] | null>(null);
  const [motionPreview, setMotionPreview] = useState<MotionEntry | null>(null);
  const [demoTime, setDemoTime] = useState(0);

  /*
   * Рендер. Кнопка б'є в демон (POST /render), демон запускає той самий
   * render.py — агент у цьому шляху не бере участі. Поки йде — поллер
   * читає стан і хвіст лога для відсотка; після — рядок із готовим
   * файлом і діями «відкрити» / «у папці».
   */
  const [render, setRender] = useState<RenderStatus | null>(null);
  // «У папці» працює лише в desktop-оболонці: міст shell.openPath
  // відкриває провідник на теці проєкту. У браузері кнопки нема —
  // замість неї повний шлях у title рядка з файлом.
  const hostShell = useMemo(() => isOpenDesignHostAvailable(), []);

  const pullRender = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/render`, { cache: 'no-store' });
      if (!resp.ok) return;
      setRender(await resp.json() as RenderStatus);
    } catch {
      // демон недоступний — старт рендера скаже про це сам
    }
  }, [projectId]);

  // Один раз на вході: якщо рендер уже йде (студію перевідкрили посеред
  // зйомки) або post.mp4 лишився з минулого разу — показати одразу.
  useEffect(() => {
    void pullRender();
  }, [pullRender]);

  useEffect(() => {
    if (render?.state !== 'running') return undefined;
    const id = window.setInterval(() => void pullRender(), 1500);
    return () => window.clearInterval(id);
  }, [render?.state, pullRender]);

  // Таймкоди — та сама механіка, що рендер: старт → поллер → підсумок.
  const [align, setAlign] = useState<AlignStatus | null>(null);

  const pullAlign = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/align`, { cache: 'no-store' });
      if (!resp.ok) return;
      setAlign(await resp.json() as AlignStatus);
    } catch {
      // демон недоступний — старт вирівнювання скаже про це сам
    }
  }, [projectId]);

  // На вході: студію могли перевідкрити посеред вирівнювання.
  useEffect(() => {
    void pullAlign();
  }, [pullAlign]);

  useEffect(() => {
    if (align?.state !== 'running') return undefined;
    const id = window.setInterval(() => void pullAlign(), 1500);
    return () => window.clearInterval(id);
  }, [align?.state, pullAlign]);

  const startAlign = useCallback(async (audioPath: string): Promise<void> => {
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: audioPath }),
      });
      const data = await resp.json().catch(() => null) as { error?: string } | null;
      if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
      setAlign({ state: 'running', startedAt: Date.now(), error: null, report: null });
    } catch (err) {
      setAlign({
        state: 'error',
        startedAt: null,
        error: err instanceof Error ? err.message : String(err),
        report: null,
      });
    }
  }, [projectId]);

  // Читаємо словник і перечитуємо, поки панель відкрита: правки руху
  // робить агент у чаті, і прев'ю має підхоплювати їх без перезапуску —
  // та сама механіка, що в post.json.
  useEffect(() => {
    let stopped = false;
    const pull = async (): Promise<void> => {
      try {
        const resp = await fetch(rawUrl(projectId, 'assets/motions.json'), { cache: 'no-store' });
        if (!resp.ok || stopped) return;
        const next = JSON.parse(await resp.text()) as { entries?: MotionEntry[] };
        const entries = next.entries ?? [];
        setMotions((prev) =>
          prev && JSON.stringify(prev) === JSON.stringify(entries) ? prev : entries);
        // Якщо правлять саме той рух, що зараз на прев'ю, — підмінити
        // його свіжою версією, інакше петля крутитиме стару. Підміна
        // ЛИШЕ при реальній зміні вмісту: новий об'єкт із того самого
        // JSON перезапускав rAF-петлю, і демо скидалось на початок
        // кожні 2.5 с — рівно в такт поллера.
        setMotionPreview((prev) => {
          if (!prev) return prev;
          const next = entries.find((e) => e.id === prev.id);
          if (!next) return prev;
          return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
        });
      } catch {
        // файлу ще немає — панель покаже, як його завести
      }
    };
    void pull();
    if (!motionsOpen && !galleryOpen) return undefined;
    const id = window.setInterval(() => void pull(), 2500);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [projectId, motionsOpen, galleryOpen]);

  // Петля прев'ю: демо крутиться по колу, час веде rAF, а не доріжка.
  // Старт із 0.02, щоб ведучий (умова time >= 0.01) не блимав на стику.
  useEffect(() => {
    if (!motionPreview?.demo) return undefined;
    const dur = Math.max(1, motionPreview.demo.duration);
    let raf = 0;
    let last = performance.now();
    let t = 0.02;
    const tick = (now: number): void => {
      t += (now - last) / 1000;
      last = now;
      if (t >= dur) t = 0.02;
      setDemoTime(t);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    // Доріжку на паузу: два часи водночас — це два ролики в одному кадрі.
    audioRef.current?.pause();
    return () => window.cancelAnimationFrame(raf);
  }, [motionPreview]);

  // Режим зйомки знімає справжній ролик — прев'ю руху йому заважати не
  // сміє: рендер, запущений під час відкритого демо, зняв би демо.
  useEffect(() => {
    if (shotMode) setMotionPreview(null);
  }, [shotMode]);

  // Escape закриває віконце прискорення: підкладка ловить лише мишу.
  useEffect(() => {
    if (!speedOpen) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSpeedOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [speedOpen]);

  // Клас вішаємо на корінь документа, а не на саму студію: панель чату
  // живе поза цим компонентом, і сховати її зсередини неможливо.
  useEffect(() => {
    if (!shotMode) return undefined;
    document.documentElement.classList.add('post-shot');
    return () => document.documentElement.classList.remove('post-shot');
  }, [shotMode]);
  const [playing, setPlaying] = useState(false);
  // Чернетка тексту озвучки. Тримаємо локально й пишемо на blur —
  // збереження на кожну літеру смикало б диск і onRefreshFiles.
  const [scriptDraft, setScriptDraft] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  // Блоки згорнуті до заголовків. Наведення розкриває тимчасово, перший
  // же клік усередині — закріплює: інакше панель згорталась би щоразу,
  // коли курсор іде до чату, просто в процесі роботи з нею.
  const [pinnedBlocks, setPinnedBlocks] = useState<ReadonlySet<string>>(() => new Set());
  const [hoverBlock, setHoverBlock] = useState<string | null>(null);

  // Поки доріжки немає, ролика ще немає — є задум. Показувати під нього
  // повний кадр немає сенсу: він порожній на весь екран, а робота йде в
  // тексті. Тому до заливки mp3 студія працює як чернетка: кадр згорнуто,
  // на екрані лишаються сценарій і очікування звуку.
  const isDraft = !post?.audio;

  const blockShell = useCallback(
    (id: string, stateClass: string) => ({
      blockId: id,
      stateClass,
      // Сценарій у чернетці розкритий сам: це єдине, що тут можна робити,
      // і згорнутий заголовок змушував би відкривати його щоразу.
      open: pinnedBlocks.has(id) || hoverBlock === id || (isDraft && id === 'script'),
      pinned: pinnedBlocks.has(id),
      onEnter: () => setHoverBlock(id),
      onLeave: () => setHoverBlock((h) => (h === id ? null : h)),
      onPin: () => setPinnedBlocks((s) => (s.has(id) ? s : new Set(s).add(id))),
      onToggle: () => setPinnedBlocks((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    }),
    [pinnedBlocks, hoverBlock, isDraft],
  );

  const audioFiles = useMemo(
    () => files.filter((f) => f.kind === 'audio' || AUDIO_RE.test(f.name)).map((f) => f.name),
    [files],
  );
  const wordsFiles = useMemo(() => files.filter((f) => WORDS_RE.test(f.name)).map((f) => f.name), [files]);
  // Тримаємо не лише імена: mtime потрібен, щоб перебити кеш браузера.
  // Без нього перезаписаний файл (зрізаний фон, перегенерована поза)
  // лишається на екрані старим до повного перезавантаження сторінки —
  // виглядає так, ніби агент відзвітував, а нічого не змінилось.
  const poseFiles = useMemo(() => files.filter((f) => POSE_RE.test(f.name)), [files]);
  // Стікери шукаємо по всьому проєкту, а не лише за шляхами з post.json:
  // намальований, але ще не прив'язаний файл має бути видно — інакше
  // робота агента виглядає як «нічого не сталося».
  // `.raw.png` — копії «як згенеровано», що лежать поруч заради
  // перерізання фону без нової генерації. У бібліотеку вони не йдуть,
  // інакше кожен стікер двоївся б, і половина була б із білим тлом.
  const stickerFiles = useMemo(
    () => files.filter((f) => STICKER_RE.test(f.name) && !/\.raw\.png$/i.test(f.name)),
    [files],
  );
  const stickerByPath = useMemo(
    () => new Map(stickerFiles.map((f) => [f.name.replace(/\\/g, '/'), f])),
    [stickerFiles],
  );

  // Реєстр стікерів. Потрібен рівно для одного: у полі `use` записано,
  // ДЛЯ ЧОГО стікер, і саме за ним його вибирають під фразу. Без реєстру
  // бібліотека перетворюється на десяток картинок без підписів, де
  // «крапля» і «кубики» нічого не кажуть, поки не згадаєш задум.
  const [stickerUse, setStickerUse] = useState<Map<string, string>>(() => new Map());
  // Реєстр цілком — для блоку бібліотеки: він показує не лише те, що
  // намальовано, а й ЗАЯВКИ (записи без файлу), які лишає агент, коли
  // під фразу нічого не підійшло.
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  const [registryStamp, setRegistryStamp] = useState(0);
  // Фолбек за id: стікер у post.json без file (заявка) підхоплює файл і
  // спрайт із реєстру, щойно вони там з'явились — «Взяти в ролик» чи
  // генерація оживляють кадр без правки post.json.
  const registryById = useMemo(
    () => new Map(registry.map((r) => [r.id, r])),
    [registry],
  );

  /*
   * Автодовезення подарунків. Агент вписує подарунок каталогу за id
   * (gift-118, gift-118-v012), але файли робити не вміє — тричі поспіль
   * це закінчувалось порожньою рамкою і «чому не показує». Тепер студія
   * сама бере подарунок з каталогу, щойно бачить його id без файла;
   * реєстровий фолбек домальовує кадр без правки post.json.
   * По одному за раз: конвертація на проєкт однопотокова (gift.pid).
   */
  const giftAutoTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!post) return;
    for (const s of post.stickers ?? []) {
      // «Бракує» — це коли шлях не РЕЗОЛВИТЬСЯ у файл, а не коли поля
      // нема: агент за прикладом зі SKILL пише file наперед, до
      // конвертації — і саме цей випадок треба довозити.
      const filePath = s.file ?? registryById.get(s.id)?.file;
      if (filePath && stickerByPath.has(filePath.replace(/\\/g, '/'))) continue;
      const m = /^(gift-\d{3})(?:-(v\d{3}))?$/.exec(s.id);
      if (!m || giftAutoTried.current.has(s.id)) continue;
      giftAutoTried.current.add(s.id);
      const [, slug, variant] = m;
      void (async () => {
        try {
          const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/gifts/take`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, ...(variant ? { variant } : {}), id: s.id }),
          });
          if (!resp.ok) throw new Error(String(resp.status));
          for (let i = 0; i < 60; i += 1) {
            await new Promise((r) => setTimeout(r, 1000));
            const st = await fetch(`/api/projects/${encodeURIComponent(projectId)}/gifts/take`, { cache: 'no-store' })
              .then((r) => r.json() as Promise<{ state: string }>)
              .catch(() => null);
            if (!st || st.state === 'running') continue;
            break;
          }
          await onRefreshFiles?.();
          setRegistryStamp((n) => n + 1);
          setNote(`подарунок «${s.id}» довезено з каталогу`);
        } catch {
          // не вийшло — рамка-заявка лишається видимою, як і була
        }
      })();
      break;
    }
  }, [post, registryById, stickerByPath, projectId, onRefreshFiles]);
  // Що відбувається всередині карток. Перевірка інакше вважає картку
  // однією нерухомою подією і свариться на «простій» там, де насправді
  // виїжджають рядки. Читаємо самі файли — дублювати кроки в post.json
  // означало б тримати два джерела правди про одну картку.
  const [cardSteps, setCardSteps] = useState<Record<string, CardStep[]>>({});
  // Еталон стилю на кожен розділ: з ним звіряють манеру лінії, кант і
  // поля. Задається в реєстрі, бо це рішення про набір, не про студію.
  const [styleRefs, setStyleRefs] = useState<Record<string, string>>({});
  //
  // Джерела два, і порядок той самий, що в позах: проєктний реєстр має
  // пріоритет (у ньому може бути набір, зроблений саме під цей ролик),
  // а якщо його немає — беремо СПІЛЬНИЙ із бібліотеки.
  //
  // Саме цієї другої гілки бракувало: щойно створений проєкт не має
  // `assets/stickers/`, панель писала «Реєстр не знайдено», і агент
  // починав із чистого аркуша — тобто малював новий набір у новій
  // манері замість того, щоб узяти наявний.
  useEffect(() => {
    let cancelled = false;
    type RegistryDoc = { stickers?: RegistryEntry[]; reference?: Record<string, string> };

    const parse = (text: string): RegistryDoc | null => {
      try {
        return JSON.parse(text) as RegistryDoc;
      } catch {
        return null; // битий JSON — краще показати картинки без підписів, ніж впасти
      }
    };

    const fromProject = async (): Promise<RegistryDoc | null> => {
      try {
        const resp = await fetch(rawUrl(projectId, 'assets/stickers/stickers.json'), { cache: 'no-store' });
        if (!resp.ok) return null;
        return parse(await resp.text());
      } catch {
        return null;
      }
    };

    const fromLibrary = async (): Promise<RegistryDoc | null> => {
      try {
        const listResp = await fetch(
          `/api/library/assets?tag=${encodeURIComponent(`${LIBRARY_STICKER_TAG},registry`)}`,
          { cache: 'no-store' },
        );
        if (!listResp.ok) return null;
        const list = (await listResp.json()) as { assets?: { id: string; capturedAt?: number }[] };
        // Реєстрів під тегом може бути КІЛЬКА: заливка не замінює попередній
        // ассет, а додає новий (перевірено 08-09 — після дозаливки їх стало
        // два, на 19 і на 23 записи). Брати `[0]` означало покладатись на
        // порядок видачі API: сьогодні він новіший першим, а завтра панель
        // тихо показала б старий набір, і агент знову малював би наявне.
        const assetId = [...(list.assets ?? [])]
          .sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0))[0]?.id;
        if (!assetId) return null;
        const rawResp = await fetch(libraryRawUrl(assetId), { cache: 'no-store' });
        if (!rawResp.ok) return null;
        return parse(await rawResp.text());
      } catch {
        return null;
      }
    };

    void (async () => {
      const data = (await fromProject()) ?? (await fromLibrary());
      if (!data || cancelled) return;
      const map = new Map<string, string>();
      for (const s of data.stickers ?? []) {
        const label = [s.shows, s.use].filter(Boolean).join(' · ');
        if (s.file) map.set(s.file.replace(/\\/g, '/'), label);
        map.set(s.id, label);
      }
      setStickerUse(map);
      setRegistry(data.stickers ?? []);
      setStyleRefs(data.reference ?? {});
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, registryStamp, stickerFiles.map((f) => `${f.name}:${f.mtime}`).join('|')]);

  // Реєстр правиться ЗЗОВНІ — агент дописує в нього після генерації, і
  // часто пізніше, ніж кладе сам файл. Кількість файлів на це вже не
  // змінюється, тож без окремого поштовху панель показувала б заявку на
  // те, що вже намальовано, аж до перезавантаження сторінки.
  //
  // Перечитуємо, коли вікно повертає фокус: власник іде в чат, агент
  // працює, власник вертається — це рівно та мить, коли дані застаріли.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out: Record<string, CardStep[]> = {};
      for (const c of post?.cards ?? []) {
        try {
          const resp = await fetch(rawUrl(projectId, c.file), { cache: 'no-store' });
          if (!resp.ok) continue;
          const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
          out[c.id] = [...doc.querySelectorAll<HTMLElement>('[data-reveal-at]')].map((n) => ({
            at: Number(n.dataset.revealAt),
            text: (n.textContent ?? '').replace(/\s+/g, ' ').trim(),
          }));
        } catch {
          // файлу немає або битий — перевірка просто не побачить його кроків
        }
      }
      if (!cancelled) setCardSteps(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, (post?.cards ?? []).map((c) => `${c.id}:${c.file}`).join('|')]);

  /*
   * Керування кадром іззовні — для рендера.
   *
   * Рендер знімає ЦЕЙ кадр, а не збирає окрему композицію: увесь рух у
   * нас — чиста функція часу, тож досить перемотати на потрібну секунду
   * і зняти. Так mp4 не «схожий» на превʼю, а є ним; будь-яка окрема
   * композиція розходилась би з ним на першій же правці.
   *
   * `ready` каже знімальнику, що дані вже завантажені й кадр можна
   * знімати — інакше перші кадри вийдуть порожніми.
   */
  useEffect(() => {
    const api = {
      setShot: (on: boolean) => setShotMode(on),
      setTime: (t: number) => {
        setTime(t);
        if (audioRef.current) audioRef.current.currentTime = t;
        // Кадр CSS-анімацій задається відʼємною затримкою від цієї
        // змінної — інакше вони крутяться за годинником браузера.
        document.documentElement.style.setProperty('--shot-t', String(t));
      },
      duration: post?.audio?.duration ?? 0,
      speed: post?.speed ?? 1,
      /** Скільки триватиме готовий файл із урахуванням прискорення. */
      outDuration: (post?.audio?.duration ?? 0) / (post?.speed ?? 1),
      fps: CANVAS.fps,
      ready: (post?.words.length ?? 0) > 0,
    };
    (window as unknown as { __postStudio?: typeof api }).__postStudio = api;
    return () => {
      delete (window as unknown as { __postStudio?: typeof api }).__postStudio;
    };
  }, [post?.audio?.duration, post?.words.length, post?.speed]);

  useEffect(() => {
    const bump = (): void => setRegistryStamp((n) => n + 1);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') bump();
    };
    window.addEventListener('focus', bump);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', bump);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  const posesJson = useMemo(() => files.find((f) => POSES_RE.test(f.name))?.name ?? null, [files]);
  const [poses, setPoses] = useState<PoseEntry[]>([]);

  // Реєстр поз: підписи «для чого» і позначки якості. Без нього сітка
  // перетворюється на однакові квадратики, де не видно, що дві пози
  // розійшлися з еталоном і їх не варто ставити в кадр.
  //
  // Джерела два. Проєктний poses.json має пріоритет — там може бути
  // ведучий, зроблений саме під цей ролик. Якщо його немає (звичайний
  // випадок для щойно створеного проєкту), беремо спільний реєстр з
  // бібліотеки, щоб персонаж був доступний скрізь, а не лише там, де
  // його колись згенерували.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fromProject = async (): Promise<PoseEntry[] | null> => {
        if (!posesJson) return null;
        try {
          const resp = await fetch(rawUrl(projectId, posesJson), { cache: 'no-store' });
          if (!resp.ok) return null;
          const data = JSON.parse(await resp.text()) as { poses?: PoseEntry[] };
          return Array.isArray(data.poses) ? data.poses : null;
        } catch {
          return null;
        }
      };

      const fromLibrary = async (): Promise<PoseEntry[]> => {
        try {
          const listResp = await fetch(
            `/api/library/assets?tag=${encodeURIComponent(`${LIBRARY_HOST_TAG},registry`)}`,
            { cache: 'no-store' },
          );
          if (!listResp.ok) return [];
          const list = (await listResp.json()) as { assets?: { id: string }[] };
          const assetId = list.assets?.[0]?.id;
          if (!assetId) return [];
          const rawResp = await fetch(libraryRawUrl(assetId), { cache: 'no-store' });
          if (!rawResp.ok) return [];
          const data = JSON.parse(await rawResp.text()) as { poses?: PoseEntry[] };
          return Array.isArray(data.poses) ? data.poses : [];
        } catch {
          return [];
        }
      };

      const resolved = (await fromProject()) ?? (await fromLibrary());
      if (!cancelled) setPoses(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, posesJson]);

  // Сітка поз. Базою беремо реєстр, а не файли проєкту: реєстр знає
  // повний набір, підписи «для чого» і позначки якості. Файл проєкту
  // лише підмінює картинку там, де він є.
  //
  // Це важливо: агент копіює еталон у проєкт перед i2i-генерацією
  // (диспетчер читає --image лише за project-relative шляхом), і якби
  // файли заміщали реєстр, один скопійований еталон ховав би решту
  // шести поз.
  const poseCards = useMemo<PoseCard[]>(() => {
    const byFile = new Map(poseFiles.map((f) => [f.name.split('/').pop() ?? f.name, f]));
    const cards: PoseCard[] = [];
    for (const entry of poses) {
      const local = byFile.get(entry.file);
      if (local) byFile.delete(entry.file);
      const src = local
        ? `${rawUrl(projectId, local.name)}?v=${local.mtime}`
        : entry.libraryId
          ? libraryRawUrl(entry.libraryId)
          : '';
      if (!src) continue;
      cards.push({
        key: entry.id,
        src,
        ref: local?.name ?? `${entry.id} (спільна бібліотека, ассет ${entry.libraryId})`,
        entry,
        inProject: Boolean(local),
      });
    }
    // Файли, яких немає в реєстрі — щойно згенеровані пози, ще не
    // вписані в poses.json. Показуємо їх, інакше свіжа генерація
    // виглядає як «нічого не сталося».
    for (const file of byFile.values()) {
      cards.push({
        key: file.name,
        src: `${rawUrl(projectId, file.name)}?v=${file.mtime}`,
        ref: file.name,
        inProject: true,
      });
    }
    // Еталон завжди перший: з ним звіряють решту, тож він має бути
    // під рукою. Далі — порядок реєстру, а безреєстрові новинки в
    // кінці, щоб їх було видно як «ще не оформлені».
    return cards.sort((a, b) => {
      const rank = (c: PoseCard): number => {
        if (c.entry?.id === 'wave') return 0;
        return c.entry ? 1 : 2;
      };
      return rank(a) - rank(b);
    });
  }, [poseFiles, poses, projectId]);

  // Перегляд пози великим планом. Без нього неможливо порівняти позу з
  // еталоном — а саме за цим і дивляться: чи не поплило обличчя.
  const [preview, setPreview] = useState<PoseCard | null>(null);
  // Перегляд стікера — той самий принцип, що в поз: клік у сітці
  // ВІДКРИВАЄ, а не робить мовчки. Дію вибирають уже тут.
  const [stickerPreview, setStickerPreview] = useState<RegistryEntry | null>(null);
  const reference = useMemo(
    () => poseCards.find((c) => c.entry?.id === 'wave') ?? poseCards[0] ?? null,
    [poseCards],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(rawUrl(projectId, POST_FILE), { cache: 'no-store' });
        if (cancelled) return;
        if (resp.ok) {
          setPost(JSON.parse(await resp.text()) as PostSpec);
          return;
        }
      } catch {
        // немає файлу або битий JSON — починаємо з чистого
      }
      if (!cancelled) setPost(emptyPost());
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /*
   * Стан ролика міняє не тільки панель — його ж пише агент із чату.
   * Доти файл читався рівно один раз, на відкритті проєкту: агент
   * складав увесь ролик, а в кадрі лишалась порожнеча, і єдиним способом
   * побачити роботу було перезапустити застосунок.
   *
   * Порівнюємо ВМІСТ, а не час файлу: збереження з самої панелі теж
   * перезаписує post.json, і на кожен свій же запис кадр перемальовувався
   * б заново. Однакові дані — стан не чіпаємо, тож смикання немає.
   *
   * У режимі зйомки опитування вимкнене: знімальник перемотує кадр по
   * секундах, і підміна стану посеред зйомки дала б рвані кадри.
   */
  useEffect(() => {
    if (shotMode) return undefined;
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (document.visibilityState !== 'visible') return;
      try {
        const resp = await fetch(rawUrl(projectId, POST_FILE), { cache: 'no-store' });
        if (!resp.ok || stopped) return;
        const text = await resp.text();
        const next = JSON.parse(text) as PostSpec;
        setPost((prev) => {
          if (prev && JSON.stringify(prev) === JSON.stringify(next)) return prev;
          // Файли теж перечитуємо — але тільки коли стан справді змінився:
          // разом із розміткою приходять нові стікери й картки, і без
          // свіжого списку кадр малював би пропуски замість картинок.
          void onRefreshFiles?.();
          return next;
        });
      } catch {
        // недописаний файл або збій мережі — наступний тік підбере
      }
    };
    const id = window.setInterval(() => void tick(), 2500);
    const onFocus = () => void tick();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      stopped = true;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [projectId, shotMode, onRefreshFiles]);

  const save = useCallback(
    async (next: PostSpec, message: string) => {
      setBusy(true);
      try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: POST_FILE, content: JSON.stringify(next, null, 2) }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setPost(next);
        setNote(message);
        await onRefreshFiles?.();
      } catch (err) {
        setNote(`не зберіг: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [projectId, onRefreshFiles],
  );

  const pickAudio = useCallback(
    async (path: string) => {
      if (!post) return;
      setBusy(true);
      const duration = await measureAudio(rawUrl(projectId, path));
      // Інша доріжка — старі таймкоди вже не про неї.
      const stale = post.words.length > 0 && post.audio?.path !== path;
      setTime(0);
      await save(
        {
          ...post,
          audio: { path, source: 'manual', duration },
          words: stale ? [] : post.words,
          beats: stale ? [] : post.beats,
        },
        stale ? 'доріжку змінено, таймкоди скинуто' : `доріжка · ${clock(duration)}`,
      );
      // Вирівнювання звідси НЕ запускаємо: цим відає ефект нижче, який
      // дивиться на СТАН ролика. Інакше автозапуск працює лише для того,
      // хто заливає доріжку панеллю, а через чат — ні.
    },
    [post, projectId, save],
  );

  /*
   * Таймкоди стартують САМІ — хто б не залив доріжку.
   *
   * Доти автозапуск жив усередині `pickAudio`, тобто спрацьовував лише
   * тоді, коли mp3 чіпляли ПАНЕЛЛЮ. Але доріжку так само пише агент,
   * коли її кидають у чат — SKILL велить йому записати `audio` просто в
   * `post.json`. Той шлях проходив повз автозапуск: у ролику є звук,
   * слів немає, і студія мовчки чекає кліку по кнопці, про яку власник
   * не знає. Саме так це й виглядало: «скинув доріжку — а далі нічого».
   *
   * Тому умова переїхала з ДІЇ на СТАН: є доріжка, є сценарій, слів
   * немає, нічого не крутиться → вирівнюємо. Один раз на доріжку:
   * помилку не крутимо по колу, для повтору є кнопка «Таймкоди».
   */
  const autoAlignedFor = useRef<string | null>(null);
  useEffect(() => {
    const path = post?.audio?.path;
    if (!post || !path) return;
    // Слова вже є — нічого не треба; запам'ятовуємо, щоб не смикнути
    // вирівнювання, якщо їх колись почистять руками.
    if (post.words.length > 0) {
      autoAlignedFor.current = path;
      return;
    }
    if (!post.script.trim()) return;
    if (align?.state === 'running' || render?.state === 'running') return;
    if (autoAlignedFor.current === path) return;
    autoAlignedFor.current = path;
    void startAlign(path);
  }, [post, align?.state, render?.state, startAlign]);

  // Заливка mp3 просто тут: раніше кнопка кидала у файловий воркспейс,
  // звідки треба було повертатись назад — три кроки замість одного.
  const uploadAudio = useCallback(
    async (file: File) => {
      setBusy(true);
      setNote(`заливаю ${file.name}…`);
      try {
        const res = await uploadProjectFiles(projectId, [file]);
        if (res.failed.length > 0) {
          const fail = res.failed[0];
          throw new Error(fail?.error ?? fail?.code ?? 'файл не залився');
        }
        await onRefreshFiles?.();
        setBusy(false);
        // Одразу робимо залите доріжкою. Інакше файл лише з'являється у
        // списку, а решта кроків лишається заблокованою — і незрозуміло,
        // що треба ще раз клікнути по ньому.
        const uploadedPath = res.uploaded[0]?.path ?? res.uploaded[0]?.name ?? file.name;
        await pickAudio(uploadedPath);
      } catch (err) {
        setBusy(false);
        setNote(`не залилось: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [projectId, onRefreshFiles, pickAudio],
  );

  // Прибрати доріжку. Разом з нею йдуть слова й біти: вони прив'язані
  // до конкретного аудіо, і лишати їх — значить тримати таймкоди, що
  // вказують у нікуди.
  const clearAudio = useCallback(async () => {
    if (!post) return;
    setTime(0);
    if (audioRef.current) audioRef.current.pause();
    await save(
      { ...post, audio: null, words: [], beats: [] },
      'звук прибрано — таймкоди й біти скинуто',
    );
  }, [post, save]);

  // Позиція відтворення на кожен кадр, а не на подію timeupdate: та
  // приходить ~4 рази на секунду, і підсвітка слів через неї смикається
  // й запізнюється. requestAnimationFrame дає рівно стільки оновлень,
  // скільки екран здатен показати, і тільки поки звук грає.
  const audioPath = post?.audio?.path ?? null;
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audioPath) return;
    let raf = 0;
    const tick = (): void => {
      setTime(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    const start = (): void => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const stop = (): void => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      setTime(el.currentTime);
    };
    // Після перемотки цикл треба ПОНОВИТИ, якщо звук іде далі. Раніше
    // тут стояв той самий stop, і перемотка на ходу глушила rAF назовсім:
    // події play більше не буде, тож кадр далі оновлювався лише з
    // timeupdate, тобто вчетверо рідше — субтитри починали смикатись.
    const onSeeked = (): void => {
      setTime(el.currentTime);
      if (!el.paused) start();
    };
    const onPlayState = (): void => setPlaying(!el.paused);
    el.addEventListener('play', start);
    el.addEventListener('play', onPlayState);
    el.addEventListener('pause', stop);
    el.addEventListener('pause', onPlayState);
    el.addEventListener('ended', stop);
    el.addEventListener('ended', onPlayState);
    el.addEventListener('seeked', onSeeked);
    setPlaying(!el.paused);
    if (!el.paused) start();
    return () => {
      el.removeEventListener('play', start);
      el.removeEventListener('play', onPlayState);
      el.removeEventListener('pause', stop);
      el.removeEventListener('pause', onPlayState);
      el.removeEventListener('ended', stop);
      el.removeEventListener('ended', onPlayState);
      el.removeEventListener('seeked', onSeeked);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [audioPath]);

  /*
   * Пришвидшення чіпає ТІЛЬКИ доріжку — і цього досить.
   *
   * Субтитри, стікери й пози читають `audio.currentTime`, а це час
   * МЕДІА, не годинника: на 1.5× секунда запису так само лишається
   * секундою запису, просто настає раніше. Тож усе, що прив'язане до
   * `words`, стискається саме собою, без жодного перерахунку — і без
   * ризику, що десь один множник забули.
   *
   * Анімації персонажа живуть у CSS, тобто на годиннику, тому вони
   * НЕ пришвидшуються. Це те, що треба: виїзд і зміна пози — рухи тіла,
   * а не частина мови, і на 2× вони перетворились би на смикання.
   */
  const speed = post?.speed ?? 1;
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // defaultPlaybackRate обов'язковий, не дубль: підвантаження нового
    // файлу скидає playbackRate саме на default. Без нього зміна
    // доріжки мовчки повертала б швидкість до 1, і панель показувала б
    // 1.5×, поки звук іде як записаний.
    el.defaultPlaybackRate = speed;
    el.playbackRate = speed;
  }, [speed, audioPath]);

  const pullWords = useCallback(
    async (path: string) => {
      if (!post) return;
      setBusy(true);
      try {
        const resp = await fetch(rawUrl(projectId, path), { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const parsed = JSON.parse(await resp.text()) as unknown;
        const words = (Array.isArray(parsed) ? parsed : []).filter(
          (w): w is WordTiming =>
            typeof w === 'object' && w !== null
            && typeof (w as WordTiming).word === 'string'
            && typeof (w as WordTiming).start === 'number'
            && typeof (w as WordTiming).end === 'number',
        );
        if (words.length === 0) throw new Error('немає слів із таймкодами');
        setBusy(false);
        const last = words[words.length - 1]!.end;
        const dur = post.audio?.duration ?? 0;
        await save(
          { ...post, words },
          dur > 0 && last > dur + 0.5
            ? `${words.length} слів, але останнє на ${last.toFixed(1)} с проти ${clock(dur)} — схоже, з іншого дубля`
            : `${words.length} слів із таймкодами`,
        );
      } catch (err) {
        setBusy(false);
        setNote(`не прочитав ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [post, projectId, save],
  );

  // Субтитр — рядок із кількох слів, а не одне слово. Три коротких
  // читаються за один погляд; довгі («найголовніше», «перейменувати»)
  // у трійці вже не влазять по ширині, тому група закривається і за
  // сумарною довжиною, не тільки за кількістю.
  //
  // Рахується ДО раннього виходу нижче: хуки не можна лишати за
  // умовним return — кількість між рендерами розійдеться, і React
  // впаде з «Rendered more hooks than during the previous render».
  const captionChunks = useMemo(() => chunkCaptionWords(post?.words ?? []), [post?.words]);

  // Демо руху зі словника: поки воно відкрите, кадр малює цей мініролик
  // замість post.json. Розгортається тут, а не в обробнику кліку, щоб
  // правка demo агентом (поллер вище підміняє motionPreview) одразу
  // перебудовувала і кадр.
  const previewPost = useMemo(
    () => (motionPreview?.demo ? demoPost(motionPreview.demo) : null),
    [motionPreview],
  );



  if (!post) {
    return (
      <div className="post-ws">
        <div className="post-ws__bar"><span className="post-ws__meta">Читаю {POST_FILE}…</span></div>
      </div>
    );
  }

  const stage = postStage(post);

  /*
   * Смуга етапів: де зараз ролик.
   *
   * Стан кожного кроку читається з САМИХ ДАНИХ, а не з окремого поля
   * прогресу. Поле довелось би комусь оновлювати, і воно розійшлося б із
   * дійсністю рівно тоді, коли на нього почали б покладатись: агент
   * зробив роботу, а смуга каже «чекає». Тут навпаки — з'явились слова,
   * крок закрився сам.
   *
   * Поточний — перший незакритий: пайплайн лінійний, і робота над
   * пізнім кроком без раннього однаково нічого не дасть.
   */
  const stages = (() => {
    const items = [
      { key: 'audio', title: 'Звук', hint: 'доріжка залита', done: Boolean(post.audio) },
      { key: 'words', title: 'Таймкоди', hint: 'слова з часом', done: post.words.length > 0 },
      { key: 'scenes', title: 'Речення', hint: 'нарізка на кадри', done: (post.scenes?.length ?? 0) > 0 },
      { key: 'beats', title: 'Розбір', hint: 'пози й ритм', done: post.beats.length > 0 },
      {
        key: 'assets',
        title: 'Кадр',
        hint: 'стікери й картки',
        done: (post.stickers?.length ?? 0) > 0 || (post.cards?.length ?? 0) > 0,
      },
      {
        key: 'render',
        title: 'Рендер',
        hint: 'готовий mp4',
        done: files.some((f) => /(^|[\\/])post\.mp4$/i.test(f.name)),
      },
    ];
    const current = items.findIndex((s) => !s.done);
    return items.map((s, i) => ({
      ...s,
      state: s.done ? 'done' : i === current ? 'current' : 'wait',
    }));
  })();

  const preset = PRESETS[post.preset] ?? PRESETS[DEFAULT_PRESET];
  const duration = post.audio?.duration ?? 0;

  /*
   * Що зараз малює кадр: ролик або демо руху зі словника.
   *
   * Кадрові обчислення нижче читають framePost/frameTime, а панелі —
   * як і раніше post/time: прев'ю руху підміняє лише картинку в рамці,
   * не стан проєкту. Час демо веде rAF-петля, не доріжка.
   */
  const framePost = previewPost ?? post;
  const frameTime = previewPost ? demoTime : time;
  const frameChunks = previewPost ? chunkCaptionWords(framePost.words) : captionChunks;

  const activeWordIndex = wordIndexAt(post.words, time);
  const activeWord = activeWordIndex < 0 ? null : post.words[activeWordIndex]!;

  // Активна група — остання, що вже почалась. Шукаємо за часом, а не за
  // індексом слова: у групи не потрапляють слова з самої пунктуації
  // (окреме тире), тому нумерація в post.words і всередині груп давно
  // розійшлася. Через це на кожному тире кадр порожнів — індекс вказував
  // у нікуди, хоча фраза тривала.
  const activeChunk = (() => {
    if (framePost.words.length === 0 || frameChunks.length === 0) return null;
    let found: WordTiming[] | null = null;
    for (const chunk of frameChunks) {
      if (chunk[0]!.start <= frameTime) found = chunk;
      else break;
    }
    if (!found) return null;
    // Довга тиша після останнього слова групи звільняє кадр — але тільки
    // якщо попереду ще щось є. Фінальну групу тримаємо до кінця доріжки.
    const last = found[found.length - 1]!;
    const isFinal = found === frameChunks[frameChunks.length - 1];
    if (!isFinal && frameTime > last.end + CAPTION_HOLD_S) {
      const nextIdx = frameChunks.indexOf(found) + 1;
      const next = frameChunks[nextIdx];
      if (next && frameTime < next[0]!.start - CAPTION_HOLD_S) return null;
    }
    return found;
  })();
  const activeBeat = beatAt(framePost.beats, frameTime);
  // У біті поза записана так, як її призначили: id з реєстру («wave»),
  // іменем файлу або повним шляхом. Тому картку шукаємо за всіма
  // полями одразу — інакше кадр лишається порожнім, хоча біт із позою
  // насправді є.
  const activePose = activeBeat?.pose ?? null;
  const matchesPose = (card: PoseCard, pose: string): boolean =>
    card.entry?.id === pose
    || card.entry?.file === pose
    || card.key === pose
    || card.ref === pose
    || (card.ref.split('/').pop() ?? card.ref) === pose;
  const isActiveCard = (card: PoseCard): boolean =>
    activePose != null && matchesPose(card, activePose);
  const activePoseCard = activePose
    ? poseCards.find((c) => matchesPose(c, activePose)) ?? null
    : null;

  const scenes = post.scenes ?? [];
  const planned = scenes.filter((s) => s.plan != null).length;
  // Без useMemo навмисно: цей рядок стоїть ПІСЛЯ умовного return вище,
  // і хук тут ламав би правило хуків. Дванадцять id — не та ціна.
  // Реєстр набору віддаємо перевірці: без нього вона не відрізнить
  // «стікер без file, але він є в наборі» від вигаданого id.
  const findings = checkPost(
    post,
    cardSteps,
    (motions ?? []).map((m) => m.id),
    registry.map((r) => r.id),
  );



  // Режим зйомки: у кадрі лишається тільки сам кадр, розтягнутий на все
  // вікно. Панель, плеєр і стрічка слів у mp4 не потрібні, а ховати їх
  // ззовні означало б покладатись на селектори, які завтра зміняться.

  const warns = findings.filter((f) => f.level === 'warn').length;
  const wanted = registry.filter((r) => r.status === 'needed');
  // Екран не плаває: вікно, термінал і список — це інтерфейс, а не
  // предмет. Плаваючий інтерфейс читається як помилка рендеру.
  const kindOf = new Map(registry.map((r) => [r.id, r.kind ?? 'object']));

  // Перемалювати наявний. Головна вимога тут — не «краще», а «в тому ж
  // наборі»: стікер, що сам по собі вдаліший, але іншої манери, ламає
  // кадр сильніше, ніж посередній свій.
  const redrawSticker = (r: RegistryEntry): void => ask([
    `Перемалюй стікер «${r.id}» у нашому стилі.`,
    '',
    `файл: ${r.file ?? `assets/stickers/${r.id}.png`}`,
    `для чого: ${r.use ?? '—'}`,
    `що зображено: ${r.shows ?? '—'}`,
    '',
    'СТИЛЬ ГОЛОВНІШИЙ ЗА ЗМІСТ. Роби IMAGE-TO-IMAGE від наявного файлу:',
    'так зберігаються товщина контурів, насиченість, білий кант і манера',
    'тіней. Генерація з самого тексту дає інший малюнок, і стікер випадає',
    'з набору навіть тоді, коли сам по собі кращий.',
    '',
    'Міняти можна: композицію, ракурс, вираз, дрібні деталі предмета.',
    'Міняти НЕ можна: манеру лінії, палітру, наявність і товщину білого',
    'канта, розмір предмета в кадрі й поля навколо нього.',
    '',
    'Промпт, хвіст стилю і три пастки — references/stickers.md плагіна',
    'create-instagram-post: не просити прозорий фон, не домальовувати кант',
    'кодом, не лишати порожніх поверхонь. Модель — з поля "model" реєстру.',
    '',
    'ПІСЛЯ: прогнати фон через make_stickers.py, ПЕРЕЗАПИСАТИ той самий',
    'файл (нового id не заводити), у реєстрі оновити shows і quality.',
    '',
    'ЗВІТ — трьома рядками: що змінилось, чим стало краще, що перевірити оком.',
  ].join('\n'));

  /*
   * Конструктор анімацій: три готові запити в чат.
   *
   * Сенс кнопок — контекст без витрат: агент одразу знає, який запис
   * правиться, де лежить файл і що прев'ю оновиться саме звідти. Інакше
   * кожна сесія починалася б із пояснень, де ми і що робимо.
   */
  const askMotionEdit = (m: MotionEntry): void => ask([
    `Конструктор анімацій. Працюємо над рухом «${m.id}» зі словника.`,
    '',
    `Файл: assets/motions.json → запис id "${m.id}". Його demo — мініролик,`,
    'який студія крутить у кадрі по колу; файл перечитується кожні ~3 с,',
    'тож твоя правка з\'являється в прев\'ю сама, без перезапуску.',
    '',
    'Я казатиму правки словами («вище», «повільніше», «бейдж раніше»,',
    '«хай заходить збоку»). Перекладай їх у поля demo: word / lead / hold /',
    'enter / badges[].at / label / scenes[].continues / beats[].pose — і',
    'зберігай файл. Тексти при цьому лиши демонстраційними.',
    '',
    'Межі можливого — references/motion-library.md, розділ «Чого студія',
    'не вміє» (у .od-skills/create-instagram-post-*/references/). Якщо я',
    'прошу неможливе — скажи прямо і запропонуй найближчий досяжний рух.',
    '',
    'Коли скажу «готово»: онови прозовий опис запису (enter/inside/exit/',
    'axes/fixed) у тому ж motions.json і перенеси зміни у джерело плагіна',
    'D:\\od-plugins\\create-instagram-post\\references\\motions.json, щоб рух',
    'дістався й іншим роликам. post.json ролика НЕ чіпай і НЕ рендери.',
  ].join('\n'));

  const askMotionNew = (): void => ask([
    'Конструктор анімацій. Створюємо НОВИЙ рух у словнику.',
    '',
    'Спершу спитай мене одним повідомленням: (1) склад кадру — скільки',
    'предметів, чи є картка, чи бейджі; (2) що відбувається — трьома',
    'фазами: як заходить → що робить у кадрі → як іде.',
    '',
    'Далі додай запис у assets/motions.json: id (kebab-case), title, pick',
    '(одне питання-дискримінатор для таблиці добору), enter/inside/exit,',
    'axes (що міняти під речення), fixed (що не чіпати й чому), avoid — і',
    'demo: мініролик на 3–6 с (words із таймінгами, scenes, stickers з',
    'наявного набору assets/stickers/, за потреби beats з позою).',
    'Прев\'ю в студії підхопить файл саме.',
    '',
    'Межі — references/motion-library.md → «Чого студія не вміє». Рух,',
    'якого студія не вміє, у словник не потрапляє: запропонуй найближчий',
    'можливий і скажи, чого саме бракує студії.',
    '',
    'Коли я скажу «готово» — допиши рух у motion-library.md (рядок у',
    'таблицю добору + повний запис) і поверни ОБИДВА файли в джерело',
    'плагіна D:\\od-plugins\\create-instagram-post\\references\\.',
  ].join('\n'));

  // Словник — копія двох файлів із плагіна; демон робить її сам, чат
  // тут був марнотратством. Поллер motions підхопить файл за ~3 с.
  const seedMotions = async (): Promise<void> => {
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/motions/seed`, { method: 'POST' });
      const data = await resp.json().catch(() => null) as { error?: string; cards?: number } | null;
      if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
      setNote(`словник заведено${typeof data?.cards === 'number' ? ` · демо-карток: ${data.cards}` : ''}`);
    } catch (err) {
      setNote(`словник не завівся: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /*
   * Видалити рух зі словника проєкту.
   *
   * Пише той самий assets/motions.json, який читає поллер, — список і
   * галерея оновляться самі. Джерело плагіна навмисно не чіпаємо:
   * видалення тут — «прибрати з цього проєкту», а не з набору назавжди;
   * повернути можна кнопкою «Завести словник».
   */
  const deleteMotion = async (id: string): Promise<void> => {
    if (!motions) return;
    const next = motions.filter((m) => m.id !== id);
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'assets/motions.json',
          content: JSON.stringify({ version: 1, entries: next }, null, 1),
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setMotions(next);
      setMotionPreview((prev) => (prev?.id === id ? null : prev));
      setNote(`рух «${id}» прибрано зі словника проєкту`);
    } catch (err) {
      setNote(`не видалив: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /*
   * Старт рендера — напряму в демон, без чату. Раніше тут збирався
   * текст-інструкція агенту з командою render.py; тепер ті самі
   * аргументи їдуть у POST, а демон запускає той самий скрипт сам.
   * Обидві кнопки (центр студії і блок 9) кличуть саме цю функцію —
   * два шляхи до одного результату не сміють розійтись.
   */
  const startRender = async (): Promise<void> => {
    // Без words студія не віддасть __postStudio.ready, і render.py висів
    // би 60 с до таймаута з глухим «код 1» — чесніше не пускати старт.
    if (!post?.audio || post.words.length === 0) return;
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: window.location.origin,
          audio: post.audio.path,
          fps: CANVAS.fps,
          speed: post.speed ?? 1,
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${resp.status}`);
      }
      setRender((prev) => ({
        state: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        exitCode: null,
        error: null,
        tail: '',
        out: prev?.out ?? null,
        dir: prev?.dir ?? null,
      }));
    } catch (err) {
      setNote(`рендер не стартував: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Замовлення бракуючого — одним текстом, бо кнопка стоїть у двох
  // місцях: у шапці блоку і під самим списком заявок. У шапці її легко
  // не помітити, а потрібна вона саме там, де видно брифи.
  const orderWanted = (): void => ask([
    'Намалюй те, чого бракує в бібліотеці.',
    '',
    'ЗАЯВКИ (з assets/stickers/stickers.json, записи зі status: "needed"):',
    ...wanted.map((r) => [
      `• ${r.id} → ${r.folder ?? 'assets/stickers/'}${r.id}.png`,
      `  для чого: ${r.use ?? '—'}`,
      `  бриф: ${r.brief ?? '—'}`,
    ].join('\n')),
    '',
    'ЯК МАЛЮВАТИ. Промпт, стиль і три пастки — references/stickers.md',
    'плагіна create-instagram-post: не просити прозорий фон (модель',
    'намалює шахівницю), не домальовувати кант кодом (вона робить його',
    'краще сама), не лишати порожніх поверхонь — казати, ЧИМ поверхня',
    'заповнена, інакше вона домалює туди сторонній предмет.',
    '',
    'Модель — та сама, що в полі "model" реєстру. Не міняй її: інша дає',
    'інший стиль, і набір перестає бути набором.',
    '',
    'КУДИ КЛАСТИ. Рівно в ту папку й під тим id, що в заявці. Не вигадуй',
    'власного імені файлу, не клади в assets/character/ (там живуть пози',
    'ведучого, і студія покаже твою картинку як зайву позу) і НЕ СТВОРЮЙ',
    'окремого реєстру: усе, що знаєш про картинку — промах моделі, спосіб',
    'зрізу фону, заміри — пиши в той самий запис stickers.json.',
    '',
    'ПІСЛЯ ГЕНЕРАЦІЇ: прогнати фон через make_stickers.py, покласти файл',
    'у вказану папку, у реєстрі прибрати status і brief, дописати file.',
    'Заявка без файлу лишається заявкою.',
    '',
    'ЗВІТ — трьома рядками: що намальовано, де лежить, що перевірити оком.',
    'Розбір процесу лишай у полях реєстру, не в чаті.',
  ].join('\n'));
  const stickers = post.stickers ?? [];
  // Картки оголошені тут, а не нижче: стеля життя стікера дивиться і на
  // них — картка займає ту саму смугу кадру, що й предмет.
  const cards = post.cards ?? [];
  // Кадр малює framePost: у прев'ю руху це демо, у звичайній роботі —
  // той самий post, тож нижче все читається однаково.
  const frameStickers = framePost.stickers ?? [];
  const frameCards = framePost.cards ?? [];
  const spans = stickerSpans(frameStickers, framePost.words, framePost.scenes ?? [], frameCards);
  const liveStickers = stickerLayout(spans, frameTime, preset.stickers.maxWidthPct);
  // Удар спільний на весь кадр: на акцентному слові смикаються ВСІ живі
  // стікери разом. Один смикається — це збіг, усі разом — це такт.
  const framePunch = accentPunch(frameTime, framePost.words);
  // Спільна лінія низу зони стікерів: рахується з максимальної
  // ширини, тому не залежить від того, скільки предметів у кадрі.
  const stickerBase = preset.stickers.top
    + preset.stickers.maxWidthPct * (CANVAS.w / CANVAS.h);
  const activeCard = cardAt(frameCards, framePost.words, frameTime);
  /*
   * Слот картки колекційного. Блок nft-card-*.html генерує демон із
   * відомою геометрією, тож позицію подарунка всередині картки студія
   * знає без домовленостей у даних: він стає в слот замість того, щоб
   * ховатись під карткою (звичайні картки стікерів не терплять).
   */
  const nftSlot = activeCard && isNftCard(activeCard.card.file) ? NFT_CARD_SLOT : null;
  // Наскільки подарунок заповнює слот. У клієнті стікер займає майже
  // весь слот, тож лишаємо тільки тонке поле.
  const NFT_SLOT_FILL = 0.98;
  /*
   * Подарунок у слоті їде РАЗОМ із карткою: та сама функція руху, що
   * малює саму картку (приїзд справа, вихід). Інакше картка в'їжджає, а
   * предмет стоїть на місці — вони роз'їжджаються посеред появи.
   */
  const nftCardMotion = nftSlot && activeCard
    ? cardMotion(frameTime - activeCard.start, activeCard.card.hold)
    : null;
  /*
   * Коробка подарунка в слоті — з МАСШТАБОМ картки.
   *
   * Картка в'їжджає від 97 % і росте від свого верхнього краю. Без цього
   * множника предмет перші 0.42 с більший за власний слот на 6 px і
   * сидить на 5 px нижче — рівно те розсинхронення, від якого пара
   * перестає читатись як одна річ. Відлік той самий, що в картки:
   * центр по ширині кадру, верх — верх шару.
   */
  const nftBox = nftSlot && (() => {
    const k = nftCardMotion?.scale ?? 1;
    const w = nftSlot.width * NFT_SLOT_FILL * k;
    const mid = 0.5 + (nftSlot.left + nftSlot.width / 2 - 0.5) * k;
    return {
      left: mid - w / 2,
      width: w,
      // Вертикаль картки (`motion.y`) — у той самий бік і в тих самих
      // одиницях, що в `CardLayer`. Без цього доданка предмет тримає
      // свою висоту, поки картка їде своєю: на виході вона піднімається
      // на 3 %, і подарунок з неї висипається.
      top: preset.stickers.top
        + (nftCardMotion?.y ?? 0) / 100
        + (nftSlot.dropPx + (nftSlot.topPx + nftSlot.sizePx * (1 - NFT_SLOT_FILL) * 0.75) * k)
          * nftSlot.pxToHeight,
      height: nftSlot.sizePx * NFT_SLOT_FILL * k * nftSlot.pxToHeight,
    };
  })();
  // Слова, на яких висить стікер: у стрічці транскрипції вони отримують
  // позначку, тож видно розкладку картинок по всьому тексту одразу.
  const stickerWords = new Set(stickers.map((s) => s.word));
  const drawnCount = stickers.filter(
    (s) => s.file && stickerByPath.has(s.file.replace(/\\/g, '/')),
  ).length;

  const seek = (t: number) => {
    setTime(t);
    if (audioRef.current) audioRef.current.currentTime = t;
  };

  /**
   * Причепити стікер до слова, на якому зараз стоїть плейхед.
   *
   * Робимо напряму, а не запитом у чат: це редагування стану, як вибір
   * доріжки, а не задача для агента. Проганяти через прогін те, що
   * зводиться до одного рядка в post.json, — зайва хвилина очікування
   * на кожен стікер.
   */
  const bindSticker = (file: string, id: string) => {
    if (post.words.length === 0) return;
    const at = Math.max(0, wordIndexAt(post.words, time));
    if (stickers.some((s) => s.word === at)) {
      setNote('на цьому слові стікер уже є — перемотай на інше');
      return;
    }
    // Місце в кадрі не задаємо: воно рахується з того, скільки стікерів
    // живих у цю мить. Записаний бік збрехав би, щойно поруч стане третій.
    const next = [...stickers, {
      id,
      word: at,
      file,
      hold: 2.6,
      note: stickerUse.get(id)?.split(' · ')[0],
    }];
    void save(
      { ...post, stickers: next },
      `${id} → «${cleanCaption(post.words[at]?.word ?? '')}» на ${clock(post.words[at]?.start ?? 0)}`,
    );
  };

  const ask = (prompt: string) => {
    if (onAskClaude) onAskClaude(prompt);
    else setNote('чат недоступний — відкрий режим усередині проєкту');
  };

  /*
   * Рядок результату рендера — один на обидва місця (центр студії і
   * блок 9), щоб файл, розмір і дії ніколи не розходились. Показуємо
   * і старий post.mp4 теж: «відкрити останній ролик» — щоденна дія,
   * якій нема чого чекати нового рендера.
   *
   * Під час running рядок схований: ffmpeg відкриває вихід із -y
   * (truncate) і дописує на ходу — «Відкрити» вело б на недописаний
   * файл. Після error старий файл лишаємось показувати, але з міткою:
   * mtime до startedAt означає, що це НЕ результат цього рендера.
   */
  const outIsStale = render?.out != null
    && render.startedAt != null
    && render.out.mtimeMs < render.startedAt;
  const renderRow = (render?.state === 'error' || (render?.out && render.state !== 'running')) ? (
    <>
      {render?.state === 'error' ? (
        <div
          className="post-render-row is-error"
          title={render.tail ? render.tail.slice(-600) : undefined}
        >
          рендер упав: {render.error ?? 'див. .cache/render.log'}
        </div>
      ) : null}
      {render?.out ? (
        <div
          className="post-render-row"
          title={render.dir
            ? `${render.dir}${render.dir.includes('\\') ? '\\' : '/'}${render.out.name}`
            : render.out.name}
        >
          <span className="post-render-row__file">
            {render.out.name}{render.state === 'error' && outIsStale ? ' (старий, до цього рендера)' : ''}
            {' '}· {(render.out.size / (1024 * 1024)).toFixed(1)} МБ · {fileAge(render.out.mtimeMs)}
          </span>
          <a
            className="post-block__pick"
            href={rawUrl(projectId, render.out.name)}
            target="_blank"
            rel="noreferrer"
            title="Відкрити готовий mp4"
          >
            Відкрити
          </a>
          {hostShell ? (
            <button
              type="button"
              className="post-block__pick"
              title="Показати теку проєкту з post.mp4 у провіднику"
              onClick={() => void openHostProjectPath(projectId)}
            >
              У папці
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  ) : null;

  return (
    <div className="post-ws">
      <div className="post-ws__bar">
        <h2 className="post-ws__title">Пост Instagram</h2>
        <span className="post-ws__meta">
          {CANVAS.w}×{CANVAS.h} · {CANVAS.fps} fps · {preset.label}
        </span>
        <span className="post-ws__spacer" />
        {note ? <span className="post-ws__meta">{note}</span> : null}
        <button type="button" className="btn" onClick={onUpload} disabled={busy}>Завантажити</button>
        <button type="button" className="btn" onClick={() => void onRefreshFiles()} title="Оновити">↻</button>
        {onExit ? <button type="button" className="btn" onClick={onExit}>Файли</button> : null}
      </div>

      <div className={`post-ws__body${shotMode ? ' is-shot' : ''}${isDraft ? ' is-draft' : ''}`}>
        <div className="post-ws__stage">
          <div
            className="post-ws__frame"
            style={{
              containerType: 'inline-size',
              background: preset.backdrop.background,
            }}
          >
            {/*
              Сітка як підлога: лежить у нижній половині й іде в
              перспективу, тож клітинки віддаляються, а не стоять
              рівним килимом на весь кадр. Догори розчиняється в тлі —
              там працюють субтитри, і будь-яка графіка їм заважає.
            */}
            <div
              className="post-ws__floor-wrap"
              style={{
                // Висота тут, а не в CSS: із неї ж рахується viewBox сітки,
                // і розійтись вони не мають права — інакше клітинки знову
                // поїдуть у видовжені.
                height: `${FLOOR_H * 100}%`,
                ['--floor-line' as string]: preset.backdrop.gridColor,
              }}
            >
              <FloorGrid />
            </div>

            {/*
              Стікер — під ведучим і під субтитрами: він ілюструє, а не
              сперечається за увагу. key змінюється разом зі стікером,
              тому поява програється заново на кожному новому, а не один
              раз за ролик.
            */}
            {/* Картка і стікери — в одній смузі, тому разом не показуємо:
                картка широка, стікери поверх неї читались би як сміття. */}
            {/* Слот картки колекційного: подарунок ставиться в нього,
                а не поруч. Ознака — файл nft-card-*.html, який генерує
                демон із відомою геометрією (NFT_CARD_SLOT). */}
            {/*
              Бейджі картки колекційного — ОКРЕМИМ шаром і ПЕРЕД карткою
              в дереві, тобто під нею.

              Всередині стікера їм не місце: стікер стоїть у слоті, тобто
              вже НАД карткою, і плашка звідти лягала поверх неї. А
              піти вбік, як у звичайного предмета, вона не може —
              найкоротша плашка ролика ширша за саму картку. Лишається
              одне місце, над карткою, і одна плашка за раз: нова
              виходить з-за верхнього краю, попередня туди ж і йде.
            */}
            {nftSlot ? (
              <div className="post-ws__nft-badges" aria-hidden>
                {liveStickers.flatMap((s) => liveBadges(
                  s.sticker.badges, framePost.words, frameTime,
                ).map(({ badge, age, rankSmooth }) => {
                  const b = badgePopSlide(age);
                  const k = nftCardMotion?.scale ?? 1;
                  // Верх картки в частках кадру — з тим самим рухом і
                  // масштабом, що й сама картка: плашка мусить їхати з
                  // нею, а не жити у власних координатах.
                  const cardTop = preset.stickers.top
                    + (nftCardMotion?.y ?? 0) / 100
                    + (nftSlot.dropPx + nftSlot.cardTopPx * k) * nftSlot.pxToHeight;
                  // Сховатись = з'їхати вниз на свою висоту плюс той
                  // просвіт, на який стоїш вище краю.
                  const hide = (BADGE_H_PX + nftSlot.badgeGapPx) * nftSlot.pxToHeight;
                  // Витіснення новішою плашкою — та сама дорога, що й
                  // виліт: не вбік, а назад за картку.
                  const back = Math.min(rankSmooth, 1);
                  const y = cardTop - nftSlot.badgeGapPx * nftSlot.pxToHeight
                    + (b.lift + back) * hide;
                  return (
                    <span
                      key={`${badge.at}-${badge.text}`}
                      className={`post-ws__badge${badge.tone ? ` is-${badge.tone}` : ''}`}
                      style={{
                        left: '50%',
                        bottom: `${(1 - y) * 100}%`,
                        opacity: b.opacity * (1 - back),
                        transform: `translateX(-50%) scale(${b.scale})`,
                      }}
                    >
                      {badge.text}
                    </span>
                  );
                }))}
              </div>
            ) : null}

            {activeCard ? (
              <CardLayer
                key={`${activeCard.card.id}-${activeCard.start.toFixed(3)}`}
                src={rawUrl(projectId, activeCard.card.file)}
                hold={activeCard.card.hold}
                start={activeCard.start}
                time={frameTime}
                // Картка колекційного стоїть нижче за звичайну: у неї на
                // всю висоту предмет із бейджами, і на верхній межі зони
                // вона тиснеться до безпечної лінії Instagram. Зсув той
                // самий, що й у подарунка в слоті, — з одного числа.
                top={preset.stickers.top
                  + (nftSlot ? nftSlot.dropPx * nftSlot.pxToHeight : 0)}
                words={framePost.words}
                sticker={activeCard.card.sticker ?? null}
                stickerUrl={activeCard.card.sticker
                  ? rawUrl(projectId, activeCard.card.sticker.file)
                  : null}
              />
            ) : null}

            {/* Зв'язки між предметами — під стікерами, щоб дуга йшла
                з-за картинок, а не лежала поверх них. */}
            {!activeCard && liveStickers.length > 1 ? (
              <StickerLinksLayer
                spans={liveStickers}
                time={frameTime}
                zoneTop={preset.stickers.top}
                zoneBottom={stickerBase}
              />
            ) : null}

            {/* Картка і стікери зазвичай не співіснують (обидва в одній
                смузі). Виняток — картка колекційного: у неї є СЛОТ, і
                подарунок стоїть у ньому окремим анімованим шаром. */}
            {(activeCard && !nftSlot ? [] : liveStickers).map((s, i) => {
              const reg = registryById.get(s.sticker.id);
              const filePath = s.sticker.file ?? reg?.file;
              const file = filePath
                ? stickerByPath.get(filePath.replace(/\\/g, '/')) ?? null
                : null;
              const sprite = s.sticker.sprite ?? reg?.sprite;
              // Дрейф за СТАЛИМ ключем, а не за місцем у списку живих.
              // Доти брався індекс у поточному масиві: помирав сусід —
              // індекс з'їжджав, і предмет посеред власного життя міняв
              // кут нахилу, період і бік похитування.
              const drift = stickerDrift(frameStickers.indexOf(s.sticker));
              // У слоті картки предмет не має власного життя: він
              // з'являється разом із карткою і стоїть. Вхід, дрейф і
              // удар прибрані — рухається лише сама анімація подарунка.
              const entry = nftSlot
                ? { x: 0, y: 0, scale: 1, opacity: 1 }
                : stickerEnter(s.sticker.enter, frameTime - s.start);
              const badges = liveBadges(s.sticker.badges, framePost.words, frameTime);
              // Вихід рахуємо часом, а не CSS-переходом: перехід згладив
              // би удар, який приходить у ті самі 0.15 с, і замість
              // смикання вийшло б розмите сповзання.
              const outP = Math.min(
                Math.max((frameTime - (s.end - STICKER_EXIT_LEAD_S)) / STICKER_EXIT_LEAD_S, 0),
                1,
              );
              // Вихід — власна вісь предмета (flip-out / drop-out / …),
              // комбінується з входом множенням і додаванням: обірваний
              // вхід і ранній вихід складаються без стрибків.
              const fx = stickerExit(s.sticker.exit, outP);
              // Коробка предмета квадратна за шириною, але зона стікерів
              // нижча за квадрат одиночного (він більший за максимум пари).
              // Тому висоту обрізаємо по зоні: інакше предмет вилазить за
              // її верх, а бейдж над ним — ще вище, під шапку Instagram.
              // Коли бейджі в предмета є, зона додатково коротшає на їхню
              // висоту. Рахуємо з УСІХ бейджів стікера, а не з живих зараз:
              // від живих коробка міняла б розмір прямо в кадрі.
              const room = (s.sticker.badges?.length ?? 0) > 0 ? BADGE_ROOM : 0;
              const box = Math.min(
                s.width * CANVAS.w / CANVAS.h,
                stickerBase - preset.stickers.top - room,
              );
              return (
                <div
                  // key від самого стікера, а не від місця: коли поруч
                  // стає наступний, попередній ЇДЕ вбік, а не зникає й
                  // зʼявляється заново. Ключ по індексу програвав би
                  // появу вдруге на кожній перекладці.
                  key={`${s.sticker.id}-${s.start.toFixed(3)}`}
                  className={`post-ws__sticker${
                    frameTime > s.end - STICKER_EXIT_LEAD_S ? ' is-out' : ''
                  }${nftSlot || s.sticker.still || kindOf.get(s.sticker.id) === 'screen' ? ' is-still' : ''}${nftSlot ? ' is-slot' : ''}`}
                  style={{
                    // У слоті картки — координати слота; інакше звичайна
                    // розкладка зони стікерів.
                    // У слоті картки подарунок трохи МЕНШИЙ за сам слот
                    // і опущений: впритул він тисне на стрічку зверху, а
                    // в оригіналі між ним і краями лишається повітря.
                    top: `${(nftBox ? nftBox.top : stickerBase - box) * 100}%`,
                    height: `${(nftBox ? nftBox.height : box) * 100}%`,
                    left: `${(nftBox ? nftBox.left : s.left) * 100}%`,
                    width: `${(nftBox ? nftBox.width : s.width) * 100}%`,
                    // Зсув картки в кадрі — у відсотках ширини КАДРУ, а
                    // слот вужчий, тож переводимо у відсотки власної
                    // ширини предмета, інакше він відстане від картки.
                    ...(nftCardMotion ? {
                      marginLeft: `${nftCardMotion.x}%`,
                    } : {}),
                    ['--enter-x' as string]: `${(entry.x + fx.x) * 100}%`,
                    ['--enter-y' as string]: `${(entry.y + fx.y) * 100}%`,
                    ['--enter-scale' as string]: `${entry.scale * fx.scaleMul}`,
                    // Прозорість множить вхід на вихід ТУТ, інлайново.
                    // Правило `.is-out { opacity: calc(1 - var(--out)) }`
                    // існувало, але не діяло жодного разу: інлайновий
                    // стиль сильніший за таблицю, а stickerEnter завжди
                    // повертає 1. Через це предмет не гаснув — стискався
                    // на 12 % і зникав стрибком на останньому кадрі.
                    opacity: entry.opacity * fx.opacity * (nftCardMotion?.opacity ?? 1),
                    // Нові осі ефектів: нейтральні значення — no-op у
                    // transform-ланцюгу, стилю вони не додають нічого.
                    ['--fx-rot' as string]: `${(entry.rot ?? 0) + fx.rot}deg`,
                    ['--fx-ry' as string]: `${(entry.ry ?? 0) + fx.ry}deg`,
                    ['--fx-sx' as string]: `${(entry.sx ?? 1) * fx.sx}`,
                    ['--fx-sy' as string]: `${(entry.sy ?? 1) * fx.sy}`,
                    ['--fx-blur' as string]: `${Math.max(entry.blur ?? 0, fx.blur)}px`,
                    // Кут, тривалість і фаза дрейфу — свої в кожного.
                    // Однакові числа читались як одна намальована
                    // картинка, що гойдається цілком.
                    ['--sticker-tilt' as string]: drift.tilt,
                    ['--drift-dur' as string]: drift.dur,
                    ['--drift-delay' as string]: drift.delay,
                    ['--drift-dir' as string]: drift.dir,
                    // Удар акценту лишився чистим: стиск виходу переїхав
                    // у stickerExit('shrink') — одне джерело правди.
                    ['--punch' as string]: `${nftSlot ? 0 : framePunch}`,
                    ['--out' as string]: `${outP}`,
                  }}
                >
                  {s.sticker.ornament ? (
                    <StickerOrnamentLayer
                      ornament={s.sticker.ornament}
                      age={frameTime - s.start}
                      time={frameTime}
                      seed={frameStickers.indexOf(s.sticker)}
                    />
                  ) : null}
                  {/* Салют летить ПІД картинкою і поза її коробкою: іскри
                      мають вилітати з-за предмета, а не лежати на ньому. */}
                  <div className="post-ws__sticker-in">
                    {/* Окремий шар під дихання: нахил і масштаб — два
                        різні transform, і на одному елементі другий
                        просто затер би перший. */}
                    <span className="post-ws__sticker-breathe">
                    {file && sprite ? (
                      // Спрайт-аркуш (Telegram-емодзі): кадр з віку.
                      // Вік ділиться на швидкість ролика: прискорення
                      // стискає голос і субтитри, а подарунок грає своїм
                      // темпом — як анімації персонажа.
                      <SpriteSticker
                        src={`${rawUrl(projectId, file.name)}?v=${file.mtime}`}
                        sprite={sprite}
                        age={(frameTime - s.start) / (framePost.speed ?? 1)}
                      />
                    ) : file && /\.json$/i.test(file.name) ? (
                      // Файл сам несе свою анімацію — тоді предмет живий, а
                      // наші поява, дрейф і удар лишаються приправою зверху.
                      <LottieSticker
                        src={`${rawUrl(projectId, file.name)}?v=${file.mtime}`}
                        age={time - s.start}
                      />
                    ) : file ? (
                      <img src={`${rawUrl(projectId, file.name)}?v=${file.mtime}`} alt="" />
                    ) : (
                      // Стікер запланований, але файлу ще немає. Порожнє
                      // місце виглядало б як «агент нічого не зробив»,
                      // тому показуємо пропуск явно — і явно службовою
                      // рамкою, щоб не сплутати з готовою картинкою.
                      <span className="post-ws__sticker-gap">{s.sticker.id}</span>
                    )}
                    </span>
                  </div>
                  {/* Бейджі: найновіший стоїть НАД предметом, попередні
                      виштовхуються вбік — праворуч, потім ліворуч.

                      Стовпчик угору тут неможливий, і це не смак, а
                      арифметика: між безпечною лінією Instagram (250 px) і
                      верхом предмета лишається 105 px, а сама плашка — 84.
                      Друга вже не вміщується і або лізе під шапку, або
                      лягає на персонажа. З боків місце є: предмет займає
                      середину, а поля кадру порожні. */}
                  {/* У слоті картки бейджі малює окремий шар ПІД карткою
                      (див. `post-ws__nft-badges` вище) — звідси нічого. */}
                  {(nftSlot ? [] : badges).map(({ badge, age, rank, rankSmooth }) => {
                    const b = badgePop(age);
                    // Місця: 0 — над предметом, 1 — праворуч, 2 — ліворуч.
                    // Позицію беремо з ПЛАВНОГО рангу, тож поява нового
                    // бейджа не телепортує старі, а перевозить їх.
                    const spot = badgeSpot(rankSmooth, s.left, s.width);
                    return (
                      <span
                        key={`${badge.at}-${badge.text}`}
                        className={`post-ws__badge${badge.tone ? ` is-${badge.tone}` : ''}`}
                        style={{
                          bottom: `${spot.bottom}%`,
                          left: `${((spot.centre - s.left) / s.width) * 100}%`,
                          opacity: b.opacity * badgeRankFade(rank),
                          transform: `translate(-50%, ${b.lift * 100}%) rotate(${b.rot}deg) scale(${b.scale})`,
                        }}
                      >
                        {badge.text}
                      </span>
                    );
                  })}
                </div>
              );
            })}

            {/* Пігулки — окремим шаром, а не всередині стікера.
                Присвоєння («ти») має стояти нерухомо: коли воно плаває
                разом із картинкою, підпис читається як частина малюнка,
                а не як твердження про нього. Тому дрейф, удар і вхід
                лишаються на стікері, а пігулка просто стоїть під ним. */}
            {(activeCard ? [] : liveStickers).map((s) => {
              if (!s.sticker.label) return null;
              const age = frameTime - s.start;
              const side = s.sticker.enter === 'from-right' || s.sticker.enter === 'from-left';
              // Предмет, що виїжджає збоку, везе свою пігулку з собою:
              // вона тримає той самий зсув входу. Інакше підпис стоїть на
              // кінцевому місці й чекає, поки картинка до нього доїде, —
              // у кадрі це читається як два різні предмети.
              const l = side ? { opacity: 1, scale: 1, lift: 0 } : labelPop(age);
              const ride = side ? stickerEnter(s.sticker.enter, age).x : 0;
              return (
                <div
                  key={`label-${s.sticker.id}-${s.start.toFixed(3)}`}
                  className={`post-ws__sticker-label${
                    s.sticker.labelTone === 'warn' ? ' is-warn' : ''
                  }`}
                  style={{
                    left: `${(s.left + s.width / 2) * 100}%`,
                    top: `${stickerBase * 100}%`,
                    opacity: l.opacity,
                    transform: `translate(-50%, ${l.lift * 100}%) translateX(${ride * 100}%) scale(${l.scale})`,
                  }}
                >
                  {s.sticker.label}
                </div>
              );
            })}

            {/* На нульовій секунді ведучого ще немає — він за нижнім краєм.
                Щойно доріжка рушила, виїжджає на місце. key сталий: інакше
                зміна пози перестворювала б елемент, і виїзд програвався б
                заново на кожному біті. */}
            {activePoseCard && frameTime >= 0.01 ? (
              <HostLayer key="host" src={activePoseCard.src} />
            ) : null}

            {/* Світло знизу — ПОВЕРХ ведучого: низ фігури тане в підлозі,
                замість того щоб обрубатись рівним краєм. Тому шар іде
                після картинки, а не до неї. */}
            <div className="post-ws__floor-glow" aria-hidden />
            {activeChunk ? (
              // Слова групи проявляються зліва направо в міру вимови, але
              // невимовлені лишаються в потоці невидимими — інакше рядок
              // сіпався б після кожного слова, бо центр зміщувався б.
              <div className="post-ws__caption">
                <span className="post-ws__caption-line">
                  {activeChunk.map((w, i) => {
                    const said = w.start <= frameTime;
                    const bare = cleanCaption(w.word);
                    const text = preset.captions.uppercase ? bare.toUpperCase() : bare;
                    return (
                      <span
                        key={`${w.start}-${i}`}
                        className={`post-ws__caption-word${said ? ' is-said' : ''}${w.accent ? ' is-accent' : ''}`}
                        style={{ ['--glow' as string]: `${wordGlow(frameTime, w)}` }}
                      >
                        {/* Слово в слові: зовнішній несе появу і плашку,
                            внутрішній — вагу під голос. Обидва чіпають
                            transform, і в одному елементі поява затирала
                            б наголос. */}
                        <span className="post-ws__caption-ink">{text}</span>
                      </span>
                    );
                  })}
                </span>
              </div>
            ) : !previewPost && post.words.length === 0 && post.script.trim() ? (
              // Заглушка ЛИШЕ доки немає таймкодів: показуємо перше слово
              // блідим, щоб було видно, як ляже субтитр — розмір, шрифт,
              // місце в кадрі. Інакше стиль перевіряєш аж після озвучки,
              // коли міняти щось уже дорого.
              //
              // Умова обов'язково перевіряє words, а не лише відсутність
              // активної групи. Без цього заглушка лізла в кадр щоразу,
              // коли групи немає при живих таймкодах: на нульовій секунді
              // до першого слова і в паузах між фразами — тобто рівно
              // там, де кадр має бути порожнім за задумом.
              <div className="post-ws__caption is-preview">
                {(() => {
                  const first = cleanCaption(post.script.trim().split(/\s+/)[0] ?? '');
                  return preset.captions.uppercase ? first.toUpperCase() : first;
                })()}
              </div>
            ) : null}
            <div className="post-ws__safe" aria-hidden />
            {/*
              Підказка про порожній кадр — лише поки нема ЧОГО показати.
              Щойно з'явився сценарій, у кадрі вже стоїть бліде превʼю
              першого слова, і два тексти лягали один на одного.
            */}
            {!previewPost && !post.audio && !post.script.trim() ? (
              <div className="post-ws__frame-empty">
                Порожньо. Почни зі звуку — від його довжини рахується решта.
              </div>
            ) : null}
          </div>

          {/* Рядок прев'ю руху — поза умовою post.audio: демо працює і в
              проєкті без доріжки, а кнопка виходу потрібна завжди. */}
          {previewPost ? (
            <div className="post-ws__preview-bar">
              <span className="post-ws__preview-dot" aria-hidden />
              <span className="post-ws__preview-name">
                рух: {motionPreview?.title ?? motionPreview?.id}
              </span>
              <span className="post-ws__preview-time">
                {demoTime.toFixed(1)} / {motionPreview?.demo?.duration.toFixed(1)} с
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => setMotionPreview(null)}
              >
                Закрити
              </button>
            </div>
          ) : null}
          {post.audio ? (
            <>
              {/*
                Рідні controls прибрані навмисно. Вони показують час
                МЕДІА, тобто завжди 0:51, хоч би яке стояло пришвидшення,
                і сперечаються з нашим лічильником. Два таймери з різними
                числами гірші за один: незрозуміло, котрому вірити.
              */}
              <audio
                ref={audioRef}
                src={rawUrl(projectId, post.audio.path)}
                onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                hidden
              />
              {/* Під час прев'ю руху скраб схований: він показує час
                  ДОРІЖКИ, а кадр живе в петлі демо — два лічильники з
                  різними числами гірші за один. */}
              <div className="post-ws__scrub" hidden={previewPost != null}>
                <button
                  type="button"
                  className="post-ws__play"
                  title={playing ? 'Пауза' : 'Відтворити'}
                  onClick={() => {
                    const el = audioRef.current;
                    if (!el) return;
                    if (el.paused) void el.play();
                    else el.pause();
                  }}
                >
                  {playing ? '❚❚' : '▶'}
                </button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(duration, 0.1)}
                  step={0.01}
                  value={Math.min(time, duration)}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setTime(next);
                    if (audioRef.current) audioRef.current.currentTime = next;
                  }}
                />
                {/*
                  Час показуємо ГОДИННИКОВИЙ, а не медійний: на 2× ролик
                  триває 25 с, і саме це число вирішує, чи влазить він у
                  формат. Повзунок при цьому лишається в часі медіа — за
                  ним шукають конкретне слово, а слова живуть у своєму
                  часі й від пришвидшення не роз'їжджаються.
                */}
                <span className="post-ws__time">
                  {clock(time / speed)} / {clock(duration / speed)}
                  {/* Множник і є входом до прискорення: він тут завжди
                      під рукою, і окрема кнопка на пів екрана під те саме
                      налаштування була б зайвою. */}
                  <span className="post-ws__rate-wrap">
                    <button
                      type="button"
                      className={`post-ws__rate${speed !== 1 ? ' is-on' : ''}`}
                      disabled={duration === 0}
                      title="Прискорення — повзунком"
                      onClick={() => setSpeedOpen((v) => !v)}
                    >
                      {speed.toFixed(1)}×
                    </button>
                    {speedOpen ? (
                      <>
                        {/* Прозора підкладка: клік повз віконце закриває
                            його. Саме div, а не button — глобальні стилі
                            застосунку красять будь-яку кнопку суцільним
                            фоном, і підкладка на весь екран ховала весь
                            інтерфейс. З клавіатури віконце закриває Escape. */}
                        <div
                          className="post-pop__scrim"
                          aria-hidden
                          onClick={() => setSpeedOpen(false)}
                        />
                        <div className="post-pop" role="dialog" aria-label="Прискорення">
                          <div className="post-pop__head">
                            <b>{speed.toFixed(1)}×</b>
                            <span>{clock(duration)} → {clock(duration / speed)}</span>
                          </div>
                          <input
                            className="post-pop__range"
                            type="range"
                            min={0}
                            max={SPEEDS.length - 1}
                            step={1}
                            value={Math.max(0, SPEEDS.indexOf(speed as (typeof SPEEDS)[number]))}
                            disabled={busy || duration === 0}
                            onChange={(e) => {
                              const v = SPEEDS[Number(e.target.value)] ?? 1;
                              void save(
                                { ...post, speed: v },
                                v === 1
                                  ? 'швидкість як записано'
                                  : `${v.toFixed(1)}× · ${clock(duration / v)}`,
                              );
                            }}
                          />
                          <div className="post-pop__scale">
                            <span>1.0×</span><span>2.0×</span>
                          </div>
                        </div>
                      </>
                    ) : null}
                  </span>
                </span>
              </div>

              {/*
                Стрічка транскрипції. Показує весь текст одразу, підсвічує
                те слово, що звучить, і дозволяє клікнути будь-яке, щоб
                перемотати. Без неї доводиться ловити момент скрабером
                наосліп — а стікери ставляться саме на конкретні слова.
              */}
              {post.words.length > 0 ? (
                <div className={`post-ws__words${wordsOpen ? ' is-open' : ''}`}>
                  {/* Згорнута до рядка. Розгорнута вона тягне сотню слів
                      і розганяє скрол колонки так, що все під нею —
                      кнопки в тому числі — їде за екран. Потрібна ж
                      цілком лише коли ставиш стікери на конкретні слова. */}
                  <button
                    type="button"
                    className="post-ws__words-toggle"
                    aria-expanded={wordsOpen}
                    title={wordsOpen ? 'Згорнути до рядка' : 'Показати весь текст'}
                    onClick={() => setWordsOpen((v) => !v)}
                  >
                    {wordsOpen ? 'Згорнути' : `Увесь текст · ${post.words.length} слів`}
                  </button>
                  {post.words.map((w, i) => {
                    // Той самий критерій, що й для субтитра в кадрі —
                    // інакше стрічка підсвічує одне, а кадр показує інше.
                    const on = i === activeWordIndex;
                    const accent = Boolean(w.accent);
                    const stuck = stickerWords.has(i);
                    return (
                      <button
                        key={`${i}-${w.start}`}
                        type="button"
                        className={`post-ws__word${on ? ' is-on' : ''}${accent ? ' is-accent' : ''}${stuck ? ' has-sticker' : ''}`}
                        title={[
                          `${w.start.toFixed(2)} — ${w.end.toFixed(2)} с`,
                          accent ? 'акцент, у кадрі на жовтій плашці' : '',
                          stuck ? `стікер: ${stickers.find((s) => s.word === i)?.id ?? ''}` : '',
                        ].filter(Boolean).join(' · ')}
                        ref={(el) => {
                          // Тримаємо активне слово в полі зору: на 80 словах
                          // стрічка довша за себе саму, і без цього підсвітка
                          // тікає вниз уже на п'ятій секунді.
                          //
                          // Крутимо саме контейнер стрічки, а не через
                          // scrollIntoView: той тягне за собою всіх предків,
                          // і сторінка з'їжджала вниз щоразу при відтворенні.
                          if (!on || !el) return;
                          const box = el.parentElement;
                          if (!box) return;
                          const top = el.offsetTop - box.offsetTop;
                          const bottom = top + el.offsetHeight;
                          if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
                            box.scrollTop = top - (box.clientHeight - el.offsetHeight) / 2;
                          }
                        }}
                        onClick={() => seek(w.start)}
                      >
                        {w.word}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {/*
          Центр: де зараз ролик і вхід до ручних правок.

          Порожнє поле під смугою лишене навмисно — туди піде живий стан
          того, що робить агент. Доти краще порожньо, ніж заповнено
          чимось, що доведеться викидати.
        */}
        <div className="post-ws__center">
          {/* Квадрат із номером, назва підписом під ним. Пояснення до
              кроку тут немає навмисно: у ряд із шести воно все одно
              влазить обрізаним, а обрізане пояснення гірше за жодне. */}
          <div className="post-ws__stages">
            {stages.map((s, i) => (
              <div key={s.key} className={`post-stage is-${s.state}`} title={s.hint}>
                <span className="post-stage__box">{i + 1}</span>
                <span className="post-stage__title">{s.title}</span>
              </div>
            ))}
          </div>

          {/*
            Дії стоять ОДРАЗУ під смугою етапів, а не в кінці колонки.
            Знизу тягнеться стрічка субтитрів на сотню слів, і панель у
            потоці тонула в скролі — щоб натиснути «Рендерити», треба
            було спершу прокрутити весь текст.

            Рендер — рішення власника, а не крок, який агент проходить
            сам: агент чекає натискання, і поки його немає, ролик не
            збирається. Інакше mp4 виходив із половини зробленої роботи.
          */}
          <div className="post-ws__actions">
            <button
              type="button"
              className="post-act is-primary"
              disabled={busy || !post.audio || post.words.length === 0 || render?.state === 'running'}
              title={!post.audio
                ? 'Спершу звук — без доріжки нема чого рендерити'
                : post.words.length === 0
                  ? 'Спершу таймкоди (words.json) — без них студія не віддасть кадр знімальнику'
                  : 'Рендер запускається прямо звідси — без чату; готовий файл з\'явиться нижче'}
              onClick={() => void startRender()}
            >
              <span className="post-act__label">
                {render?.state === 'running' ? 'Рендериться…' : 'Рендерити'}
              </span>
              <span className="post-act__hint">
                {render?.state === 'running'
                  ? renderProgress(render.tail)
                  : !post.audio
                    ? 'нема доріжки'
                    : post.words.length === 0
                      ? 'нема таймкодів'
                      : (() => {
                          const out = (post.audio.duration ?? 0) / (post.speed ?? 1);
                          return `${Math.round(out * CANVAS.fps)} кадрів · ${clock(out)}`;
                        })()}
              </span>
            </button>

            <button
              type="button"
              className="post-act"
              onClick={() => setManualOpen(true)}
            >
              <span className="post-act__label">Ручні правки</span>
              <span className="post-act__hint">десять кроків</span>
            </button>
          </div>

          {renderRow}

          {/*
            Конструктор анімацій — у місці, яке для нього й тримали.

            Список читає assets/motions.json; клік по запису програє його
            демо прямо в кадрі праворуч. Правки руху робляться в чаті
            словами — кнопка «Правити» дає агенту контекст запису, щоб не
            витрачати токени на пояснення, де ми і що робимо.
          */}
          {/*
            Анімації — два входи до одного словника.

            Панель-список тут, у центрі: розгорнув, клікнув рух — він
            грає у великому кадрі праворуч, і правки з чату видно на
            льоту. Галерея — окрема сторінка поверх студії: всі рухи
            квадратними блоками-сценами, клік відкриває повне демо з
            діями. Список — для роботи на ходу, галерея — для огляду.
          */}
          <div className="post-ws__motions">
            <button
              type="button"
              className="post-motions__head"
              aria-expanded={motionsOpen}
              onClick={() => setMotionsOpen((v) => !v)}
            >
              <span className="post-motions__title">Анімації</span>
              <span className="post-motions__hint">
                {motions == null
                  ? 'словник рухів'
                  : `${motions.length} рухів · ${motions.filter((m) => m.demo).length} з прев'ю`}
              </span>
              <span className="post-block__chev" aria-hidden>⌄</span>
            </button>

            {motionsOpen ? (
              motions == null ? (
                <div className="post-motions__empty">
                  <div className="post-ws__hint">
                    У проєкті ще немає словника рухів (assets/motions.json).
                  </div>
                  <button type="button" className="btn" onClick={() => void seedMotions()}>
                    Завести словник
                  </button>
                </div>
              ) : (
                <div className="post-motions__list">
                  <div className="post-motions__bar">
                    <button type="button" className="btn" onClick={() => setGalleryOpen(true)}>
                      Галерея
                    </button>
                    <button type="button" className="btn" onClick={askMotionNew}>
                      Нова анімація
                    </button>
                  </div>
                  {motions.map((m) => {
                    const active = motionPreview?.id === m.id;
                    return (
                      <div key={m.id} className={`post-motion${active ? ' is-on' : ''}`}>
                        <button
                          type="button"
                          className="post-motion__row"
                          title={m.demo ? 'Програти у кадрі праворуч' : "Без прев'ю — лише опис"}
                          onClick={() => setMotionPreview(active ? null : m)}
                        >
                          <span className="post-motion__play" aria-hidden>
                            {m.demo ? (active ? '■' : '▶') : '·'}
                          </span>
                          <span className="post-motion__name">{m.title}</span>
                          <span className="post-motion__pick">{m.pick}</span>
                        </button>
                        {active ? (
                          <div className="post-motion__detail">
                            {m.enter ? <div><b>Вхід.</b> {m.enter}</div> : null}
                            {m.inside ? <div><b>У кадрі.</b> {m.inside}</div> : null}
                            {m.exit ? <div><b>Вихід.</b> {m.exit}</div> : null}
                            {m.axes?.length ? <div><b>Осі:</b> {m.axes.join(' · ')}</div> : null}
                            {m.fixed?.length ? <div><b>Не чіпати:</b> {m.fixed.join(' · ')}</div> : null}
                            {m.avoid ? <div><b>Не брати, коли:</b> {m.avoid}</div> : null}
                            {m.from?.length ? (
                              <div><b>Живі приклади:</b> {m.from.join(' · ')}</div>
                            ) : null}
                            <button type="button" className="btn" onClick={() => askMotionEdit(m)}>
                              Правити в чаті
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )
            ) : null}
          </div>

          {/*
            Подарунки — другий каталог поруч зі словником рухів. Живе не
            в проєкті, а в даних демона (165 анімацій спільні на всі
            ролики), тому кнопка є завжди, а не «заводиться» в проєкт.
          */}
          <div className="post-ws__motions">
            <button
              type="button"
              className="post-motions__head"
              onClick={() => setGiftsOpen(true)}
            >
              <span className="post-motions__title">Подарунки</span>
              <span className="post-motions__hint">
                {gifts == null
                  ? 'каталог Telegram · зірки і NFT'
                  : `${gifts.filter((g) => g.kind === 'nft').length} NFT · ${gifts.filter((g) => g.kind === 'star').length} за зірки`}
              </span>
              <span className="post-block__chev" aria-hidden>⌄</span>
            </button>
          </div>

          {/*
            Сценарій — швидкий доступ до тексту озвучки прямо з головного
            екрана: власник копіює його в ElevenLabs. Раніше текст жив
            лише в блоці 2 усередині шторки «Ручні правки» — далеко.
            Показуємо біти зі script.md, якщо він є (там таблиця з темпом
            і паузами для начитки), інакше — текст із post.json.
          */}
          <div className="post-ws__motions">
            <button
              type="button"
              className="post-motions__head"
              aria-expanded={scriptOpen}
              onClick={() => setScriptOpen((v) => !v)}
            >
              <span className="post-motions__title">Сценарій</span>
              <span className="post-motions__hint">
                {scriptRows.length
                  ? `${scriptRows.length} біт · зі script.md`
                  : post.script.trim()
                    ? `${post.script.trim().split(/\s+/).length} слів`
                    : 'ще порожньо'}
              </span>
              <span className="post-block__chev" aria-hidden>⌄</span>
            </button>
            {scriptOpen ? (
              <div className="post-script">
                <div className="post-script__bar">
                  <button
                    type="button"
                    className="post-block__pick"
                    disabled={!scriptPlain.trim()}
                    title="Чистий текст без номерів і темпів — вставляй у ElevenLabs"
                    onClick={() => {
                      void navigator.clipboard.writeText(scriptPlain.trim()).then(
                        () => setNote('сценарій скопійовано — вставляй у ElevenLabs'),
                        () => setNote('не вийшло скопіювати — виділи текст і Ctrl+C'),
                      );
                    }}
                  >
                    Скопіювати для озвучки
                  </button>
                  {scriptRows.length ? (
                    <span className="post-ws__hint">
                      {scriptMeta.hook ? `гак: ${scriptMeta.hook}` : ''}
                      {scriptMeta.hook && scriptMeta.frame ? ' · ' : ''}
                      {scriptMeta.frame ? `каркас: ${scriptMeta.frame}` : ''}
                    </span>
                  ) : null}
                </div>
                {scriptRows.length ? (
                  <ol className="post-script__rows">
                    {scriptRows.map((r) => (
                      <li key={r.n} className="post-script__row">
                        <span className="post-script__n">{r.n}</span>
                        <span className="post-script__text">{r.text}</span>
                        <span className="post-script__meta">
                          {r.tempo != null ? `т${r.tempo}` : ''}
                          {r.tone != null ? ` тон${r.tone}` : ''}
                          {r.pause != null ? ` п${r.pause}` : ''}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <pre className="post-script__plain">{scriptPlain.trim() || 'Сценарію ще нема — попроси агента написати або встав у блок 2.'}</pre>
                )}
              </div>
            ) : null}
          </div>

          {giftsOpen ? (
            <GiftGallery
              items={gifts ?? []}
              projectId={projectId}
              takeState={giftTake}
              onTake={takeGift}
              onNote={setNote}
              onClose={() => setGiftsOpen(false)}
            />
          ) : null}

          {galleryOpen ? (
            motions == null ? (
              <div className="post-gallery">
                <div className="post-gallery__bar">
                  <span className="post-gallery__title">Анімації</span>
                  <span className="post-ws__spacer" />
                  <button type="button" className="btn" onClick={() => setGalleryOpen(false)}>
                    Закрити
                  </button>
                </div>
                <div className="post-motions__empty">
                  <div className="post-ws__hint">
                    У проєкті ще немає словника рухів (assets/motions.json).
                  </div>
                  <button type="button" className="btn" onClick={() => void seedMotions()}>
                    Завести словник
                  </button>
                </div>
              </div>
            ) : (
              <MotionGallery
                entries={motions}
                projectId={projectId}
                poseCards={poseCards}
                stickerByPath={stickerByPath}
                onEdit={askMotionEdit}
                onNew={askMotionNew}
                onDelete={deleteMotion}
                onClose={() => setGalleryOpen(false)}
              />
            )
          ) : null}

          <div className="post-ws__center-free" />
        </div>

        {/*
          Панель іде ПОРТАЛОМ у body, а не лишається тут.

          На місці вона сиділа всередині розкладки проєкту, і композер
          чату лишався поверх неї попри більший z-index: число всередині
          чужого стекінг-контексту нічого не важить. Той самий висновок
          уже був на модалках стікерів — тому одразу портал, а не ще один
          підбір z-index.
        */}
        {manualOpen ? createPortal((
        <div className="post-ws__blocks is-open">
          <div className="post-ws__blocks-bar">
            <span className="post-ws__blocks-title">Ручні правки</span>
            <button
              type="button"
              className="btn"
              onClick={() => setManualOpen(false)}
            >
              Закрити
            </button>
          </div>
          <BlockShell
            num={1}
            title="Звук"
            {...blockShell(
              'audio',
              `${stage === 'audio' ? ' is-active' : ''}${post.audio ? ' is-done' : ''}`,
            )}
            actions={(
              <div className="post-block__head-actions">
                {post.audio ? (
                  <button
                    type="button"
                    className="post-block__icon is-danger"
                    disabled={busy}
                    title="Прибрати доріжку — таймкоди й біти теж скинуться"
                    onClick={() => void clearAudio()}
                  >
                    Прибрати
                  </button>
                ) : null}
                {post.audio ? (
                  <button
                    type="button"
                    className="post-block__icon"
                    disabled={busy || align?.state === 'running' || render?.state === 'running'}
                    title="Перевирівняти таймкоди — якщо текст сценарію мінявся після озвучки"
                    onClick={() => post.audio && void startAlign(post.audio.path)}
                  >
                    Таймкоди
                  </button>
                ) : null}
                <button
                  type="button"
                  className="post-block__icon"
                  disabled={busy}
                  title="Залити mp3 з диска"
                  onClick={() => audioInputRef.current?.click()}
                >
                  Залити mp3
                </button>
              </div>
            )}
          >
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.m4a"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Скидаємо значення, щоб повторний вибір того самого
                // файлу теж дав onChange.
                e.target.value = '';
                if (file) void uploadAudio(file);
              }}
            />
            <div className="post-block__note">
              {post.audio
                ? `${post.audio.path} · ${clock(post.audio.duration)}`
                : audioFiles.length
                  // Файли є, але жоден не вибраний — решта кроків мовчить,
                  // і незрозуміло чому. Кажемо прямо, що робити.
                  ? 'Клікни файл нижче, щоб зробити його доріжкою.'
                  : 'Залий mp3 або обери з проєкту.'}
            </div>
            {align && align.state !== 'idle' ? (
              <div className="post-block__note" title={align.error ?? undefined}>
                {align.state === 'running'
                  ? 'таймкоди: вирівнюю…'
                  : align.state === 'error'
                    ? `⚠ таймкоди не вийшли: ${align.error ?? 'див. .cache/align.log'}`
                    : align.report?.warning
                      ? `⚠ таймкоди: ${post.words.length} слів, але ${align.report.warning}`
                      : `таймкоди: ${post.words.length || align.report?.words || 0} слів ✓`}
              </div>
            ) : null}
            <div className="post-block__row">
              {audioFiles.map((path) => (
                <button
                  key={path}
                  type="button"
                  className={`post-block__pick${post.audio?.path === path ? ' is-on' : ''}`}
                  disabled={busy}
                  onClick={() => void pickAudio(path)}
                  title={path}
                >
                  {path.split('/').pop()}
                </button>
              ))}
            </div>
          </BlockShell>

          <BlockShell
            num={2}
            title="Сценарій"
            {...blockShell(
              'script',
              `${stage === 'align' ? ' is-active' : ''}${post.words.length ? ' is-done' : ''}`,
            )}
            actions={(
              <div className="post-block__head-actions">
                <button
                  type="button"
                  className="post-block__icon"
                  disabled={!(scriptDraft ?? post.script).trim()}
                  title="Скопіювати сценарій — вставиш у ElevenLabs і озвучиш"
                  onClick={() => {
                    const text = (scriptDraft ?? post.script).trim();
                    void navigator.clipboard.writeText(text).then(
                      () => setNote('сценарій скопійовано — вставляй у ElevenLabs'),
                      () => setNote('не вийшло скопіювати — виділи текст і Ctrl+C'),
                    );
                  }}
                >
                  Копіювати
                </button>
                {post.audio ? (
                  <button
                    type="button"
                    className="post-block__icon"
                    disabled={busy}
                    title="Запасний шлях: розпізнати мову з доріжки. Потрібен лише для чужого аудіо, тексту якого немає — качає ~3 ГБ ваг і плутається в термінах. Свій сценарій точніше вирівняти по тексту."
                    onClick={() => ask(
                      `Транскрибуй доріжку ${post.audio!.path} — розпізнай мову, не чекай тексту від мене.\n\n`
                      + 'npx hyperframes transcribe "<файл>" --model large-v3 --language uk --json\n\n'
                      + 'Модель саме large-v3: решта (tiny.en, base.en, small.en, medium.en) — '
                      + 'англомовні й українську не візьмуть. Перший запуск тягне ваги, це довго.\n\n'
                      + 'З результату склади words.json у форматі [{word, start, end}] і поклади '
                      + 'у корінь проєкту. Розпізнаний текст запиши в post.json → script, '
                      + 'щоб він був видимий у полі нижче.',
                    )}
                  >
                    Транскрибувати
                  </button>
                ) : null}
              </div>
            )}
          >
            <div className="post-block__note">
              {(() => {
                const text = (scriptDraft ?? post.script).trim();
                const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
                // Читання вголос ≈ 120 слів/хв — заміряно на нашій же
                // доріжці (102 слова на 51 с). Показуємо оцінку ще до
                // озвучки, щоб не писати сценарій на дві хвилини там,
                // де формат тримає тридцять секунд.
                const est = words ? Math.round((words / 120) * 60) : 0;
                if (post.words.length) {
                  return `${post.words.length} слів вирівняно — субтитри в кадрі йдуть звідси.`;
                }
                if (!words) {
                  return 'Напиши або встав сценарій. З нього підуть і озвучка, і субтитри.';
                }
                return `${words} слів ≈ ${clock(est)} озвучки. `
                  + (post.audio
                    ? 'Натисни «Порахувати таймкоди» — і слова стануть субтитрами.'
                    : 'Скопіюй, озвуч у ElevenLabs і залий mp3 у блок 1.');
              })()}
            </div>
            <textarea
              className="post-block__script"
              placeholder="Сценарій — те, що озвучуватиме нейронка, дослівно"
              rows={9}
              value={scriptDraft ?? post.script}
              onChange={(e) => setScriptDraft(e.target.value)}
              onBlur={() => {
                const next = (scriptDraft ?? '').trim();
                if (scriptDraft === null || next === post.script.trim()) return;
                void save({ ...post, script: next }, `текст збережено · ${next.split(/\s+/).filter(Boolean).length} слів`);
              }}
            />
            <div className="post-block__row">
              {wordsFiles.map((path) => (
                <button key={path} type="button" className="post-block__pick" disabled={busy} onClick={() => void pullWords(path)} title={path}>
                  ⤵ {path.split('/').pop()}
                </button>
              ))}
              {post.audio ? (
                <button
                  type="button"
                  className="post-block__pick"
                  disabled={!(scriptDraft ?? post.script).trim()}
                  onClick={() => ask(
                    `Порахуй таймкоди: запусти в корені проєкту\n\n`
                    + `python scripts/align.py --audio "${post.audio!.path}" --post post.json\n\n`
                    + `Текст озвучки вже лежить у post.json → script. Після цього поклади `
                    + `words.json у корінь проєкту, щоб студія його підхопила.\n\n`
                    + 'Далі познач ключові слова: додай "accent": true тим словам у '
                    + 'words.json — у кадрі вони підуть на жовтій плашці.\n\n'
                    + 'КРИТЕРІЙ: акцент падає на те, що глядач має запамʼятати й '
                    + 'повторити. Це конкретика, а не емоція:\n'
                    + '- назви інструментів, продуктів, технологій: Claude Code, '
                    + 'Cursor, ChatGPT, Python. Назва з двох слів позначається цілком '
                    + '(обидва слова з accent), щоб плашка була одна.\n'
                    + '- БУДЬ-ЯКЕ слово латиницею в українському тексті — це майже '
                    + 'завжди назва продукту або технології. Позначай його акцентом '
                    + 'за замовчуванням: саме такі слова глядач іде гуглити, і саме '
                    + 'їх має бачити на паузі.\n'
                    + '- маркери кроків: «Перше:», «Друге:», «Третє:»\n'
                    + '- конкретні числа й одиниці: «п’ять хвилин», «двісті файлів»\n'
                    + '- конкретна дія, яку можна піти й зробити\n\n'
                    + 'НЕ акцент — оцінні прикметники й прислівники («великої», '
                    + '«маленькими», «навпаки», «реально»), абстрактні іменники '
                    + '(«помилка», «ідея»), службові слова, займенники, звʼязки. '
                    + 'Вони підсилюють інтонацію, але запамʼятовувати в них нема чого, '
                    + 'а жовтий у кадрі — це саме «запишіть собі».\n\n'
                    + 'Щільність: одне-два акцентні слова на речення, і не більше ніж '
                    + 'кожне восьме слово загалом. Якщо жовтого багато, він перестає '
                    + 'бути акцентом і стає тлом. Два окремі акценти підряд не став — '
                    + 'виняток лише для назви з двох слів.\n\n'
                    + 'Наявні accent спершу зніми повністю, потім розстав заново за '
                    + 'цим критерієм — інакше старі й нові змішаються.\n\n'
                    + 'Той самий accent продублюй у post.json → words, щоб студія '
                    + 'бачила його одразу.',
                  )}
                >
                  Порахувати таймкоди
                </button>
              ) : null}
            </div>
          </BlockShell>

          <BlockShell
            num={3}
            title="Речення"
            {...blockShell(
              'scenes',
              `${post.words.length && scenes.length === 0 ? ' is-active' : ''}${
                scenes.length ? ' is-done' : ''
              }`,
            )}
            actions={post.words.length ? (
              <div className="post-block__head-actions">
                <button
                  type="button"
                  className="post-block__icon"
                  disabled={busy}
                  title="Розмітити за паузами в доріжці. Межі потім правляться руками."
                  onClick={() => void save(
                    { ...post, scenes: sliceScenes(post.words) },
                    'речення розмічено',
                  )}
                >
                  {scenes.length ? 'Перерозмітити' : 'Розмітити'}
                </button>
                {scenes.length ? (
                  <button
                    type="button"
                    className="post-block__icon is-danger"
                    disabled={busy}
                    title="Прибрати розмітку. Стікери лишаться на своїх словах."
                    onClick={() => void save({ ...post, scenes: [] }, 'розмітку знято')}
                  >
                    Прибрати
                  </button>
                ) : null}
              </div>
            ) : undefined}
          >
            <div className="post-block__note">
              {post.words.length === 0
                ? 'Спершу таймкоди — межі речень рахуються з пауз між словами.'
                : scenes.length === 0
                  ? 'Речення — це смислова одиниця ролика: поки думка триває, група картинок у кадрі одна й та сама.'
                  : `${scenes.length} реч. · тема й роль — робота агента, межі можна правити руками`}
            </div>
            {scenes.length ? (
              <div className="post-block__scenes">
                {scenes.map((sc, i) => {
                  const span = sceneSpan(sc, post.words);
                  const here = time >= span.start && time < span.end;
                  const mine = stickers.filter(
                    (s) => s.word >= sc.from && s.word <= sc.to,
                  ).length;
                  return (
                    <button
                      type="button"
                      key={`${sc.from}-${sc.to}`}
                      className={`post-block__scene${here ? ' is-on' : ''}${
                        sc.continues ? ' is-cont' : ''
                      }`}
                      onClick={() => seek(span.start)}
                      title={sc.why ?? 'Перемотати на це речення'}
                    >
                      <span className="post-block__scene-at">
                        {i + 1} · {span.start.toFixed(1)}
                      </span>
                      <span className="post-block__scene-text">{sceneText(sc, post.words)}</span>
                      <span className="post-block__scene-meta">
                        {sc.topic ? <b>{sc.topic}</b> : <i>без теми</i>}
                        {sc.role ? ` · ${sc.role}` : ''}
                        {/* Скільки картинок припадає на думку — головне
                            число цього списку: порожня думка означає, що
                            глядач слухає її на голому кадрі. */}
                        {mine ? ` · ${mine}🖼` : ' · —'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </BlockShell>

          <BlockShell
            num={4}
            title="Розбір"
            {...blockShell(
              'plans',
              `${scenes.length && planned === 0 ? ' is-active' : ''}${
                scenes.length && planned === scenes.length ? ' is-done' : ''
              }`,
            )}
          >
            <div className="post-block__note">
              {scenes.length === 0
                ? 'Спершу речення — розбір робиться по одному на думку.'
                : `${planned} з ${scenes.length} · що показуємо і чому — пише агент`}
            </div>
            {scenes.length ? (
              <div className="post-block__scenes">
                {scenes.map((sc, i) => {
                  const span = sceneSpan(sc, post.words);
                  const here = time >= span.start && time < span.end;
                  const plan = sc.plan;
                  return (
                    <button
                      type="button"
                      key={`plan-${sc.from}`}
                      className={`post-block__scene${here ? ' is-on' : ''}`}
                      onClick={() => seek(span.start)}
                      title={plan?.why ?? 'Розбору ще немає'}
                    >
                      <span className="post-block__scene-at">
                        {i + 1} · {span.start.toFixed(1)}
                      </span>
                      <span className="post-block__scene-text">
                        {plan
                          ? plan.kind === 'none'
                            ? 'тиша'
                            : `${plan.kind === 'page' ? 'сторінка' : 'картинки'}: ${
                                (plan.items ?? []).join(' + ') || '—'
                              }`
                          : <i>розбору немає</i>}
                      </span>
                      <span className="post-block__scene-meta">
                        {plan?.motion ? plan.motion : sc.topic ?? ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </BlockShell>

          <BlockShell
            num={5}
            title="Персонаж"
            {...blockShell(
              'host',
              `${stage === 'beats' ? ' is-active' : ''}${post.beats.length ? ' is-done' : ''}`,
            )}
          >
            <div className="post-block__note">
              {poseCards.length === 0
                ? 'Поз ще немає — Клод згенерує ведучого.'
                : (() => {
                    const bad = poseCards.filter((c) => /розход/i.test(c.entry?.quality ?? '')).length;
                    const local = poseCards.filter((c) => c.inProject).length;
                    const where = local === poseCards.length
                      ? 'у проєкті'
                      : local
                        ? `${local} у проєкті, решта зі спільної бібліотеки`
                        : 'зі спільної бібліотеки';
                    return bad
                      ? `${poseCards.length} поз · ${where} · ${bad} розходяться з еталоном (позначені !)`
                      : `${poseCards.length} поз · ${where}.`;
                  })()}
            </div>
            <div className="post-block__poses">
              {/* Без обрізання: набір поз росте, і кожна нова має бути
                  видимою одразу. Висоту тримає CSS, зайве прокручується. */}
              {poseCards.map((card) => {
                // «розходиться» в реєстрі = поза згенерована з тексту, а не
                // від еталона, і обличчя на ній інше. Позначаємо, щоб її
                // не поставили в кадр не подумавши.
                const drifted = /розход/i.test(card.entry?.quality ?? '');
                const isRef = reference?.key === card.key;
                return (
                  <button
                    key={card.key}
                    type="button"
                    className={`post-block__pose${isActiveCard(card) ? ' is-on' : ''}${drifted ? ' is-drifted' : ''}`}
                    title={[card.entry?.use, card.entry?.quality, card.entry?.id ?? card.key]
                      .filter(Boolean)
                      .join(' · ')}
                    onClick={() => setPreview(card)}
                  >
                    <img src={card.src} alt="" loading="lazy" />
                    {drifted ? <span className="post-block__pose-warn" aria-hidden>!</span> : null}
                    {isRef ? <span className="post-block__pose-ref" aria-hidden>★</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="post-block__row">
              <button
                type="button"
                className="post-block__pick"
                onClick={() => ask(poseCards.length
                  ? 'Перегенеруй позу ведучого так, щоб вона лишалась схожою на наявні пози з реєстру poses.json.'
                  : 'Проведи character-bootstrap за references/character.md і згенеруй ведучого.')}
              >
                {poseCards.length ? 'Перегенерувати позу' : 'Створити ведучого'}
              </button>
              {poseCards.length > 0 ? (
                <button
                  type="button"
                  className="post-block__pick"
                  disabled={post.words.length === 0}
                  title={post.words.length
                    ? 'Клод пройде сценарій і призначить позу кожній думці'
                    : 'Спершу таймкоди — без них нема до чого прив’язувати пози'}
                  onClick={() => ask(
                    'Розстав пози ведучого під сценарій.\n\n'
                    + '1. Візьми post.json: script — текст, words — пословні таймкоди.\n'
                    + '2. Розбий текст на смислові блоки (речення або тезу), для кожного '
                    + 'візьми start з першого слова блоку і end з останнього.\n'
                    + '3. Признач позу з assets/character/poses.json, орієнтуючись на поле '
                    + '"use" кожної пози — воно описує, для чого поза призначена.\n'
                    + '4. Зміна пози — подія, а не прикраса. Став її на зламах думки '
                    + '(проблема → причина → рішення → доказ), а не на кожну фразу. '
                    + 'Орієнтир: одна поза тримається 4-8 секунд. На 50-секундному ролику '
                    + 'це 6-10 змін, не двадцять.\n'
                    + '4a. Числівники ставляться буквально: глядач читає кількість пальців. '
                    + '«Перше» — поза з одним пальцем, «друге» — з двома, «третє» — з трьома. '
                    + 'Поставити на «перше» позу з двома пальцями означає збрехати в кадрі. '
                    + 'Якщо потрібної кількості в реєстрі немає — це саме той випадок, '
                    + 'коли треба спинитись і спитати (пункт нижче), а не брати схожу.\n'
                    + '5. Запиши результат у post.json → beats у форматі '
                    + '[{index, text, start, end, pose}], де pose — це id з реєстру.\n\n'
                    + 'ВАЖЛИВО: якщо для якоїсь думки потрібної пози в реєстрі немає — '
                    + 'не підставляй приблизну і не вигадуй. Зупинись і спитай мене: '
                    + 'опиши, який жест бракує і для якої фрази, та запропонуй два варіанти — '
                    + 'згенерувати нову позу через i2i від еталона, або взяти конкретну '
                    + 'наявну як компроміс. Я вирішу.',
                  )}
                >
                  Розставити пози
                </button>
              ) : null}
            </div>
          </BlockShell>

          <BlockShell
            num={6}
            title="Бібліотека"
            {...blockShell(
              'library',
              `${wanted.length ? ' is-active' : ''}${
                registry.length && wanted.length === 0 ? ' is-done' : ''
              }`,
            )}
            actions={wanted.length ? (
              <div className="post-block__head-actions">
                <button
                  type="button"
                  className="post-block__icon"
                  disabled={busy}
                  title="Віддати заявки в чат — з брифом, папкою і правилами генерації"
                  onClick={orderWanted}
                >
                  Замовити ({wanted.length})
                </button>
              </div>
            ) : undefined}
          >
            <div className="post-block__note">
              {registry.length === 0
                ? 'Реєстр не знайдено — assets/stickers/stickers.json.'
                : `${registry.length - wanted.length} намальовано · ${wanted.length} у заявках`}
            </div>
            {KINDS.map(({ kind, title, hint }) => {
              const mine = registry.filter((r) => (r.kind ?? 'object') === kind && !r.status);
              if (mine.length === 0) return null;
              return (
                <div key={kind} className="post-block__kind">
                  <div className="post-block__kind-head">
                    {title} <span>{mine.length}</span>
                  </div>
                  <div className="post-block__kind-hint">{hint}</div>
                  <div className="post-block__poses">
                    {mine.map((r) => {
                      const f = r.file ? stickerByPath.get(r.file.replace(/\\/g, '/')) : null;
                      // Файл проєкту → ассет бібліотеки → нічого. Без другої
                      // ланки наскрізний набір показувався б порожніми
                      // квадратами з підписами: реєстр є, а дивитись нема на що.
                      const src = f
                        ? `${rawUrl(projectId, f.name)}?v=${f.mtime}`
                        : r.libraryId
                          ? libraryRawUrl(r.libraryId)
                          : '';
                      return (
                        <button
                          type="button"
                          key={r.id}
                          className="post-block__pose"
                          disabled={busy}
                          title={[
                            r.id,
                            r.use ?? '',
                            f ? 'у проєкті' : r.libraryId ? 'зі спільної бібліотеки' : '',
                            '',
                            'Клік — перемалювати в нашому стилі',
                          ].filter(Boolean).join('\n')}
                          onClick={() => setStickerPreview(r)}
                        >
                          {src ? (
                            <img src={src} alt="" loading="lazy" />
                          ) : (
                            <span className="post-block__sticker-gap">{r.id}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {wanted.length ? (
              <div className="post-block__kind">
                <div className="post-block__kind-head">
                  Бракує <span>{wanted.length}</span>
                </div>
                <div className="post-block__kind-hint">
                  Агент не знайшов підхожого і лишив бриф замість того, щоб узяти приблизне.
                </div>
                {wanted.map((r) => (
                  <div key={r.id} className="post-block__want">
                    <b>{r.id}</b>
                    <span>{r.use}</span>
                    <i>{r.brief}</i>
                  </div>
                ))}
                <div className="post-block__row">
                  <button
                    type="button"
                    className="post-block__pick"
                    disabled={busy}
                    title="Віддати заявки в чат — з брифом, папкою і правилами генерації"
                    onClick={orderWanted}
                  >
                    Замовити {wanted.length === 1 ? 'малюнок' : `малюнки (${wanted.length})`}
                  </button>
                </div>
              </div>
            ) : null}
          </BlockShell>

          <BlockShell
            num={7}
            title="Стікери"
            {...blockShell(
              'stickers',
              `${stage === 'ready' && stickers.length === 0 ? ' is-active' : ''}${
                stickers.length && drawnCount === stickers.length ? ' is-done' : ''
              }`,
            )}
            actions={stickers.length ? (
              <div className="post-block__head-actions">
                <button
                  type="button"
                  className="post-block__icon is-danger"
                  disabled={busy}
                  title="Зняти всі прив’язки. Намальовані файли лишаться в проєкті."
                  onClick={() => void save({ ...post, stickers: [] }, 'стікери відв’язано')}
                >
                  Прибрати
                </button>
              </div>
            ) : undefined}
          >
            <div className="post-block__note">
              {post.words.length === 0
                ? 'Спершу таймкоди — без них немає слів, до яких кріпити.'
                : stickers.length === 0
                  ? 'Стікер ставиться на конкретне слово — орієнтир один на 4–6 секунд.'
                  : (() => {
                      // Раніше тут стояла щільність «один на 4–6 секунд».
                      // Відколи стікери накопичуються, вона лається завжди:
                      // сцена з чотирьох картинок за пʼять секунд — це не
                      // перебір, а задум. Тому міряємо інше — скільки їх
                      // сходиться в кадрі РАЗОМ, бо перебір тепер саме там.
                      let peak = 0;
                      for (const s of spans) {
                        const n = spans.filter((o) => o.start < s.end && s.start < o.end).length;
                        if (n > peak) peak = n;
                      }
                      const missing = stickers.length - drawnCount;
                      return `${stickers.length} стікерів, найбільше разом у кадрі — ${peak}`
                        + (peak > STICKER_MAX_LIVE ? ` (у кадр увійде ${STICKER_MAX_LIVE})` : '')
                        + '.'
                        + (missing ? ` ${missing} ще не намальовано.` : '');
                    })()}
            </div>

            {spans.length > 0 ? (
              <div className="post-block__stickers">
                {spans.map(({ sticker, start, end }) => {
                  const file = sticker.file
                    ? stickerByPath.get(sticker.file.replace(/\\/g, '/')) ?? null
                    : null;
                  const live = time >= start && time < end;
                  return (
                    <button
                      key={`${sticker.id}-${sticker.word}`}
                      type="button"
                      className={`post-block__sticker${live ? ' is-on' : ''}${file ? '' : ' is-missing'}`}
                      title={[
                        `${clock(start)} — ${clock(end)}`,
                        `на слові «${cleanCaption(post.words[sticker.word]?.word ?? '')}»`,
                        sticker.note,
                        file ? sticker.file : 'файлу ще немає',
                      ].filter(Boolean).join(' · ')}
                      onClick={() => seek(start)}
                    >
                      {file ? (
                        <img
                          src={`${rawUrl(projectId, file.name)}?v=${file.mtime}`}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span className="post-block__sticker-gap" aria-hidden>?</span>
                      )}
                      <span className="post-block__sticker-at">{clock(start)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {spans.length < stickers.length ? (
              <div className="post-ws__hint" style={{ marginTop: 8 }}>
                {stickers.length - spans.length} стікерів вказують на слова, яких у
                таймкодах немає — схоже, доріжку перезалили. Перепідбери.
              </div>
            ) : null}

            {/*
              Бібліотека проєкту. Показуємо ЗАВЖДИ, коли файли є, а не
              лише коли щось прив'язано: намальований стікер, якого не
              видно в панелі, виглядає так, ніби його не існує.
            */}
            {stickerFiles.length > 0 ? (
              <>
                <div className="post-block__note" style={{ marginTop: 10 }}>
                  {post.words.length === 0
                    ? `${stickerFiles.length} у бібліотеці проєкту. Прив'язати можна після таймкодів.`
                    : `${stickerFiles.length} у бібліотеці. Клік ставить на слово, де стоїть плейхед.`}
                </div>
                <div className="post-block__poses">
                  {stickerFiles.map((f) => {
                    const path = f.name.replace(/\\/g, '/');
                    const id = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
                    const used = stickers.some((s) => s.id === id);
                    return (
                      <button
                        key={f.name}
                        type="button"
                        className={`post-block__pose${used ? ' is-on' : ''}`}
                        disabled={busy || post.words.length === 0}
                        title={[
                          id,
                          stickerUse.get(id) ?? '',
                          used ? 'уже в ролику' : 'клік — поставити на поточне слово',
                        ].filter(Boolean).join('\n')}
                        onClick={() => bindSticker(path, id)}
                      >
                        <img src={`${rawUrl(projectId, f.name)}?v=${f.mtime}`} alt="" loading="lazy" />
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}

            <div className="post-block__row">
              <button
                type="button"
                className="post-block__pick"
                disabled={post.words.length === 0}
                title={post.words.length
                  ? 'Клод пройде текст і вибере слова, де картинка додає сенс'
                  : 'Спершу таймкоди — без них нема до чого кріпити'}
                onClick={() => ask(
                  'Розстав стікери під сценарій.\n\n'
                  + 'ЩО ПРОЧИТАТИ СПЕРШУ:\n'
                  + '1. post.json → script (текст) і words (пословні таймкоди).\n'
                  + '2. assets/stickers/stickers.json — реєстр наявних. Поле "use" '
                  + 'у кожного каже, ДЛЯ ЧОГО він; вибирай за ним, а не за назвою файлу.\n\n'
                  + 'ЯК ЦЕ ПРАЦЮЄ. Стікер кріпиться до СЛОВА за його індексом у '
                  + 'words (з нуля) — не до біта: біт триває 4–8 секунд, і картинка '
                  + 'зʼявилась би задовго до слова, яке малює.\n\n'
                  + 'СТІКЕРИ НАКОПИЧУЮТЬСЯ, і це головне. Поки один висить, поруч '
                  + 'стає наступний, і кадр добудовується в маленьку схему. Тому '
                  + 'думай не окремими картинками, а СЦЕНАМИ: одна теза — одна '
                  + 'сцена з двох-трьох предметів, які разом читаються як думка '
                  + `(«не стартап, а дрібниця» = ракета + крапля). До ${STICKER_MAX_LIVE} `
                  + 'разом у кадрі; більше — у кадр просто не влізе, і кожен стане '
                  + 'дрібним нерозбірливим значком.\n\n'
                  + 'Розкладку по горизонталі не задавай — її рахує студія з '
                  + 'кількості живих у цю мить. Керуєш лише тим, ЩО і КОЛИ.\n\n'
                  + 'КОЛИ СТІКЕР ПОТРІБЕН — фраза називає річ, яку можна намалювати '
                  + 'одним предметом: конкретний предмет («файл», «бот»), метафора '
                  + '(«порожня голова»), протиставлення.\n\n'
                  + 'КОЛИ НЕ ПОТРІБЕН: службові звʼязки («тому», «а далі»), повтор '
                  + 'уже показаного, фінальна фраза — там працюють ведучий і текст. '
                  + 'Порожній кадр між сценами обовʼязковий: якщо картинки не '
                  + 'зникають зовсім, ролик перетворюється на дошку оголошень.\n\n'
                  + 'ЧОГО НЕ ВИСТАЧАЄ. Якщо наявний підходить хоч приблизно — бери '
                  + 'наявний: набір має ходити між роликами, а кожна генерація це '
                  + 'гроші. Якщо ж під фразу справді немає нічого, НЕ малюй одразу '
                  + 'і не бери схоже абияк. Допиши в реєстр ЗАЯВКУ:\n'
                  + '{ "id": "coffee-cup", "kind": "object", "use": "для чого '
                  + 'потрібен", "status": "needed", "folder": "assets/stickers/", '
                  + '"brief": "що саме намальовано і чого малювати не можна" }\n'
                  + '- kind: object — предмет · screen — інтерфейс · avatar — '
                  + 'глядач і його речі\n'
                  + '- запис без "file" і є заявка: студія покаже її в блоці '
                  + 'Бібліотека окремим списком, і власник запустить генерацію '
                  + 'звідти, коли перегляне всі брифи разом\n'
                  + 'Пройди ВЕСЬ сценарій і залиш усі заявки одним заходом, а не '
                  + 'по одній у процесі.\n\n'
                  + 'ЯК ВОНО РУХАЄТЬСЯ — не вигадуй, а ВИБЕРИ зі словника '
                  + 'assets/motions.json: пройди таблицю добору (motion-library.md), '
                  + 'перше «так» згори — твій запис. Вибір ЗАПИШИ у сцену: '
                  + 'scenes[].plan.motion = "<id запису>" ("hook-solo-lead", '
                  + '"empty-face", …) — по ньому Перевірка звіряє бюджет ролика '
                  + '(один гак, одне кільце, квоти карток і пауз). Сцена без '
                  + 'motion = вибір, якого не можна перевірити.\n\n'
                  + 'Правила у references/motion.md плагіна. Коротко: перший стікер '
                  + 'речення заходить "instant" (поки він виростає, глядач дивиться '
                  + 'на порожнечу); другий предмет — "from-right" чи "from-left", бо '
                  + 'рух іззовні читається як поява нової дійової особи; "label" — '
                  + 'синя пігулка присвоєння («ти», «твій сайт»), одна на весь час; '
                  + '"badges" — червоні плашки над стікером, що НАКОПИЧУЮТЬСЯ («−10 хв» '
                  + '×3) і показують, що з предметом відбувається зараз. Нічого не '
                  + 'зникає до кінця думки: кадр добудовується в схему.\n\n'
                  + 'МЕЖА МІЖ РЕЧЕННЯМИ. Вирішуй, ХТО її переживає — це задається '
                  + 'через hold. Лишається той, про кого мова далі: аватар «ти» '
                  + 'тримається, поки наступна думка теж про глядача, і йде, щойно '
                  + 'розмова перейшла на інший предмет. Предмет, який уже сказав '
                  + 'своє, не тягнуть «щоб кадр не був порожнім» — тиша краща за '
                  + 'декорацію. Далі схема сама: перейшло 0 — кадр очищається і '
                  + 'нова думка починається з порожнього; перейшов 1 — він '
                  + 'повертається в центр; перейшов 1 і приходить новий — новий '
                  + 'заходить з протилежного краю, не з того, звідки прийшов '
                  + 'попередній. Розкладку рахує студія, ти керуєш лише hold і '
                  + 'enter. Деталі — references/motion.md.\n\n'
                  + 'ЗАПИШИ в post.json → stickers масивом обʼєктів:\n'
                  + '{ "id": "rocket", "word": 45, "hold": 2.6, "file": '
                  + '"assets/stickers/rocket.png", "note": "стартап", '
                  + '"enter": "from-right", "label": "твій стартап", '
                  + '"badges": [{ "text": "−10 хв", "at": 47 }] }\n'
                  + '- enter — instant | pop | from-right | from-left\n'
                  + '- label — коротко, два-три слова; порожньо, якщо картинка '
                  + 'говорить сама\n'
                  + '- badges[].at — індекс слова, як і word: час завжди з words\n'
                  + '- id — з реєстру, або kebab-case для нового\n'
                  + '- word — індекс слова у words, з нуля\n'
                  + '- hold — скільки висить, 2.2–4 с. Довший hold і є те, що '
                  + 'тримає попередній стікер у кадрі, поки зʼявляється наступний\n'
                  + '- file — шлях, якщо стікер уже існує; для нового лиши порожнім '
                  + 'до генерації\n'
                  + '- note — що зображено, одним рядком',
                )}
              >
                Підібрати стікери
              </button>
              {stickers.length > drawnCount ? (
                <button
                  type="button"
                  className="post-block__pick"
                  onClick={() => ask(
                    'Зроби стікери, яких ще немає.\n\n'
                    + 'Візьми post.json → stickers: у кого немає file — того й треба '
                    + 'зробити. Поле note каже, що саме зображено.\n\n'
                    + 'ВИМОГИ ДО РЕЗУЛЬТАТУ (фон ролика світлий #EFEFEC — це міняє все):\n'
                    + '- квадрат, прозоре тло\n'
                    + '- кант ТЕМНИЙ #1A1A1A: на світлому фоні світлий кант '
                    + 'розчиняється, і стікер читається як артефакт\n'
                    + '- плоский вектор, насичені кольори, без градієнтів\n'
                    + '- мʼяка тінь як у ведучого: зсув вниз 8, розмиття 12, '
                    + 'непрозорість 18 %\n'
                    + '- ТЕКСТУ всередині немає ніколи: він сперечається з '
                    + 'субтитрами і не читається на швидкості\n'
                    + '- один предмет, не сцена: силует має читатись з відстані\n\n'
                    + 'Клади у assets/stickers/<id> і одразу впиши шлях у '
                    + 'post.json → stickers[].file, інакше студія їх не підхопить.',
                  )}
                >
                  Намалювати відсутні
                </button>
              ) : null}
              <button
                type="button"
                className="post-block__pick"
                disabled={post.words.length === 0}
                title={post.words.length
                  ? 'Екрани й документи малюються розміткою, а не генерацією'
                  : 'Спершу таймкоди'}
                onClick={() => ask(
                  'Розстав блоки-екрани під сценарій.\n\n'
                  + 'ЩО ЦЕ ТАКЕ І ЧИМ ВІДРІЗНЯЄТЬСЯ ВІД СТІКЕРА. Стікер — предмет '
                  + 'або метафора (ракета, крапля, лампочка), його малює модель '
                  + 'картинкою. Блок — ЕКРАН чи ДОКУМЕНТ: термінал, файл коду, '
                  + 'чек-лист, дерево файлів, велика цифра з підписом. Його малюєш '
                  + 'ТИ розміткою, і саме тому він виграє: справжній моноширинний '
                  + 'шрифт лишається чітким на будь-якому кеглі, а рядки можуть '
                  + 'відкриватись під мову — растрова картинка не вміє ні того, ні '
                  + 'того. Згенерований «стікер терміналу» вже пробували: вийшов '
                  + 'розмитий мультик, у якому текст не читається.\n\n'
                  + 'ЩО ПРОЧИТАТИ: post.json → script і words. Пройди текст і знайди '
                  + 'місця, де глядачеві треба ПОКАЗАТИ вміст, а не натякнути на '
                  + 'нього: перелік правил, вміст файлу, команду в терміналі, цифру '
                  + 'з наслідком.\n\n'
                  + 'ЯК МАЛЮВАТИ. Один блок — один файл `assets/blocks/<id>.html`, '
                  + 'самодостатній фрагмент: розмітка плюс `<style>` з правилами, '
                  + 'обмеженими цим блоком. Полотно 1080 px завширшки — пиши в тих '
                  + 'самих пікселях, студія стисне під превʼю сама. Кегль великий: '
                  + 'це кадр Reels, а не сторінка. Не більше девʼяти рядків — далі '
                  + 'глядач не встигає.\n\n'
                  + 'ПОЯВА РЯДКІВ. Признач `data-reveal` тим елементам, які мають '
                  + 'виходити по черзі під мову: студія додаватиме їм клас '
                  + '`is-shown` у міру відтворення. Закритий і відкритий стан '
                  + 'опиши в CSS блоку сам — це твоє рішення, не студії.\n\n'
                  + 'ЗАПИШИ в post.json → cards масивом:\n'
                  + '{ "id": "pytest", "word": 72, "hold": 3.4, '
                  + '"file": "assets/blocks/pytest.html", "note": "термінал із pytest" }\n'
                  + '- word — індекс слова у words, з нуля\n'
                  + '- hold — скільки висить; рядки відкриються за перші три чверті\n\n'
                  + 'Блок і стікери одночасно в кадрі не показуються — блок широкий. '
                  + 'Тому не став блок на ті самі слова, де вже стоять стікери: '
                  + 'вибери, що там важливіше.',
                )}
              >
                Намалювати блоки
              </button>
            </div>
          </BlockShell>

          <BlockShell
            num={8}
            title="Перевірка"
            {...blockShell(
              'check',
              `${warns ? ' is-active' : ''}${findings.length === 0 ? ' is-done' : ''}`,
            )}
          >
            <div className="post-block__note">
              {findings.length === 0
                ? 'Чисто: усе встигає прочитатись, порожніх кадрів немає.'
                : `${warns} треба поправити · ${findings.length - warns} на подумати`}
            </div>
            {findings.length ? (
              <div className="post-block__scenes">
                {findings.map((f, i) => (
                  <button
                    type="button"
                    key={`${f.at}-${i}`}
                    className={`post-block__scene${f.level === 'warn' ? ' is-warn' : ''}`}
                    onClick={() => seek(Math.max(0, f.at - 0.4))}
                    title={f.why}
                  >
                    <span className="post-block__scene-at">{f.at.toFixed(1)}</span>
                    <span className="post-block__scene-text">{f.what}</span>
                    <span className="post-block__scene-meta">{f.why}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </BlockShell>

          <BlockShell
            num={9}
            title="Рендер"
            {...blockShell(
              'render',
              `${findings.length === 0 && post.audio ? ' is-active' : ''}`,
            )}
          >
            <div className="post-block__note">
              {!post.audio
                ? 'Спершу звук — без доріжки нема чого рендерити.'
                : post.words.length === 0
                  ? 'Спершу таймкоди (words.json) — без них студія не віддасть кадр знімальнику.'
                  : warns
                    ? `${warns} зауваження в перевірці — рендер запише їх у файл як є.`
                    : 'Рендер знімає САМ цей кадр покадрово, тому mp4 виходить таким, як тут.'}
            </div>
            <div className="post-block__row">
              <button
                type="button"
                className="post-block__pick"
                disabled={busy || !post.audio || post.words.length === 0 || render?.state === 'running'}
                title="Рендер запускається прямо звідси — без чату"
                onClick={() => void startRender()}
              >
                {render?.state === 'running'
                  ? `Рендериться… ${renderProgress(render.tail)}`
                  : 'Відрендерити'}
              </button>
            </div>
            {renderRow}
            <div className="post-block__kind-hint">
              {(() => {
                const speed = post.speed ?? 1;
                const out = (post.audio?.duration ?? 0) / speed;
                return `Кадрів буде ${Math.round(out * CANVAS.fps)} · ${clock(out)}`
                  + `${speed !== 1 ? ` на ${speed}×` : ''} · ${CANVAS.w}×${CANVAS.h} · ${CANVAS.fps} fps`;
              })()}
            </div>
          </BlockShell>

          <BlockShell
            num={10}
            title="Швидкість"
            {...blockShell('speed', speed > 1 ? ' is-done' : '')}
            // Значок навмисно НЕ в post-block__head-actions: там усе
            // ховається, поки блок згорнутий, а множник має бути видно
            // саме згорнутим — інакше пришвидшення стає невидимим
            // налаштуванням, про яке згадуєш аж на рендері.
            actions={speed > 1 ? (
              <span className="post-block__badge">{speed.toFixed(1)}×</span>
            ) : undefined}
          >
            <div className="post-block__note">
              {duration === 0
                ? 'Спершу доріжка — від її довжини рахується решта.'
                : (() => {
                    const out = duration / speed;
                    const saved = duration - out;
                    if (speed === 1) {
                      return `${clock(duration)} як записано. Пришвидшення стискає голос `
                        + 'разом із субтитрами; ведучий рухається як рухався.';
                    }
                    return `${clock(duration)} → ${clock(out)} на ${speed.toFixed(1)}× `
                      + `(коротше на ${saved.toFixed(1)} с). Субтитри й стікери їдуть `
                      + 'із голосом, анімація ведучого — ні.';
                  })()}
            </div>
            <div className="post-block__row">
              {SPEEDS.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`post-block__pick${v === speed ? ' is-on' : ''}`}
                  disabled={busy || duration === 0}
                  title={duration === 0
                    ? 'Спершу доріжка'
                    : `${clock(duration)} → ${clock(duration / v)}`}
                  onClick={() => void save(
                    { ...post, speed: v },
                    v === 1
                      ? 'швидкість як записано'
                      : `${v.toFixed(1)}× · ${clock(duration / v)}`,
                  )}
                >
                  {v === 1 ? '1.0×' : `${v.toFixed(1)}×`}
                </button>
              ))}
            </div>
            {/*
              Превʼю чує пришвидшення одразу — плеєру виставлено
              playbackRate. Рендер його поки не читає: там доріжку треба
              проганяти через atempo, а таймкоди ділити на той самий
              множник. Кажемо про це прямо, щоб цифра в панелі не
              видавалась за готовий ролик.
            */}
            {speed > 1 ? (
              <div className="post-ws__hint" style={{ marginTop: 8 }}>
                У превʼю чути одразу. У рендер це ще не заведено — доріжку
                там треба гнати через <code>atempo</code>, а таймкоди ділити
                на {speed.toFixed(1)}.
              </div>
            ) : null}
          </BlockShell>
        </div>
        ), document.body) : null}
      </div>

      {/*
        Перегляд стікера. Дії тут ті самі, що були розкидані по сітці:
        поставити на слово і перемалювати. Клік у сітці лише відкриває —
        інакше одне натискання мовчки витрачає гроші на генерацію.
      */}
      {stickerPreview ? (() => {
        const f = stickerPreview.file
          ? stickerByPath.get(stickerPreview.file.split('\\').join('/'))
          : null;
        // Еталон свого розділу — поруч, як у позах ведучого. Саме з ним
        // звіряють манеру, а не з абстрактним «нашим стилем»: словами
        // товщину канта й насиченість не передати.
        const refId = styleRefs[stickerPreview.kind ?? 'object'];
        const refEntry = refId && refId !== stickerPreview.id
          ? registry.find((x) => x.id === refId)
          : null;
        const refFile = refEntry?.file
          ? stickerByPath.get(refEntry.file.split('\\').join('/'))
          : null;
        // Портал у body: модалка живе всередині правої панелі, а та
        // створює власний шар — z-index усередині нього не підіймає
        // вікно над композером чату зліва.
        return createPortal((
          <div
            className="post-ws__preview"
            role="dialog"
            aria-modal="true"
            onClick={() => setStickerPreview(null)}
          >
            <div className="post-ws__preview-box" onClick={(e) => e.stopPropagation()}>
              <div className="post-ws__preview-shots">
                {refFile ? (
                  <figure className="post-ws__preview-shot">
                    <img src={`${rawUrl(projectId, refFile.name)}?v=${refFile.mtime}`} alt="" />
                    <figcaption>еталон · {refEntry?.id}</figcaption>
                  </figure>
                ) : null}
                <figure className="post-ws__preview-shot">
                  {f ? (
                    <img src={`${rawUrl(projectId, f.name)}?v=${f.mtime}`} alt="" />
                  ) : (
                    <span className="post-block__sticker-gap">файлу ще немає</span>
                  )}
                  <figcaption>{stickerPreview.id}</figcaption>
                </figure>
              </div>
              {refFile ? (
                <div className="post-ws__preview-use">
                  Звіряй манеру лінії, насиченість, білий кант і поля навколо предмета —
                  саме вони тримають набір разом.
                </div>
              ) : null}

              {stickerPreview.use ? (
                <div className="post-ws__preview-use">{stickerPreview.use}</div>
              ) : null}
              {stickerPreview.shows ? (
                <div className="post-ws__preview-use">{stickerPreview.shows}</div>
              ) : null}

              <div className="post-block__row">
                <button
                  type="button"
                  className="post-block__pick"
                  disabled={busy || !f || post.words.length === 0}
                  title={post.words.length === 0
                    ? 'Спершу таймкоди — без них нема до чого кріпити'
                    : 'Поставити на слово, де стоїть плейхед'}
                  onClick={() => {
                    if (f) bindSticker(f.name.split('\\').join('/'), stickerPreview.id);
                    setStickerPreview(null);
                  }}
                >
                  Поставити на слово
                </button>
                <button
                  type="button"
                  className="post-block__pick"
                  disabled={busy || !f}
                  title="Перемалювати в нашому стилі — image-to-image від наявного файлу"
                  onClick={() => {
                    redrawSticker(stickerPreview);
                    setStickerPreview(null);
                  }}
                >
                  Перемалювати
                </button>
                <button
                  type="button"
                  className="post-block__pick"
                  onClick={() => setStickerPreview(null)}
                >
                  Закрити
                </button>
              </div>
            </div>
          </div>
        ), document.body);
      })() : null}

      {/*
        Перегляд пози. Поруч завжди еталон — саме з ним звіряють обличчя,
        і тримати їх поруч важливіше за розмір однієї картинки. Дії теж
        тут: у сітці клік має відкривати, а не мовчки щось призначати.
      */}
      {preview ? createPortal((
        <div
          className="post-ws__preview"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
        >
          <div className="post-ws__preview-box" onClick={(e) => e.stopPropagation()}>
            <div className="post-ws__preview-shots">
              {reference && reference.key !== preview.key ? (
                <figure className="post-ws__preview-shot">
                  <img src={reference.src} alt="" />
                  <figcaption>еталон · {reference.entry?.id ?? ''}</figcaption>
                </figure>
              ) : null}
              <figure className="post-ws__preview-shot">
                <img src={preview.src} alt="" />
                <figcaption>
                  {preview.entry?.id ?? preview.key}
                  {preview.inProject ? ' · у проєкті' : ' · бібліотека'}
                </figcaption>
              </figure>
            </div>

            {preview.entry?.use ? (
              <div className="post-ws__preview-use">{preview.entry.use}</div>
            ) : null}
            {/розход/i.test(preview.entry?.quality ?? '') ? (
              <div className="post-ws__preview-warn">
                Ця поза розходиться з еталоном — обличчя інше. Краще
                перегенерувати від еталона, ніж ставити в кадр.
              </div>
            ) : null}

            <div className="post-block__row">
              <button
                type="button"
                className="post-block__pick"
                onClick={() => {
                  ask(`Признач позу ${preview.ref} на біт у момент ${time.toFixed(1)} с і онови post.json.`);
                  setPreview(null);
                }}
              >
                Призначити на біт
              </button>
              <button
                type="button"
                className="post-block__pick"
                onClick={() => {
                  const id = preview.entry?.id ?? preview.key;
                  const file = preview.entry?.file ?? preview.ref;
                  ask(
                    `Перегенеруй позу ${id} методом image-to-image від еталона `
                      + `${reference?.entry?.file ?? 'character-wave.png'} зі style_lock з poses.json.\n\n`
                      + '1. Зовнішність текстом не описуй — вона має прийти з референсу.\n'
                      + '2. Кадр по пояс із запасом: не обрізай кисті, лікті й полу куртки, '
                      + 'низ одягу має доходити до краю кадру, як на еталоні. Ніяких дуг і овалів знизу.\n'
                      + `3. Результат перезапиши в ТОЙ САМИЙ файл ${file}. `
                      + 'Не створюй pose-*-v2, -v3 і подібні: кожна зайва версія залишається в сітці сміттям.\n'
                      + '4. Одразу прожени через remove-background (hyperframes remove-background) — '
                      + 'модель майже завжди малює фон замість прозорості. Перевір, що на виході pix_fmt=rgba.\n'
                      + '5. Онови libraryId у poses.json і заміни ассет у спільній бібліотеці '
                      + '(od library rm старий, потім import з тегом "reels-host,<id>").\n'
                      + '6. Звір з еталоном: колір очей, тон шкіри, товщина контурів.\n'
                      + `7. Онови quality у poses.json для ${id}: прибери позначку про розходження, `
                      + 'інакше поза лишиться з попередженням у панелі попри вдалу перегенерацію. '
                      + 'Той самий poses.json скопіюй у корінь плагіна і перезалий у бібліотеку '
                      + 'з тегом "reels-host,registry".',
                  );
                  setPreview(null);
                }}
              >
                Перегенерувати від еталона
              </button>
              <button
                type="button"
                className="post-block__pick"
                disabled={!preview.inProject}
                title={preview.inProject
                  ? 'Зрізати фон локальною моделлю, не чіпаючи саму фігуру'
                  : 'Спершу поза має бути у файлах проєкту'}
                onClick={() => {
                  ask(
                    `Прибери фон у ${preview.ref} через remove-background ` +
                      '(hyperframes remove-background, локальна модель). ' +
                      'Не перегенеровуй зображення — обличчя вже збіглося з ' +
                      'еталоном, друга генерація його змінить. Перезапиши ' +
                      'той самий файл, онови libraryId у poses.json і заміни ' +
                      'ассет у спільній бібліотеці.',
                  );
                  setPreview(null);
                }}
              >
                Видалити фон
              </button>
              <button
                type="button"
                className="post-block__pick is-danger"
                onClick={() => {
                  const id = preview.entry?.id ?? preview.key;
                  ask(
                    `Прибери позу ${preview.ref}. Видали файл із проєкту, ` +
                      `запис ${id} з poses.json і ассет зі спільної бібліотеки ` +
                      '(od library rm), якщо він там є. Решту поз не чіпай.',
                  );
                  setPreview(null);
                }}
              >
                Видалити позу
              </button>
              <button type="button" className="post-block__pick" onClick={() => setPreview(null)}>
                Закрити
              </button>
            </div>
          </div>
        </div>
      ), document.body) : null}
    </div>
  );
}

/** Нарізка слів на групи субтитрів — спільна для ролика і демо руху. */
function chunkCaptionWords(words: readonly WordTiming[]): WordTiming[][] {
    // Рішення приймає ширина, а не кількість. «Це і є» — три слова, але
    // п'ять символів: закривати на них групу означало б лишити пів
    // рядка порожнім, а наступне слово («навчання») відкинути в новий
    // кадр. Тому стеля за словами висока, а справжня межа — довжина.
    const MAX_WORDS = 4;
    // Міряно, не вгадано: при кеглі 6.9 % ширини кадру рядок із 20
    // символів займає 1252 px проти 756 доступних. Тринадцять — стеля,
    // за якої найдовша реальна група ще вміщається без стискання.
    //
    // Стискати рядок під ширину не можна: сусідні кадри отримали б різний
    // кегль, і субтитр «дихав» би розміром від групи до групи. У
    // референсі кегль сталий, а короткі група — саме тому.
    const MAX_CHARS = 13;
    const chunks: WordTiming[][] = [];
    let cur: WordTiming[] = [];
    let len = 0;
    for (const w of words) {
      // Довжину рахуємо за очищеним словом, бо саме воно піде в кадр.
      // Слова з самої пунктуації в групу не беремо взагалі: вони з’їдали
      // б місце й ламали лічильник, нічого не показуючи.
      const wl = cleanCaption(w.word).length;
      if (wl === 0) continue;
      // +1 на пробіл між словами — інакше рядок із п'яти коротких слів
      // рахується вужчим, ніж малюється.
      const cost = cur.length > 0 ? wl + 1 : wl;
      if (cur.length >= MAX_WORDS || (cur.length > 0 && len + cost > MAX_CHARS)) {
        chunks.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(w);
      len += cur.length > 1 ? cost : wl;
      // Кінець речення закриває групу. Без цього рядок склеює хвіст
      // однієї фрази з початком наступної («не соромно | це і є») і
      // ріже думку там, де її треба тримати цілою.
      if (/[.!?…]$/.test(w.word.trim())) {
        chunks.push(cur);
        cur = [];
        len = 0;
      }
    }
    if (cur.length > 0) chunks.push(cur);
    return chunks;
}

/* ------------------------------------------------------------------ */
/* Галерея рухів                                                       */
/* ------------------------------------------------------------------ */

/**
 * Мінікадр демо руху.
 *
 * Це свідома друга копія кадру студії: та сама розкладка тими самими
 * чистими функціями (stickerSpans/stickerLayout/liveBadges/...) і ті
 * самі CSS-класи — тому мініатюра масштабується контейнером і виглядає
 * як справжній кадр. Спрощення рівно три: немає скраба, немає порожніх
 * станів, немає режиму зйомки. Якщо кадр студії і мінікадр розійшлись —
 * правити ТУТ, звіряючись зі стейджем вище.
 */
function MotionMiniFrame({ demo, time, projectId, poseCards, stickerByPath, full = false }: {
  demo: NonNullable<MotionEntry['demo']>;
  time: number;
  projectId: string;
  poseCards: PoseCard[];
  stickerByPath: Map<string, PostFile>;
  /**
   * Повний кадр 9:16 із ведучим і субтитрами — для модалу. У сітці
   * галереї кадр без них: блок квадратний і показує саму сцену, бо
   * ведучий і текст однакові в усіх рухах і лише розмивають різницю.
   */
  full?: boolean;
}) {
  const post = useMemo(() => demoPost(demo), [demo]);
  const preset = PRESETS[DEFAULT_PRESET];
  const stickers = post.stickers ?? [];
  const cards = post.cards ?? [];
  const spans = stickerSpans(stickers, post.words, post.scenes ?? [], cards);
  const live = stickerLayout(spans, time, preset.stickers.maxWidthPct);
  const punch = accentPunch(time, post.words);
  const stickerBase = preset.stickers.top
    + preset.stickers.maxWidthPct * (CANVAS.w / CANVAS.h);
  const card = cardAt(cards, post.words, time);
  const chunks = useMemo(() => chunkCaptionWords(post.words), [post.words]);
  const chunk = (() => {
    let found: WordTiming[] | null = null;
    for (const c of chunks) {
      if (c[0]!.start <= time) found = c;
      else break;
    }
    return found;
  })();
  const beat = beatAt(post.beats, time);
  const pose = beat?.pose ?? null;
  const poseCard = pose
    ? poseCards.find((c) =>
      c.entry?.id === pose || c.entry?.file === pose || c.key === pose
      || (c.ref.split('/').pop() ?? c.ref) === pose) ?? null
    : null;

  /*
   * Шов петлі. Демо крутиться по колу, і на рестарті вміст зникав одним
   * кадром — «пропав за 0.1 с, і наступний з'явився негарно». Тепер
   * останні та перші 0.3 с циклу кадр накриває пелена кольору тла:
   * вміст плавно розчиняється, кадр мить стоїть чистим і так само
   * плавно проявляється наново. Фон і сітка при цьому не блимають.
   */
  const SEAM_S = 0.3;
  const seamCover = 1 - Math.max(0, Math.min(time / SEAM_S, (demo.duration - time) / SEAM_S, 1));

  return (
    <div
      className="post-ws__frame post-mini__frame"
      style={{
        containerType: 'inline-size',
        background: preset.backdrop.background,
        ['--grid-color' as string]: preset.backdrop.gridColor,
        ['--grid-step' as string]: `${(preset.backdrop.gridStep / CANVAS.w) * 100}cqw`,
        ['--grid-width' as string]: `${preset.backdrop.gridWidth}px`,
      }}
    >
      <div
        className="post-ws__floor-wrap"
        style={{
          height: `${FLOOR_H * 100}%`,
          ['--floor-line' as string]: preset.backdrop.gridColor,
        }}
      >
        <FloorGrid />
      </div>

      {card ? (
        <CardLayer
          key={`${card.card.id}-${card.start.toFixed(3)}`}
          src={rawUrl(projectId, card.card.file)}
          hold={card.card.hold}
          start={card.start}
          time={time}
          top={preset.stickers.top}
          words={post.words}
          sticker={card.card.sticker ?? null}
          stickerUrl={card.card.sticker
            ? rawUrl(projectId, card.card.sticker.file)
            : null}
        />
      ) : null}

      {!card && live.length > 1 ? (
        <StickerLinksLayer
          spans={live}
          time={time}
          zoneTop={preset.stickers.top}
          zoneBottom={stickerBase}
        />
      ) : null}

      {(card ? [] : live).map((s) => {
        const file = s.sticker.file
          ? stickerByPath.get(s.sticker.file.replace(/\\/g, '/')) ?? null
          : null;
        // Демо словника завжди несуть file+sprite самі — реєстрового
        // фолбека (як у головному кадрі) тут нема свідомо.
        const sprite = s.sticker.sprite;
        const drift = stickerDrift(stickers.indexOf(s.sticker));
        const entry = stickerEnter(s.sticker.enter, time - s.start);
        const badges = liveBadges(s.sticker.badges, post.words, time);
        const outP = Math.min(
          Math.max((time - (s.end - STICKER_EXIT_LEAD_S)) / STICKER_EXIT_LEAD_S, 0),
          1,
        );
        // Той самий вихід, що в головному кадрі: мінікадр — це той самий
        // рендер, і різні числа тут означали б брехливе демо.
        const fx = stickerExit(s.sticker.exit, outP);
        const room = (s.sticker.badges?.length ?? 0) > 0 ? BADGE_ROOM : 0;
        const box = Math.min(
          s.width * CANVAS.w / CANVAS.h,
          stickerBase - preset.stickers.top - room,
        );
        return (
          <div
            key={`${s.sticker.id}-${s.start.toFixed(3)}`}
            className={`post-ws__sticker${
              time > s.end - STICKER_EXIT_LEAD_S ? ' is-out' : ''
            }${s.sticker.still ? ' is-still' : ''}`}
            style={{
              top: `${(stickerBase - box) * 100}%`,
              height: `${box * 100}%`,
              left: `${s.left * 100}%`,
              width: `${s.width * 100}%`,
              ['--enter-x' as string]: `${(entry.x + fx.x) * 100}%`,
              ['--enter-y' as string]: `${(entry.y + fx.y) * 100}%`,
              ['--enter-scale' as string]: `${entry.scale * fx.scaleMul}`,
              opacity: entry.opacity * fx.opacity,
              ['--fx-rot' as string]: `${(entry.rot ?? 0) + fx.rot}deg`,
              ['--fx-ry' as string]: `${(entry.ry ?? 0) + fx.ry}deg`,
              ['--fx-sx' as string]: `${(entry.sx ?? 1) * fx.sx}`,
              ['--fx-sy' as string]: `${(entry.sy ?? 1) * fx.sy}`,
              ['--fx-blur' as string]: `${Math.max(entry.blur ?? 0, fx.blur)}px`,
              ['--sticker-tilt' as string]: drift.tilt,
              ['--drift-dur' as string]: drift.dur,
              ['--drift-delay' as string]: drift.delay,
              ['--drift-dir' as string]: drift.dir,
              ['--punch' as string]: `${punch}`,
              ['--out' as string]: `${outP}`,
            }}
          >
            {s.sticker.ornament ? (
              <StickerOrnamentLayer
                ornament={s.sticker.ornament}
                age={time - s.start}
                time={time}
                seed={stickers.indexOf(s.sticker)}
              />
            ) : null}
            <div className="post-ws__sticker-in">
              <span className="post-ws__sticker-breathe">
                {file && sprite ? (
                  <SpriteSticker
                    src={`${rawUrl(projectId, file.name)}?v=${file.mtime}`}
                    sprite={sprite}
                    age={(time - s.start) / (post.speed ?? 1)}
                  />
                ) : file ? (
                  <img src={`${rawUrl(projectId, file.name)}?v=${file.mtime}`} alt="" />
                ) : (
                  <span className="post-ws__sticker-gap">{s.sticker.id}</span>
                )}
              </span>
            </div>
            {badges.map(({ badge, age, rank, rankSmooth }) => {
              const b = badgePop(age);
              const spot = badgeSpot(rankSmooth, s.left, s.width);
              return (
                <span
                  key={`${badge.at}-${badge.text}`}
                  className={`post-ws__badge${badge.tone ? ` is-${badge.tone}` : ''}`}
                  style={{
                    bottom: `${spot.bottom}%`,
                    left: `${((spot.centre - s.left) / s.width) * 100}%`,
                    opacity: b.opacity * badgeRankFade(rank),
                    transform: `translate(-50%, ${b.lift * 100}%) rotate(${b.rot}deg) scale(${b.scale})`,
                  }}
                >
                  {badge.text}
                </span>
              );
            })}
          </div>
        );
      })}

      {(card ? [] : live).map((s) => {
        if (!s.sticker.label) return null;
        const age = time - s.start;
        const side = s.sticker.enter === 'from-right' || s.sticker.enter === 'from-left';
        const l = side ? { opacity: 1, scale: 1, lift: 0 } : labelPop(age);
        const ride = side ? stickerEnter(s.sticker.enter, age).x : 0;
        return (
          <div
            key={`label-${s.sticker.id}-${s.start.toFixed(3)}`}
            className={`post-ws__sticker-label${
              s.sticker.labelTone === 'warn' ? ' is-warn' : ''
            }`}
            style={{
              left: `${(s.left + s.width / 2) * 100}%`,
              top: `${stickerBase * 100}%`,
              opacity: l.opacity,
              transform: `translate(-50%, ${l.lift * 100}%) translateX(${ride * 100}%) scale(${l.scale})`,
            }}
          >
            {s.sticker.label}
          </div>
        );
      })}

      {full && poseCard && time >= 0.01 ? <HostLayer key="host" src={poseCard.src} /> : null}
      <div className="post-ws__floor-glow" aria-hidden />

      {full && chunk ? (
        <div className="post-ws__caption">
          <span className="post-ws__caption-line">
            {chunk.map((w, i) => {
              const said = w.start <= time;
              const bare = cleanCaption(w.word);
              const text = preset.captions.uppercase ? bare.toUpperCase() : bare;
              return (
                <span
                  key={`${w.start}-${i}`}
                  className={`post-ws__caption-word${said ? ' is-said' : ''}${w.accent ? ' is-accent' : ''}`}
                  style={{ ['--glow' as string]: `${wordGlow(time, w)}` }}
                >
                  <span className="post-ws__caption-ink">{text}</span>
                </span>
              );
            })}
          </span>
        </div>
      ) : null}

      {seamCover > 0 ? (
        <div
          className="post-mini__seam"
          aria-hidden
          style={{ opacity: seamCover, background: preset.backdrop.background }}
        />
      ) : null}
    </div>
  );
}

/**
 * Каталог подарунків Telegram — сторінка поверх студії.
 *
 * Два види в окремих вкладках, бо це різні сутності для сценарію:
 * подарунок за зірки — витрата, колекційний — актив. Прев'ю статичні
 * (сітка з 165 анімацій задушила б браузер); анімація приїжджає в
 * ролик разом зі спрайтом, коли натиснути «Взяти».
 */
function GiftGallery({ items, projectId, takeState, onTake, onNote, onClose }: {
  items: GiftItem[];
  projectId: string;
  takeState: { slug: string; state: 'running' | 'done' | 'error'; error?: string } | null;
  onTake: (g: GiftItem, variant?: string) => Promise<void> | void;
  onNote: (text: string) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'nft' | 'star' | 'backdrops'>('nft');
  const [q, setQ] = useState('');
  // Відкритий подарунок — підменю з його NFT-моделями (свій emoji-набір
  // на кожен подарунок; власник заповнює їх поступово).
  const [openGift, setOpenGift] = useState<GiftItem | null>(null);
  // Шукаємо і за призначенням теж: «Хеллоуїн», «гроші», «зима» —
  // так каталог відповідає на питання «що взяти під цю фразу».
  const needle = q.trim().toLowerCase();
  const shown = items.filter((g) => g.kind === kind
    && (needle === ''
      || (g.title ?? '').toLowerCase().includes(needle)
      || (g.use ?? '').toLowerCase().includes(needle)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Спершу закривається підменю моделей, потім сама галерея.
      setOpenGift((prev) => {
        if (prev != null) return null;
        onClose();
        return prev;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="post-gallery">
      <div className="post-gallery__bar">
        <span className="post-gallery__title">Подарунки</span>
        <div className="post-gallery__groups">
          <button
            type="button"
            className={`post-gallery__group${kind === 'nft' ? ' is-on' : ''}`}
            onClick={() => setKind('nft')}
          >
            Колекційні (NFT) <span>{items.filter((g) => g.kind === 'nft').length}</span>
          </button>
          <button
            type="button"
            className={`post-gallery__group${kind === 'star' ? ' is-on' : ''}`}
            onClick={() => setKind('star')}
          >
            За зірки <span>{items.filter((g) => g.kind === 'star').length}</span>
          </button>
          <button
            type="button"
            className={`post-gallery__group${kind === 'backdrops' ? ' is-on' : ''}`}
            onClick={() => setKind('backdrops')}
          >
            Фони NFT
          </button>
        </div>
        <input
          className="post-gifts__search"
          placeholder="пошук за назвою…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="post-ws__spacer" />
        <button type="button" className="btn" onClick={onClose}>Закрити</button>
      </div>

      <div className="post-ws__hint post-gifts__note">
        {kind === 'nft'
          ? 'Колекційні: подарунок після апгрейду — унікальний, назад у зірки не повертається. Довідник для сценаріїв — references/gifts-nft.md.'
          : kind === 'star'
            ? 'Подарунки з магазину за зірки: тираж обмежений, можна конвертувати назад у зірки.'
            : 'Фони і символи справжніх колекційних подарунків (кольори зняті зі сторінок t.me/nft). Картка кладеться в ролик блоком, подарунок ставиться в неї окремим стікером — і лишається анімованим.'}
      </div>

      {kind === 'backdrops' ? (
        <NftBackdrops projectId={projectId} onNote={onNote} />
      ) : null}

      <div className="post-gifts__grid" hidden={kind === 'backdrops'}>
        {shown.map((g) => {
          const busy = takeState?.slug === g.slug && takeState.state === 'running';
          const done = takeState?.slug === g.slug && takeState.state === 'done';
          const failed = takeState?.slug === g.slug && takeState.state === 'error';
          return (
            <div key={g.slug} className="post-gifts__cell" title={g.use ?? ''}>
              {/* Клік по картинці — підменю з NFT-моделями подарунка. */}
              <button
                type="button"
                className="post-gifts__open"
                title="Відкрити моделі цього подарунка"
                onClick={() => setOpenGift(g)}
              >
                <img src={`/api/gifts/preview/${g.slug}`} alt="" loading="lazy" />
              </button>
              <div className="post-gifts__name">
                {g.title || `${g.emoji ?? ''} ${g.slug}`}
              </div>
              {/* Призначення — те, за чим агент обирає предмет під фразу;
                  у сітці воно важливіше за саму назву. */}
              <div className="post-gifts__use">{g.use ?? ''}</div>
              <button
                type="button"
                className="post-block__pick"
                disabled={busy}
                title={failed ? takeState?.error : 'Покласти в набір ролика анімованим спрайтом'}
                onClick={() => void onTake(g)}
              >
                {busy ? 'Беру…' : done ? 'У наборі ✓' : failed ? 'Не вийшло' : 'Взяти в ролик'}
              </button>
            </div>
          );
        })}
        {shown.length === 0 ? (
          <div className="post-ws__hint">Нічого не знайшлось.</div>
        ) : null}
      </div>

      {openGift ? (
        <GiftVariants
          gift={openGift}
          takeState={takeState}
          onTake={(variant) => void onTake(openGift, variant)}
          onClose={() => setOpenGift(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Фони NFT — третя вкладка каталогу.
 *
 * Квадратна картка колекційного подарунка складається з трьох речей:
 * радіальний градієнт (фон), зафарбований символ-патерн і стрічка з
 * номером. Кольори зняті з публічних сторінок t.me/nft, тож картка в
 * ролику виглядає як справжня, а не «схожа».
 *
 * Сам подарунок у картку НЕ запікається: він лишається окремим
 * анімованим стікером поверх блока — інакше довелось би вибирати між
 * правильним фоном і живою анімацією.
 */
/** Затемнити hex-колір: overlay ціни/значка у клієнті = edge × 0.9. */
function dimHex(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return hex;
  const ch = (v: number): string => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

/** Освітлити hex-колір: змішати з білим на частку k. */
function lightHex(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return hex;
  const ch = (v: number): string => Math.round(v + (255 - v) * k).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

function NftBackdrops({ projectId, onNote }: { projectId: string; onNote: (t: string) => void }) {
  interface Backdrop {
    name: string; center: string; edge: string;
    symbolColor?: string; textColor?: string; rarity?: number | null;
  }
  interface Symbol0 { name: string; file: string; rarity?: number | null }
  const [backdrops, setBackdrops] = useState<Backdrop[]>([]);
  const [symbols, setSymbols] = useState<Symbol0[]>([]);
  const [pick, setPick] = useState<{ backdrop?: string; symbol?: string }>({});
  const [number, setNumber] = useState('318139');
  const [price, setPrice] = useState('623');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const [b, s] = await Promise.all([
          fetch('/api/gifts/nft/backdrops', { cache: 'no-store' }).then((r) => r.json() as Promise<{ items?: Backdrop[] }>),
          fetch('/api/gifts/nft/symbols', { cache: 'no-store' }).then((r) => r.json() as Promise<{ items?: Symbol0[] }>),
        ]);
        if (off) return;
        setBackdrops(b.items ?? []);
        setSymbols(s.items ?? []);
      } catch {
        // каталогу ще нема — порожній стан пояснить, що робити
      }
    })();
    return () => { off = true; };
  }, []);

  const make = async (): Promise<void> => {
    if (!pick.backdrop) return;
    setBusy(true);
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/nft-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backdrop: pick.backdrop, symbol: pick.symbol ?? '',
          number, price,
        }),
      });
      const data = await resp.json().catch(() => null) as { error?: string; file?: string } | null;
      if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
      onNote(`картка ${data?.file} готова — постав її блоком і поклади подарунок зверху`);
    } catch (err) {
      onNote(`картка не вийшла: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const chosen = backdrops.find((b) => b.name === pick.backdrop);
  const chosenSym = symbols.find((s) => s.name === pick.symbol);

  return (
    <div className="post-nft">
      <div className="post-nft__side">
        <div className="post-block__kind-hint">Фони · {backdrops.length}</div>
        <div className="post-nft__list">
          {backdrops.map((b) => (
            <button
              key={b.name}
              type="button"
              className={`post-nft__chip${pick.backdrop === b.name ? ' is-on' : ''}`}
              style={{ background: `radial-gradient(circle at 50% 42%, ${b.center}, ${b.edge})` }}
              title={`${b.name}${b.rarity ? ` · ${b.rarity}%` : ''}`}
              onClick={() => setPick((p) => ({ ...p, backdrop: b.name }))}
            >
              <span>{b.name}</span>
            </button>
          ))}
          {backdrops.length === 0 ? (
            <div className="post-ws__hint">
              Каталог порожній. Збери його скриптом плагіна
              <code> nft_backdrops.py</code> — він знімає фони й символи
              зі сторінок t.me/nft.
            </div>
          ) : null}
        </div>

        <div className="post-block__kind-hint">Символи · {symbols.length}</div>
        <div className="post-nft__syms">
          <button
            type="button"
            className={`post-nft__sym${!pick.symbol ? ' is-on' : ''}`}
            title="без символів"
            onClick={() => setPick((p) => ({ ...p, symbol: undefined }))}
          >—</button>
          {symbols.map((s) => (
            <button
              key={s.name}
              type="button"
              className={`post-nft__sym${pick.symbol === s.name ? ' is-on' : ''}`}
              title={`${s.name}${s.rarity ? ` · ${s.rarity}%` : ''}`}
              onClick={() => setPick((p) => ({ ...p, symbol: s.name }))}
            >
              <img src={`/api/gifts/nft/symbols/${s.file.split('/').pop()}`} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      </div>

      <div className="post-nft__preview">
        {/* Прев'ю тим самим рецептом, що й блок: градієнт + маска
            символу + стрічка. Побачив тут — те саме буде в кадрі. */}
        {/* Прев'ю — той самий рецепт, що й блок ролика: градієнт і
            розкладка символів із веб-SVG t.me/nft; бейдж-стрічка,
            зірка Stars і діамант — із клієнта Telegram Web (path 1:1).
            Клітинка 264 px ≈ ×2.06 від клітинки клієнта 128. */}
        {/* Прев'ю — точно за мобільним клієнтом Telegram (GiftSheet.GiftCell
            + StarGiftPatterns TYPE_GIFT + RibbonDrawable), 1 dp = 2 px.
            Ті самі константи (post-spec.ts) кладе в блок демон. */}
        {(() => {
          const DP = 2;
          const RIB = 1.22; // ×довжина стрічки понад клієнтські 48 dp
          const W = 128 * DP, H = 160 * DP;
          const cx = W / 2, cy = Math.min(50 * DP, H / 2); // центр градієнта (CardBackground)
          const gradR = ((Math.min(W, H) + (Math.max(W, H) - Math.min(W, H)) * 0.35) / 2);
          const symUrl = chosenSym ? `/api/gifts/nft/symbols/${chosenSym.file.split('/').pop()}` : null;
          const ribC = chosen ? tgAdaptHsv(chosen.center, TG_RIBBON_HSV_SAT, TG_RIBBON_HSV_VAL) : '#888';
          const ribE = chosen ? tgAdaptHsv(chosen.edge, TG_RIBBON_HSV_SAT, TG_RIBBON_HSV_VAL) : '#666';
          return (
            <div className="post-nft__wrap" style={{ width: W, height: H }}>
              <div
                className="post-nft__card"
                style={{
                  borderRadius: TG_CARD_RADIUS_DP * DP,
                  background: chosen
                    ? `radial-gradient(${gradR}px circle at ${cx}px ${cy}px, ${chosen.center} 0%, ${chosen.edge} 100%)`
                    : 'var(--bg-panel)',
                }}
              >
                {symUrl ? TG_PATTERN_GIFT.map((p, i) => (
                  <div
                    key={i}
                    className="post-nft__glyph"
                    style={{
                      left: cx + p.x * DP - (p.size * DP) / 2,
                      top: cy + p.y * DP - (p.size * DP) / 2 + 12 * DP,
                      width: p.size * DP,
                      height: p.size * DP,
                      opacity: p.alpha,
                      backgroundColor: chosen?.symbolColor ?? '#000',
                      WebkitMaskImage: `url(${symUrl})`,
                      maskImage: `url(${symUrl})`,
                    }}
                  />
                )) : null}
                <div className="post-nft__slot" style={{ left: (W - 80 * DP) / 2, top: 12 * DP, width: 80 * DP, height: 80 * DP }}>
                  подарунок<br />ставиться<br />стікером
                </div>
                {/* Ціна (GiftCell, unique): StarsBackground 0x40FFFFFF —
                    білий 25 % поверх фону, кути 13 dp, 12 dp bold, білий
                    текст, від низу 11 dp, padding 10 dp. */}
                <div className="post-nft__price" style={{ height: 26 * DP, padding: `0 ${10 * DP}px`, fontSize: 12 * DP, bottom: 11 * DP, borderRadius: 13 * DP, background: 'rgba(255,255,255,.25)' }}>
                  <svg viewBox="0 0 24 24" style={{ width: 12 * DP, height: 12 * DP }}><path d={TG_ICON_STAR_D} /></svg>{price || '—'}
                </div>
              </div>
              {/* Стрічка: контур 48×48 dp у правому верхньому куті
                  (marginTop 2, marginRight 1), градієнт center→edge через
                  adaptHSV, текст 10 dp bold під 45°. */}
              {/* Форма стрічки — їхній path без змін; лише масштаб ×RIB, щоб
                  довжина була більша і підвороти вийшли за край картки.
                  Зсув компенсує приріст, тож середина стрічки лишається
                  на діагоналі кута. */}
              <svg
                className="post-nft__ribbon-svg"
                width={TG_RIBBON_SIZE_DP * DP * RIB}
                height={TG_RIBBON_SIZE_DP * DP * RIB}
                viewBox={`0 0 ${TG_RIBBON_SIZE_DP} ${TG_RIBBON_SIZE_DP}`}
                style={{
                  position: 'absolute',
                  top: (2 - TG_RIBBON_SIZE_DP * (RIB - 1) / 2) * DP,
                  right: (1 - TG_RIBBON_SIZE_DP * (RIB - 1) / 2) * DP,
                  zIndex: 3, overflow: 'visible',
                }}
              >
                <defs>
                  <linearGradient id="postNftRibbonGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor={ribC} />
                    <stop offset="1" stopColor={ribE} />
                  </linearGradient>
                </defs>
                <path d={TG_RIBBON_PATH_D} fill="url(#postNftRibbonGrad)" strokeLinejoin="round" />
                {/* Центр тексту — на осі смуги: у клієнті поворот навколо
                    (30, 18) і малювання на y=19; для симетрії зверху/знизу
                    садимо базову лінію рівно в центр смуги. */}
                <text
                  x={24 + 6}
                  y={24 - 3.5}
                  fill="#fff"
                  fontSize={TG_RIBBON_TEXT_DP}
                  fontWeight={700}
                  fontFamily="Roboto, Arial, sans-serif"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(45 ${24 + 6} ${24 - 6})`}
                  textLength={number.length > 5 ? TG_RIBBON_TEXT_MAX_W_DP : undefined}
                  lengthAdjust="spacingAndGlyphs"
                >
                  #{number || '—'}
                </text>
              </svg>
            </div>
          );
        })()}

        <div className="post-nft__form">
          <label>
            Номер
            <input value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label>
            Ціна ⭐
            <input value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} />
          </label>
          <button
            type="button"
            className="post-block__pick"
            disabled={busy || !pick.backdrop}
            onClick={() => void make()}
          >
            {busy ? 'Роблю…' : 'Зробити блок для ролика'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Моделі (NFT-варіанти) одного подарунка — другий рівень каталогу.
 *
 * У кожного подарунка свій emoji-набір із варіантами; власник заповнює
 * їх поступово: вставив назву/лінк t.me/addemoji — демон скачає набір,
 * розпакує і намалює прев'ю. Порожній стан прямо каже, що зробити.
 */
function GiftVariants({ gift, takeState, onTake, onClose }: {
  gift: GiftItem;
  takeState: { slug: string; state: 'running' | 'done' | 'error'; error?: string } | null;
  onTake: (variant: string) => void;
  onClose: () => void;
}) {
  interface VariantItem { slug: string; emoji?: string; title?: string }
  const [doc, setDoc] = useState<{ setTitle?: string; items: VariantItem[] } | null>(null);
  const [setName, setSetName] = useState('');
  const [ingest, setIngest] = useState<'idle' | 'running' | 'error'>('idle');
  const [ingestErr, setIngestErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch(`/api/gifts/${gift.slug}/variants`, { cache: 'no-store' });
      if (!resp.ok) return;
      const d = await resp.json() as { setTitle?: string; items?: VariantItem[] };
      setDoc({ setTitle: d.setTitle, items: d.items ?? [] });
    } catch {
      // демон недоступний — порожній стан скаже, що робити
    }
  }, [gift.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const startIngest = async (): Promise<void> => {
    if (!setName.trim()) return;
    setIngest('running');
    setIngestErr(null);
    try {
      const resp = await fetch(`/api/gifts/${gift.slug}/variants/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set: setName }),
      });
      const data = await resp.json().catch(() => null) as { error?: string } | null;
      if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
      // Набір на сотню емодзі качається кілька хвилин — чекаємо спокійно.
      for (let i = 0; i < 600; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await fetch(`/api/gifts/${gift.slug}/variants/ingest`, { cache: 'no-store' })
          .then((r) => r.json() as Promise<{ state: string; error?: string }>)
          .catch(() => null);
        if (!st || st.state === 'running') continue;
        if (st.state === 'error') throw new Error(st.error ?? 'скрипт впав');
        break;
      }
      setIngest('idle');
      setSetName('');
      await load();
    } catch (err) {
      setIngest('error');
      setIngestErr(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="post-gallery post-gifts__variants">
      <div className="post-gallery__bar">
        <button type="button" className="btn" onClick={onClose}>‹ Каталог</button>
        <span className="post-gallery__title">
          {gift.title || gift.slug} — моделі
        </span>
        {doc?.setTitle ? (
          <span className="post-motions__hint">{doc.setTitle}</span>
        ) : null}
        <span className="post-ws__spacer" />
        <input
          className="post-gifts__search"
          placeholder="t.me/addemoji/… або назва набору"
          value={setName}
          onChange={(e) => setSetName(e.target.value)}
          disabled={ingest === 'running'}
        />
        <button
          type="button"
          className="btn"
          disabled={ingest === 'running' || !setName.trim()}
          onClick={() => void startIngest()}
        >
          {ingest === 'running' ? 'Качаю…' : 'Завантажити набір'}
        </button>
      </div>

      {ingest === 'error' ? (
        <div className="post-ws__hint post-gifts__note">⚠ {ingestErr}</div>
      ) : null}

      <div className="post-gifts__grid">
        {(doc?.items ?? []).map((v) => {
          const key = `${gift.slug}:${v.slug}`;
          const busy = takeState?.slug === key && takeState.state === 'running';
          const done = takeState?.slug === key && takeState.state === 'done';
          const failed = takeState?.slug === key && takeState.state === 'error';
          return (
            <div key={v.slug} className="post-gifts__cell">
              <img src={`/api/gifts/${gift.slug}/variants/preview/${v.slug}`} alt="" loading="lazy" />
              <div className="post-gifts__name">{v.title || `${v.emoji ?? ''} ${v.slug}`}</div>
              <button
                type="button"
                className="post-block__pick"
                disabled={busy}
                title={failed ? takeState?.error : 'Покласти модель у набір ролика спрайтом'}
                onClick={() => onTake(v.slug)}
              >
                {busy ? 'Беру…' : done ? 'У наборі ✓' : failed ? 'Не вийшло' : 'Взяти в ролик'}
              </button>
            </div>
          );
        })}
        {doc != null && doc.items.length === 0 ? (
          <div className="post-ws__hint post-gifts__note">
            Моделей цього подарунка ще нема. Знайди його emoji-набір
            (наприклад, t.me/addemoji/PlushPepeGifts_by_EmojiRu_Bot),
            встав лінк угорі і натисни «Завантажити набір».
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Сторінка-галерея: рухи по групах.
 *
 * Блок сітки — квадратна СЦЕНА руху (без ведучого й субтитрів: вони
 * однакові в усіх і лише розмивають різницю). Клік — модал поверх
 * сторінки з повним кадром і діями: правити в чаті, видалити.
 *
 * Час один на всю галерею: єдиний rAF веде спільний лічильник, а кожен
 * мінікадр бере від нього залишок за модулем своєї тривалості.
 */
function MotionGallery({ entries, projectId, poseCards, stickerByPath, onEdit, onNew, onDelete, onClose }: {
  entries: MotionEntry[];
  projectId: string;
  poseCards: PoseCard[];
  stickerByPath: Map<string, PostFile>;
  onEdit: (m: MotionEntry) => void;
  onNew: () => void;
  onDelete: (id: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [group, setGroup] = useState<'all' | MotionGroup>('all');
  const [t, setT] = useState(0.02);
  const [openId, setOpenId] = useState<string | null>(null);
  // Видалення — у два кліки на місці, без діалогу: перший показує «точно?»,
  // другий видаляє. Скидається закриттям модалу.
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let cur = 0.02;
    let acc = 0;
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      cur += dt;
      acc += dt;
      // Повні кадри всюди: 30 fps для сітки здавались економією, але
      // безперервні рухи (орбіта смайлів, вльоти) на них читаються
      // «лагуче» — власник це побачив одразу. Плитки дрібні, React їх
      // тягне; якщо сітка колись просяде — дросель повертати сюди.
      if (acc >= 0) {
        setT(cur);
        acc = 0;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Спершу закривається модал, потім сторінка — як і очікуєш від Esc.
      setOpenId((prev) => {
        if (prev != null) return null;
        onClose();
        return prev;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = entries.filter((m) => group === 'all' || m.group === group);
  // Відкритий рух шукається щоразу з entries: поллер міняє словник під
  // час правки з чату, і модал має показувати свіжу версію, а не зліпок.
  const open = openId != null ? entries.find((m) => m.id === openId) ?? null : null;

  return (
    <div className="post-gallery" role="dialog" aria-label="Галерея рухів">
      <div className="post-gallery__bar">
        <span className="post-gallery__title">Анімації</span>
        <div className="post-gallery__groups">
          <button
            type="button"
            className={`post-gallery__group${group === 'all' ? ' is-on' : ''}`}
            onClick={() => setGroup('all')}
          >
            Всі
          </button>
          {MOTION_GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              className={`post-gallery__group${group === g.key ? ' is-on' : ''}`}
              onClick={() => setGroup(g.key)}
            >
              {g.label}
              <i>{entries.filter((m) => m.group === g.key).length}</i>
            </button>
          ))}
        </div>
        <span className="post-ws__spacer" />
        <button type="button" className="btn" onClick={onClose}>Закрити</button>
      </div>

      <div className="post-gallery__grid">
        {shown.map((m) => {
          // Рух без предметів і карток (пауза) у вікні-сцені показував
          // би голе тло: його суть — ведучий і субтитр, а вони живуть у
          // нижній частині кадру, за межами квадратного вікна. Такому
          // руху сцена показує ПОВНИЙ кадр, вписаний у квадрат.
          const bare = m.demo != null
            && !(m.demo.stickers?.length ?? 0)
            && !(m.demo.cards?.length ?? 0);
          return (
            <button
              key={m.id}
              type="button"
              className="post-gcard"
              onClick={() => {
                setOpenId(m.id);
                setArmed(false);
              }}
            >
              <span className={`post-gcard__scene${bare ? ' is-full' : ''}`}>
                {m.demo ? (
                  <MotionMiniFrame
                    demo={m.demo}
                    time={t % m.demo.duration}
                    projectId={projectId}
                    poseCards={poseCards}
                    stickerByPath={stickerByPath}
                    full={bare}
                  />
                ) : (
                  <span className="post-gcard__none">без прев'ю</span>
                )}
              </span>
              <span className="post-gcard__name">{m.title}</span>
            </button>
          );
        })}

        {/* Блок «+» — замовлення нового руху через чат. */}
        <button type="button" className="post-gcard post-gcard--plus" onClick={onNew}>
          <span className="post-gcard__plus" aria-hidden>+</span>
          <span className="post-gcard__name">Нова анімація</span>
          <span className="post-gcard__pick">опиши в чаті — зберу демо</span>
        </button>
      </div>

      {open ? (
        <div className="post-gmodal" role="dialog" aria-label={open.title}>
          <div
            className="post-gmodal__scrim"
            aria-hidden
            onClick={() => setOpenId(null)}
          />
          <div className="post-gmodal__body">
            <div className="post-gmodal__frame">
              {open.demo ? (
                <MotionMiniFrame
                  demo={open.demo}
                  time={t % open.demo.duration}
                  projectId={projectId}
                  poseCards={poseCards}
                  stickerByPath={stickerByPath}
                  full
                />
              ) : (
                <div className="post-ws__frame post-mini__frame post-gcard__none">
                  <span>без прев'ю — дивись у ролику</span>
                </div>
              )}
            </div>
            <div className="post-gmodal__side">
              <div className="post-gmodal__title">{open.title}</div>
              {open.pick ? <div className="post-gcard__pick">{open.pick}</div> : null}
              <div className="post-motion__detail">
                {open.enter ? <div><b>Вхід.</b> {open.enter}</div> : null}
                {open.inside ? <div><b>У кадрі.</b> {open.inside}</div> : null}
                {open.exit ? <div><b>Вихід.</b> {open.exit}</div> : null}
                {open.axes?.length ? <div><b>Осі:</b> {open.axes.join(' · ')}</div> : null}
                {open.fixed?.length ? <div><b>Не чіпати:</b> {open.fixed.join(' · ')}</div> : null}
                {open.avoid ? <div><b>Не брати, коли:</b> {open.avoid}</div> : null}
                {open.from?.length ? (
                  <div><b>Живі приклади:</b> {open.from.join(' · ')}</div>
                ) : null}
              </div>
              <div className="post-gmodal__actions">
                <button type="button" className="btn" onClick={() => onEdit(open)}>
                  Правити в чаті
                </button>
                <button
                  type="button"
                  className={`btn post-gmodal__del${armed ? ' is-armed' : ''}`}
                  onClick={() => {
                    if (!armed) {
                      setArmed(true);
                      return;
                    }
                    void onDelete(open.id);
                    setOpenId(null);
                  }}
                >
                  {armed ? 'Точно видалити?' : 'Видалити'}
                </button>
                <span className="post-ws__spacer" />
                <button type="button" className="btn" onClick={() => setOpenId(null)}>
                  Закрити
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

