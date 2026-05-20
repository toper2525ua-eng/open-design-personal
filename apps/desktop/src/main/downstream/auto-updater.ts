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

async function checkOnce(): Promise<void> {
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
  if (result.response !== 0) return;

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

  // Generate a self-deleting batch that swaps the install dir + relaunches.
  // Windows can't replace a running executable, so we wait for THIS process
  // to exit, then robocopy from staging into the install dir.
  //
  // Robocopy is used instead of xcopy because the Next.js standalone bundle
  // has paths well past Windows' MAX_PATH (260 chars), and xcopy fails with
  // "Insufficient memory" on those. Robocopy handles long paths natively
  // and supports up to ~32k-char paths via the kernel extended-length APIs.
  //
  // Robocopy exit codes are bit flags, not POSIX-style. Codes 0-7 are OK
  // (files copied, mismatched, extra files etc.). Code 8+ means real
  // failure. We treat >= 8 as fatal.
  //
  // The batch also writes a log file so post-mortem diagnosis works even
  // if the spawned cmd window is invisible — never pause/wait for input.
  const batchPath = join(tmpRoot, `od-update-${Date.now()}.bat`);
  const logPath = join(tmpRoot, `od-update-${Date.now()}.log`);
  const script =
    `@echo off\r\n` +
    `chcp 65001 >nul\r\n` +
    `echo [%date% %time%] update batch started > "${logPath}"\r\n` +
    `set /a waited=0\r\n` +
    `:wait_for_exit\r\n` +
    `tasklist /FI "IMAGENAME eq Open Design.exe" 2>nul | find /I "Open Design.exe" >nul\r\n` +
    `if not errorlevel 1 (\r\n` +
    `  if %waited% GEQ 60 (\r\n` +
    `    echo [%date% %time%] timeout waiting for Open Design.exe; killing >> "${logPath}"\r\n` +
    `    taskkill /F /IM "Open Design.exe" >nul 2>&1\r\n` +
    `    timeout /t 1 /nobreak >nul\r\n` +
    `    goto do_copy\r\n` +
    `  )\r\n` +
    `  set /a waited=waited+1\r\n` +
    `  timeout /t 1 /nobreak >nul\r\n` +
    `  goto wait_for_exit\r\n` +
    `)\r\n` +
    `:do_copy\r\n` +
    `echo [%date% %time%] starting robocopy >> "${logPath}"\r\n` +
    `robocopy "${unpackedDir}" "${installDir}" /E /MT:8 /R:3 /W:1 /NP /NJH /NJS /NDL /NFL >> "${logPath}" 2>&1\r\n` +
    `set RC=%ERRORLEVEL%\r\n` +
    `echo [%date% %time%] robocopy exit %RC% >> "${logPath}"\r\n` +
    `if %RC% GEQ 8 (\r\n` +
    `  echo [%date% %time%] robocopy failed, aborting >> "${logPath}"\r\n` +
    `  exit /b 1\r\n` +
    `)\r\n` +
    `echo [%date% %time%] launching new app >> "${logPath}"\r\n` +
    `start "" "${exePath}"\r\n` +
    `rmdir /S /Q "${stagingDir}" 2>nul\r\n` +
    `(goto) 2>nul & del /F /Q "%~f0"\r\n`;
  await writeFile(batchPath, script, "utf-8");

  // Run the batch detached so it survives our exit, then quit so the
  // batch's wait-loop unblocks and the swap can start.
  spawn("cmd.exe", ["/c", "start", "/min", "", batchPath], {
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

  setTimeout(() => {
    void checkOnce();
  }, FIRST_CHECK_DELAY_MS);

  setInterval(() => {
    void checkOnce();
  }, POLL_INTERVAL_MS);
}
