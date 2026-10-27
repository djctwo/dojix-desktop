// ExitAnalysis (SPEC Appendix A): how much of each move the exits capture.
//
// Port of Dojix `Components/ExitAnalysis.swift:10-78` and Greenwick
// `Components/ExitAnalysis.swift:10-68`. Shared: valid trades = those with an exit efficiency
// (`Trade.exitEfficiency`: MFE > 0 and SL distance > 0); average efficiency; money left on the
// table summed over winners (pips / points); five efficiency buckets; insight bands < 50, < 70,
// < 85. The view needs n ≥ 10 (line 87 / 77).
// Brand differences:
// - Dojix "early exit %" = winners with postClose15m > 0, plus the average post-close 15m / 30m
//   of the winners (lines 27-42).
// - Greenwick "early exit %" = winners with `exitEfficiency ?? 100` < 50 (lines 27-32); it has no
//   post-close fields.
//
// PARITY D-03: the Mac's buckets are closed ranges 0…20, 20…40, …, 80…100, so an efficiency of
// exactly 20, 40, 60 or 80 is counted in two buckets. `fixed` mode uses half-open buckets
// [0,20), [20,40), [40,60), [60,80) and a closed [80,100].

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { exitEfficiency, isWin, moneyLeftOnTable } from "../model/accessors";
import type { Trade } from "../model/trade";
import { toRef, type ComponentParity } from "./support";

/** `ExitAnalysis.Bucket` (stored: id, label, count). */
export interface ExitBucket {
  id: string;
  label: string;
  count: number;
}

export interface ExitAnalysisModel<T extends Trade = Trade> {
  validTrades: T[];
  /** Percent 0–100; 0 with no valid trade. */
  avgExitEfficiency: number;
  /** Pips (Dojix) or points (Greenwick). */
  totalMoneyLeftOnTable: number;
  winners: T[];
  /** Percent of winners (definition per brand, see the header). */
  earlyExitPercent: number;
  /** Dojix only: average postClose15m of the winners (0 with none); null for Greenwick. */
  avgPostClose15m: number | null;
  /** Dojix only: average postClose30m of the winners; null for Greenwick. */
  avgPostClose30m: number | null;
  distributionBuckets: ExitBucket[];
  exitsEarly: boolean;
  insightText: string;
}

const RANGES: readonly [string, number, number][] = [
  ["0-20%", 0, 20],
  ["20-40%", 20, 40],
  ["40-60%", 40, 60],
  ["60-80%", 60, 80],
  ["80-100%", 80, 100],
];

function inBucket(x: number, lo: number, hi: number, last: boolean, fixed: boolean): boolean {
  if (!fixed) return x >= lo && x <= hi; // ClosedRange.contains (D-03: edges count twice)
  return x >= lo && (last ? x <= hi : x < hi);
}

function insightOf(avg: number): string {
  if (avg < 50) return "Exiting way too early — capturing less than half of available moves";
  if (avg < 70) return "Exiting early — consider trailing stops to capture more of each move";
  if (avg < 85) return "Solid exit timing — capturing most of the available move";
  return "Excellent exits — near-optimal profit capture";
}

export function computeExitAnalysis<T extends Trade>(ctx: Pick<EngineContext, "brand" | "compat">, trades: readonly T[]): ExitAnalysisModel<T> {
  const compat = ctx.compat;
  const effs: number[] = [];
  const validTrades: T[] = [];
  for (const t of trades) {
    const e = exitEfficiency(t, compat);
    if (e !== null) {
      validTrades.push(t);
      effs.push(e);
    }
  }
  let effSum = 0;
  for (const e of effs) effSum += e;
  const avgExitEfficiency = validTrades.length === 0 ? 0 : effSum / validTrades.length;

  let totalMoneyLeftOnTable = 0;
  for (const t of trades) {
    const m = moneyLeftOnTable(t, compat);
    if (m !== null) totalMoneyLeftOnTable += m;
  }

  const winners = trades.filter(isWin);
  let earlyExitPercent = 0;
  let avgPostClose15m: number | null = null;
  let avgPostClose30m: number | null = null;
  if (ctx.brand === "dojix") {
    avgPostClose15m = 0;
    avgPostClose30m = 0;
    if (winners.length > 0) {
      let continued = 0;
      let s15 = 0;
      let s30 = 0;
      for (const t of winners) {
        if (t.brand !== "dojix") continue;
        if (t.postClose15m > 0) continued += 1;
        s15 += t.postClose15m;
        s30 += t.postClose30m;
      }
      earlyExitPercent = (continued / winners.length) * 100;
      avgPostClose15m = s15 / winners.length;
      avgPostClose30m = s30 / winners.length;
    }
  } else if (winners.length > 0) {
    let early = 0;
    for (const t of winners) if ((exitEfficiency(t, compat) ?? 100) < 50) early += 1;
    earlyExitPercent = (early / winners.length) * 100;
  }

  const fixed = compat === "fixed";
  const distributionBuckets = RANGES.map(([label, lo, hi], i) => {
    let count = 0;
    for (const e of effs) if (inBucket(e, lo, hi, i === RANGES.length - 1, fixed)) count += 1;
    return { id: label, label, count };
  });

  return {
    validTrades,
    avgExitEfficiency,
    totalMoneyLeftOnTable,
    winners,
    earlyExitPercent,
    avgPostClose15m,
    avgPostClose30m,
    distributionBuckets,
    exitsEarly: avgExitEfficiency < 70,
    insightText: insightOf(avgExitEfficiency),
  };
}

export const exitAnalysisComponent = defineComponent<BrandId, ExitAnalysisModel>({
  id: "ExitAnalysis",
  brands: ["dojix", "greenwick"],
  tab: "risk",
  minTrades: 10,
  compute: (ctx, trades) => computeExitAnalysis(ctx, trades),
});

export const exitAnalysisParity: ComponentParity<ExitAnalysisModel> = {
  component: "ExitAnalysis",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeExitAnalysis(ctx, trades),
  members: {
    validTrades: (m) => toRef(m.validTrades),
    avgExitEfficiency: (m) => m.avgExitEfficiency,
    totalMoneyLeftOnTable: (m) => m.totalMoneyLeftOnTable,
    winners: (m) => toRef(m.winners),
    earlyExitPercent: (m) => m.earlyExitPercent,
    avgPostClose15m: (m) => m.avgPostClose15m,
    avgPostClose30m: (m) => m.avgPostClose30m,
    distributionBuckets: (m) => toRef(m.distributionBuckets),
    exitsEarly: (m) => m.exitsEarly,
    insightText: (m) => m.insightText,
  },
};
