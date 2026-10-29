// The typed IPC contract between the web view and the Rust shell (SPEC 7.4).
//
// - `Commands` maps every command name to its argument object and its result. Rust receives
//   the arguments as named (camelCase) fields and replies with camelCase JSON.
// - `COMMAND_INFO` says which commands exist in Rust today ("available") and which ones the
//   screens still need ("planned"), with the team that needs them. A planned command rejects with
//   `{ code: "unavailable" }` in the real app; the mock IPC implements most of them so screens
//   and Playwright specs can be built now. `contract.test.ts` checks this table against
//   src-tauri (lib.rs handlers and capabilities/main.json), so a command Rust adds must be
//   flipped to "available" here in the same change.
// - No secret ever travels from Rust to the web view: `has_secret` returns a boolean only.
//
// This file has no Tauri import; `ipc.ts` is the only one (boundary.test.ts).

import type {
  AppInfo,
  BackupKind,
  JournalRow,
  LockStatus,
  PickedBackup,
  RestoreSummary,
  RotationOutcome,
  StoredTrade,
} from "@dojix-desktop/core";

type NoArgs = Record<string, never>;

// --- shapes used by planned commands -----------------------------------------------------------

/** One change to the journal (SPEC 7.4 `journal_mutate`). Validated again in Rust. */
export type JournalMutation =
  | { kind: "add"; trade: NewTrade }
  | { kind: "edit"; id: number; fields: Partial<EditableTradeFields> }
  | { kind: "delete"; ids: number[] }
  | { kind: "deleteAll" }
  | { kind: "restoreDeleted"; token: string }
  | { kind: "notes"; id: number; notes: string }
  | { kind: "tags"; id: number; tags: string[] }
  | { kind: "emotion"; id: number; emotion: string | null }
  | { kind: "checklist"; id: number; checklist: Record<string, boolean> }
  | { kind: "costs"; id: number; commission: string; swap: string };

/** Manual entry (Add Trade). Money as decimal text; times as GRDB UTC text. */
export interface NewTrade {
  symbol: string;
  direction: "BUY" | "SELL";
  quantity: number;
  openTime: string;
  closeTime: string;
  openPrice: string;
  closePrice: string;
  sl: string;
  tp: string;
  commission: string;
  swap: string;
  notes: string;
  tags: string[];
}

export type EditableTradeFields = Pick<StoredTrade, "sl" | "tp" | "comment" | "notes" | "emotion">;

export interface MutationResult {
  /** Rows changed. */
  changed: number;
  /** For `delete` / `deleteAll`: pass to `restoreDeleted` within the undo window (5 s). */
  undoToken?: string;
}

export interface DataInfo {
  trades: number;
  sampleTrades: number;
  journalBytes: number;
}

export interface ScreenshotMeta {
  id: number;
  tradeId: number;
  createdAt: string;
}

export interface ScreenshotData {
  mime: "image/png" | "image/jpeg";
  /** Base64 bytes (shown through a blob: URL; CSP img-src allows blob:). */
  base64: string;
}

export type ImportOrigin = "manual" | "scan";

export interface ImportPreview {
  /** Opaque id of the picked files held in Rust (paths never reach the web view). */
  token: string;
  files: {
    fileName: string;
    format: string | null;
    estimatedTrades: number;
    needsMapping: boolean;
    headers: string[];
    sampleRows: string[][];
    skipped: string | null;
  }[];
}

export interface ColumnMapping {
  /** Target field → source column index. */
  columns: Record<string, number>;
  dateFormat: string;
}

export interface ImportResult {
  batchId: number;
  parsed: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  issues: { row: number; reason: string }[];
}

export interface ImportBatch extends ImportResult {
  source: string;
  origin: string;
  fileName: string | null;
  startedAt: string;
}

export interface MappingPreset {
  id: number;
  name: string;
  headerSignature: string;
  mapping: ColumnMapping;
}

export interface StrategyCheckpoint {
  id: number;
  date: string;
  title: string;
  description: string;
}

export type SecretName = "anthropic" | "finnhub" | "twelveData" | "polygon" | "oanda";

export interface ConnectionTest {
  ok: boolean;
  message: string;
}

export interface AiPreview {
  /** Exactly what would be sent ("what is sent" preview, SPEC 8.2). */
  text: string;
  model: string;
}

export interface AiReport {
  id: number;
  createdAt: string;
  model: string;
  responseText: string;
}

export interface Quote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  /** Epoch ms of the quote. */
  at: number;
}

export interface CompanyProfile {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  marketCap: number | null;
}

export interface EconomicEvent {
  id: string;
  at: number;
  currency: string;
  title: string;
  impact: "low" | "medium" | "high";
}

export interface Mt5Location {
  label: string;
  /** Shown to the user; the watcher itself stays in Rust. */
  displayPath: string;
  found: "auto" | "added";
}

export interface UpdateInfo {
  available: boolean;
  version: string | null;
  notes: string | null;
}

/** Saved files: the Save dialog opens in Rust and the chosen path stays there. */
export type ExportKind = "pdf" | "csv";

// --- the command map ---------------------------------------------------------------------------

export interface Commands {
  // Available on main (Phase 1 + security core).
  app_info: { args: NoArgs; result: AppInfo };
  journal_query: { args: { limit: number }; result: JournalRow[] };
  lock_status: { args: NoArgs; result: LockStatus };
  lock_unlock: { args: { password: string }; result: LockStatus };
  lock_setup: { args: { password: string; confirmation: string }; result: LockStatus };
  lock_enable: { args: { password: string; confirmation: string }; result: RotationOutcome };
  lock_change: { args: { current: string; password: string; confirmation: string }; result: RotationOutcome };
  lock_disable: { args: { password: string }; result: LockStatus };
  lock_now: { args: NoArgs; result: boolean };
  lock_activity: { args: NoArgs; result: null };
  older_copy_open: { args: { password: string | null; confirmed: boolean }; result: LockStatus };
  prefs_set_idle: { args: { minutes: number }; result: null };
  erase_all: { args: { confirmation: string }; result: LockStatus };
  save_retry: { args: NoArgs; result: null };
  app_quit: { args: { force: boolean }; result: null };
  backup_export: { args: { password: string | null; confirmation: string | null }; result: string | null };
  backup_pick: { args: NoArgs; result: PickedBackup | null };
  backup_restore: { args: { password: string | null }; result: RestoreSummary };

  // Planned: ui-journal.
  journal_trades: { args: NoArgs; result: StoredTrade[] };
  journal_mutate: { args: { mutation: JournalMutation }; result: MutationResult };
  checklist_rules_get: { args: NoArgs; result: string[] };
  checklist_rules_set: { args: { rules: string[] }; result: null };
  screenshot_add: { args: { tradeId: number }; result: ScreenshotMeta | null };
  screenshot_list: { args: { tradeId: number }; result: ScreenshotMeta[] };
  screenshot_get: { args: { id: number }; result: ScreenshotData };
  screenshot_delete: { args: { id: number }; result: null };
  export_save: { args: { kind: ExportKind; suggestedName: string; base64: string }; result: string | null };
  clipboard_write_temporary: { args: { text: string; clearAfterSeconds: number }; result: null };

  // Planned: ui-dashboard.
  settings_get: { args: { key: string }; result: unknown };
  settings_set: { args: { key: string; value: unknown }; result: null };
  prefs_get: { args: NoArgs; result: Record<string, unknown> };
  prefs_set: { args: { key: string; value: unknown }; result: null };
  checkpoints_list: { args: NoArgs; result: StrategyCheckpoint[] };
  checkpoints_add: { args: { date: string; title: string; description: string }; result: StrategyCheckpoint };
  checkpoints_delete: { args: { id: number }; result: null };

  // Planned: ui-tools (Edge Report, Import, Settings, Onboarding, Help, About).
  import_pick: { args: { mode: "files" | "folder" }; result: ImportPreview | null };
  import_preview_mapping: { args: { token: string; fileIndex: number; mapping: ColumnMapping }; result: StoredTrade[] };
  import_commit: { args: { token: string; mappings: Record<number, ColumnMapping> }; result: ImportResult[] };
  import_history: { args: NoArgs; result: ImportBatch[] };
  mapping_presets_list: { args: NoArgs; result: MappingPreset[] };
  mapping_presets_save: { args: { preset: Omit<MappingPreset, "id"> }; result: MappingPreset };
  sample_trades_load: { args: NoArgs; result: number };
  sample_trades_remove: { args: NoArgs; result: number };
  data_info: { args: NoArgs; result: DataInfo };
  open_data_folder: { args: NoArgs; result: null };
  diagnostics_export: { args: NoArgs; result: string | null };
  set_secret: { args: { name: SecretName; value: string }; result: null };
  has_secret: { args: { name: SecretName }; result: boolean };
  delete_secret: { args: { name: SecretName }; result: null };
  test_connection: { args: { name: SecretName }; result: ConnectionTest };
  ai_preview: { args: { scope: "edgeReport" | "dashboard" }; result: AiPreview };
  ai_run: { args: { scope: "edgeReport" | "dashboard" }; result: AiReport };
  ai_reports_list: { args: NoArgs; result: AiReport[] };
  updates_check: { args: NoArgs; result: UpdateInfo };
  open_external: { args: { url: string }; result: null };
  mt5_discover: { args: NoArgs; result: Mt5Location[] };
  mt5_watch_set: { args: { enabled: boolean }; result: null };

  // Planned: ui-brand (Pulse, Browse, Watchlist, sidebar ticker).
  watchlist_get: { args: NoArgs; result: string[] };
  watchlist_set: { args: { symbols: string[] }; result: null };
  quotes_get: { args: { symbols: string[] }; result: Quote[] };
  quotes_subscribe: { args: { symbols: string[] }; result: null };
  quotes_unsubscribe: { args: NoArgs; result: null };
  symbol_search: { args: { query: string }; result: { symbol: string; description: string }[] };
  company_profile: { args: { symbol: string }; result: CompanyProfile | null };
  calendar_week: { args: { weekStartMs: number }; result: EconomicEvent[] };
}

export type CommandName = keyof Commands;
export type ArgsOf<K extends CommandName> = Commands[K]["args"];
export type ResultOf<K extends CommandName> = Commands[K]["result"];
/** Commands without arguments are called as `call("lock_now")`. */
export type CallArgs<K extends CommandName> = ArgsOf<K> extends NoArgs ? [] : [ArgsOf<K>];

/** The teams of Phase 3 (docs/UI.md "Who builds what"). */
export type UiTeam = "foundation" | "ui-journal" | "ui-dashboard" | "ui-tools" | "ui-brand";

export interface CommandInfo {
  status: "available" | "planned";
  /** The screen team that needs it (for planned commands) or built it. */
  team: UiTeam;
  /** What it is for, in one line. */
  purpose: string;
}

export const COMMAND_INFO: Readonly<Record<CommandName, CommandInfo>> = {
  app_info: { status: "available", team: "foundation", purpose: "Start-up status: brand, version, storage state" },
  journal_query: { status: "available", team: "foundation", purpose: "Newest trades, 5 columns (Journal list of Phase 1)" },
  lock_status: { status: "available", team: "foundation", purpose: "Launch gate phase and App Lock state" },
  lock_unlock: { status: "available", team: "foundation", purpose: "Unlock with the App Lock password" },
  lock_setup: { status: "available", team: "foundation", purpose: "First password when no keyring exists" },
  lock_enable: { status: "available", team: "foundation", purpose: "Turn App Lock on (key rotation)" },
  lock_change: { status: "available", team: "foundation", purpose: "Change the App Lock password" },
  lock_disable: { status: "available", team: "foundation", purpose: "Turn App Lock off" },
  lock_now: { status: "available", team: "foundation", purpose: "Lock immediately" },
  lock_activity: { status: "available", team: "foundation", purpose: "Reset the idle-lock timer" },
  older_copy_open: { status: "available", team: "foundation", purpose: "Open an older copy after confirming" },
  prefs_set_idle: { status: "available", team: "foundation", purpose: "Lock-when-idle minutes" },
  erase_all: { status: "available", team: "foundation", purpose: "Erase all local data (forgotten password)" },
  save_retry: { status: "available", team: "foundation", purpose: "Retry a failed save" },
  app_quit: { status: "available", team: "foundation", purpose: "Quit (optionally discarding unsaved changes)" },
  backup_export: { status: "available", team: "foundation", purpose: "Export a backup (Save dialog in Rust)" },
  backup_pick: { status: "available", team: "foundation", purpose: "Pick a backup to restore (dialog in Rust)" },
  backup_restore: { status: "available", team: "foundation", purpose: "Restore the picked backup" },

  journal_trades: { status: "planned", team: "ui-journal", purpose: "Every trade as a full StoredTrade row, close time descending (Journal table, analytics worker)" },
  journal_mutate: { status: "planned", team: "ui-journal", purpose: "Add / edit / delete / notes / tags / emotion / checklist / costs; delete returns an undo token" },
  checklist_rules_get: { status: "planned", team: "ui-journal", purpose: "Checklist rules for trade detail toggles" },
  checklist_rules_set: { status: "planned", team: "ui-journal", purpose: "Edit the checklist rules" },
  screenshot_add: { status: "planned", team: "ui-journal", purpose: "Attach a screenshot (file dialog in Rust, sealed on disk)" },
  screenshot_list: { status: "planned", team: "ui-journal", purpose: "Screenshots of a trade" },
  screenshot_get: { status: "planned", team: "ui-journal", purpose: "Decrypted screenshot bytes for display" },
  screenshot_delete: { status: "planned", team: "ui-journal", purpose: "Remove a screenshot" },
  export_save: { status: "planned", team: "ui-journal", purpose: "Save a generated PDF/CSV through a Save dialog, owner-only file" },
  clipboard_write_temporary: { status: "planned", team: "ui-journal", purpose: "Copy a summary and clear the clipboard afterwards (SPEC 2.7)" },

  settings_get: { status: "planned", team: "ui-dashboard", purpose: "Journal settings table (prop-firm parameters, …)" },
  settings_set: { status: "planned", team: "ui-dashboard", purpose: "Write a journal setting" },
  prefs_get: { status: "planned", team: "ui-dashboard", purpose: "prefs.json (Essential/All, First Look, display zone, week start, …)" },
  prefs_set: { status: "planned", team: "ui-dashboard", purpose: "Write one preference" },
  checkpoints_list: { status: "planned", team: "ui-dashboard", purpose: "Strategy checkpoints (Advanced tab)" },
  checkpoints_add: { status: "planned", team: "ui-dashboard", purpose: "Add a strategy checkpoint" },
  checkpoints_delete: { status: "planned", team: "ui-dashboard", purpose: "Delete a strategy checkpoint" },

  import_pick: { status: "planned", team: "ui-tools", purpose: "Choose files / scan a folder (dialogs in Rust) and preview them" },
  import_preview_mapping: { status: "planned", team: "ui-tools", purpose: "Preview rows under a column mapping" },
  import_commit: { status: "planned", team: "ui-tools", purpose: "Import the previewed files; per-file results with skipped-row reasons" },
  import_history: { status: "planned", team: "ui-tools", purpose: "Import batches saved in the journal" },
  mapping_presets_list: { status: "planned", team: "ui-tools", purpose: "Column-mapping presets" },
  mapping_presets_save: { status: "planned", team: "ui-tools", purpose: "Save a column-mapping preset" },
  sample_trades_load: { status: "planned", team: "ui-tools", purpose: "Load the 30 fictional sample trades" },
  sample_trades_remove: { status: "planned", team: "ui-tools", purpose: "Remove only the sample trades" },
  data_info: { status: "planned", team: "ui-tools", purpose: "Trade count and journal size (Settings → Data)" },
  open_data_folder: { status: "planned", team: "ui-tools", purpose: "Open the data folder in the file manager" },
  diagnostics_export: { status: "planned", team: "ui-tools", purpose: "Export the redacted log bundle" },
  set_secret: { status: "planned", team: "ui-tools", purpose: "Store a provider key in the OS vault" },
  has_secret: { status: "planned", team: "ui-tools", purpose: "Whether a key is stored (never the key)" },
  delete_secret: { status: "planned", team: "ui-tools", purpose: "Remove a stored key" },
  test_connection: { status: "planned", team: "ui-tools", purpose: "Test a provider key" },
  ai_preview: { status: "planned", team: "ui-tools", purpose: "Exactly what an AI request would send" },
  ai_run: { status: "planned", team: "ui-tools", purpose: "Run the AI recommendation (user's key, opt-in)" },
  ai_reports_list: { status: "planned", team: "ui-tools", purpose: "Saved AI reports" },
  updates_check: { status: "planned", team: "ui-tools", purpose: "Check GitHub Releases for an update" },
  open_external: { status: "planned", team: "ui-tools", purpose: "Open an allow-listed https link (Report an issue, provider consoles)" },
  mt5_discover: { status: "planned", team: "ui-tools", purpose: "Found MT5 terminals for Settings (Dojix)" },
  mt5_watch_set: { status: "planned", team: "ui-tools", purpose: "Turn the opt-in MT5 watcher on or off (Dojix)" },

  watchlist_get: { status: "planned", team: "ui-brand", purpose: "Watchlist symbols (encrypted journal)" },
  watchlist_set: { status: "planned", team: "ui-brand", purpose: "Save the watchlist (validated symbols)" },
  quotes_get: { status: "planned", team: "ui-brand", purpose: "Latest quotes for symbols (user's provider key)" },
  quotes_subscribe: { status: "planned", team: "ui-brand", purpose: "Stream quotes as quote_tick events" },
  quotes_unsubscribe: { status: "planned", team: "ui-brand", purpose: "Stop streaming quotes" },
  symbol_search: { status: "planned", team: "ui-brand", purpose: "Ticker search (Browse, Greenwick)" },
  company_profile: { status: "planned", team: "ui-brand", purpose: "Company profile card (Browse, Greenwick)" },
  calendar_week: { status: "planned", team: "ui-brand", purpose: "Economic calendar week (Pulse, Dojix)" },
};

// --- events ------------------------------------------------------------------------------------

export interface ImportProgress {
  fileName: string;
  done: number;
  total: number;
}

export interface Events {
  /** Available: a save failed (true) or recovered (false). */
  save_failed: boolean;
  /** Available: the window was closed with unsaved changes. */
  unsaved_close: null;
  /** Available: the session locked (the shell also reloads the web view). */
  locked: null;
  /** Planned (ui-journal): any journal write; the UI refetches trades and analytics. */
  trades_changed: null;
  /** Planned (ui-tools). */
  import_progress: ImportProgress;
  /** Planned (ui-brand). */
  quote_tick: Quote;
}

export type EventName = keyof Events;

/** The whole boundary. `tauriIpc` (ipc.ts) and `createMockIpc` (mock/) implement it. */
export interface Ipc {
  call<K extends CommandName>(name: K, ...args: CallArgs<K>): Promise<ResultOf<K>>;
  /** Subscribes to a shell event; returns the unsubscribe function. */
  on<E extends EventName>(event: E, handler: (payload: Events[E]) => void): () => void;
}

/** The error a planned command rejects with until Rust implements it. */
export function unavailable(name: CommandName): { code: "unavailable"; message: string } {
  return { code: "unavailable", message: `This build can't do that yet (${name} is not implemented).` };
}

export type { BackupKind };
