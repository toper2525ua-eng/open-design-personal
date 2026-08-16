// Реліз особистої збірки: зібрати → порахувати → опублікувати на GitHub.
//
// Навіщо окремо від `tools-release`. Той конвеєр веде релізи розробників
// Open Design у їхнє сховище з підписами, каналами й нотатками. Нам
// потрібне рівно одне: щоб встановлені копії (мої і друзів) побачили
// нову версію й запропонували оновитись. Джерело для них — реліз на
// GitHub, адреса якого запечена у збірку (`updater/config.ts`).
//
//   node scripts/release-personal.mjs --version 0.18.0
//   node scripts/release-personal.mjs --version 0.18.0 --dry-run
//   node scripts/release-personal.mjs --version 0.18.0 --skip-build
//
// Запускати під Node 24: `fnm exec --using=24 node scripts/…`.
//
// Що робить по кроках:
//   1. збирає інсталятор із `--portable` (без запечених локальних тек);
//   2. перейменовує його на безпечне ім'я — GitHub міняє пробіли в
//      іменах вкладень на крапки, і адреса в стрічці стала б битою;
//   3. рахує sha256 і розмір;
//   4. пише `metadata.json` рівно тієї форми, яку читає апдейтер;
//   5. створює реліз і вантажить обидва файли.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'toper2525ua-eng/open-design-personal';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER_DIR = path.join(ROOT, '.tmp', 'tools-pack', 'out', 'win', 'namespaces', 'default', 'builder');
const OUT_DIR = path.join(ROOT, '.tmp', 'release-personal');

// Ключі стрічки — НЕ вигадані: беруться з `selectedWinPlatformKey` і
// `selectedPackageLauncherArtifact` у `apps/desktop/src/main/updater/feed.ts`.
// Для x64 Windows це рівно 'win' і 'installer'.
const PLATFORM_KEY = 'win';
const ARTIFACT_KEY = 'installer';
const CHANNEL = 'stable';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next == null || next.startsWith('--') ? true : next;
}

function die(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: false, ...opts });
  if (r.error) die(`${cmd} не запустився: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} завершився з кодом ${r.status}`);
}

const version = arg('version');
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  die('потрібна версія: --version 0.18.0');
}
const dryRun = arg('dry-run', false) === true;
const skipBuild = arg('skip-build', false) === true;
const notes = arg('notes', null);
const tag = `v${version}`;

// Версія з суфіксом (0.18.0-beta.1) поїхала б в інший канал і не
// зійшлася б із `channel: 'stable'` у стрічці — апдейтер відкидає таку
// пару з «metadata-channel-mismatch». Тому тут лише чисті три числа.

console.log(`\n=== реліз ${tag} → ${REPO} ===`);

if (!skipBuild) {
  const pnpm = process.env.PNPM_CJS
    ?? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (!existsSync(pnpm)) die(`не знайшов pnpm.cjs (${pnpm}) — передай шлях у PNPM_CJS`);
  run(process.execPath, [
    pnpm, 'exec', 'tools-pack', 'win', 'build',
    // Без цього у збірку запікаються ЛОКАЛЬНІ теки рантайму, і на чужій
    // машині програма шукає теку, якої там немає.
    '--portable',
    '--to', 'nsis',
    '--app-version', version,
  ]);
} else {
  console.log('\n(збірку пропущено за --skip-build)');
}

if (!existsSync(BUILDER_DIR)) die(`немає теки збірки: ${BUILDER_DIR}`);
const exe = readdirSync(BUILDER_DIR)
  .filter((f) => f.toLowerCase().endsWith('.exe') && f.toLowerCase().includes('setup'))
  .map((f) => ({ f, m: statSync(path.join(BUILDER_DIR, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];
if (!exe) die(`у ${BUILDER_DIR} немає інсталятора *setup*.exe`);

mkdirSync(OUT_DIR, { recursive: true });
// Ім'я без пробілів: GitHub замінює їх у вкладеннях на крапки, і адреса
// в стрічці розійшлася б із реальною — оновлення падало б на 404.
const assetName = `open-design-${version}-win-x64-setup.exe`;
const assetPath = path.join(OUT_DIR, assetName);
copyFileSync(path.join(BUILDER_DIR, exe.f), assetPath);

const bytes = readFileSync(assetPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const size = bytes.length;
console.log(`\nінсталятор: ${exe.f}\n  → ${assetName}\n  розмір: ${(size / 1024 / 1024).toFixed(1)} МБ\n  sha256: ${sha256}`);

const metadata = {
  channel: CHANNEL,
  releaseVersion: version,
  stableVersion: version,
  platforms: {
    [PLATFORM_KEY]: {
      // Без `enabled: true` апдейтер відкидає платформу як «немає
      // сумісного артефакту» — і мовчки, це не помилка мережі.
      enabled: true,
      arch: 'x64',
      artifacts: {
        [ARTIFACT_KEY]: {
          url: `https://github.com/${REPO}/releases/download/${tag}/${assetName}`,
          name: assetName,
          size,
          sha256,
        },
      },
    },
  },
};
const metadataPath = path.join(OUT_DIR, 'metadata.json');
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
console.log(`\nстрічка: ${metadataPath}`);

if (dryRun) {
  console.log('\n--dry-run: реліз не створюю. Вміст стрічки:\n');
  console.log(JSON.stringify(metadata, null, 2));
  process.exit(0);
}

run('gh', [
  'release', 'create', tag,
  assetPath, metadataPath,
  '--repo', REPO,
  '--title', `Open Design ${version} (особиста збірка)`,
  '--notes', notes ?? `Особиста збірка ${version}. Встановлені копії побачать оновлення самі.`,
]);

console.log(`\n✔ реліз ${tag} опубліковано`);
console.log(`  стрічка: https://github.com/${REPO}/releases/latest/download/metadata.json`);
