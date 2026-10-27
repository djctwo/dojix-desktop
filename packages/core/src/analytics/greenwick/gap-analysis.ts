// GapAnalysis (Greenwick `Components/GapAnalysis.swift`): overnight gaps between a symbol's
// consecutive traded days, how often they fill, and gap-and-go vs gap-and-fade.
//
// - Days are the ET date of the **open** (`TradingCalendar.dayKey(openTime)`), zero-padded, so
//   sorting the keys as strings is date order (the Mac's D-13 fix, now parity).
// - Previous close = the close price of the previous traded day's last close (`max(by:)`, the
//   first of equal close times in open-time order); today's open = the open price of the day's first open
//   (`min(by:)`, the first of equal open times).
// - Prices go through Foundation's Decimal → Double (`NSDecimalNumber.doubleValue`).
// - The Mac walks symbols in dictionary order (random); the desktop walks them in first
//   appearance, which changes only the order of `gapTrades` and the last bits of the sums.

import { isWin, profitDouble } from "../../model/accessors";
import type { GreenwickTrade } from "../../model/trade";
import { maxBy, minBy, stableSorted, swiftMax, swiftMin } from "../../swiftcompat/collections";
import { decimalToDouble } from "../../swiftcompat/decimal";
import { asCurrency } from "../../swiftcompat/format";
import { TRADING_CALENDAR } from "../../time/us-market";
import { groupByString, swiftStringKey } from "./shared";

/** `GapType` raw values. */
export type GapType = "Gap Up" | "Gap Down";

export interface GapTrade {
  trade: GreenwickTrade;
  gapType: GapType;
  /** (today's open − previous close) / previous close × 100. */
  gapPercent: number;
  previousClose: number;
  gapFilled: boolean;
}

export interface GapStats {
  type: GapType;
  count: number;
  avgPnL: number;
  /** Percent. */
  winRate: number;
  totalPnL: number;
  /** Percent of the gap trades whose day filled the gap. */
  fillRate: number;
}

export interface GapAnalysisModel {
  /** At least 2 gap trades (else "Need more trades to detect gap patterns"). */
  hasEnoughData: boolean;
  /** Every trade of a day that opened with a gap > 0.5%. */
  gapTrades: GapTrade[];
  up: GapStats;
  down: GapStats;
  /** Unique (symbol, day) gaps that filled, percent. */
  overallFillRate: number;
  /** Average P&L of buys on gap-up days (gap-and-go), 0 when none. */
  gapAndGoAvgPnL: number;
  /** Average P&L of sells on gap-up days (gap-and-fade), 0 when none. */
  gapAndFadeAvgPnL: number;
  bestStrategy: string;
}

function price(text: string): number {
  return decimalToDouble(text);
}

/** `gapTrades` (GapAnalysis.swift:33-101). */
export function findGapTrades(trades: readonly GreenwickTrade[]): GapTrade[] {
  const results: GapTrade[] = [];
  for (const { items: symbolTrades } of groupByString(trades, (t) => t.symbol)) {
    const sorted = stableSorted(symbolTrades, (a, b) => a.openTime < b.openTime);
    const byDay = new Map<string, GreenwickTrade[]>();
    for (const t of sorted) {
      const k = TRADING_CALENDAR.dayKey(t.openTime);
      const g = byDay.get(k);
      if (g) g.push(t);
      else byDay.set(k, [t]);
    }
    // Swift `keys.sorted()`: the keys are ASCII, so code-unit order is Swift's order.
    const dayKeys = [...byDay.keys()].sort();
    if (dayKeys.length < 2) continue;

    for (let i = 1; i < dayKeys.length; i++) {
      const prevDayTrades = byDay.get(dayKeys[i - 1] as string) as GreenwickTrade[];
      const currDayTrades = byDay.get(dayKeys[i] as string) as GreenwickTrade[];
      const lastTradeYesterday = maxBy(prevDayTrades, (a, b) => a.closeTime < b.closeTime) as GreenwickTrade;
      const prevClose = price(lastTradeYesterday.closePrice);
      const firstTradeToday = minBy(currDayTrades, (a, b) => a.openTime < b.openTime) as GreenwickTrade;
      const todayOpen = price(firstTradeToday.openPrice);

      if (!(prevClose > 0)) continue;
      const gapPercent = ((todayOpen - prevClose) / prevClose) * 100;
      if (!(Math.abs(gapPercent) > 0.5)) continue;

      const gapType: GapType = gapPercent > 0 ? "Gap Up" : "Gap Down";
      const gapFilled = currDayTrades.some((t) => {
        const closeVal = price(t.closePrice);
        const openVal = price(t.openPrice);
        return gapType === "Gap Up" ? swiftMin(openVal, closeVal) <= prevClose : swiftMax(openVal, closeVal) >= prevClose;
      });
      for (const trade of currDayTrades) {
        results.push({ trade, gapType, gapPercent, previousClose: prevClose, gapFilled });
      }
    }
  }
  return results;
}

/** `stats(for:)` (:103-121). */
export function gapStats(gapTrades: readonly GapTrade[], type: GapType): GapStats {
  const matching = gapTrades.filter((g) => g.gapType === type);
  const count = matching.length;
  let totalPnL = 0;
  let wins = 0;
  let filled = 0;
  for (const g of matching) {
    totalPnL += profitDouble(g.trade);
    if (isWin(g.trade)) wins += 1;
    if (g.gapFilled) filled += 1;
  }
  return {
    type,
    count,
    avgPnL: count > 0 ? totalPnL / count : 0,
    winRate: count > 0 ? (wins / count) * 100 : 0,
    totalPnL,
    fillRate: count > 0 ? (filled / count) * 100 : 0,
  };
}

/** `overallFillRate` (:127-143): one vote per (symbol, open day). */
function overallFillRate(gapTrades: readonly GapTrade[]): number {
  const seen = new Set<string>();
  let filled = 0;
  for (const g of gapTrades) {
    const key = `${swiftStringKey(g.trade.symbol)}-${TRADING_CALENDAR.dayKey(g.trade.openTime)}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (g.gapFilled) filled += 1;
    }
  }
  return seen.size > 0 ? (filled / seen.size) * 100 : 0;
}

function averagePnL(gs: readonly GapTrade[]): number {
  if (gs.length === 0) return 0;
  let total = 0;
  for (const g of gs) total += profitDouble(g.trade);
  return total / gs.length;
}

/** GapAnalysis.swift:33-171. No minimum trade count. */
export function computeGapAnalysis(trades: readonly GreenwickTrade[], locale: string): GapAnalysisModel {
  const gapTrades = findGapTrades(trades);

  const up = gapStats(gapTrades, "Gap Up");
  const down = gapStats(gapTrades, "Gap Down");
  const goBuys = gapTrades.filter((g) => g.gapType === "Gap Up" && g.trade.direction === "BUY");
  const fadeSells = gapTrades.filter((g) => g.gapType === "Gap Up" && g.trade.direction === "SELL");
  const go = averagePnL(goBuys);
  const fade = averagePnL(fadeSells);

  // bestStrategy (:145-171)
  let bestStrategy: string;
  if (up.count < 3 && down.count < 3) bestStrategy = "Need more gap trades to determine best strategy";
  else if (goBuys.length === 0 && fadeSells.length === 0) bestStrategy = "Need both long and short gap trades to compare strategies";
  else if (go > fade) bestStrategy = `Gap-and-go works better for you (avg ${asCurrency(go, locale)} vs ${asCurrency(fade, locale)} fade)`;
  else if (fade > go) bestStrategy = `Gap-and-fade works better for you (avg ${asCurrency(fade, locale)} vs ${asCurrency(go, locale)} go)`;
  else bestStrategy = "Gap-and-go and gap-and-fade perform similarly";

  return {
    hasEnoughData: gapTrades.length >= 2, // :123-125
    gapTrades,
    up,
    down,
    overallFillRate: overallFillRate(gapTrades),
    gapAndGoAvgPnL: go,
    gapAndFadeAvgPnL: fade,
    bestStrategy,
  };
}
