// Named bindings for the online commands (docs/ONLINE.md), over any `Ipc`: the shell's
// (`tauriOnlineIpc` in ipc.ts) or the mock's (`createOnlineIpc(mockIpc)`), so Pulse, Browse,
// Watchlist, Settings and the AI card run in the browser too. No method returns a key.

import type {
  AiPreview,
  AiReport,
  CalendarWeek,
  CompanyProfile,
  ModelInfo,
  OandaHistory,
  OnlineSettingsPatch,
  OnlineSettingsView,
  PriceTick,
  QuotesStatus,
  SecretAccount,
  StockQuote,
  StreamStatus,
  SymbolSearchResult,
  TestProvider,
  TestResult,
} from "@dojix-desktop/core";
import type { Ipc } from "./contract";

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

const done = async (p: Promise<unknown>): Promise<void> => {
  await p;
};

export function createOnlineIpc(ipc: Ipc): OnlineIpc {
  return {
    settings: () => ipc.call("online_settings_get"),
    updateSettings: (patch) => ipc.call("online_settings_set", { patch }),
    setSecret: (account, value) => done(ipc.call("set_secret", { account, value })),
    hasSecret: (account) => ipc.call("has_secret", { account }),
    deleteSecret: (account) => done(ipc.call("delete_secret", { account })),
    testConnection: (provider) => ipc.call("test_connection", { provider }),
    aiModels: () => ipc.call("ai_models"),
    aiPreview: (prompt) => ipc.call("ai_preview", { prompt }),
    aiRun: (prompt, requestSha256, consent) => ipc.call("ai_run", { prompt, requestSha256, consent }),
    aiReports: (limit) => ipc.call("ai_reports_list", { limit }),
    deleteAiReport: (id) => done(ipc.call("ai_report_delete", { id })),
    quotesStart: (symbols) => ipc.call("quotes_start", { symbols }),
    quotesStop: () => done(ipc.call("quotes_stop")),
    quotesStatus: () => ipc.call("quotes_status"),
    calendarWeek: (force) => ipc.call("calendar_week", { force }),
    finnhubQuote: (symbol) => ipc.call("finnhub_quote", { symbol }),
    finnhubProfile: (symbol) => ipc.call("finnhub_profile", { symbol }),
    finnhubSearch: (query) => ipc.call("finnhub_search", { query }),
    oandaFetchHistory: (days) => ipc.call("oanda_fetch_history", { days }),
    onQuoteTick: (handler) => ipc.on("quote_tick", handler),
    onQuoteStatus: (handler) => ipc.on("quote_status", handler),
  };
}
