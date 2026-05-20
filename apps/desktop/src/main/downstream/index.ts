// Desktop downstream barrel. Wires up every downstream IPC handler in
// one place so apps/desktop/src/main/runtime.ts touches only this single
// import.

import { registerAutoUpdater } from "./auto-updater.js";
import { registerTgWebFolderPicker } from "./tg-web/folder-picker.js";

export function registerDesktopDownstreamHandlers(): void {
  registerTgWebFolderPicker();
  registerAutoUpdater();
}
