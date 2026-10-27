// The ONLY module that talks to the Tauri shell. Everything else stays framework-free,
// so the UI can be tested with a mocked IPC and the shell could be swapped later.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppInfo,
  JournalRow,
  LockStatus,
  PickedBackup,
  RestoreSummary,
  RotationOutcome,
} from "@dojix-desktop/core";

/** Events the shell sends: a save failed or recovered, a close with unsaved changes. */
export type ShellEvent = "save_failed" | "unsaved_close";

export interface Ipc {
  appInfo(): Promise<AppInfo>;
  listTrades(limit: number): Promise<JournalRow[]>;
  lockStatus(): Promise<LockStatus>;
  unlock(password: string): Promise<LockStatus>;
  setupPassword(password: string, confirmation: string): Promise<LockStatus>;
  enableLock(password: string, confirmation: string): Promise<RotationOutcome>;
  changePassword(current: string, password: string, confirmation: string): Promise<RotationOutcome>;
  disableLock(password: string): Promise<LockStatus>;
  lockNow(): Promise<boolean>;
  /** User input in the window (the caller throttles it). */
  activity(): void;
  openOlderCopy(password: string | null, confirmed: boolean): Promise<LockStatus>;
  setIdleMinutes(minutes: number): Promise<void>;
  eraseAll(confirmation: string): Promise<LockStatus>;
  saveRetry(): Promise<void>;
  quit(force: boolean): Promise<void>;
  exportBackup(password: string | null, confirmation: string | null): Promise<string | null>;
  pickBackup(): Promise<PickedBackup | null>;
  restoreBackup(password: string | null): Promise<RestoreSummary>;
  /** Subscribes to a shell event; returns the unsubscribe function. */
  onEvent(event: ShellEvent, handler: (payload: unknown) => void): () => void;
}

export const tauriIpc: Ipc = {
  appInfo: () => invoke<AppInfo>("app_info"),
  listTrades: (limit) => invoke<JournalRow[]>("journal_query", { limit }),
  lockStatus: () => invoke<LockStatus>("lock_status"),
  unlock: (password) => invoke<LockStatus>("lock_unlock", { password }),
  setupPassword: (password, confirmation) =>
    invoke<LockStatus>("lock_setup", { password, confirmation }),
  enableLock: (password, confirmation) =>
    invoke<RotationOutcome>("lock_enable", { password, confirmation }),
  changePassword: (current, password, confirmation) =>
    invoke<RotationOutcome>("lock_change", { current, password, confirmation }),
  disableLock: (password) => invoke<LockStatus>("lock_disable", { password }),
  lockNow: () => invoke<boolean>("lock_now"),
  activity: () => {
    invoke("lock_activity").catch(() => undefined);
  },
  openOlderCopy: (password, confirmed) =>
    invoke<LockStatus>("older_copy_open", { password, confirmed }),
  setIdleMinutes: (minutes) => invoke<void>("prefs_set_idle", { minutes }),
  eraseAll: (confirmation) => invoke<LockStatus>("erase_all", { confirmation }),
  saveRetry: () => invoke<void>("save_retry"),
  quit: (force) => invoke<void>("app_quit", { force }),
  exportBackup: (password, confirmation) =>
    invoke<string | null>("backup_export", { password, confirmation }),
  pickBackup: () => invoke<PickedBackup | null>("backup_pick"),
  restoreBackup: (password) => invoke<RestoreSummary>("backup_restore", { password }),
  onEvent: (event, handler) => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    listen(event, (e) => handler(e.payload))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  },
};
