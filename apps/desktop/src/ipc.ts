// The ONLY module that talks to the Tauri shell. Everything else stays framework-free,
// so the UI can be tested with a mocked IPC and the shell could be swapped later.
import { invoke } from "@tauri-apps/api/core";
import type { AppInfo, JournalRow } from "@dojix-desktop/core";

export interface Ipc {
  appInfo(): Promise<AppInfo>;
  listTrades(limit: number): Promise<JournalRow[]>;
}

export const tauriIpc: Ipc = {
  appInfo: () => invoke<AppInfo>("app_info"),
  listTrades: (limit) => invoke<JournalRow[]>("journal_query", { limit }),
};
