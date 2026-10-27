// DirectionalEdge (Pairs / Symbols tab, both brands). SPEC Appendix A "DirectionalEdge".
//
// Dojix `Components/DirectionalEdge.swift:8-36,98-100`; Greenwick's copy is identical.
//
// Per direction (Long = BUY, Short = SELL): count, total P&L (input order), WR%, average R and
// average P&L (all 0 without trades). The better side has the higher average P&L ("Short" on a
// tie); the insight is shown when both sides have ≥ 5 trades.

import type { EngineContext } from "../engine/context";
import type { Trade } from "../model/trade";
import { swiftMax } from "../swiftcompat/collections";
import { meanR, percentOf, winCount } from "./shared";
import { sumProfit } from "./support";

export interface DirectionStats {
  count: number;
  totalPnL: number;
  /** Percent. */
  winRate: number;
  avgR: number;
  avgPnL: number;
}

export interface DirectionalEdgeModel {
  buyStats: DirectionStats;
  sellStats: DirectionStats;
  betterDirection: "Long" | "Short";
  betterAvgPnL: number;
  /** Both sides have ≥ 5 trades: "<side> trades average $x/trade — consider leaning into this direction." */
  showInsight: boolean;
  sampleSize: number;
}

export function directionStats(filtered: readonly Trade[]): DirectionStats {
  if (filtered.length === 0) return { count: 0, totalPnL: 0, winRate: 0, avgR: 0, avgPnL: 0 };
  const totalPnL = sumProfit(filtered);
  return {
    count: filtered.length,
    totalPnL,
    winRate: percentOf(winCount(filtered), filtered.length),
    avgR: meanR(filtered),
    avgPnL: totalPnL / filtered.length,
  };
}

export function directionalEdge(_ctx: EngineContext, trades: readonly Trade[]): DirectionalEdgeModel {
  const buyStats = directionStats(trades.filter((t) => t.direction === "BUY"));
  const sellStats = directionStats(trades.filter((t) => t.direction === "SELL"));
  return {
    buyStats,
    sellStats,
    betterDirection: buyStats.avgPnL > sellStats.avgPnL ? "Long" : "Short",
    betterAvgPnL: swiftMax(buyStats.avgPnL, sellStats.avgPnL),
    showInsight: buyStats.count >= 5 && sellStats.count >= 5,
    sampleSize: trades.length,
  };
}
