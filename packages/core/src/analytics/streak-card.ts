// StreakCard (Overview, both brands). SPEC Appendix A "StreakCard".
//
// Dojix `Components/StreakCard.swift:7-56`; Greenwick `Components/StreakCard.swift` adds the
// near-personal-best badge (:58-63).
//
// Trades sorted by close time ascending (stable):
// - current = the run back from the last trade while `isWin` matches the last trade's (a
//   breakeven counts as a loss), +n for wins, −n otherwise;
// - best win run (reset by anything that is not a win) and best loss run (reset by anything
//   that is not a loss, so a breakeven resets both);
// - the last 10 results as isWin (a breakeven shows as a loss).
//
// PARITY D-17: these rules differ from MetricsCalculator's streaks (where a breakeven changes
// nothing). Documented and kept per component in both modes.

import type { EngineContext } from "../engine/context";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { isLoss, isWin } from "../model/accessors";
import type { Trade } from "../model/trade";

export interface StreakCardModel {
  currentStreak: number;
  bestWinStreak: number;
  bestLossStreak: number;
  /** Up to 10 results, most recent last. */
  recentResults: boolean[];
  /**
   * Greenwick only: current ≥ 3, best ≥ 3 and current ≥ ceil(0.8 × best) ("Personal Best!" when
   * equal, else "Near Personal Best!"). Null for Dojix, whose card has no badge.
   */
  isNearPersonalBest: boolean | null;
  hasTrades: boolean;
}

function bestRun(sorted: readonly Trade[], hit: (t: Trade) => boolean): number {
  let best = 0;
  let current = 0;
  for (const t of sorted) {
    if (hit(t)) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

export function streakCard(ctx: EngineContext, trades: readonly Trade[]): StreakCardModel {
  const sorted = sortedByCloseAscending(trades);
  let currentStreak = 0;
  const last = sorted[sorted.length - 1];
  if (last !== undefined) {
    const lastWin = isWin(last);
    let count = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (isWin(sorted[i] as Trade) === lastWin) count += 1;
      else break;
    }
    currentStreak = lastWin ? count : -count;
  }
  const bestWinStreak = bestRun(sorted, isWin);
  const bestLossStreak = bestRun(sorted, isLoss);
  return {
    currentStreak,
    bestWinStreak,
    bestLossStreak,
    recentResults: sorted.slice(Math.max(0, sorted.length - 10)).map(isWin),
    isNearPersonalBest:
      ctx.brand === "greenwick" ? currentStreak >= 3 && bestWinStreak >= 3 && currentStreak >= Math.ceil(bestWinStreak * 0.8) : null,
    hasTrades: trades.length > 0,
  };
}
