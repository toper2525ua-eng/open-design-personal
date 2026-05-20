// Electron-updater integration. The existing apps/desktop/src/main/updater.ts
// is mac-only (returns UNSUPPORTED on Windows). This downstream module wires
// `electron-updater` for Windows so the packaged app auto-pulls new builds
// from GitHub Releases without a re-install.
//
// Feed config is baked into the build by tools-pack via electron-builder's
// `publish` block (provider: github, owner: toper2525ua-eng,
// repo: open-design-personal) — electron-updater reads that from the
// generated `app-update.yml` shipped inside the .exe.

import { app, dialog } from "electron";

let registered = false;

export async function registerAutoUpdater(): Promise<void> {
  // Skip in non-packaged (dev) mode — there's no app to update there.
  if (!app.isPackaged) return;
  if (registered) return;
  registered = true;

  // electron-updater is loaded dynamically so dev mode (where the package
  // may not be installed yet) doesn't crash on import.
  let autoUpdaterModule: typeof import("electron-updater") | null = null;
  try {
    autoUpdaterModule = await import("electron-updater");
  } catch (err) {
    // Module missing — log and skip silently. Build process should add it
    // as a dependency; if it's gone, fall back to no-update behavior.
    console.warn("[downstream/auto-updater] electron-updater not available:", err instanceof Error ? err.message : String(err));
    return;
  }

  const { autoUpdater } = autoUpdaterModule;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    console.log("[downstream/auto-updater] update available:", info.version);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    console.log("[downstream/auto-updater] update downloaded:", info.version);
    const result = await dialog.showMessageBox({
      type: "info",
      title: "Open Design — оновлення готове",
      message: `Завантажено нову версію ${info.version}.`,
      detail: "Перезапустіть Open Design, щоб застосувати оновлення.",
      buttons: ["Перезапустити зараз", "Пізніше"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    console.warn("[downstream/auto-updater] update error:", err.message);
  });

  // Kick off the first check after the app has settled. checkForUpdates
  // returns a Promise that resolves once metadata is fetched; we swallow
  // errors because the user shouldn't see a popup for transient network
  // issues — the next check (in 30 min) will retry.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[downstream/auto-updater] initial check failed:", err.message);
    });
  }, 10_000);

  // Re-check every 30 minutes so long-running sessions pick up new
  // releases without needing a restart.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // ignore — periodic check, no need to surface errors
    });
  }, 30 * 60 * 1000);
}
