// The importers' data model.
//
// Parsers build *Mac trades*: the Swift `Trade` structs field for field (Decimal money, Date
// instants, Int64 tickets), so every Mac rule (sanitize, tickets, R) runs on the same values the
// Mac sees. `toImportedTrade` then turns a Mac trade into a desktop journal row (SPEC §4.1).

import type { BrandId, BiasAlignment, CompatMode, MarketSession, StoredTrade, SwiftDecimal, TradeDirection, TradingSession, VolatilityRegime } from "@dojix-desktop/core";

export type { CompatMode };

/** `trades.source` values the importers produce (SPEC §4.1). */
export type ImportSource =
  | "mt5_32col"
  | "dojix_export"
  | "mt5_report"
  | "mt4"
  | "ctrader"
  | "tradingview"
  | "oanda_csv"
  | "oanda_api"
  | "ibkr"
  | "tos"
  | "ninjatrader"
  | "webull"
  | "robinhood"
  | "schwab"
  | "fidelity"
  | "etrade"
  | "tastytrade"
  | "generic"
  | "mac_backup";

/** Everything an import depends on besides the bytes. */
export interface ImportContext {
  brand: BrandId;
  /** `fixed` (what the app ships) applies the PARITY.md fixes; `swift` reproduces the Mac. */
  compat: CompatMode;
  /** "Now" (epoch ms): importedAt, two-digit years, the OANDA ticket fallback. */
  now: number;
}

/** Fields both Mac trades share (Swift names). */
interface MacTradeCommon {
  /** Swift Int64. */
  ticket: bigint;
  symbol: string;
  direction: TradeDirection;
  /** Epoch ms. */
  openTime: number;
  closeTime: number;
  durationMin: number;
  openPrice: SwiftDecimal;
  closePrice: SwiftDecimal;
  sl: SwiftDecimal;
  tp: SwiftDecimal;
  netProfit: SwiftDecimal;
  rMultiple: number;
  dayOfWeek: string;
  hour: number;
  rangeSize: number;
  hitBreakeven: boolean;
  scaledIn: boolean;
  comment: string;
  timeToMFEMin: number;
  notes: string;
  tags: string;
  emotion: string;
  screenshots: string;
  checklistData: string;
  commission: SwiftDecimal;
  swap: SwiftDecimal;
}

/** Dojix `Models/Trade.swift:5-64`. */
export interface DojixMacTrade extends MacTradeCommon {
  brand: "dojix";
  lots: number;
  maePips: number;
  mfePips: number;
  session: TradingSession;
  sweepDepth: number;
  usedFVG: boolean;
  volRegime: VolatilityRegime;
  magic: number;
  slDistPips: number;
  slippagePips: number;
  postClose15m: number;
  postClose30m: number;
  biasAtEntry: BiasAlignment;
}

/** Greenwick `Models/Trade.swift:5-68`. */
export interface GreenwickMacTrade extends MacTradeCommon {
  brand: "greenwick";
  shares: number;
  maePoints: number;
  mfePoints: number;
  session: MarketSession;
  slDistPoints: number;
  slippagePoints: number;
  sector: string;
  industry: string;
  volume: number;
  avgVolume: number;
  isSample: boolean;
}

export type MacTrade = DojixMacTrade | GreenwickMacTrade;

/** What the desktop knows about a parsed row beyond the Mac struct. */
export interface RowMeta {
  source: ImportSource;
  /** 1-based line in the decoded file (null for API / backup rows). */
  line: number | null;
  /** Broker id shown in the UI only (Trade #, order number, position id …). */
  externalId: string | null;
  /** MAE / MFE came from the file (false → NULL in `fixed` mode, D-18). */
  maeKnown: boolean;
  mfeKnown: boolean;
  /** Forex strategy fields (range, sweep, FVG, regime, bias) are known; DojixExport leaves them empty (→ NULL). */
  strategyKnown: boolean;
  timeBasis: "utc" | "broker";
  /** Trading account named by the file (DojixExport `Account`), for the accounts table. */
  account?: string;
}

/** A parsed trade: the Mac struct plus desktop metadata. */
export interface ParsedRow<T extends MacTrade = MacTrade> {
  trade: T;
  meta: RowMeta;
}

/** A desktop journal row ready for `import_commit` (the Rust side adds id, account and batch). */
export type ImportedTrade = Omit<StoredTrade, "id" | "accountId" | "importBatchId" | "updatedAt"> & { ticket: string };

/** Why a row was not imported. */
export type IssueCode =
  | "too_few_columns"
  | "invalid_ticket"
  | "invalid_direction"
  | "invalid_date"
  | "missing_symbol"
  | "invalid_quantity"
  | "invalid_price"
  | "out_of_range"
  | "not_a_trade"
  | "option_row"
  | "unmatched_leg"
  | "fifo_out_of_range"
  | "section_end"
  | "unpaired"
  | "storage_rejected"
  | "duplicate_in_file";

export interface RowIssue {
  /** 1-based line in the decoded file, or null. */
  line: number | null;
  code: IssueCode;
  /** Plain-English reason shown in the preview. */
  reason: string;
}

/** Detected file format. */
export type FormatId =
  | "mt5_32col"
  | "dojix_export"
  | "mt5_report"
  | "mt4"
  | "ctrader"
  | "tradingview"
  | "oanda_csv"
  | "ibkr"
  | "tos"
  | "ninjatrader"
  | "webull"
  | "robinhood"
  | "schwab"
  | "fidelity"
  | "etrade"
  | "tastytrade"
  | "generic";

/** A file-level failure (nothing imported). */
export class ImportError extends Error {
  constructor(
    readonly code: "empty_file" | "too_large" | "no_trade_section" | "unknown_format" | "encoding",
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

/** 50 MB, the import cap of both Macs (SPEC §5.1). */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
