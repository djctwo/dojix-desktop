// RMultipleChart (Sessions tab, both brands). SPEC Appendix A "RMultipleChart".
//
// Dojix `Components/RMultipleChart.swift:62-98`; Greenwick's copy is identical.
//
// - half-open buckets [−100,−2), [−2,−1.5), …, [1.5,2), [2,100); an R outside [−100, 100) is in
//   no bucket; empty buckets are omitted;
// - labels "<-2R", ">2R", otherwise "%.1fR" of the lower edge; midpoint = (low + high) / 2;
// - average (input order), median (mean of the middle two when even), best = max, worst = min
//   (0 without trades).

import type { EngineContext } from "../engine/context";
import type { Trade } from "../model/trade";
import { seqMax, seqMin } from "../swiftcompat/collections";
import { formatFixed } from "../swiftcompat/format";
import { swiftMedian } from "./shared";

export interface RMultipleBucket {
  range: string;
  count: number;
  midpoint: number;
}

export interface RMultipleModel {
  buckets: RMultipleBucket[];
  avgR: number;
  medianR: number;
  bestR: number;
  worstR: number;
  /** False shows "Import trades to see R-multiple distribution". */
  hasTrades: boolean;
}

/** RMultipleChart.swift:67-70. */
export const R_MULTIPLE_RANGES: readonly (readonly [number, number])[] = [
  [-100, -2.0],
  [-2.0, -1.5],
  [-1.5, -1.0],
  [-1.0, -0.5],
  [-0.5, 0.0],
  [0.0, 0.5],
  [0.5, 1.0],
  [1.0, 1.5],
  [1.5, 2.0],
  [2.0, 100],
];

export function rMultipleLabel(low: number, high: number): string {
  if (low <= -100) return "<-2R";
  if (high >= 100) return ">2R";
  return `${formatFixed(low, 1)}R`;
}

export function rMultipleChart(_ctx: EngineContext, trades: readonly Trade[]): RMultipleModel {
  const rValues = trades.map((t) => t.rMultiple);
  const buckets: RMultipleBucket[] = [];
  if (rValues.length > 0) {
    for (const [low, high] of R_MULTIPLE_RANGES) {
      const count = rValues.filter((r) => r >= low && r < high).length;
      if (count === 0) continue;
      buckets.push({ range: rMultipleLabel(low, high), count, midpoint: (low + high) / 2 });
    }
  }
  let total = 0;
  for (const r of rValues) total += r;
  return {
    buckets,
    avgR: rValues.length === 0 ? 0 : total / rValues.length,
    medianR: swiftMedian(rValues) ?? 0,
    bestR: seqMax(rValues) ?? 0,
    worstR: seqMin(rValues) ?? 0,
    hasTrades: trades.length > 0,
  };
}
