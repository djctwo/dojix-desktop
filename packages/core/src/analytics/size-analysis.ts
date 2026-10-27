// LotSizeAnalysis (Dojix) / ShareSizeAnalysis (Greenwick), Pairs / Symbols tab.
// SPEC Appendix A "LotSize / ShareSize".
//
// Dojix `Components/LotSizeAnalysis.swift:8-18,25,58`; Greenwick
// `Components/ShareSizeAnalysis.swift` (same math on shares; the stat pills print "%.0f").
//
// - needs n ≥ 5 (scatter of size vs P&L);
// - average size of the wins and of the losses (0 when none; breakevens in neither);
// - "Oversizing on losses" when avgLoss > avgWin × 1.2.

import type { EngineContext } from "../engine/context";
import { isLoss, isWin, profitDouble, quantity } from "../model/accessors";
import type { Trade } from "../model/trade";

export const SIZE_ANALYSIS_MIN_TRADES = 5;

export interface SizePoint {
  /** Lots (Dojix) or shares (Greenwick). */
  quantity: number;
  pnl: number;
}

export interface SizeAnalysisModel {
  /** n ≥ 5; below it "Need at least 5 trades". */
  enoughData: boolean;
  points: SizePoint[];
  avgWinSize: number;
  avgLossSize: number;
  oversizingOnLosses: boolean;
  /** "lots" (Dojix) or "shares" (Greenwick). */
  unit: "lots" | "shares";
}

function averageSize(trades: readonly Trade[]): number {
  if (trades.length === 0) return 0;
  let total = 0;
  for (const t of trades) total += quantity(t);
  return total / trades.length;
}

export function sizeAnalysis(ctx: EngineContext, trades: readonly Trade[]): SizeAnalysisModel {
  const avgWinSize = averageSize(trades.filter(isWin));
  const avgLossSize = averageSize(trades.filter(isLoss));
  return {
    enoughData: trades.length >= SIZE_ANALYSIS_MIN_TRADES,
    points: trades.map((t) => ({ quantity: quantity(t), pnl: profitDouble(t) })),
    avgWinSize,
    avgLossSize,
    oversizingOnLosses: avgLossSize > avgWinSize * 1.2,
    unit: ctx.brand === "dojix" ? "lots" : "shares",
  };
}
