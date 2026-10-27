// DurationAnalysis (Timing tab, both brands). SPEC Appendix A "DurationAnalysis".
//
// Dojix `Components/DurationAnalysis.swift:17-40,81`; Greenwick's copy is identical.
//
// - closed integer buckets 0…5, 6…15, 16…30, 31…60, 61…120, 121…999999 minutes (a duration
//   outside every range, e.g. negative or ≥ 1,000,000, is in no bucket);
// - per bucket: profit (input order), trade count, WR%, average R;
// - sweet spot = `max(by: avgR <)` (the first of ties), shown only when it has ≥ 3 trades.

import type { EngineContext } from "../engine/context";
import type { Trade } from "../model/trade";
import { maxBy } from "../swiftcompat/collections";
import { meanR, percentOf, winCount } from "./shared";
import { sumProfit } from "./support";

export interface DurationRange {
  label: string;
  /** Inclusive bounds in whole minutes (Swift `ClosedRange<Int>`). */
  lower: number;
  upper: number;
}

/** DurationAnalysis.swift:18-25. */
export const DURATION_RANGES: readonly DurationRange[] = [
  { label: "0-5m", lower: 0, upper: 5 },
  { label: "5-15m", lower: 6, upper: 15 },
  { label: "15-30m", lower: 16, upper: 30 },
  { label: "30-60m", lower: 31, upper: 60 },
  { label: "1-2h", lower: 61, upper: 120 },
  { label: "2h+", lower: 121, upper: 999_999 },
];

export interface DurationBucket {
  id: string;
  label: string;
  profit: number;
  tradeCount: number;
  /** Percent. */
  winRate: number;
  avgR: number;
}

export interface DurationAnalysisModel {
  /** Non-empty buckets, in range order. */
  buckets: DurationBucket[];
  /** The bucket with the highest average R when it has at least 3 trades, else null. */
  sweetSpot: DurationBucket | null;
  sampleSize: number;
}

export function durationAnalysis(_ctx: EngineContext, trades: readonly Trade[]): DurationAnalysisModel {
  const buckets: DurationBucket[] = [];
  for (const range of DURATION_RANGES) {
    const matching = trades.filter((t) => range.lower <= t.durationMin && t.durationMin <= range.upper);
    if (matching.length === 0) continue;
    buckets.push({
      id: range.label,
      label: range.label,
      profit: sumProfit(matching),
      tradeCount: matching.length,
      winRate: percentOf(winCount(matching), matching.length),
      avgR: meanR(matching),
    });
  }
  const best = maxBy(buckets, (a, b) => a.avgR < b.avgR);
  return {
    buckets,
    sweetSpot: best !== undefined && best.tradeCount >= 3 ? best : null,
    sampleSize: trades.length,
  };
}
