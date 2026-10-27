// EarningsImpact (Greenwick `Components/EarningsImpact.swift`): catalyst days found by a
// volatility heuristic, and performance on them vs normal days.
//
// - A trade's volatility is max(MAE, range size) in points. Per symbol, the threshold is twice
//   the average volatility; a trade at or above it makes its **close** day (ET) a catalyst day
//   for that symbol. (SPEC App. A says "ET open day"; the Swift code keys on the close, :58 and
//   :70, and the code is the parity source.)
// - Catalyst trades close on a catalyst day of their symbol; "held through" ones opened on an
//   earlier, non-catalyst day.
// - Win rates here are fractions (0–1), as on the Mac.
// - D-18: in `fixed` mode an unknown MAE gives way to the range size alone; the Mac reads it as
//   0 (`max(0, range)`).

import type { CompatMode } from "../../engine/compat";
import { maeOf } from "../../model/accessors";
import type { GreenwickTrade } from "../../model/trade";
import { swiftMax } from "../../swiftcompat/collections";
import { swiftFormat } from "../../swiftcompat/format";
import { TRADING_CALENDAR } from "../../time/us-market";
import { groupByString, sumProfit, swiftStringKey, winCount } from "./shared";

export interface CatalystGroupStats {
  count: number;
  /** Fraction (0–1). */
  winRate: number;
  avgPnL: number;
  totalPnL: number;
}

export type EarningsRecommendationLabel = "TRADE" | "AVOID" | "CAUTION";

export interface EarningsRecommendation {
  label: EarningsRecommendationLabel;
  text: string;
}

export interface EarningsImpactModel {
  catalystTrades: GreenwickTrade[];
  normalTrades: GreenwickTrade[];
  heldThroughTrades: GreenwickTrade[];
  catalyst: CatalystGroupStats;
  normal: CatalystGroupStats;
  heldThrough: CatalystGroupStats;
  /** At least 3 catalyst trades; below that the card shows only its header and "Not enough high-volatility days detected for analysis". */
  hasEnoughCatalysts: boolean;
  /** catalyst.avgPnL > normal.avgPnL. */
  performsBetter: boolean;
  /** catalyst.avgPnL − normal.avgPnL. */
  avgPnLDelta: number;
  /** "You perform better/worse on catalyst days (+1.23 avg P&L difference)". */
  comparisonText: string;
  /** Held-through average P&L > 0 ("HELPED", else "HURT"); null when nothing was held through. */
  heldThroughHelped: boolean | null;
  recommendation: EarningsRecommendation;
}

/** `GroupStats.from` (:27-37). */
export function catalystGroupStats(trades: readonly GreenwickTrade[]): CatalystGroupStats {
  if (trades.length === 0) return { count: 0, winRate: 0, avgPnL: 0, totalPnL: 0 };
  const total = sumProfit(trades);
  return { count: trades.length, winRate: winCount(trades) / trades.length, avgPnL: total / trades.length, totalPnL: total };
}

/** `max(maePoints, rangeSize)`; see the D-18 note above. */
export function tradeVolatility(t: GreenwickTrade, compat: CompatMode): number {
  const mae = maeOf(t, compat);
  return mae === null ? t.rangeSize : swiftMax(mae, t.rangeSize);
}

/** `recommendationSection` (:269-292). */
export function earningsRecommendation(catalyst: CatalystGroupStats, normal: CatalystGroupStats): EarningsRecommendation {
  const performsBetter = catalyst.avgPnL > normal.avgPnL;
  const wrBetter = catalyst.winRate > normal.winRate;
  const significant = Math.abs(catalyst.avgPnL - normal.avgPnL) > Math.abs(normal.avgPnL) * 0.2;
  if (performsBetter && wrBetter && significant) {
    return {
      label: "TRADE",
      text: "Catalyst days are a strength. Your win rate and average P&L both improve during high-volatility events. Consider increasing size on catalyst days.",
    };
  }
  if (!performsBetter && !wrBetter && significant) {
    return {
      label: "AVOID",
      text: `High-volatility events hurt your performance. Consider reducing size or sitting out on catalyst days. The data shows ${swiftFormat("$%.2f", Math.abs(catalyst.avgPnL - normal.avgPnL))} worse per trade.`,
    };
  }
  return {
    label: "CAUTION",
    text: "Mixed results on catalyst days. Monitor your performance and consider using smaller position sizes until you have more data.",
  };
}

/** EarningsImpact.swift:42-123. Shown from 20 trades (the registry guard; hidden below). */
export function computeEarningsImpact(trades: readonly GreenwickTrade[], compat: CompatMode): EarningsImpactModel {
  // :43-62 — per-symbol thresholds and catalyst close days.
  const catalystDates = new Map<string, Set<string>>();
  for (const { label, items } of groupByString(trades, (t) => t.symbol)) {
    let sum = 0;
    for (const t of items) sum += tradeVolatility(t, compat);
    const threshold = (sum / items.length) * 2.0;
    if (!(threshold > 0)) continue;
    const dates = new Set<string>();
    for (const t of items) if (tradeVolatility(t, compat) >= threshold) dates.add(TRADING_CALENDAR.dayKey(t.closeTime));
    catalystDates.set(swiftStringKey(label), dates);
  }

  // :64-85
  const catalystTrades: GreenwickTrade[] = [];
  const normalTrades: GreenwickTrade[] = [];
  const heldThroughTrades: GreenwickTrade[] = [];
  for (const t of trades) {
    const dates = catalystDates.get(swiftStringKey(t.symbol));
    const tradeDate = TRADING_CALENDAR.dayKey(t.closeTime);
    const openDate = TRADING_CALENDAR.dayKey(t.openTime);
    if (dates?.has(tradeDate)) {
      catalystTrades.push(t);
      if (openDate !== tradeDate && !dates.has(openDate)) heldThroughTrades.push(t);
    } else {
      normalTrades.push(t);
    }
  }

  const catalyst = catalystGroupStats(catalystTrades);
  const normal = catalystGroupStats(normalTrades);
  const heldThrough = catalystGroupStats(heldThroughTrades);
  const performsBetter = catalyst.avgPnL > normal.avgPnL;
  const delta = catalyst.avgPnL - normal.avgPnL;
  return {
    catalystTrades,
    normalTrades,
    heldThroughTrades,
    catalyst,
    normal,
    heldThrough,
    hasEnoughCatalysts: catalyst.count >= 3,
    performsBetter,
    avgPnLDelta: delta,
    comparisonText: `You perform ${performsBetter ? "better" : "worse"} on catalyst days (${swiftFormat("%+.2f", delta)} avg P&L difference)`,
    heldThroughHelped: heldThroughTrades.length === 0 ? null : heldThrough.avgPnL > 0,
    recommendation: earningsRecommendation(catalyst, normal),
  };
}
