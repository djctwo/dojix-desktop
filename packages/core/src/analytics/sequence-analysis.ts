// SequenceAnalysis (Sessions tab, both brands). SPEC Appendix A "SequenceAnalysis".
//
// Dojix `Components/SequenceAnalysis.swift:7-85,189-200`; Greenwick's copy is identical.
//
// - n ≥ 20, trades ascending by close time (stable);
// - transitions WW / WL / LW / LL from consecutive pairs (a breakeven is "not a win", so it
//   counts on the loss side);
// - conditional percentages (0 when there is no prior win / loss), average P&L after a win and
//   after a loss (input order of the ascending walk);
// - pattern, first match wins: Tilt Risk (LL > 55 and avgAfterLoss < .5 × avgAfterWin),
//   Momentum (WW > 55 and LL > 55), Mean Reverting (LW > 55 and WL > 55), else Random.

import type { EngineContext } from "../engine/context";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";

export type SequencePattern = "Momentum" | "Mean Reverting" | "Random" | "Tilt Risk";

/** The insight under the matrix (SequenceAnalysis.swift:189-200). */
export const SEQUENCE_INSIGHT: Readonly<Record<SequencePattern, string>> = {
  "Tilt Risk": "Warning: Losses tend to cluster and worsen. Consider stepping away after a loss.",
  Momentum: "Wins and losses tend to cluster. Stay in the zone during streaks, step back during slumps.",
  "Mean Reverting": "Results tend to alternate. Stay disciplined — a loss doesn't predict another loss.",
  Random: "No clear sequencing pattern. Each trade is independent of the previous result.",
};

export const SEQUENCE_MIN_TRADES = 20;

export interface SequenceStats {
  /** P(win | previous win), percent. */
  winAfterWin: number;
  winAfterLoss: number;
  lossAfterWin: number;
  lossAfterLoss: number;
  avgPnLAfterWin: number;
  avgPnLAfterLoss: number;
  pattern: SequencePattern;
  /** Raw transition counts. */
  ww: number;
  wl: number;
  lw: number;
  ll: number;
}

export interface SequenceAnalysisModel {
  /** Null below 20 trades ("Need 20+ trades for sequence analysis"). */
  stats: SequenceStats | null;
}

/** The pattern from the conditional percentages and the average P&L after a win / a loss. */
export function sequencePattern(
  winAfterWin: number,
  lossAfterWin: number,
  winAfterLoss: number,
  lossAfterLoss: number,
  avgAfterWin: number,
  avgAfterLoss: number,
): SequencePattern {
  if (lossAfterLoss > 55 && avgAfterLoss < avgAfterWin * 0.5) return "Tilt Risk";
  if (winAfterWin > 55 && lossAfterLoss > 55) return "Momentum";
  if (winAfterLoss > 55 && lossAfterWin > 55) return "Mean Reverting";
  return "Random";
}

export function sequenceAnalysis(_ctx: EngineContext, trades: readonly Trade[]): SequenceAnalysisModel {
  const sorted = sortedByCloseAscending(trades);
  if (sorted.length < SEQUENCE_MIN_TRADES) return { stats: null };
  let ww = 0;
  let wl = 0;
  let lw = 0;
  let ll = 0;
  let afterWinSum = 0;
  let afterWinCount = 0;
  let afterLossSum = 0;
  let afterLossCount = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prevWin = isWin(sorted[i - 1] as Trade);
    const curr = sorted[i] as Trade;
    const currWin = isWin(curr);
    if (prevWin && currWin) ww += 1;
    else if (prevWin && !currWin) wl += 1;
    else if (!prevWin && currWin) lw += 1;
    else ll += 1;
    if (prevWin) {
      afterWinSum += profitDouble(curr);
      afterWinCount += 1;
    } else {
      afterLossSum += profitDouble(curr);
      afterLossCount += 1;
    }
  }
  const totalAfterWin = ww + wl;
  const totalAfterLoss = lw + ll;
  const winAfterWin = totalAfterWin > 0 ? (ww / totalAfterWin) * 100 : 0;
  const winAfterLoss = totalAfterLoss > 0 ? (lw / totalAfterLoss) * 100 : 0;
  const lossAfterWin = totalAfterWin > 0 ? (wl / totalAfterWin) * 100 : 0;
  const lossAfterLoss = totalAfterLoss > 0 ? (ll / totalAfterLoss) * 100 : 0;
  const avgPnLAfterWin = afterWinCount === 0 ? 0 : afterWinSum / afterWinCount;
  const avgPnLAfterLoss = afterLossCount === 0 ? 0 : afterLossSum / afterLossCount;
  return {
    stats: {
      winAfterWin,
      winAfterLoss,
      lossAfterWin,
      lossAfterLoss,
      avgPnLAfterWin,
      avgPnLAfterLoss,
      pattern: sequencePattern(winAfterWin, lossAfterWin, winAfterLoss, lossAfterLoss, avgPnLAfterWin, avgPnLAfterLoss),
      ww,
      wl,
      lw,
      ll,
    },
  };
}
