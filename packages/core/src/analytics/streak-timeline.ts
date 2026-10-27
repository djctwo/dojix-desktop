// StreakTimeline (Sessions tab, both brands). SPEC Appendix A "StreakTimeline".
//
// Dojix `Components/StreakTimeline.swift:14-35`; Greenwick's copy is identical.
// Trades sorted by close time ascending (stable), then runs of equal `isWin`; a breakeven is
// not a win, so it joins a losing run (PARITY D-17 notes the per-component streak rules).

import type { EngineContext } from "../engine/context";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { isWin } from "../model/accessors";
import type { Trade } from "../model/trade";

export interface StreakSegment {
  isWin: boolean;
  count: number;
  /** Index of the first trade of the run in the ascending order. */
  startIndex: number;
}

export interface StreakTimelineModel {
  segments: StreakSegment[];
  totalTrades: number;
}

export function streakTimeline(_ctx: EngineContext, trades: readonly Trade[]): StreakTimelineModel {
  const sorted = sortedByCloseAscending(trades);
  const segments: StreakSegment[] = [];
  const first = sorted[0];
  if (first !== undefined) {
    let currentIsWin = isWin(first);
    let currentCount = 1;
    let startIdx = 0;
    for (let i = 1; i < sorted.length; i++) {
      const w = isWin(sorted[i] as Trade);
      if (w === currentIsWin) {
        currentCount += 1;
      } else {
        segments.push({ isWin: currentIsWin, count: currentCount, startIndex: startIdx });
        currentIsWin = w;
        currentCount = 1;
        startIdx = i;
      }
    }
    segments.push({ isWin: currentIsWin, count: currentCount, startIndex: startIdx });
  }
  return { segments, totalTrades: trades.length };
}
