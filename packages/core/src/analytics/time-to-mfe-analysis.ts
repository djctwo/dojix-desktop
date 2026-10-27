// TimeToMFEAnalysis (SPEC Appendix A): how fast trades reach their best price, and whether the
// trader holds far longer than that.
//
// Port of Dojix `Components/TimeToMFEAnalysis.swift:18-65` and Greenwick
// `Components/TimeToMFEAnalysis.swift:18-63`.
// - valid trades: timeToMFEMin > 0 (input order);
// - buckets (closed Int ranges) 0…5, 6…15, 16…30, 31…60, 61…999999; empty ones dropped; a
//   value above 999,999 falls in no bucket;
// - median: the middle value, or for an even count the mean of the two middle values as a
//   Double truncated by `Int(saturating:)` (Dojix `saturatingAverage`, Greenwick
//   `overflowSafeAverage`) — integer-division-like for these positive values;
// - average hold: the same saturating mean of durationMin;
// - average exit efficiency over the valid trades that have one (`Trade.exitEfficiency`);
// - overholding: average hold > 2 × median and median > 0. Dojix compares in Int (`median * 2`
//   would trap on overflow above Int.max / 2); Greenwick compares in Double. Both are the
//   same comparison here for every value a stored trade can hold.
// The view shows nothing without valid trades and "Need at least 10" below 10.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { exitEfficiency } from "../model/accessors";
import type { Trade } from "../model/trade";
import { saturatingAverage } from "../swiftcompat/int";
import { toRef, type ComponentParity } from "./support";

export interface MFEBucket {
  id: string;
  label: string;
  count: number;
}

export interface TimeToMFEAnalysisModel<T extends Trade = Trade> {
  validTrades: T[];
  buckets: MFEBucket[];
  /** Minutes (Swift Int). */
  medianTimeToMFE: number;
  /** Minutes (Swift Int). */
  avgHoldTime: number;
  /** Percent 0–100, null when no valid trade has an efficiency. */
  avgExitEfficiency: number | null;
  isOverholding: boolean;
}

const RANGES: readonly (readonly [string, number, number])[] = [
  ["0-5m", 0, 5],
  ["5-15m", 6, 15],
  ["15-30m", 16, 30],
  ["30-60m", 31, 60],
  ["1h+", 61, 999_999],
];

export function computeTimeToMFEAnalysis<T extends Trade>(ctx: EngineContext, trades: readonly T[]): TimeToMFEAnalysisModel<T> {
  const flavor = ctx.brand;
  const validTrades = trades.filter((t) => t.timeToMFEMin > 0);
  const buckets: MFEBucket[] = [];
  for (const [label, lo, hi] of RANGES) {
    const count = validTrades.filter((t) => t.timeToMFEMin >= lo && t.timeToMFEMin <= hi).length;
    if (count > 0) buckets.push({ id: label, label, count });
  }

  const sorted = validTrades.map((t) => t.timeToMFEMin).sort((a, b) => a - b);
  let median = 0;
  if (sorted.length > 0) {
    const mid = Math.floor(sorted.length / 2);
    median =
      sorted.length % 2 === 0
        ? saturatingAverage([sorted[mid - 1] as number, sorted[mid] as number], flavor)
        : (sorted[mid] as number);
  }
  const avgHoldTime = saturatingAverage(
    validTrades.map((t) => t.durationMin),
    flavor,
  );

  let effSum = 0;
  let effCount = 0;
  for (const t of validTrades) {
    const e = exitEfficiency(t, ctx.compat);
    if (e !== null) {
      effSum += e;
      effCount += 1;
    }
  }
  return {
    validTrades,
    buckets,
    medianTimeToMFE: median,
    avgHoldTime,
    avgExitEfficiency: effCount === 0 ? null : effSum / effCount,
    isOverholding: median > 0 && avgHoldTime > median * 2,
  };
}

export const timeToMFEAnalysisComponent = defineComponent<BrandId, TimeToMFEAnalysisModel>({
  id: "TimeToMFEAnalysis",
  brands: ["dojix", "greenwick"],
  tab: "advanced",
  minTrades: 10,
  compute: (ctx, trades) => {
    const m = computeTimeToMFEAnalysis(ctx, trades);
    return m.validTrades.length < 10 ? null : m;
  },
});

export const timeToMFEAnalysisParity: ComponentParity<TimeToMFEAnalysisModel> = {
  component: "TimeToMFEAnalysis",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeTimeToMFEAnalysis(ctx, trades),
  members: {
    validTrades: (m) => toRef(m.validTrades),
    // MFEBucket.id is a stored String (not a UUID), so the harness keeps it.
    buckets: (m) => toRef(m.buckets),
    medianTimeToMFE: (m) => m.medianTimeToMFE,
    avgHoldTime: (m) => m.avgHoldTime,
    avgExitEfficiency: (m) => m.avgExitEfficiency,
    isOverholding: (m) => m.isOverholding,
  },
  integerMembers: ["medianTimeToMFE", "avgHoldTime"],
};
