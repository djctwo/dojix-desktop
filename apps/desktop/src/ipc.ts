// The ONLY module that talks to the Tauri shell. Everything else stays framework-free,
// so the UI can be tested with a mocked IPC and the shell could be swapped later.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AiPreview,
  AiReport,
  AppInfo,
  CalendarWeek,
  CompanyProfile,
  JournalRow,
  LockStatus,
  ModelInfo,
  OandaHistory,
  OnlineSettingsPatch,
  OnlineSettingsView,
  PickedBackup,
  PriceTick,
  QuotesStatus,
  RestoreSummary,
  RotationOutcome,
  SecretAccount,
  StockQuote,
  StreamStatus,
  SymbolSearchResult,
  TestProvider,
  TestResult,
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

// ---------------------------------------------------------------------------------------------
// Online features (SPEC 8; Rust: src-tauri/src/net/commands.rs). The web view never touches
// the network: every call below goes through the shell. No method returns a key.
// ---------------------------------------------------------------------------------------------

/** Price-stream events from the shell. */
export type OnlineEvent = "quote_tick" | "quote_status";

export interface OnlineIpc {
  settings(): Promise<OnlineSettingsView>;
  updateSettings(patch: OnlineSettingsPatch): Promise<OnlineSettingsView>;
  /** Stores a key in the OS credential vault. It can never be read back. */
  setSecret(account: SecretAccount, value: string): Promise<void>;
  hasSecret(account: SecretAccount): Promise<boolean>;
  deleteSecret(account: SecretAccount): Promise<void>;
  testConnection(provider: TestProvider): Promise<TestResult>;
  /** The provider's model list for the advanced picker. */
  aiModels(): Promise<ModelInfo[]>;
  /** The exact request a run would send (works without a key or the switch). */
  aiPreview(prompt: string): Promise<AiPreview>;
  /** Sends exactly the previewed request; `consent` is required on the first run. */
  aiRun(prompt: string, requestSha256: string, consent: boolean): Promise<AiReport>;
  aiReports(limit: number): Promise<AiReport[]>;
  deleteAiReport(id: number): Promise<void>;
  quotesStart(symbols: string[]): Promise<QuotesStatus>;
  quotesStop(): Promise<void>;
  quotesStatus(): Promise<QuotesStatus>;
  calendarWeek(force: boolean): Promise<CalendarWeek>;
  finnhubQuote(symbol: string): Promise<StockQuote>;
  finnhubProfile(symbol: string): Promise<CompanyProfile>;
  finnhubSearch(query: string): Promise<SymbolSearchResult[]>;
  /** OANDA import step 1 (map with `mapOandaTransactions`, then commit like any import). */
  oandaFetchHistory(days: number | null): Promise<OandaHistory>;
  onQuoteTick(handler: (tick: PriceTick) => void): () => void;
  onQuoteStatus(handler: (status: StreamStatus) => void): () => void;
}

function subscribe<T>(event: OnlineEvent, handler: (payload: T) => void): () => void {
  let stop: (() => void) | null = null;
  let cancelled = false;
  listen<T>(event, (e) => handler(e.payload))
    .then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    stop?.();
  };
}

export const tauriOnlineIpc: OnlineIpc = {
  settings: () => invoke<OnlineSettingsView>("online_settings_get"),
  updateSettings: (patch) => invoke<OnlineSettingsView>("online_settings_set", { patch }),
  setSecret: (account, value) => invoke<void>("set_secret", { account, value }),
  hasSecret: (account) => invoke<boolean>("has_secret", { account }),
  deleteSecret: (account) => invoke<void>("delete_secret", { account }),
  testConnection: (provider) => invoke<TestResult>("test_connection", { provider }),
  aiModels: () => invoke<ModelInfo[]>("ai_models"),
  aiPreview: (prompt) => invoke<AiPreview>("ai_preview", { prompt }),
  aiRun: (prompt, requestSha256, consent) => invoke<AiReport>("ai_run", { prompt, requestSha256, consent }),
  aiReports: (limit) => invoke<AiReport[]>("ai_reports_list", { limit }),
  deleteAiReport: (id) => invoke<void>("ai_report_delete", { id }),
  quotesStart: (symbols) => invoke<QuotesStatus>("quotes_start", { symbols }),
  quotesStop: () => invoke<void>("quotes_stop"),
  quotesStatus: () => invoke<QuotesStatus>("quotes_status"),
  calendarWeek: (force) => invoke<CalendarWeek>("calendar_week", { force }),
  finnhubQuote: (symbol) => invoke<StockQuote>("finnhub_quote", { symbol }),
  finnhubProfile: (symbol) => invoke<CompanyProfile>("finnhub_profile", { symbol }),
  finnhubSearch: (query) => invoke<SymbolSearchResult[]>("finnhub_search", { query }),
  oandaFetchHistory: (days) => invoke<OandaHistory>("oanda_fetch_history", { days }),
  onQuoteTick: (handler) => subscribe<PriceTick>("quote_tick", handler),
  onQuoteStatus: (handler) => subscribe<StreamStatus>("quote_status", handler),
};
