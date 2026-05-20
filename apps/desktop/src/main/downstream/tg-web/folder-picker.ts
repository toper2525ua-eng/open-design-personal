// TG Web folder picker IPC handler.
//
// Unlike `dialog:pick-and-import` which is bound to a single atomic
// HMAC-gated import flow, this handler returns the raw chosen path back
// to the renderer so the user can configure where their local bot repo
// lives. The relaxed trust boundary is acceptable because the path is
// used by the TG Web deploy flow which the user initiates explicitly
// per-design-file, and the daemon's deploy endpoint validates the path
// independently (must exist + be a directory) before writing anything
// to it.

import { dialog, ipcMain } from "electron";

const IPC_CHANNEL = "dialog:tg-web-pick-folder";

export function registerTgWebFolderPicker(): void {
  // removeHandler before registering so dev hot-reload doesn't throw
  // "Attempted to register a second handler" on the second runtime init.
  ipcMain.removeHandler(IPC_CHANNEL);
  ipcMain.handle(
    IPC_CHANNEL,
    async (_event, init?: { initial?: string | null }) => {
      const defaultPath = typeof init?.initial === "string" && init.initial.length > 0
        ? init.initial
        : undefined;
      const result = await dialog.showOpenDialog({
        title: "Select your bot repo folder",
        properties: ["openDirectory"],
        ...(defaultPath ? { defaultPath } : {}),
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      const picked = result.filePaths[0].trim();
      if (picked.length === 0) {
        return { canceled: true };
      }
      return { path: picked };
    },
  );
}
