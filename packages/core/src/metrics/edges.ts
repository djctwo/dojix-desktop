// Edge breakdowns and conditions (SPEC §3.3 `edgeBy*`, `confidence`, `allEdgeConditions`).
//
// Port of Dojix `MetricsCalculator.swift:144-347` and Greenwick `MetricsCalculator.swift`.
// Brand variants:
// - Dojix groups the day by the stored `dayOfWeek`; Greenwick by the ET weekday of the close
//   (`TradingCalendar.groupedByWeekday`), so a stored label like "Fr." doesn't matter.
// - Dojix has Pair, Bias and Volatility; Greenwick has Symbol and Sector ("Unknown" when empty).
// - Hour labels are "\(hour):00" ("9:00", not "09:00"); sessions use display names.
//
// Determinism: the Mac groups with `Dictionary(grouping:)`, whose order is random, then sorts by
// profit with a stable sort, so equal-profit groups come out in random order on the Mac. The
// desktop orders groups by first appearance in the input (SPEC §3.1 "Order"); parity fixtures
// avoid tied group totals (F2).

import type { BrandId } from "../brand";
import { isLoss, isWin, profitDouble } from "../model/accessors";
import { MARKET_SESSION_INFO, TRADING_SESSION_INFO } from "../model/enums";
import type { DojixTrade, GreenwickTrade, Trade } from "../model/trade";
import { groupByFirstAppearance, stableSorted } from "../swiftcompat/collections";
import { tradingWeekday } from "../time/us-market";
import { expectancyOf, profitFactorOf } from "./metrics-calculator";

export interface EdgeBreakdown {
  category: string;
  label: string;
  profit: number;
  tradeCount: number;
  /** Percent. */
  winRate: number;
}

function breakdown(category: string, label: string, group: readonly Trade[]): EdgeBreakdown {
  let profit = 0;
  let wins = 0;
  for (const t of group) {
    profit += profitDouble(t);
    if (isWin(t)) wins += 1;
  }
  return { category, label, profit, tradeCount: group.length, winRate: (wins / group.length) * 100 };
}

/** Groups, builds a breakdown per group, then sorts by profit descending (stable). */
export function edgeBy<T extends Trade>(
  trades: readonly T[],
  category: string,
  key: (t: T) => string,
): EdgeBreakdown[] {
  const groups = groupByFirstAppearance(trades, key);
  const rows = [...groups].map(([label, group]) => breakdown(category, label, group));
  return stableSorted(rows, (a, b) => a.profit > b.profit);
}

/** Display label of the trade's stored session. */
export function sessionLabel(t: Trade): string {
  return t.brand === "dojix" ? TRADING_SESSION_INFO[t.session].displayName : MARKET_SESSION_INFO[t.session].displayName;
}

/** Day key per brand: Dojix the stored label; Greenwick the ET weekday of the close. */
export function dayLabel(t: Trade): string {
  return t.brand === "dojix" ? t.dayOfWeek : tradingWeekday(t);
}

/** `edgeByHour`: by stored hour, label "H:00". */
export function edgeByHour(trades: readonly Trade[]): EdgeBreakdown[] {
  return edgeBy(trades, "Hour", (t) => `${t.hour}:00`);
}

/** `edgeBySession`: by stored session, display-name labels. */
export function edgeBySession(trades: readonly Trade[]): EdgeBreakdown[] {
  return edgeBy(trades, "Session", sessionLabel);
}

/** `edgeByDay` (see `dayLabel` for the brand rule). */
export function edgeByDay(trades: readonly Trade[]): EdgeBreakdown[] {
  return edgeBy(trades, "Day", dayLabel);
}

/** Dojix `edgeByPair`. */
export function edgeByPair(trades: readonly DojixTrade[]): EdgeBreakdown[] {
  return edgeBy(trades, "Pair", (t) => t.symbol);
}

/** Greenwick `edgeBySymbol`. */
export function edgeBySymbol(trades: readonly GreenwickTrade[]): EdgeBreakdown[] {
  return edgeBy(trades, "Symbol", (t) => t.symbol);
}

/** Dojix `edgeByBias` (raw labels WITH / AGAINST / NEUTRAL). */
export function edgeByBias(trades: readonly DojixTrade[]): EdgeBreakdown[] {
  return edgeBy(trades, "Bias", (t) => t.biasAtEntry);
}

/** Dojix `edgeByVolRegime` (LOW / MED / HIGH). */
export function edgeByVolRegime(trades: readonly DojixTrade[]): EdgeBreakdown[] {
  return edgeBy(trades, "Volatility", (t) => t.volRegime);
}

/** Greenwick sector label: "Unknown" when empty. */
export function sectorLabel(t: GreenwickTrade): string {
  return t.sector === "" ? "Unknown" : t.sector;
}

/** Greenwick `edgeBySector`. */
export function edgeBySector(trades: readonly GreenwickTrade[]): EdgeBreakdown[] {
  return edgeBy(trades, "Sector", sectorLabel);
}

// --- statistical confidence ------------------------------------------------------------------

export type ConfidenceLevel = "insufficient" | "low" | "significant";

/** `confidenceLevel(sampleSize:)`: < 10 insufficient, < 30 low, else significant. */
export function confidenceLevel(sampleSize: number): ConfidenceLevel {
  if (sampleSize < 10) return "insufficient";
  if (sampleSize < 30) return "low";
  return "significant";
}

/** `isActionable(sampleSize:)`: n ≥ 30. */
export function isActionable(sampleSize: number): boolean {
  return sampleSize >= 30;
}

// --- edge conditions ------------------------------------------------------------------------

export interface EdgeCondition {
  /** "<dimension>_<label>" */
  id: string;
  dimension: string;
  label: string;
  profit: number;
  tradeCount: number;
  /** Percent. */
  winRate: number;
  expectancy: number;
  /** +∞ when there are no losses but some profit. */
  profitFactor: number;
  /** profit × 21 / tradingDays. */
  monthlyImpact: number;
}

function condition(dimension: string, label: string, group: readonly Trade[], monthScale: number): EdgeCondition {
  let profit = 0;
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let lossSum = 0;
  for (const t of group) profit += profitDouble(t);
  for (const t of group) if (isWin(t)) wins += 1;
  for (const t of group) if (isLoss(t)) losses += 1;
  for (const t of group) if (isWin(t)) grossWin += profitDouble(t);
  for (const t of group) if (isLoss(t)) lossSum += profitDouble(t);
  const grossLoss = Math.abs(lossSum);
  const winRate = (wins / group.length) * 100;
  const avgWin = wins > 0 ? grossWin / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  return {
    id: `${dimension}_${label}`,
    dimension,
    label,
    profit,
    tradeCount: group.length,
    winRate,
    expectancy: expectancyOf(winRate, avgWin, avgLoss),
    profitFactor: profitFactorOf(grossWin, grossLoss),
    monthlyImpact: profit * monthScale,
  };
}

/** The dimensions `allEdgeConditions` walks, in the Mac's order, per brand. */
export function edgeDimensions(brand: BrandId): readonly { dimension: string; key: (t: Trade) => string }[] {
  const hour = { dimension: "Hour", key: (t: Trade) => `${t.hour}:00` };
  const day = { dimension: "Day", key: dayLabel };
  const session = { dimension: "Session", key: sessionLabel };
  if (brand === "dojix") {
    return [
      hour,
      day,
      session,
      { dimension: "Pair", key: (t: Trade) => t.symbol },
      { dimension: "Volatility", key: (t: Trade) => (t as DojixTrade).volRegime },
      { dimension: "Bias", key: (t: Trade) => (t as DojixTrade).biasAtEntry },
    ];
  }
  return [
    hour,
    day,
    session,
    { dimension: "Symbol", key: (t: Trade) => t.symbol },
    { dimension: "Sector", key: (t: Trade) => sectorLabel(t as GreenwickTrade) },
  ];
}

/**
 * `allEdgeConditions(from:tradingDays:)`: every group of every dimension with full metrics,
 * dimensions in the Mac's order, groups in first-appearance order (the Mac's is random).
 * Empty when there are no trades or `tradingDays` ≤ 0.
 */
export function allEdgeConditions(trades: readonly Trade[], tradingDays: number, brand: BrandId): EdgeCondition[] {
  if (trades.length === 0 || !(tradingDays > 0)) return [];
  const monthScale = 21.0 / tradingDays;
  const out: EdgeCondition[] = [];
  for (const { dimension, key } of edgeDimensions(brand)) {
    for (const [label, group] of groupByFirstAppearance(trades, key)) {
      out.push(condition(dimension, label, group, monthScale));
    }
  }
  return out;
}
