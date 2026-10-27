// PairAnalytics (Dojix) / SymbolAnalytics (Greenwick), Pairs / Symbols tab.
// SPEC Appendix A "Pair / SymbolAnalytics".
//
// Dojix `Components/PairAnalytics.swift:8-14,29-37,100-107`; Greenwick
// `Components/SymbolAnalytics.swift` (identical math).
//
// - grouped by symbol; groups sorted by total P&L descending (stable; the Mac's order of equal
//   totals is random, the desktop keeps first appearance);
// - per card: P&L (input order), wins as `profitDouble > 0`, WR%, average R, BUY / SELL counts
//   (sells = count − buys) with each side's P&L, and a mini equity curve over the trades sorted
//   by close time ascending.

import type { EngineContext } from "../engine/context";
import { confidenceLevel, type ConfidenceLevel } from "../metrics/edges";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, stableSorted } from "../swiftcompat/collections";
import { meanR, percentOf, positiveProfitCount, sumProfit } from "./shared";

export interface SymbolCard {
  symbol: string;
  trades: Trade[];
  pnl: number;
  tradeCount: number;
  /** Percent. */
  winRate: number;
  avgR: number;
  buys: number;
  sells: number;
  buyPnL: number;
  sellPnL: number;
  /** Cumulative P&L after each trade, oldest first. */
  equityCurve: number[];
  confidence: ConfidenceLevel;
}

export interface SymbolAnalyticsModel {
  cards: SymbolCard[];
}

function symbolCard(symbol: string, trades: Trade[]): SymbolCard {
  const buyTrades = trades.filter((t) => t.direction === "BUY");
  const sellTrades = trades.filter((t) => t.direction === "SELL");
  const equityCurve: number[] = [];
  let cumulative = 0;
  for (const t of sortedByCloseAscending(trades)) {
    cumulative += profitDouble(t);
    equityCurve.push(cumulative);
  }
  return {
    symbol,
    trades,
    pnl: sumProfit(trades),
    tradeCount: trades.length,
    winRate: trades.length === 0 ? 0 : percentOf(positiveProfitCount(trades), trades.length),
    avgR: trades.length === 0 ? 0 : meanR(trades),
    buys: buyTrades.length,
    sells: trades.length - buyTrades.length,
    buyPnL: sumProfit(buyTrades),
    sellPnL: sumProfit(sellTrades),
    equityCurve,
    confidence: confidenceLevel(trades.length),
  };
}

export function symbolAnalytics(_ctx: EngineContext, trades: readonly Trade[]): SymbolAnalyticsModel {
  const groups = [...groupByFirstAppearance(trades, (t) => t.symbol)].map(([symbol, group]) => ({ symbol, group, total: sumProfit(group) }));
  const sorted = stableSorted(groups, (a, b) => a.total > b.total);
  return { cards: sorted.map(({ symbol, group }) => symbolCard(symbol, group)) };
}
