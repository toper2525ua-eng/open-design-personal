// Desktop downstream barrel. Wires up every downstream IPC handler in
// one place so apps/desktop/src/main/runtime.ts touches only this single
// import.

import { registerAutoUpdater } from "./auto-updater.js";
import { registerTgWebFolderPicker } from "./tg-web/folder-picker.js";

export function registerDesktopDownstreamHandlers(): void {
  registerTgWebFolderPicker();
  // Auto-updater is async (dynamic-imports electron-updater) but we don't
  // need to await it — the function self-bootstraps a periodic check.
  void registerAutoUpdater();
}
