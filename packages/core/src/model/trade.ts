// The engine's view of a trade (SPEC §4.2): the Mac apps' field names, one interface per brand.
//
// - Money stays decimal text (`DecimalText`), exactly as stored; analytics convert it with the
//   Foundation algorithm (`profitDouble` etc. in accessors.ts), never with `Number()`.
// - Times are epoch milliseconds (UTC). Storage keeps GRDB text; see time/grdb-time.ts.
// - Tickets are Int64 values above 2^53 (Dojix content tickets are in [8e18, 9e18)), so they
//   travel as decimal strings.
// - MAE / MFE are nullable (PARITY D-18): `null` means unknown. In `compat: "swift"` mode the
//   accessors read null as 0, which is how the Mac stores it.
// - Engine trades are immutable values: derived numbers are cached per object.

import type { BrandId } from "../brand";
import type {
  BiasAlignment,
  MarketSession,
  TradeDirection,
  TradingSession,
  VolatilityRegime,
} from "./enums";

/** Decimal number as text: "." separator, no grouping (e.g. "-12.5"). */
export type DecimalText = string;
/** Milliseconds since 1970-01-01T00:00:00Z. */
export type EpochMs = number;
/** A Swift Int64 ticket as decimal text. */
export type TicketId = string;

/** Fields both apps share, under the Mac names. */
export interface TradeCommon {
  /** Row id in the journal (null before insert). */
  id: number | null;
  ticket: TicketId;
  symbol: string;
  direction: TradeDirection;
  openTime: EpochMs;
  closeTime: EpochMs;
  /** Whole minutes (Swift Int). */
  durationMin: number;
  openPrice: DecimalText;
  closePrice: DecimalText;
  sl: DecimalText;
  tp: DecimalText;
  /** Net of commission and swap in both brands (SPEC §3.1). */
  netProfit: DecimalText;
  commission: DecimalText;
  swap: DecimalText;
  rMultiple: number;
  /** Stored weekday label of the open ("Mon"…). Greenwick analytics use the close's ET day instead. */
  dayOfWeek: string;
  /** Stored hour of the open: UTC (Dojix generic), broker time (Dojix 32-column) or ET (Greenwick). */
  hour: number;
  rangeSize: number;
  hitBreakeven: boolean;
  scaledIn: boolean;
  comment: string;
  timeToMFEMin: number;
  notes: string;
  tags: readonly string[];
  /** Raw emotion value ("" when none); see `parseTradeEmotion`. */
  emotion: string;
  /** Checklist rule → followed. */
  checklist: Readonly<Record<string, boolean>>;
  importedAt: EpochMs;
  /** One of the fictional sample trades. */
  isSample: boolean;
}

/** Dojix (forex). Mac: Dojix `Models/Trade.swift:5-64`. */
export interface DojixTrade extends TradeCommon {
  brand: "dojix";
  lots: number;
  /** Pips; null = unknown (D-18). */
  maePips: number | null;
  /** Pips; null = unknown (D-18). */
  mfePips: number | null;
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

/** Greenwick (stocks). Mac: Greenwick `Models/Trade.swift:5-68`. */
export interface GreenwickTrade extends TradeCommon {
  brand: "greenwick";
  shares: number;
  /** Points; null = unknown (D-18). */
  maePoints: number | null;
  /** Points; null = unknown (D-18). */
  mfePoints: number | null;
  session: MarketSession;
  slDistPoints: number;
  slippagePoints: number;
  sector: string;
  industry: string;
  volume: number;
  avgVolume: number;
}

export type Trade = DojixTrade | GreenwickTrade;

/** The trade type of a brand. */
export type TradeOf<B extends BrandId> = B extends "dojix" ? DojixTrade : GreenwickTrade;

export function isDojixTrade(t: Trade): t is DojixTrade {
  return t.brand === "dojix";
}

export function isGreenwickTrade(t: Trade): t is GreenwickTrade {
  return t.brand === "greenwick";
}
