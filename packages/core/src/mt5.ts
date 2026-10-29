// MT5 auto-import (Dojix): the shapes the Rust shell's `mt5_*` commands exchange with the UI
// (SPEC §5.4; docs/MT5.md). Pure types.

/** What kind of folder an MT5 location is. */
export type Mt5LocationKind = "common" | "terminal" | "portable" | "custom";

/** A file in a location's preview (shown before the folder is enabled). */
export interface Mt5PreviewFile {
  fileName: string;
  size: number;
  modifiedMs: number;
  /** `trade_file` would be imported; `other_csv` never is. */
  kind: "trade_file" | "other_csv";
}

/** A folder MT5 writes files to (`mt5_discover`). */
export interface Mt5Location {
  /** Stable id derived from the path; pass it back to `mt5_watch_set` / `mt5_remove_folder`. */
  id: string;
  kind: Mt5LocationKind;
  /** "All terminals (Common\Files)", the broker's install-folder name from origin.txt, … */
  label: string;
  path: string;
  /** The 32-hex terminal data folder name (terminal locations). */
  terminalId: string | null;
  /** The install folder from origin.txt (terminal) or the install folder itself (portable). */
  installPath: string | null;
  /** The Wine prefix (Linux). */
  winePrefix: string | null;
  /** False when the folder doesn't exist yet (MT5 creates Common\Files on first use). */
  exists: boolean;
  /** Being watched (auto-import on for this folder). */
  enabled: boolean;
  tradeFiles: number;
  otherCsvFiles: number;
  /** Newest trade files first, then other CSVs; at most 20. */
  preview: Mt5PreviewFile[];
}

export type Mt5FolderState = "watching" | "polling" | "missing";

export interface Mt5FolderStatus {
  id: string;
  label: string;
  path: string;
  state: Mt5FolderState;
}

export type Mt5FileState =
  | "waiting"
  | "partial"
  | "busy"
  | "pending"
  | "imported"
  | "unchanged"
  | "deleted"
  | "not_trade_file"
  | "failed"
  | "denied"
  | "too_large";

export interface Mt5FileStatus {
  folderId: string;
  fileName: string;
  state: Mt5FileState;
  detail: string | null;
  atMs: number;
}

/** A file read and queued for import. */
export interface Mt5PendingFile {
  token: number;
  folderId: string;
  fileName: string;
  size: number;
}

export type Mt5ImportResult = "imported" | "not_trade_file" | "failed";

/** The result of one handled file (`mt5_import_commit`, the `mt5_imported` event). */
export interface Mt5ImportSummary {
  fileName: string;
  folderId: string;
  format: string | null;
  result: Mt5ImportResult;
  message: string | null;
  parsed: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  atMs: number;
}

/** The watcher's state (`mt5_status`). */
export interface Mt5Status {
  /** True while at least one folder is watched. */
  active: boolean;
  /** The 32-column export's file-name prefix. */
  prefix32: string;
  folders: Mt5FolderStatus[];
  /** Newest first. */
  files: Mt5FileStatus[];
  pending: Mt5PendingFile[];
  lastImport: Mt5ImportSummary | null;
}

/** One row issue as the importer reports it (`RowIssue`). */
export interface Mt5RowIssue {
  line: number | null;
  code: string;
  reason: string;
}

/**
 * What the web view made of a queued file (`mt5_import_commit`). `trades` are the importer's
 * `ImportedTrade` rows; the shell checks every one again before storing it.
 */
export type Mt5ImportOutcome =
  | {
      kind: "trades";
      format: "mt5_32col" | "dojix_export" | "mt5_report";
      trades: readonly object[];
      parsed: number;
      duplicatesInFile: number;
      issues: readonly Mt5RowIssue[];
    }
  | { kind: "not_trade_file"; format: string }
  | { kind: "error"; code: string; message: string };
