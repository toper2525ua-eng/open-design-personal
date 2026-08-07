import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { uploadProjectFiles } from '../providers/registry';
import { LottieSticker } from './LottieSticker';
import {
  AUDIO_RE,
  accentPunch,
  CANVAS,
  cardAt,
  cardRevealCount,
  DEFAULT_PRESET,
  emptyPost,
  PRESETS,
  labelPop,
  liveBadges,
  badgePop,
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
  stickerLayout,
  stickerSpans,
  wordGlow,
  type Beat,
  type PostSpec,
  type WordTiming,
} from './post-spec';
import './post-studio.css';

/*
 * Dev: правка цього модуля або його стилів перезавантажує сторінку цілком.
 *
 * Часткове оновлення тут регулярно ГУБИТЬ post-studio.css. Файл
 * імпортують два модулі (цей і ReelsView), і коли Next підмінює один із
 * них, стильовий чанк назад не додається. Наслідок ні з чим не сплутаєш:
 * кадр розтягується на всю ширину, підлога стає велетенською сіткою, бар
 * злипається в один рядок. Виглядає як зламана верстка, хоч верстка ціла.
 *
 * Лікується це тільки повним перезавантаженням, тож просимо про нього
 * одразу: decline() каже webpack не намагатись оновити модуль частково.
 * Перезавантаження на кожну правку тут дешевше за здогадку «я щойно
 * зламав CSS» — і рівно те саме, що робилось руками через Ctrl+R.
 *
 * У продакшн-збірці webpackHot немає взагалі, тож код лишається в dev.
 */
(import.meta as unknown as { webpackHot?: { decline: () => void } }).webpackHot?.decline();

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

function libraryRawUrl(assetId: string): string {
  return `/api/library/assets/${encodeURIComponent(assetId)}/raw`;
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

/**
 * Картка в кадрі. Розмітку пише АГЕНТ у `assets/blocks/<id>.html`,
 * студія її лише вставляє, масштабує під кадр і відкриває рядки під мову.
 *
 * Агент малює під полотно 1080 px завширшки — у тих самих пікселях, що й
 * решта формату. Превʼю вужче, тому вміст стискається одним множником;
 * рахуємо його з реальної ширини, бо поділити довжину на довжину в CSS
 * не можна, а гадати про розмір превʼю не варто — воно ще й гумове.
 */
function CardLayer({ src, hold, start, time, top }: {
  src: string; hold: number; start: number; time: number; top: number;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [k, setK] = useState(1);
  const wrap = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(src, { cache: 'no-store' });
        if (r.ok && !cancelled) setHtml(await r.text());
      } catch {
        // файлу немає — кадр просто лишиться без картки
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const measure = (): void => setK(el.clientWidth / CANVAS.w);
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
  useDomLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
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
    items.forEach((node, i) => node.classList.toggle('is-shown', i < n));
    // Стан лишається видимим у розмітці: коли картка знову поводитиметься
    // дивно, `data-shown="2/3"` відповідає на перше питання без здогадок.
    el.dataset.shown = `${n}/${items.length}`;
  }, [html, hold, start, time]);

  if (!html) return null;
  return (
    <div className="post-ws__card" ref={wrap} style={{ top: `${top * 100}%` }}>
      <div
        className="post-ws__card-in"
        ref={box}
        style={{ transform: `translateX(-50%) scale(${k})` }}
        // Розмітку пише агент у файлі проєкту — той самий рівень довіри,
        // що й решта файлів ролика. Скрипти через innerHTML не
        // виконуються, тож картка лишається саме розміткою.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
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

  const blockShell = useCallback(
    (id: string, stateClass: string) => ({
      stateClass,
      open: pinnedBlocks.has(id) || hoverBlock === id,
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
    [pinnedBlocks, hoverBlock],
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
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(rawUrl(projectId, 'assets/stickers/stickers.json'), { cache: 'no-store' });
        if (!resp.ok) return;
        const data = JSON.parse(await resp.text()) as { stickers?: RegistryEntry[] };
        const map = new Map<string, string>();
        for (const s of data.stickers ?? []) {
          const label = [s.shows, s.use].filter(Boolean).join(' · ');
          if (s.file) map.set(s.file.replace(/\\/g, '/'), label);
          map.set(s.id, label);
        }
        if (!cancelled) {
          setStickerUse(map);
          setRegistry(data.stickers ?? []);
        }
      } catch {
        // немає реєстру або битий JSON — покажемо картинки без підписів
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, stickerFiles.length]);
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
    },
    [post, projectId, save],
  );

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
  const captionChunks = useMemo(() => {
    // Рішення приймає ширина, а не кількість. «Це і є» — три слова, але
    // п'ять символів: закривати на них групу означало б лишити пів
    // рядка порожнім, а наступне слово («навчання») відкинути в новий
    // кадр. Тому стеля за словами висока, а справжня межа — довжина.
    const MAX_WORDS = 5;
    const MAX_CHARS = 20;
    const chunks: WordTiming[][] = [];
    let cur: WordTiming[] = [];
    let len = 0;
    for (const w of post?.words ?? []) {
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
  }, [post?.words]);

  if (!post) {
    return (
      <div className="post-ws">
        <div className="post-ws__bar"><span className="post-ws__meta">Читаю {POST_FILE}…</span></div>
      </div>
    );
  }

  const stage = postStage(post);
  const preset = PRESETS[post.preset] ?? PRESETS[DEFAULT_PRESET];
  const duration = post.audio?.duration ?? 0;
  const activeWordIndex = wordIndexAt(post.words, time);
  const activeWord = activeWordIndex < 0 ? null : post.words[activeWordIndex]!;

  // Активна група — остання, що вже почалась. Шукаємо за часом, а не за
  // індексом слова: у групи не потрапляють слова з самої пунктуації
  // (окреме тире), тому нумерація в post.words і всередині груп давно
  // розійшлася. Через це на кожному тире кадр порожнів — індекс вказував
  // у нікуди, хоча фраза тривала.
  const activeChunk = (() => {
    if (post.words.length === 0 || captionChunks.length === 0) return null;
    let found: WordTiming[] | null = null;
    for (const chunk of captionChunks) {
      if (chunk[0]!.start <= time) found = chunk;
      else break;
    }
    if (!found) return null;
    // Довга тиша після останнього слова групи звільняє кадр — але тільки
    // якщо попереду ще щось є. Фінальну групу тримаємо до кінця доріжки.
    const last = found[found.length - 1]!;
    const isFinal = found === captionChunks[captionChunks.length - 1];
    if (!isFinal && time > last.end + CAPTION_HOLD_S) {
      const nextIdx = captionChunks.indexOf(found) + 1;
      const next = captionChunks[nextIdx];
      if (next && time < next[0]!.start - CAPTION_HOLD_S) return null;
    }
    return found;
  })();
  const activeBeat = beatAt(post.beats, time);
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
  const wanted = registry.filter((r) => r.status === 'needed');
  // Екран не плаває: вікно, термінал і список — це інтерфейс, а не
  // предмет. Плаваючий інтерфейс читається як помилка рендеру.
  const kindOf = new Map(registry.map((r) => [r.id, r.kind ?? 'object']));
  const stickers = post.stickers ?? [];
  const spans = stickerSpans(stickers, post.words);
  const liveStickers = stickerLayout(spans, time, preset.stickers.maxWidthPct);
  // Удар спільний на весь кадр: на акцентному слові смикаються ВСІ живі
  // стікери разом. Один смикається — це збіг, усі разом — це такт.
  const framePunch = accentPunch(time, post.words);
  // Спільна лінія низу зони стікерів: рахується з максимальної
  // ширини, тому не залежить від того, скільки предметів у кадрі.
  const stickerBase = preset.stickers.top
    + preset.stickers.maxWidthPct * (CANVAS.w / CANVAS.h);
  const cards = post.cards ?? [];
  const activeCard = cardAt(cards, post.words, time);
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

      <div className="post-ws__body">
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
            {activeCard ? (
              <CardLayer
                key={`${activeCard.card.id}-${activeCard.start.toFixed(3)}`}
                src={rawUrl(projectId, activeCard.card.file)}
                hold={activeCard.card.hold}
                start={activeCard.start}
                time={time}
                top={preset.stickers.top}
              />
            ) : null}

            {(activeCard ? [] : liveStickers).map((s, i) => {
              const file = s.sticker.file
                ? stickerByPath.get(s.sticker.file.replace(/\\/g, '/')) ?? null
                : null;
              const drift = stickerDrift(i);
              const entry = stickerEnter(s.sticker.enter, time - s.start);
              const badges = liveBadges(s.sticker.badges, post.words, time);
              // Вихід рахуємо часом, а не CSS-переходом: перехід згладив
              // би удар, який приходить у ті самі 0.15 с, і замість
              // смикання вийшло б розмите сповзання.
              const outP = Math.min(
                Math.max((time - (s.end - STICKER_EXIT_LEAD_S)) / STICKER_EXIT_LEAD_S, 0),
                1,
              );
              return (
                <div
                  // key від самого стікера, а не від місця: коли поруч
                  // стає наступний, попередній ЇДЕ вбік, а не зникає й
                  // зʼявляється заново. Ключ по індексу програвав би
                  // появу вдруге на кожній перекладці.
                  key={`${s.sticker.id}-${s.start.toFixed(3)}`}
                  className={`post-ws__sticker${
                    time > s.end - STICKER_EXIT_LEAD_S ? ' is-out' : ''
                  }${kindOf.get(s.sticker.id) === 'screen' ? ' is-still' : ''}`}
                  style={{
                    top: `${(stickerBase - s.width * CANVAS.w / CANVAS.h) * 100}%`,
                    left: `${s.left * 100}%`,
                    width: `${s.width * 100}%`,
                    ['--enter-x' as string]: `${entry.x * 100}%`,
                    ['--enter-scale' as string]: `${entry.scale}`,
                    opacity: entry.opacity,
                    // Кут, тривалість і фаза дрейфу — свої в кожного.
                    // Однакові числа читались як одна намальована
                    // картинка, що гойдається цілком.
                    ['--sticker-tilt' as string]: drift.tilt,
                    ['--drift-dur' as string]: drift.dur,
                    ['--drift-delay' as string]: drift.delay,
                    ['--drift-dir' as string]: drift.dir,
                    ['--punch' as string]: `${framePunch - 0.06 * outP}`,
                  }}
                >
                  {/* Салют летить ПІД картинкою і поза її коробкою: іскри
                      мають вилітати з-за предмета, а не лежати на ньому. */}
                  <div className="post-ws__sticker-in">
                    {/* Окремий шар під дихання: нахил і масштаб — два
                        різні transform, і на одному елементі другий
                        просто затер би перший. */}
                    <span className="post-ws__sticker-breathe">
                    {file && /\.json$/i.test(file.name) ? (
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
                  {/* Бейджі — стовпчиком угору, найновіший найвище. Кожен
                      наступний зсунуто вбік через один: рівний стовп
                      читається як таблиця, а не як розліт. */}
                  {badges.map(({ badge, age }, k) => {
                    const b = badgePop(age);
                    // Найстаріший унизу, новий над ним. Раніше рахувалось
                    // навпаки, і поява другого миттєво підкидала перший на
                    // ряд вище — у кадрі це читалось як «один зник, двоє
                    // зʼявились деінде». Тепер уже поставлений бейдж не
                    // рухається взагалі.
                    const row = k;
                    return (
                      <span
                        key={`${badge.at}-${badge.text}`}
                        className={`post-ws__badge${badge.tone === 'info' ? ' is-info' : ''}`}
                        style={{
                          bottom: `${96 + row * 21}%`,
                          left: `${50 + (row % 2 === 0 ? 7 : -7)}%`,
                          opacity: b.opacity,
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
              const age = time - s.start;
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
                  className="post-ws__sticker-label"
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
            {activePoseCard && time >= 0.01 ? (
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
                    const said = w.start <= time;
                    const bare = cleanCaption(w.word);
                    const text = preset.captions.uppercase ? bare.toUpperCase() : bare;
                    return (
                      <span
                        key={`${w.start}-${i}`}
                        className={`post-ws__caption-word${said ? ' is-said' : ''}${w.accent ? ' is-accent' : ''}`}
                        style={{ ['--glow' as string]: `${wordGlow(time, w)}` }}
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
            ) : post.words.length === 0 && post.script.trim() ? (
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
            {!post.audio ? (
              <div className="post-ws__frame-empty">
                Порожньо. Почни зі звуку — від його довжини рахується решта.
              </div>
            ) : null}
          </div>

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
              <div className="post-ws__scrub">
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
                  {speed !== 1 ? <span className="post-ws__rate">{speed.toFixed(1)}×</span> : null}
                </span>
              </div>

              {/*
                Стрічка транскрипції. Показує весь текст одразу, підсвічує
                те слово, що звучить, і дозволяє клікнути будь-яке, щоб
                перемотати. Без неї доводиться ловити момент скрабером
                наосліп — а стікери ставляться саме на конкретні слова.
              */}
              {post.words.length > 0 ? (
                <div className="post-ws__words">
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

        <div className="post-ws__blocks">
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
                  onClick={() => ask(
                    'Намалюй те, чого бракує в бібліотеці.\n\n'
                    + 'ЗАЯВКИ (з assets/stickers/stickers.json, записи зі status: "needed"):\n'
                    + wanted
                      .map((r) => `• ${r.id} → ${r.folder ?? 'assets/stickers/'}${r.id}.png\n`
                        + `  для чого: ${r.use ?? '—'}\n`
                        + `  бриф: ${r.brief ?? '—'}`)
                      .join('\n')
                    + '\n\nЯК МАЛЮВАТИ. Промпт, стиль і три пастки — '
                    + 'references/stickers.md плагіна create-instagram-post: не просити '
                    + 'прозорий фон (модель намалює шахівницю), не домальовувати кант '
                    + 'кодом (вона робить його краще сама), не лишати порожніх '
                    + 'поверхонь — казати, ЧИМ поверхня заповнена, інакше вона '
                    + 'домалює туди сторонній предмет.\n\n'
                    + 'Модель — та сама, що в полі "model" реєстру. Не міняй її: інша '
                    + 'дає інший стиль, і набір перестає бути набором.\n\n'
                    + 'ПІСЛЯ ГЕНЕРАЦІЇ: прогнати фон через make_stickers.py, покласти '
                    + 'файл у вказану папку, у реєстрі прибрати status і brief, '
                    + 'дописати file. Заявка без файлу лишається заявкою.\n\n'
                    + 'КУДИ КЛАСТИ. Рівно в ту папку й під тим id, що в заявці. Не '
                    + 'вигадуй власного імені файлу, не клади в assets/character/ '
                    + '(там живуть пози ведучого, і студія покаже твою картинку як '
                    + '15-ту позу) і НЕ СТВОРЮЙ окремого реєстру: усе, що знаєш про '
                    + 'картинку — промах моделі, спосіб зрізу фону, заміри — пиши в '
                    + 'той самий запис stickers.json. Два реєстри в одному проєкті '
                    + 'розходяться першого ж дня.\n\n'
                    + 'ЗВІТ — трьома рядками: що намальовано, де лежить, що '
                    + 'перевірити оком. Розбір процесу лишай у полях реєстру, не в чаті.',
                  )}
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
                      return (
                        <button
                          type="button"
                          key={r.id}
                          className="post-block__pose"
                          disabled={busy || post.words.length === 0 || !f}
                          title={`${r.id}\n${r.use ?? ''}`}
                          onClick={() => (f ? bindSticker(f.name.replace(/\\/g, '/'), r.id) : undefined)}
                        >
                          {f ? (
                            <img src={`${rawUrl(projectId, f.name)}?v=${f.mtime}`} alt="" loading="lazy" />
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
                  + 'ЯК ВОНО РУХАЄТЬСЯ — вирішуєш теж ти, і це половина роботи. '
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
      </div>

      {/*
        Перегляд пози. Поруч завжди еталон — саме з ним звіряють обличчя,
        і тримати їх поруч важливіше за розмір однієї картинки. Дії теж
        тут: у сітці клік має відкривати, а не мовчки щось призначати.
      */}
      {preview ? (
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
      ) : null}
    </div>
  );
}
