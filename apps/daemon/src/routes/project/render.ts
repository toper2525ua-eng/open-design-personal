/*
 * Механічні кроки Post Studio без чату: рендер, таймкоди, словник.
 *
 * Кнопки студії раніше кидали готові команди в чат, і скрипти запускав
 * агент. Для кроків, де рішень нема (рендер mp4, forced alignment
 * таймкодів, копія словника рухів у проєкт), це коштувало повідомлення
 * агенту щоразу. Тепер студія б'є в ці роути: демон сам запускає ті
 * САМІ скрипти плагіна з тими самими аргументами (джерело правди не
 * роздвоюється), а стан студія читає звідси й показує сама.
 *
 * Скрипти й довідники беруться зі staged-копії скіла проєкту
 * (.od-skills/…) — тієї версії, з якою проєкт реально працює; якщо її
 * нема — із встановленого плагіна.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { RouteDeps } from '../../server-context.js';
import { getInstalledPlugin } from '../../plugins/registry.js';

type SqliteDb = Database.Database;

type RenderJobState = 'running' | 'done' | 'error';

interface RenderJob {
  state: RenderJobState;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  error: string | null;
  logPath: string;
  child: ChildProcess | null;
  // Підсумок скрипта, якщо той друкує JSON-звіт останнім рядком
  // (align.py: {words, worst_loss, warning?}).
  report: Record<string, unknown> | null;
}

// Один прогін на проєкт і тип: другий клік по кнопці під час роботи —
// це повторне натискання, а не запит на паралельний прогін. Ключі:
// `<id>` — рендер (історичний контракт), `align:<id>` — таймкоди.
// Мапа тримає й завершені job'и — GET після фінішу віддає підсумок,
// поки не стартував наступний прогін.
const jobs = new Map<string, RenderJob>();

/*
 * Картка колекційного подарунка — ТОЧНО за мобільним клієнтом Telegram
 * (Android, DrKLO/Telegram: ui/Gifts/GiftSheet.java + ui/Stars/
 * StarGiftPatterns.java). Числа в dp; та сама таблиця — у web
 * (post-spec.ts). Прев'ю і блок мусять збігатися.
 */
const TG_CARD_RADIUS_DP = 11;
const TG_PATTERN_GIFT: ReadonlyArray<{ x: number; y: number; size: number; alpha: number }> = [
  { x: -0.83, y: -52.16, size: 12.33, alpha: 0.2 },
  { x: 26.66, y: -40.33, size: 16, alpha: 0.2 },
  { x: 44.16, y: -20.5, size: 12.33, alpha: 0.2 },
  { x: 53, y: 7.33, size: 16, alpha: 0.2 },
  { x: 31, y: 23.66, size: 14.66, alpha: 0.2 },
  { x: 0, y: 32, size: 13.33, alpha: 0.2 },
  { x: -29, y: 23.66, size: 14, alpha: 0.2 },
  { x: -53, y: 7.33, size: 16, alpha: 0.2 },
  { x: -44.5, y: -20.16, size: 12.33, alpha: 0.2 },
  { x: -27.33, y: -40.33, size: 16, alpha: 0.2 },
  { x: 43.66, y: 50, size: 14.66, alpha: 0.2 },
  { x: -41.66, y: 48, size: 14.66, alpha: 0.2 },
];
const TG_RIBBON_SIZE_DP = 48;
const TG_RIBBON_PATH_D =
  'M46.83 24.5 L23.5 1.17 C22.75 0.42 21.73 0 20.68 0 C19.62 0 2.73 0.05 1.55 0.05 '
  + 'C0.36 0.05 -0.23 1.4885 0.6 2.32 L45.72 47.44 C46.56 48.28 48 47.68 48 46.5 '
  + 'C48 45.31 48 28.38 48 27.32 C48 26.26 47.5 25.24 46.82 24.5 Z';
const TG_RIBBON_TEXT_DP = 10;
const TG_RIBBON_TEXT_MAX_W_DP = 40;
const TG_RIBBON_HSV_SAT = 0.05;
const TG_RIBBON_HSV_VAL = -0.10;
const TG_ICON_STAR_D = "M11.4664 17.7532L6.96555 20.5105C6.49754 20.7972 5.88574 20.6502 5.59904 20.1822C5.45901 19.9536 5.41726 19.6782 5.48327 19.4184L6.18 16.676C6.4315 15.6861 7.10892 14.8586 8.02968 14.4165L12.9399 12.059C13.1688 11.9491 13.2653 11.6745 13.1553 11.4455C13.0663 11.2602 12.8651 11.1564 12.6624 11.1915L7.19676 12.1377C6.08572 12.3301 4.94636 12.0233 4.08213 11.299L2.35549 9.85207C1.93483 9.49955 1.8796 8.87276 2.23212 8.45211C2.40357 8.24752 2.65013 8.1205 2.91625 8.09968L8.19167 7.68682C8.56437 7.65765 8.88916 7.4218 9.03224 7.07642L11.0674 2.16367C11.2774 1.65662 11.8588 1.41586 12.3658 1.62591C12.6093 1.72677 12.8027 1.92021 12.9036 2.16367L14.9388 7.07642C15.0818 7.4218 15.4066 7.65765 15.7793 7.68682L21.0837 8.10194C21.6309 8.14477 22.0397 8.62304 21.9969 9.17021C21.9763 9.43343 21.8518 9.67763 21.6509 9.84891L17.6055 13.2978C17.3207 13.5405 17.1964 13.9227 17.284 14.2866L18.5277 19.4531C18.6561 19.9867 18.3277 20.5234 17.7941 20.6519C17.5377 20.7136 17.2673 20.6709 17.0424 20.5331L12.5046 17.7532C12.186 17.5581 11.7849 17.5581 11.4664 17.7532Z";

// adaptHSV з Theme.java: насиченість зсувається лише коли 0.1<s<0.9.
function tgAdaptHsv(hex: string, sat: number, val: number): string {
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return hex;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  let s = max === 0 ? 0 : d / max;
  let v = max;
  if (s > 0.1 && s < 0.9) s = Math.min(1, Math.max(0, s + sat));
  v = Math.min(1, Math.max(0, v + val));
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let rr = 0, gg = 0, bb = 0;
  if (h < 60) [rr, gg, bb] = [c, x, 0];
  else if (h < 120) [rr, gg, bb] = [x, c, 0];
  else if (h < 180) [rr, gg, bb] = [0, c, x];
  else if (h < 240) [rr, gg, bb] = [0, x, c];
  else if (h < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];
  const ch = (q: number): string => Math.round((q + m) * 255).toString(16).padStart(2, '0');
  return `#${ch(rr)}${ch(gg)}${ch(bb)}`;
}

// Завантаження наборів варіантів подарунків — легкі задачі поза
// проєктами, зі своїм життєвим циклом (без pid-файлів і .cache-логів).
const variantJobs = new Map<string, { state: 'running' | 'done' | 'error'; tail: string; error: string | null }>();

const PLUGIN_ID = 'create-instagram-post';
const OUT_NAME = 'post.mp4';

/*
 * Рестарт демона не сміє лишати python+chromium+ffmpeg сиротами: мапа
 * job'ів живе в пам'яті, і без цього хука рендер продовжив би молотити
 * ноут, а студія показувала б idle. На Windows kill самого python не
 * зачіпає його дітей — валимо все дерево через taskkill. Обробник
 * 'exit' виконується і на process.exit(0) із SIGINT/SIGTERM-шляху
 * daemon-startup; spawnSync тут легальний, бо синхронний.
 */
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const job of jobs.values()) {
      const pid = job.child?.pid;
      if (job.state !== 'running' || pid == null) continue;
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
          job.child?.kill('SIGTERM');
        }
      } catch {
        // виходимо — що не вбилось, те доб'є pid-файл при наступному POST
      }
    }
  });
}

// PID-файл переживає і рестарт, і аварійну смерть демона (SIGKILL, коли
// 'exit' не спрацює): якщо процес із нього ще дихає — другий рендер не
// стартує, бо render.py першим кроком зносить .frames під ногами першого.
function readAlivePid(pidPath: string): number | null {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM = живий, але чужий; ESRCH = мертвий
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

/*
 * Файл плагіна (скрипт чи довідник). Порядок пошуку — від найближчого
 * до проєкту до найзагальнішого:
 *
 *   1. staged-копія в самому проєкті — з нею проєкт реально працює;
 *   2. РЕЄСТР: де плагін лежить насправді (`installed_plugins.fs_path`);
 *   3. стара локальна установка в даних — лише як хвіст сумісності.
 *
 * Крок 2 з'явився, коли плагін переїхав у образ застосунку. Доти
 * резолвер знав рівно два місця, і жодне з них не вело до вкладеного:
 * свіжий проєкт (де staged-копії ще немає) мовчки брав словник рухів зі
 * СТАРОЇ локальної установки. У галереї це виглядало як «нові анімації
 * не з'явились», хоча канон уже містив їх — просто ніхто його не читав.
 *
 * Реєстр тут єдине надійне джерело: bundled-ходок пише туди справжній
 * шлях і в dev (тека репозиторію), і в packaged (тека всередині образу).
 */
function findPluginFile(
  projectDir: string,
  runtimeDataDir: string,
  rel: string,
  db?: SqliteDb,
): string | null {
  const staged = path.join(projectDir, '.od-skills');
  try {
    for (const entry of fs.readdirSync(staged)) {
      if (!entry.startsWith(PLUGIN_ID)) continue;
      const candidate = path.join(staged, entry, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // staged-теки немає — шукаємо далі
  }
  if (db) {
    try {
      const record = getInstalledPlugin(db, PLUGIN_ID);
      if (record?.fsPath) {
        const candidate = path.join(record.fsPath, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // реєстр недоступний — лишається хвіст сумісності
    }
  }
  const installed = path.join(runtimeDataDir, 'plugins', PLUGIN_ID, rel);
  return fs.existsSync(installed) ? installed : null;
}

// Хвіст лога, а не весь файл: ffmpeg пише прогрес безперервно, і лог
// на довгому ролику виростає до сотень кілобайт — студії з нього
// потрібні лише останні рядки для відсотка.
function logTail(logPath: string, bytes = 4096): string {
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

interface PluginJobOpts {
  jobKey: string;
  projectDir: string;
  script: string;
  scriptArgs: string[];
  logName: string;
  pidName: string;
  // Викликається на code 0; довершує роботу скрипта (перевірити файл,
  // перенести дані) і повертає текст помилки або null. Кидати не мусить —
  // будь-який throw тут переводить job у error з текстом винятку.
  finalize: (job: RenderJob) => string | null;
}

// Спільний каркас запуску скрипта плагіна: лог у .cache, pid-файл,
// захист демона від помилок стрімів, прибирання на close. Валідація
// аргументів — справа роута, сюди приходить уже безпечне.
function spawnPluginJob(o: PluginJobOpts): { error: string } | { ok: true } {
  const cacheDir = path.join(o.projectDir, '.cache');
  const pidPath = path.join(cacheDir, o.pidName);
  const stalePid = readAlivePid(pidPath);
  if (stalePid != null) {
    return { error: `уже йде (процес ${stalePid} з попереднього запуску демона)` };
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const logPath = path.join(cacheDir, o.logName);
  const log = fs.createWriteStream(logPath, { flags: 'w' });

  // -u обов'язковий: stdout python при пайпі буферизується блоками, і
  // рядки прогресу випадали б у лог однією пачкою аж наприкінці —
  // студія не бачила б поступу.
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawn(python, ['-u', o.script, ...o.scriptArgs], {
    cwd: o.projectDir,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const job: RenderJob = {
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    error: null,
    logPath,
    child,
    report: null,
  };
  jobs.set(o.jobKey, job);
  installExitHook();
  try {
    fs.writeFileSync(pidPath, String(child.pid ?? ''));
  } catch {
    // без pid-файла прогін працює — втрачається лише захист від
    // подвійного старту через рестарт демона
  }

  /*
   * Помилка стріму не сміє класти демон: на uncaughtException у
   * server.ts стоїть навмисний process.exit(1) (fatal telemetry), а
   * необроблений 'error' стріму ескалює саме туди — падіння запису в
   * лог (ENOSPC, замок антивірусу) вбивало б і студію, і чат.
   * Той самий захист — runtimes/runs.ts. Прогін цінніший за лог.
   */
  const swallowStreamError = (err: Error): void => {
    if (job.error == null) job.error = `лог недоступний: ${err.message}`;
    // Мертвий лог відпайплює потоки, і stdout python-а впирається в
    // повний буфер — print завис би назавжди. Зливаємо в нікуди.
    child.stdout?.resume();
    child.stderr?.resume();
  };
  log.on('error', swallowStreamError);
  child.stdout?.on('error', swallowStreamError);
  child.stderr?.on('error', swallowStreamError);

  // Обидва потоки — в один лог; end робимо самі на close, інакше
  // перший потік, що закрився, обірве стрім другому.
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on('error', (err) => {
    job.state = 'error';
    job.error = `процес не запустився: ${err.message}`;
    job.finishedAt = Date.now();
    job.child = null;
    try {
      fs.rmSync(pidPath, { force: true });
    } catch {
      // нешкідливо: перевірка pid-файла дивиться на живість процесу
    }
    try {
      log.end(`\n${job.error}\n`);
    } catch {
      // лог уже закрито — стан job важливіший за хвіст у файлі
    }
  });
  child.on('close', (code) => {
    try {
      fs.rmSync(pidPath, { force: true });
    } catch {
      // застарілий pid-файл нешкідливий: перевірка дивиться, чи
      // процес живий, а не чи файл існує
    }
    if (job.state === 'error') return;
    job.exitCode = code;
    job.finishedAt = Date.now();
    job.child = null;
    let failure: string | null;
    if (code === 0) {
      try {
        failure = o.finalize(job);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    } else {
      failure = `скрипт завершився з кодом ${String(code)}`;
    }
    job.state = failure == null ? 'done' : 'error';
    if (failure != null && job.error == null) job.error = failure;
    try {
      log.end();
    } catch {
      // потік уже закрився сам
    }
  });

  return { ok: true };
}

// Останній JSON-рядок лога — звіт скрипта (align.py друкує його в
// самому кінці). Не знайшли — не страшно, звіт опційний.
function parseReport(logPath: string): Record<string, unknown> | null {
  const tail = logTail(logPath, 8192);
  const lines = tail.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[i] ?? '');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // не JSON — дивимось попередній рядок
    }
  }
  return null;
}

export function registerProjectRenderRoutes(
  app: Express,
  ctx: RouteDeps<'db' | 'paths' | 'projectStore' | 'projectFiles'>,
) {
  const { db } = ctx;
  const { PROJECTS_DIR, RUNTIME_DATA_DIR } = ctx.paths;
  const { getProject } = ctx.projectStore;
  const { resolveProjectDir } = ctx.projectFiles;

  app.post('/api/projects/:id/render', (req, res) => {
    try {
      const id = req.params.id;
      const project = getProject(db, id);
      if (!project) {
        res.status(404).json({ error: 'проєкт не знайдено' });
        return;
      }
      const projectDir = resolveProjectDir(PROJECTS_DIR, id, project.metadata);

      if (jobs.get(id)?.state === 'running') {
        res.status(409).json({ error: 'рендер уже йде' });
        return;
      }
      // Рендер знімає живу студію, а align переписує words у post.json,
      // який студія перечитує на льоту — кадри мінялись би посеред зйомки.
      if (jobs.get(`align:${id}`)?.state === 'running') {
        res.status(409).json({ error: 'йде вирівнювання таймкодів — дочекайся, потім рендер' });
        return;
      }

      // Роут запускає локальний процес, тож кожен аргумент із запиту
      // звужено до безпечної форми: адреса — лише локальна студія,
      // доріжка — лише файл усередині теки проєкту.
      const url = typeof req.body?.url === 'string' ? req.body.url : '';
      if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/i.test(url)) {
        res.status(400).json({ error: 'url має бути локальною адресою студії' });
        return;
      }
      const fpsRaw = Number(req.body?.fps);
      const fps = Number.isInteger(fpsRaw) && fpsRaw >= 1 && fpsRaw <= 120 ? fpsRaw : 30;
      const speedRaw = Number(req.body?.speed);
      // 0 — «спитай студію»: render.py сам читає __postStudio.speed.
      const speed = Number.isFinite(speedRaw) && speedRaw > 0 && speedRaw <= 3 ? speedRaw : 0;

      let audioRel: string | null = null;
      if (typeof req.body?.audio === 'string' && req.body.audio.trim()) {
        const rel = req.body.audio.trim();
        const abs = path.resolve(projectDir, rel);
        if (!abs.startsWith(path.resolve(projectDir) + path.sep)) {
          res.status(400).json({ error: 'доріжка поза текою проєкту' });
          return;
        }
        if (!fs.existsSync(abs)) {
          res.status(400).json({ error: `нема доріжки: ${rel}` });
          return;
        }
        audioRel = rel;
      }

      const script = findPluginFile(projectDir, RUNTIME_DATA_DIR, path.join('scripts', 'render.py'), db);
      if (!script) {
        res.status(404).json({
          error: 'render.py не знайдено — ні в .od-skills проєкту, ні у встановленому плагіні',
        });
        return;
      }

      const args = ['--url', url, '--project', id, '--out', '.', '--fps', String(fps), '--speed', String(speed)];
      if (audioRel) args.push('--audio', audioRel);

      const spawned = spawnPluginJob({
        jobKey: id,
        projectDir,
        script,
        scriptArgs: args,
        logName: 'render.log',
        pidName: 'render.pid',
        // Успіх — це не «код 0», а «код 0 І файл на місці»: ffmpeg міг
        // упасти після знятих кадрів, лишивши старий post.mp4.
        finalize: () => (fs.existsSync(path.join(projectDir, OUT_NAME))
          ? null
          : 'render.py вийшов з кодом 0, але post.mp4 не з\'явився'),
      });
      if ('error' in spawned) {
        res.status(409).json({ error: `рендер ${spawned.error}` });
        return;
      }

      res.json({ ok: true, state: 'running', log: '.cache/render.log' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/projects/:id/render', (req, res) => {
    try {
      const id = req.params.id;
      const project = getProject(db, id);
      if (!project) {
        res.status(404).json({ error: 'проєкт не знайдено' });
        return;
      }
      const projectDir = resolveProjectDir(PROJECTS_DIR, id, project.metadata);
      const job = jobs.get(id);

      // Файл звітується незалежно від job: після рестарту демона мапа
      // порожня, а торішній post.mp4 у проєкті — досі є що відкривати.
      let out: { name: string; size: number; mtimeMs: number } | null = null;
      try {
        const st = fs.statSync(path.join(projectDir, OUT_NAME));
        out = { name: OUT_NAME, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        // ще не рендерився
      }

      res.json({
        state: job?.state ?? 'idle',
        startedAt: job?.startedAt ?? null,
        finishedAt: job?.finishedAt ?? null,
        exitCode: job?.exitCode ?? null,
        error: job?.error ?? null,
        tail: job ? logTail(job.logPath) : '',
        out,
        dir: projectDir,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /*
   * Таймкоди: mp3 → words.json → post.json.words. Раніше це був
   * обов'язковий чат-крок КОЖНОГО ролика («залив mp3, зроби таймкоди»),
   * хоча рішень тут нуль: команда фіксована, текст — із post.json.
   * Скрипт кладе words.json у --out; перенесення в post.json робив
   * агент — тепер довершує finalize.
   */
  app.post('/api/projects/:id/align', (req, res) => {
    try {
      const id = req.params.id;
      const project = getProject(db, id);
      if (!project) {
        res.status(404).json({ error: 'проєкт не знайдено' });
        return;
      }
      const projectDir = resolveProjectDir(PROJECTS_DIR, id, project.metadata);
      const jobKey = `align:${id}`;

      if (jobs.get(jobKey)?.state === 'running') {
        res.status(409).json({ error: 'вирівнювання вже йде' });
        return;
      }
      // Дзеркальний до гейта в POST render: words у post.json не сміють
      // мінятись, поки рендер знімає живу студію.
      if (jobs.get(id)?.state === 'running') {
        res.status(409).json({ error: 'йде рендер — таймкоди після нього' });
        return;
      }

      if (!process.env.ELEVENLABS_API_KEY) {
        res.status(400).json({
          error: 'ELEVENLABS_API_KEY не заданий в оточенні демона — вирівнювання не запуститься',
        });
        return;
      }

      const rel = typeof req.body?.audio === 'string' ? req.body.audio.trim() : '';
      if (!rel) {
        res.status(400).json({ error: 'вкажи доріжку (audio)' });
        return;
      }
      const abs = path.resolve(projectDir, rel);
      if (!abs.startsWith(path.resolve(projectDir) + path.sep)) {
        res.status(400).json({ error: 'доріжка поза текою проєкту' });
        return;
      }
      if (!fs.existsSync(abs)) {
        res.status(400).json({ error: `нема доріжки: ${rel}` });
        return;
      }

      // Рання чесна відмова: align.py бере текст із post.json.script —
      // без тексту він однаково впаде, тільки за 10 секунд і глухіше.
      const postPath = path.join(projectDir, 'post.json');
      let scriptText = '';
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(postPath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          const s = (parsed as Record<string, unknown>).script;
          if (typeof s === 'string') scriptText = s.trim();
        }
      } catch {
        // нема post.json — та сама відмова, що й без тексту
      }
      if (!scriptText) {
        res.status(400).json({ error: 'у post.json нема тексту сценарію — спершу сценарій' });
        return;
      }

      const script = findPluginFile(projectDir, RUNTIME_DATA_DIR, path.join('scripts', 'align.py'), db);
      if (!script) {
        res.status(404).json({
          error: 'align.py не знайдено — ні в .od-skills проєкту, ні у встановленому плагіні',
        });
        return;
      }

      const outDir = path.join('.cache', 'align');
      const spawned = spawnPluginJob({
        jobKey,
        projectDir,
        script,
        scriptArgs: ['--audio', rel, '--post', 'post.json', '--out', outDir],
        logName: 'align.log',
        pidName: 'align.pid',
        finalize: (job) => {
          const wordsSrc = path.join(projectDir, outDir, 'words.json');
          if (!fs.existsSync(wordsSrc)) {
            return 'align.py вийшов з кодом 0, але words.json не з\'явився';
          }
          const words: unknown = JSON.parse(fs.readFileSync(wordsSrc, 'utf8'));
          if (!Array.isArray(words) || words.length === 0) {
            return 'words.json порожній — вирівнювання не дало слів';
          }
          // post.json перечитуємо СВІЖИЙ на момент фінішу (студія могла
          // писати його ці ~10 секунд) і міняємо лише words; запис через
          // rename, щоб поллер студії не зловив недописаний JSON.
          const current = JSON.parse(fs.readFileSync(postPath, 'utf8')) as Record<string, unknown>;
          current.words = words;
          const tmp = `${postPath}.align-tmp`;
          fs.writeFileSync(tmp, JSON.stringify(current, null, 1));
          fs.renameSync(tmp, postPath);
          // Канон SKILL: повний words.json лежить і в корені проєкту.
          fs.copyFileSync(wordsSrc, path.join(projectDir, 'words.json'));
          job.report = parseReport(job.logPath);
          return null;
        },
      });
      if ('error' in spawned) {
        res.status(409).json({ error: `вирівнювання ${spawned.error}` });
        return;
      }

      res.json({ ok: true, state: 'running', log: '.cache/align.log' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/projects/:id/align', (req, res) => {
    try {
      const id = req.params.id;
      const project = getProject(db, id);
      if (!project) {
        res.status(404).json({ error: 'проєкт не знайдено' });
        return;
      }
      const job = jobs.get(`align:${id}`);
      res.json({
        state: job?.state ?? 'idle',
        startedAt: job?.startedAt ?? null,
        finishedAt: job?.finishedAt ?? null,
        exitCode: job?.exitCode ?? null,
        error: job?.error ?? null,
        tail: job ? logTail(job.logPath) : '',
        report: job?.report ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /*
   * Каталог подарунків Telegram — спільний на всі ролики, тому живе в
   * даних демона (`<data>/gifts/`), а не в теці проєкту: 165 анімацій
   * по пів мегабайта дублювати в кожен ролик безглуздо.
   */
  app.get('/api/gifts', (_req, res) => {
    try {
      const file = path.join(RUNTIME_DATA_DIR, 'gifts', 'gifts.json');
      if (!fs.existsSync(file)) {
        res.json({ version: 1, items: [] });
        return;
      }
      res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Прев'ю подарунка — статичний кадр із каталогу. Slug звужений до
  // безпечної форми: роут читає файли поза теками проєктів.
  app.get('/api/gifts/preview/:slug', (req, res) => {
    try {
      const slug = req.params.slug;
      if (!/^[a-z0-9-]{1,64}$/i.test(slug)) {
        res.status(400).json({ error: 'bad slug' });
        return;
      }
      const file = path.join(RUNTIME_DATA_DIR, 'gifts', 'preview', `${slug}.png`);
      if (!fs.existsSync(file)) {
        res.status(404).json({ error: 'no preview' });
        return;
      }
      res.type('png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(file).on('error', () => res.end()).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /*
   * Фони і символи NFT — те, з чого складається квадратна картка
   * колекційного подарунка: радіальний градієнт (два кольори),
   * зафарбований символ-патерн, стрічка з номером. Каталог збирає
   * `nft_backdrops.py` з публічних сторінок t.me/nft.
   */
  app.get('/api/gifts/nft/backdrops', (_req, res) => {
    try {
      const file = path.join(RUNTIME_DATA_DIR, 'gifts', 'nft', 'backdrops.json');
      res.json(fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf8'))
        : { version: 1, items: [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/gifts/nft/symbols', (_req, res) => {
    try {
      const file = path.join(RUNTIME_DATA_DIR, 'gifts', 'nft', 'symbols.json');
      res.json(fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf8'))
        : { version: 1, items: [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/gifts/nft/symbols/:name', (req, res) => {
    try {
      const name = req.params.name;
      if (!/^[a-z0-9-]{1,64}\.png$/i.test(name)) {
        res.status(400).json({ error: 'bad name' });
        return;
      }
      const file = path.join(RUNTIME_DATA_DIR, 'gifts', 'nft', 'symbols', name);
      if (!fs.existsSync(file)) {
        res.status(404).json({ error: 'no symbol' });
        return;
      }
      res.type('png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(file).on('error', () => res.end()).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /*
   * Варіанти подарунка — колекція NFT-моделей конкретного подарунка
   * (свій emoji-набір на кожен, власник заповнює поступово). Живуть у
   * `<data>/gifts/variants/<slug>/` зі своїм variants.json.
   */
  app.get('/api/gifts/:slug/variants', (req, res) => {
    try {
      const slug = req.params.slug;
      if (!/^[a-z0-9-]{1,64}$/i.test(slug)) {
        res.status(400).json({ error: 'bad slug' });
        return;
      }
      const file = path.join(RUNTIME_DATA_DIR, 'gifts', 'variants', slug, 'variants.json');
      if (!fs.existsSync(file)) {
        res.json({ version: 1, items: [] });
        return;
      }
      res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/gifts/:slug/variants/preview/:vslug', (req, res) => {
    try {
      const { slug, vslug } = req.params;
      if (!/^[a-z0-9-]{1,64}$/i.test(slug) || !/^[a-z0-9-]{1,64}$/i.test(vslug)) {
        res.status(400).json({ error: 'bad slug' });
        return;
      }
      const file = path.join(RUNTIME_DATA_DIR, 'gifts', 'variants', slug, 'preview', `${vslug}.png`);
      if (!fs.existsSync(file)) {
        res.status(404).json({ error: 'no preview' });
        return;
      }
      res.type('png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(file).on('error', () => res.end()).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /*
   * Завантажити набір варіантів з t.me/addemoji/<set>. Скрипт плагіна
   * качає через Bot API; токен демон бере з env або з
   * `<data>/gifts/tg-token.txt` і передає дитині через середовище.
   */
  app.post('/api/gifts/:slug/variants/ingest', (req, res) => {
    try {
      const slug = req.params.slug;
      if (!/^[a-z0-9-]{1,64}$/i.test(slug)) {
        res.status(400).json({ error: 'bad slug' });
        return;
      }
      // Приймаємо і чисту назву, і вставлений лінк t.me/addemoji/<set>.
      const rawSet = typeof req.body?.set === 'string' ? req.body.set.trim() : '';
      const setName = rawSet.replace(/^https?:\/\/t\.me\/addemoji\//i, '').replace(/[^A-Za-z0-9_]/g, '');
      if (!setName) {
        res.status(400).json({ error: 'вкажи назву набору (t.me/addemoji/…)' });
        return;
      }
      let token = process.env.TG_BOT_TOKEN ?? '';
      const tokenFile = path.join(RUNTIME_DATA_DIR, 'gifts', 'tg-token.txt');
      if (!token && fs.existsSync(tokenFile)) {
        token = fs.readFileSync(tokenFile, 'utf8').trim();
      }
      if (!token) {
        res.status(400).json({ error: 'нема TG-токена: поклади його в gifts/tg-token.txt' });
        return;
      }
      // Скрипт беремо БЕЗ staged-фолбека: операція не проєктна.
      const script = path.join(RUNTIME_DATA_DIR, 'plugins', PLUGIN_ID, 'scripts', 'gift_variants.py');
      if (!fs.existsSync(script)) {
        res.status(404).json({ error: 'gift_variants.py не знайдено у плагіні' });
        return;
      }
      const outDir = path.join(RUNTIME_DATA_DIR, 'gifts', 'variants', slug);
      fs.mkdirSync(outDir, { recursive: true });

      // Тека каталогу — не проєкт, тож spawnPluginJob із його
      // .cache-логами тут не пасує: маленький власний запуск.
      if (variantJobs.get(slug)?.state === 'running') {
        res.status(409).json({ error: 'набір уже завантажується' });
        return;
      }
      const python = process.platform === 'win32' ? 'python' : 'python3';
      const child = spawn(python, ['-u', script, '--set', setName, '--out', outDir], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', TG_BOT_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const job = { state: 'running' as 'running' | 'done' | 'error', tail: '', error: null as string | null };
      variantJobs.set(slug, job);
      const keep = (buf: Buffer): void => {
        job.tail = (job.tail + buf.toString('utf8')).slice(-2000);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});
      child.on('error', (err) => {
        job.state = 'error';
        job.error = err.message;
      });
      child.on('close', (code) => {
        if (job.state === 'error') return;
        job.state = code === 0 ? 'done' : 'error';
        if (code !== 0) job.error = `скрипт завершився з кодом ${String(code)}`;
      });
      res.json({ ok: true, state: 'running', set: setName });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/gifts/:slug/variants/ingest', (req, res) => {
    const job = variantJobs.get(req.params.slug);
    res.json({
      state: job?.state ?? 'idle',
      error: job?.error ?? null,
      tail: job?.tail ?? '',
    });
  });

  /*
   * «Взяти подарунок у ролик»: lottie з каталогу → спрайт-аркуш у
   * наборі проєкту + запис у реєстрі. Спрайт, а не lottie, бо
   * `lottie-web` малює TGS Telegram порожніми — доведено пробою.
   */
  app.post('/api/projects/:id/gifts/take', (req, res) => {
    try {
      const id = req.params.id;
      const project = getProject(db, id);
      if (!project) {
        res.status(404).json({ error: 'проєкт не знайдено' });
        return;
      }
      const projectDir = resolveProjectDir(PROJECTS_DIR, id, project.metadata);

      const slug = typeof req.body?.slug === 'string' ? req.body.slug : '';
      if (!/^[a-z0-9-]{1,64}$/i.test(slug)) {
        res.status(400).json({ error: 'bad slug' });
        return;
      }
      // Варіант (NFT-модель) — lottie з підкаталогу варіантів подарунка.
      const variant = typeof req.body?.variant === 'string' ? req.body.variant : '';
      if (variant && !/^[a-z0-9-]{1,64}$/i.test(variant)) {
        res.status(400).json({ error: 'bad variant' });
        return;
      }
      const src = variant
        ? path.join(RUNTIME_DATA_DIR, 'gifts', 'variants', slug, 'lottie', `${variant}.json`)
        : path.join(RUNTIME_DATA_DIR, 'gifts', 'lottie', `${slug}.json`);
      if (!fs.existsSync(src)) {
        res.status(404).json({ error: variant ? 'варіанта немає в каталозі' : 'подарунка немає в каталозі' });
        return;
      }

      const catalogFile = path.join(RUNTIME_DATA_DIR, 'gifts', 'gifts.json');
      const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as {
        items?: Array<{ slug: string; title?: string; emoji?: string; kind?: string; use?: string }>;
      };
      const entry = catalog.items?.find((x) => x.slug === slug);

      const script = findPluginFile(projectDir, RUNTIME_DATA_DIR, path.join('scripts', 'gift_sprite.py'), db);
      if (!script) {
        res.status(404).json({ error: 'gift_sprite.py не знайдено у плагіні' });
        return;
      }

      const stickerId = typeof req.body?.id === 'string' && /^[a-z0-9-]{1,48}$/i.test(req.body.id)
        ? req.body.id
        : (variant ? `${slug}-${variant}` : slug);
      const rel = path.join('assets', 'stickers', `${stickerId}.sprite.png`).replace(/\\/g, '/');
      fs.mkdirSync(path.join(projectDir, 'assets', 'stickers'), { recursive: true });

      const spawned = spawnPluginJob({
        jobKey: `gift:${id}`,
        projectDir,
        script,
        scriptArgs: ['--src', src, '--out', rel],
        logName: 'gift.log',
        pidName: 'gift.pid',
        finalize: (job) => {
          const abs = path.join(projectDir, rel);
          if (!fs.existsSync(abs)) return 'спрайт не з\'явився';
          const report = parseReport(job.logPath);
          if (!report || typeof report.frames !== 'number') {
            return 'скрипт не віддав звіт про кадри';
          }
          job.report = report;
          // Реєстр набору: без запису подарунок лишиться картинкою без
          // призначення, і агент його не вибере під фразу.
          const regPath = path.join(projectDir, 'assets', 'stickers', 'stickers.json');
          let doc: { stickers: Array<Record<string, unknown>> } = { stickers: [] };
          try {
            const parsed: unknown = JSON.parse(fs.readFileSync(regPath, 'utf8'));
            if (Array.isArray(parsed)) doc = { stickers: parsed as Array<Record<string, unknown>> };
            else if (parsed && typeof parsed === 'object') {
              doc = parsed as { stickers: Array<Record<string, unknown>> };
              if (!Array.isArray(doc.stickers)) doc.stickers = [];
            }
          } catch {
            // реєстру ще немає — заведемо
          }
          const sprite = {
            frames: report.frames, cols: report.cols, rows: report.rows, fps: report.fps,
          };
          const title = (entry?.title || slug) + (variant ? ` (модель ${variant})` : '');
          const rec = {
            id: stickerId,
            file: rel,
            sprite,
            shows: `подарунок Telegram «${title}»`,
            // Призначення беремо з каталогу — воно писалось під вибір
            // предмета до фрази; загальний рядок лишається запасним.
            use: entry?.use
              ? `${entry.use} (${entry.kind === 'star' ? 'подарунок за зірки' : 'колекційний NFT'})`
              : entry?.kind === 'star'
                ? `подарунок за зірки «${title}»: магазин, ціна в зірках, дарування`
                : `колекційний (NFT) подарунок «${title}»: апгрейд, рідкість, ринок`,
            kind: 'object',
            animated: true,
            source: 'telegram gift emoji',
          };
          doc.stickers = doc.stickers.filter((x) => x.id !== stickerId).concat(rec);
          fs.writeFileSync(regPath, JSON.stringify(doc, null, 1));
          return null;
        },
      });
      if ('error' in spawned) {
        res.status(409).json({ error: `подарунок ${spawned.error}` });
        return;
      }
      res.json({ ok: true, state: 'running', file: rel, id: stickerId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/projects/:id/gifts/take', (req, res) => {
    const job = jobs.get(`gift:${req.params.id}`);
    res.json({
      state: job?.state ?? 'idle',
      error: job?.error ?? null,
      report: job?.report ?? null,
    });
  });

  /*
   * Картка колекційного подарунка як БЛОК ролика.
   *
   * Складається з трьох речей, які в Telegram і роблять NFT: фон
   * (радіальний градієнт), символ-патерн поверх нього і стрічка з
   * номером. Сам подарунок у центр кладе студія — окремим стікером
   * поверх картки, щоб він лишався анімованим.
   */
  app.post('/api/projects/:id/nft-card', (req, res) => {
    try {
      const id = req.params.id;
      const project = getProject(db, id);
      if (!project) {
        res.status(404).json({ error: 'проєкт не знайдено' });
        return;
      }
      const projectDir = resolveProjectDir(PROJECTS_DIR, id, project.metadata);
      const nftDir = path.join(RUNTIME_DATA_DIR, 'gifts', 'nft');

      const backdropName = typeof req.body?.backdrop === 'string' ? req.body.backdrop : '';
      const symbolName = typeof req.body?.symbol === 'string' ? req.body.symbol : '';
      const number = typeof req.body?.number === 'string' ? req.body.number.slice(0, 16) : '';
      const price = typeof req.body?.price === 'string' ? req.body.price.slice(0, 16) : '';

      const backdrops = JSON.parse(fs.readFileSync(path.join(nftDir, 'backdrops.json'), 'utf8')) as {
        items: Array<{ name: string; center: string; edge: string; symbolColor?: string; textColor?: string }>;
      };
      const b = backdrops.items.find((x) => x.name === backdropName);
      if (!b) {
        res.status(404).json({ error: `фон «${backdropName}» не знайдено` });
        return;
      }
      let symbolFile: string | null = null;
      if (symbolName) {
        const symbols = JSON.parse(fs.readFileSync(path.join(nftDir, 'symbols.json'), 'utf8')) as {
          items: Array<{ name: string; file: string }>;
        };
        const s = symbols.items.find((x) => x.name === symbolName);
        if (s) symbolFile = path.join(nftDir, s.file);
      }

      // Символ копіюємо в проєкт: блок мусить лишатись самодостатнім —
      // рендер бере файли ролика, а не дані демона.
      const blocksDir = path.join(projectDir, 'assets', 'blocks');
      fs.mkdirSync(blocksDir, { recursive: true });
      let symbolRel: string | null = null;
      if (symbolFile && fs.existsSync(symbolFile)) {
        const base = path.basename(symbolFile);
        fs.copyFileSync(symbolFile, path.join(blocksDir, base));
        symbolRel = base;
      }

      const slug = `nft-card-${backdropName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const symbolColor = b.symbolColor ?? '#000000';
      // Патерн — сітка з символу: як у Telegram, дрібний і напівпрозорий,
      // зафарбований одним кольором (маска, а не сам PNG: у нього свої
      // кольори, і без маски фон перетворюється на строкатий килим).
      /*
       * Блок — ТОЧНО за мобільним клієнтом (GiftCell): клітинка 128×160 dp,
       * 1 dp = DP px. Кути 11 dp; градієнт CardBackground: радіус =
       * lerp(min, max, .35)/2, центр (cx, min(50dp, cy)); патерн TYPE_GIFT
       * (12 символів, центри в dp від центру картки); стікер 80×80 dp з
       * відступом 12 зверху; ціна — пігулка 26 dp, 12 dp bold, padding 10;
       * стрічка — контур 48×48 dp у правому верхньому куті (top 2,
       * right 1), градієнт center→edge через adaptHSV(+.05, −.10), текст
       * 10 dp bold під 45° навколо (30, 18), стиснутий до 40 dp.
       */
      /*
       * Пропорція картки — рівно як у клієнті: 128×160 dp. Масштаб і
       * відступ згори підібрані так, щоб картка стояла НИЖЧЕ в зоні
       * стікерів (0.13…0.38 висоти кадру = 480 px полотна): 352×440
       * плюс 40 px відступу = рівно 480.
       */
      const DP = 352 / 128;
      const W = Math.round(128 * DP), H = Math.round(160 * DP);
      const cx = W / 2, cy = Math.min(50 * DP, H / 2);
      const gradR = (Math.min(W, H) + (Math.max(W, H) - Math.min(W, H)) * 0.35) / 2;
      const ribC = tgAdaptHsv(b.center, TG_RIBBON_HSV_SAT, TG_RIBBON_HSV_VAL);
      const ribE = tgAdaptHsv(b.edge, TG_RIBBON_HSV_SAT, TG_RIBBON_HSV_VAL);
      /*
       * Шлях до символу — АБСОЛЮТНИЙ через API проєкту. Відносний
       * («./crown.png») резолвиться відносно сторінки студії, а не
       * файла блока: маска не знаходилась, і патерн просто зникав —
       * картка виглядала порожньою.
       */
      const symbolUrl = symbolRel
        ? `/api/projects/${encodeURIComponent(id)}/raw/assets/blocks/${symbolRel}`
        : '';
      const symbolsHtml = symbolRel
        ? TG_PATTERN_GIFT.map((p) => `<div class="nftc__sym" style="left:${(cx + p.x * DP - (p.size * DP) / 2).toFixed(1)}px;`
            + `top:${(cy + p.y * DP - (p.size * DP) / 2 + 12 * DP).toFixed(1)}px;`
            + `width:${(p.size * DP).toFixed(1)}px;height:${(p.size * DP).toFixed(1)}px;`
            + `opacity:${p.alpha}"></div>`).join('\n    ')
        : '';
      const patternCss = symbolRel
        ? `
  .nftc__sym {
    position: absolute;
    background-color: ${symbolColor};
    -webkit-mask-image: url("${symbolUrl}"); mask-image: url("${symbolUrl}");
    -webkit-mask-size: contain; mask-size: contain;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
    -webkit-mask-position: center; mask-position: center;
  }`
        : '';
      // Форма стрічки — їхній path без змін; масштаб ×RIB подовжує її, щоб
      // підвороти вийшли за край; зсув тримає середину на діагоналі кута.
      const RIB = 1.22;
      const ribbonSvg = number
        ? `<svg class="nftc__ribbon" width="${TG_RIBBON_SIZE_DP * DP * RIB}" height="${TG_RIBBON_SIZE_DP * DP * RIB}" viewBox="0 0 ${TG_RIBBON_SIZE_DP} ${TG_RIBBON_SIZE_DP}">`
          + `<defs><linearGradient id="nftcRibbonGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${ribC}"/><stop offset="1" stop-color="${ribE}"/></linearGradient></defs>`
          + `<path d="${TG_RIBBON_PATH_D}" fill="url(#nftcRibbonGrad)" stroke-linejoin="round"/>`
          + `<text x="30" y="20.5" fill="#fff" font-size="${TG_RIBBON_TEXT_DP}" font-weight="700" font-family="Roboto, Arial, sans-serif" text-anchor="middle" dominant-baseline="middle" transform="rotate(45 30 18)"${number.length > 5 ? ` textLength="${TG_RIBBON_TEXT_MAX_W_DP}" lengthAdjust="spacingAndGlyphs"` : ''}>#${number}</text>`
          + `</svg>`
        : '';
      const html = `<style>
  .nftc-wrap {
    position: relative; width: ${W}px; height: ${H}px; margin: 40px auto 0;
    font-family: Roboto, "Segoe UI", Arial, Helvetica, sans-serif;
  }
  .nftc {
    position: absolute; inset: 0;
    border-radius: ${Math.round(TG_CARD_RADIUS_DP * DP)}px; overflow: hidden;
    background: radial-gradient(${gradR.toFixed(1)}px circle at ${cx.toFixed(1)}px ${cy.toFixed(1)}px, ${b.center} 0%, ${b.edge} 100%);
    box-shadow: 0 ${Math.round(0.33 * DP)}px ${Math.round(1.66 * DP)}px rgba(0,0,0,.18);
  }${patternCss}
  .nftc__slot { position: absolute; left: ${((W - 80 * DP) / 2).toFixed(1)}px; top: ${(12 * DP).toFixed(1)}px; width: ${(80 * DP).toFixed(1)}px; height: ${(80 * DP).toFixed(1)}px; }
  /* Ціна (GiftCell, unique): білий 25 % поверх фону, кути 13 dp,
     12 dp bold білий, від низу 11 dp, padding 10 dp. */
  .nftc__price {
    position: absolute; left: 50%; bottom: ${(11 * DP).toFixed(1)}px; transform: translateX(-50%);
    height: ${(26 * DP).toFixed(1)}px; padding: 0 ${(10 * DP).toFixed(1)}px;
    border-radius: ${(13 * DP).toFixed(1)}px; background: rgba(255,255,255,.25); color: #fff;
    font-size: ${(12 * DP).toFixed(1)}px; line-height: 1; font-weight: 700;
    display: flex; align-items: center; gap: ${(3 * DP).toFixed(1)}px; z-index: 2;
  }
  .nftc__price svg { width: ${(12 * DP).toFixed(1)}px; height: ${(12 * DP).toFixed(1)}px; fill: #fff; }
  .nftc__ribbon { position: absolute; top: ${((2 - TG_RIBBON_SIZE_DP * (RIB - 1) / 2) * DP).toFixed(1)}px; right: ${((1 - TG_RIBBON_SIZE_DP * (RIB - 1) / 2) * DP).toFixed(1)}px; z-index: 3; overflow: visible; }
</style>
<div class="nftc-wrap">
  <div class="nftc">
    ${symbolsHtml}
    <div class="nftc__slot"></div>
    ${price ? `<div class="nftc__price"><svg viewBox="0 0 24 24"><path d="${TG_ICON_STAR_D}"/></svg>${price}</div>` : ''}
  </div>
  ${ribbonSvg}
</div>
`;
      const file = path.join('assets', 'blocks', `${slug}.html`).replace(/\\/g, '/');
      fs.writeFileSync(path.join(projectDir, file), html);
      res.json({ ok: true, file, backdrop: b.name, symbol: symbolName || null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /*
   * Словник рухів у проєкт — копія двох речей із плагіна: motions.json
   * і demo-картки. Кнопка «Завести словник» раніше просила про це
   * агента в чаті — копіювання файлів не варте повідомлення.
   */
  app.post('/api/projects/:id/motions/seed', (req, res) => {
    try {
      const id = req.params.id;
      const project = getProject(db, id);
      if (!project) {
        res.status(404).json({ error: 'проєкт не знайдено' });
        return;
      }
      const projectDir = resolveProjectDir(PROJECTS_DIR, id, project.metadata);

      const target = path.join(projectDir, 'assets', 'motions.json');
      if (fs.existsSync(target)) {
        res.status(409).json({
          error: 'словник уже заведено (assets/motions.json існує)',
        });
        return;
      }
      const motionsSrc = findPluginFile(
        projectDir,
        RUNTIME_DATA_DIR,
        path.join('references', 'motions.json'),
        db,
      );
      if (!motionsSrc) {
        res.status(404).json({ error: 'motions.json не знайдено у плагіні' });
        return;
      }

      const blocksDir = path.join(projectDir, 'assets', 'blocks');
      fs.mkdirSync(blocksDir, { recursive: true });
      fs.copyFileSync(motionsSrc, target);

      // Demo-картки — лише відсутні: наявні в проєкті могли правитись
      // у конструкторі, копія з канону їх не сміє перетирати.
      let cards = 0;
      const demoDir = findPluginFile(projectDir, RUNTIME_DATA_DIR, path.join('references', 'demo-cards'), db);
      if (demoDir) {
        for (const name of fs.readdirSync(demoDir)) {
          if (!name.endsWith('.html')) continue;
          const dst = path.join(blocksDir, name);
          if (fs.existsSync(dst)) continue;
          fs.copyFileSync(path.join(demoDir, name), dst);
          cards += 1;
        }
      }

      /*
       * Стікери — разом зі словником, а не окремо.
       *
       * Вітрини рухів побудовані на предметах із набору: `fx-demo-enters`
       * показує чотири входи на чотирьох стікерах. Студія шукає файли
       * за проєктним шляхом `assets/stickers/…`, тож у свіжому проєкті
       * такий запис давав порожні рамки — словник ніби заведено, а в
       * галереї нічого не рухається.
       *
       * Заразом це лікує ширшу вада: без набору агент починав ролик із
       * чистого аркуша й малював СВОЇ стікери в новій манері замість
       * того, щоб узяти наявні.
       *
       * Правило те саме, що для карток: копіюємо лише відсутні.
       */
      let stickers = 0;
      const stickersDir = findPluginFile(projectDir, RUNTIME_DATA_DIR, path.join('assets', 'stickers'), db);
      if (stickersDir) {
        const dstDir = path.join(projectDir, 'assets', 'stickers');
        fs.mkdirSync(dstDir, { recursive: true });
        for (const name of fs.readdirSync(stickersDir)) {
          if (!/\.(png|json)$/i.test(name)) continue;
          const dst = path.join(dstDir, name);
          if (fs.existsSync(dst)) continue;
          fs.copyFileSync(path.join(stickersDir, name), dst);
          stickers += 1;
        }
      }

      res.json({ ok: true, cards, stickers });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
