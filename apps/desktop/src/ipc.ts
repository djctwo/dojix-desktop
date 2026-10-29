// The ONLY module that talks to the Tauri shell. Everything else stays framework-free,
// so the UI can be tested with a mocked IPC and the shell could be swapped later.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppInfo,
  JournalRow,
  LockStatus,
  Mt5ImportOutcome,
  Mt5ImportSummary,
  Mt5Location,
  Mt5Status,
  PickedBackup,
  RestoreSummary,
  RotationOutcome,
} from "@dojix-desktop/core";

/**
 * Events the shell sends: a save failed or recovered, a close with unsaved changes; MT5 files
 * queued for import (payload: the queue length), an MT5 file handled (`Mt5ImportSummary`),
 * and trades added outside the UI.
 */
export type ShellEvent = "save_failed" | "unsaved_close" | "mt5_file_ready" | "mt5_imported" | "trades_changed";

/** MT5 auto-import (Dojix; Greenwick rejects every call with `unsupported`). See docs/MT5.md. */
export interface Mt5Ipc {
  /** Every MT5 folder found, plus the user's own, each with a preview. Nothing is watched until enabled. */
  mt5Discover(): Promise<Mt5Location[]>;
  /** The watcher's state; also (re)starts it for the enabled folders after an unlock. */
  mt5Status(): Promise<Mt5Status>;
  /** Turns auto-import on or off for one listed folder. */
  mt5WatchSet(id: string, enabled: boolean): Promise<Mt5Status>;
  /** "Add folder…" (the dialog opens in the shell). Listed, not yet watched. `null` when cancelled. */
  mt5AddFolder(): Promise<Mt5Location | null>;
  /** Removes a folder the user added (and stops watching it). */
  mt5RemoveFolder(id: string): Promise<Mt5Status>;
  /** The 32-column export's file-name prefix; `null` restores the default. */
  mt5SetPrefix(prefix: string | null): Promise<Mt5Status>;
  /** Looks at the enabled folders now. */
  mt5Rescan(): Promise<Mt5Status>;
  /** The bytes of a queued file. */
  mt5Read(token: number): Promise<Uint8Array>;
  /** Commits what the importer made of a queued file. */
  mt5ImportCommit(token: number, outcome: Mt5ImportOutcome): Promise<Mt5ImportSummary>;
}

export interface Ipc extends Mt5Ipc {
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

/** A raw command response: an ArrayBuffer (IPC protocol) or a number array (JSON fallback). */
function bytesOf(raw: ArrayBuffer | number[]): Uint8Array {
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
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
  mt5Discover: () => invoke<Mt5Location[]>("mt5_discover"),
  mt5Status: () => invoke<Mt5Status>("mt5_status"),
  mt5WatchSet: (id, enabled) => invoke<Mt5Status>("mt5_watch_set", { id, enabled }),
  mt5AddFolder: () => invoke<Mt5Location | null>("mt5_add_folder"),
  mt5RemoveFolder: (id) => invoke<Mt5Status>("mt5_remove_folder", { id }),
  mt5SetPrefix: (prefix) => invoke<Mt5Status>("mt5_set_prefix", { prefix }),
  mt5Rescan: () => invoke<Mt5Status>("mt5_rescan"),
  mt5Read: async (token) => bytesOf(await invoke<ArrayBuffer | number[]>("mt5_read", { token })),
  mt5ImportCommit: (token, outcome) => invoke<Mt5ImportSummary>("mt5_import_commit", { token, outcome }),
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
