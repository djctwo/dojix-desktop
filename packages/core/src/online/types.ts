// Shapes exchanged with the Rust shell's online commands (SPEC 7.4 "Secrets and network",
// SPEC 8; Rust: apps/desktop/src-tauri/src/net/*). Pure types. No key ever crosses IPC toward
// the web view: the shell stores, tests for and deletes keys, and never returns one.

/** An error from an online command. `message` is written for the user. */
export interface NetError {
  /**
   * Stable codes: `off` (switched off), `no_key`, `invalid_key`, `rate_limited`, `unavailable`,
   * `timeout`, `offline`, `bad_response`, `too_large`, `blocked_host`, `invalid`, `vault`,
   * `locked`, `busy`, `refused`, `empty`, `consent_required`, `preview_mismatch`, `not_found`,
   * `stale`, `unsupported`, `http`, `store`, `read`, `prefs`.
   */
  code: string;
  message: string;
  /** Seconds the provider asked us to wait (HTTP Retry-After). */
  retryAfterSecs?: number;
}

/** The user's API keys, by vault account (SPEC 6.4). Dojix uses the first five, Greenwick
 * `anthropic_api_key` and `finnhub_api_key`. */
export type SecretAccount =
  | "anthropic_api_key"
  | "twelve_data_api_key"
  | "polygon_api_key"
  | "oanda_api_token"
  | "oanda_account_id"
  | "finnhub_api_key";

export const DOJIX_SECRET_ACCOUNTS: readonly SecretAccount[] = [
  "anthropic_api_key",
  "twelve_data_api_key",
  "polygon_api_key",
  "oanda_api_token",
  "oanda_account_id",
];
export const GREENWICK_SECRET_ACCOUNTS: readonly SecretAccount[] = ["anthropic_api_key", "finnhub_api_key"];

/** Where Pulse gets live prices (Dojix). `off` until the user picks one. */
export type LiveSource = "off" | "twelve_data_rest" | "twelve_data_ws" | "oanda_stream" | "polygon_ws" | "mt5_file";

export interface OnlineSettingsView {
  brand: "dojix" | "greenwick";
  /** "Allow AI analysis" (off by default). */
  aiEnabled: boolean;
  /** The model a run uses. */
  aiModel: string;
  aiDefaultModel: string;
  /** The user has agreed once to send the summary (the first run asks). */
  aiConsented: boolean;
  liveSource: LiveSource;
  oandaLive: boolean;
  /** Greenwick Browse/Watchlist quotes (off by default). */
  finnhubEnabled: boolean;
  /** Pulse's economic calendar (on by default). */
  calendarEnabled: boolean;
  calendarSource: string;
  oandaImportDays: number;
  /** account → stored. Never the key itself. */
  keys: Partial<Record<SecretAccount, boolean>>;
  /** False on Linux without a Secret Service: keys can't be stored. */
  keyringAvailable: boolean;
}

/** A partial update; absent fields keep their value. `aiModel: ""` resets to the default. */
export interface OnlineSettingsPatch {
  aiEnabled?: boolean;
  aiModel?: string;
  liveSource?: LiveSource;
  oandaLive?: boolean;
  finnhubEnabled?: boolean;
  calendarEnabled?: boolean;
  oandaImportDays?: number;
}

/** Settings → Test. */
export type TestProvider =
  | "anthropic"
  | "twelve_data"
  | "polygon"
  | "oanda_stream"
  | "oanda_import"
  | "finnhub"
  | "mt5_file";

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
}

/** "Show what will be sent": the exact request. */
export interface AiPreview {
  endpoint: string;
  model: string;
  /** [name, value]; the key's header shows a placeholder, never the key. */
  headers: [string, string][];
  /** The exact body bytes as text. */
  body: string;
  bodyPretty: string;
  /** Pass this to `aiRun`: the shell refuses to send anything else. */
  requestSha256: string;
  byteCount: number;
}

export interface AiReport {
  id: number;
  /** UTC, "YYYY-MM-DD HH:MM:SS.SSS". */
  createdAt: string;
  model: string;
  requestSha256: string;
  /** The exact request body that was sent. */
  requestPreview: string;
  responseText: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface PriceTick {
  /** Always "AAA/BBB" for currency pairs. */
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  timestampMs: number;
  /** Daily change in percent (Twelve Data polling only). */
  changePercent?: number;
}

export type StreamStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "reconnecting"; attempt: number }
  | { state: "error"; message: string };

export interface QuotesStatus {
  source: LiveSource;
  sourceLabel: string;
  symbols: string[];
  status: StreamStatus;
  latest: PriceTick[];
  /** Twelve Data credits left today (Twelve Data sources only). */
  creditsLeftToday?: number;
}

export type Impact = "low" | "medium" | "high";

export interface EconomicEvent {
  title: string;
  /** Currency code ("USD", "EUR", …). */
  country: string;
  timeMs: number;
  impact: Impact;
  actual?: string;
  forecast?: string;
  previous?: string;
}

export interface CalendarWeek {
  events: EconomicEvent[];
  fetchedAtMs: number;
  source: string;
  /** The last refresh failed; these are the previous events. */
  stale: boolean;
}

export interface StockQuote {
  symbol: string;
  currentPrice: number;
  change: number;
  percentChange: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: number;
}

export interface CompanyProfile {
  name: string;
  ticker: string;
  exchange: string;
  industry: string;
  /** Millions. */
  marketCap: number;
  /** Millions. */
  sharesOutstanding: number;
  ipo: string;
  country: string;
}

export interface SymbolSearchResult {
  description: string;
  displaySymbol: string;
  symbol: string;
  type: string;
}

/** OANDA import step 1; map with `decodeOandaPage` / `mapOandaTransactions` (importers). */
export interface OandaHistory {
  transactions: unknown[];
  pages: number;
  from: string;
}
