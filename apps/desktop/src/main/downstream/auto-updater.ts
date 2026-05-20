// Custom GitHub-Releases-based auto-updater that bypasses Windows Smart App
// Control entirely. Instead of downloading and executing a fresh installer
// .exe (which SAC blocks because we don't ship a code-signing certificate),
// we download the win-unpacked ZIP from the release, swap the unpacked
// files in place under the existing trusted `Open Design.exe`, then relaunch.
//
// SAC trust model:
// - The currently-installed `Open Design.exe` has earned trust through
//   actual user invocation (first install was a direct file-copy, not a
//   downloaded installer execution).
// - Updating only the bytes of the inner JS bundle and supporting files
//   leaves the executable's identity unchanged from SAC's perspective.
// - We never launch a freshly-downloaded executable, so SAC's "block
//   unsigned downloaded binaries" rule never fires.
//
// This deliberately replaces the standard `electron-updater` flow. The
// library is still imported elsewhere but its NsisUpdater path would hit
// SAC and silently fail — using a homegrown poller is more honest.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { app, dialog } from "electron";

const REPO = "toper2525ua-eng/open-design-personal";
const POLL_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 10_000;
const ZIP_ASSET_SUFFIX = "-win-unpacked.zip";
const STATE_FILE_NAME = "auto-updater-state.json";

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GithubRelease {
  tag_name: string;
  name: string;
  assets: GithubReleaseAsset[];
}

function parseTag(tag: string): number[] | null {
  // Accept "v0.8.0-5", "0.8.0", "v0.8.0" — keep build-suffix as the 4th part
  // so e.g. v0.8.0-6 ranks higher than v0.8.0-5.
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
}

function isNewer(remote: number[], local: number[]): boolean {
  for (let i = 0; i < Math.max(remote.length, local.length); i++) {
    const r = remote[i] ?? 0;
    const l = local[i] ?? 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

async function fetchLatestRelease(): Promise<GithubRelease | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "user-agent": "Open-Design-Personal-Updater" },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as GithubRelease;
  } catch {
    return null;
  }
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url, {
    headers: { "user-agent": "Open-Design-Personal-Updater" },
  });
  if (!resp.ok || !resp.body) throw new Error(`download HTTP ${resp.status}`);
  await mkdir(dirname(destPath), { recursive: true });
  // resp.body is a Web ReadableStream; convert to Node stream for pipeline.
  await pipeline(
    Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destPath),
  );
}

async function unzipWithTar(zipPath: string, destDir: string): Promise<void> {
  // Windows 10+ ships `tar.exe` which handles ZIPs natively. No extra deps.
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("tar", ["-xf", zipPath, "-C", destDir], { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

let registered = false;
let lastNotifiedTag: string | null = null;
let statePath: string | null = null;
let hydrationDone: Promise<void> = Promise.resolve();

// Persist the "Later"-dismissed release tag across app restarts so the user
// doesn't get re-prompted for the same release ~10s after every launch.
// Newer releases break out automatically (their tag won't match this one).
async function hydrateDismissedTag(): Promise<void> {
  if (!statePath) return;
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as { dismissedTag?: unknown };
    if (typeof parsed.dismissedTag === "string") {
      lastNotifiedTag = parsed.dismissedTag;
    }
  } catch {
    // No state file yet, or unreadable — start clean.
  }
}

async function persistDismissedTag(tag: string): Promise<void> {
  if (!statePath) return;
  try {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ dismissedTag: tag }), "utf-8");
  } catch (err) {
    console.warn(`[auto-updater] failed to persist dismissed tag: ${String(err)}`);
  }
}

async function checkOnce(): Promise<void> {
  await hydrationDone;
  const release = await fetchLatestRelease();
  if (!release) return;
  const remoteVersion = parseTag(release.tag_name);
  if (!remoteVersion) return;
  const localVersion = parseTag(`v${app.getVersion()}`);
  if (!localVersion) return;
  if (!isNewer(remoteVersion, localVersion)) return;
  if (lastNotifiedTag === release.tag_name) return;
  lastNotifiedTag = release.tag_name;

  const zipAsset = release.assets.find((a) => a.name.endsWith(ZIP_ASSET_SUFFIX));
  if (!zipAsset) {
    console.warn(`[auto-updater] release ${release.tag_name} has no *${ZIP_ASSET_SUFFIX} asset`);
    return;
  }

  const result = await dialog.showMessageBox({
    type: "info",
    title: "Open Design — доступне оновлення",
    message: `Нова версія ${release.tag_name}`,
    detail: `Поточна: ${app.getVersion()}. Завантажити і встановити зараз?`,
    buttons: ["Так, оновити", "Пізніше"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response !== 0) {
    // User chose "Later" — remember it on disk so a quick relaunch (or any
    // restart while this release is still latest) doesn't re-pester them.
    await persistDismissedTag(release.tag_name);
    return;
  }

  try {
    await applyUpdate(zipAsset);
  } catch (err) {
    await dialog.showMessageBox({
      type: "error",
      title: "Open Design — помилка оновлення",
      message: "Не вдалося завершити оновлення.",
      detail: err instanceof Error ? err.message : String(err),
      buttons: ["OK"],
    });
  }
}

async function applyUpdate(zipAsset: GithubReleaseAsset): Promise<void> {
  const exePath = app.getPath("exe");
  const installDir = dirname(exePath);
  const tmpRoot = app.getPath("temp");
  const stagingDir = join(tmpRoot, `open-design-update-${Date.now()}`);
  const zipPath = join(stagingDir, "win-unpacked.zip");
  const unpackedDir = join(stagingDir, "win-unpacked");

  await mkdir(stagingDir, { recursive: true });
  await downloadFile(zipAsset.browser_download_url, zipPath);
  await unzipWithTar(zipPath, unpackedDir);

  // Generate a self-deleting batch that swaps the resources/ dir +
  // relaunches the existing executable. We force-kill the running app
  // up-front (a previous `tasklist /FI` poll approach was unreliable for
  // image names with spaces) and only ever update the resources/ tree —
  // never the .exe or DLLs at the install root.
  //
  // Why skip the .exe: Windows 11 Smart App Control blocks ANY unsigned
  // executable that came from the internet, including .exe files extracted
  // from a ZIP we downloaded via GitHub Releases. The currently-installed
  // Open Design.exe has earned local trust from prior launches; replacing
  // its bytes with a freshly-downloaded copy makes SAC re-evaluate it,
  // and the new copy gets blocked with no recovery path short of code
  // signing or disabling SAC (which requires reinstalling Windows). Since
  // Open Design.exe is just the Electron launcher and all of our actual
  // app code lives under resources/app/prebundled/ + resources/open-
  // design-web-standalone/, leaving the .exe untouched is invisible to
  // the user but bypasses SAC entirely.
  //
  // Robocopy handles long paths natively (the bundled Next.js standalone
  // has paths past Windows' MAX_PATH 260-char limit, which broke xcopy
  // with "Insufficient memory"). Robocopy exit codes 0-7 are non-fatal;
  // 8+ means actual failure.
  const batchPath = join(tmpRoot, `od-update-${Date.now()}.bat`);
  const logPath = join(tmpRoot, `od-update-${Date.now()}.log`);
  const srcResources = join(unpackedDir, "resources");
  const destResources = join(installDir, "resources");
  const script =
    `@echo off\r\n` +
    `chcp 65001 >nul\r\n` +
    `echo [%date% %time%] update batch started > "${logPath}"\r\n` +
    `echo [%date% %time%] force-killing any running Open Design >> "${logPath}"\r\n` +
    `taskkill /F /IM "Open Design.exe" >nul 2>&1\r\n` +
    `timeout /t 2 /nobreak >nul\r\n` +
    `echo [%date% %time%] starting robocopy resources/ -> resources/ >> "${logPath}"\r\n` +
    `robocopy "${srcResources}" "${destResources}" /E /MT:8 /R:3 /W:1 /NP /NJH /NJS /NDL /NFL >> "${logPath}" 2>&1\r\n` +
    `set RC=%ERRORLEVEL%\r\n` +
    `echo [%date% %time%] robocopy exit %RC% >> "${logPath}"\r\n` +
    `if %RC% GEQ 8 (\r\n` +
    `  echo [%date% %time%] robocopy failed, aborting >> "${logPath}"\r\n` +
    `  exit /b 1\r\n` +
    `)\r\n` +
    `echo [%date% %time%] launching app >> "${logPath}"\r\n` +
    `start "" "${exePath}"\r\n` +
    `rmdir /S /Q "${stagingDir}" 2>nul\r\n` +
    `(goto) 2>nul & del /F /Q "%~f0"\r\n`;
  await writeFile(batchPath, script, "utf-8");

  // Run the batch detached so it survives our exit. windowsHide + the
  // direct `cmd /c batchPath` invocation (no intermediate `start /min`
  // wrapper) means no console window flashes for the user during the
  // update. The batch redirects all output to a log file, so the only
  // visible window throughout the swap is the relaunched app itself.
  spawn("cmd.exe", ["/c", batchPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();

  // Small delay to ensure cmd has handed off control.
  setTimeout(() => app.quit(), 500);
}

export function registerAutoUpdater(): void {
  // Skip in non-packaged (dev) mode — there's no installed app to update.
  if (!app.isPackaged) return;
  if (registered) return;
  registered = true;

  statePath = join(app.getPath("userData"), STATE_FILE_NAME);
  hydrationDone = hydrateDismissedTag();

  setTimeout(() => {
    void checkOnce();
  }, FIRST_CHECK_DELAY_MS);

  setInterval(() => {
    void checkOnce();
  }, POLL_INTERVAL_MS);
}
