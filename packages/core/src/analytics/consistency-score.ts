// ConsistencyScore (SPEC Appendix A): five 0–100 sub-scores and their mean.
//
// Port of Dojix `Components/ConsistencyScore.swift:14-64,147-248` and Greenwick
// `Components/ConsistencyScore.swift` (identical except `reduce(0, +)` for `saturatingSum()`
// on the drawdown lengths, and shares for lots). n ≥ 10, ASC.
// 1. Win rate: windows of w = max(5, n/4) trades, fraction per window; (1 − σ/μ)×100 clamped,
//    cv = 1 when μ = 0.
// 2. P/F of the two halves (split at n/2; 10 when a half has wins and no losses):
//    min/max(max, 0.01) × 100, capped at 100; 0 when neither half is above 0.
// 3. Underwater stretches (trades below the running peak, peak from 0, `>=` resets):
//    100 − avg/n×200 − (max > n/3 ? 20 : 0), clamped; 100 when there are none.
// 4. Size CV: (1 − cv)×100 clamped; 50 when the mean size is not above 0.
// 5. Timing: min(100, (1 − uniqueHours/24)×120) over the stored hour.
// Clamps are Swift `max(0, min(100, x))`: a NaN x becomes 100 there (min(100, NaN) = 100).
// Grade: ≥85 A, ≥70 B, ≥55 C, ≥40 D, else F.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { isLoss, isWin, profitDouble, quantity } from "../model/accessors";
import type { Trade } from "../model/trade";
import { seqMax, swiftMax, swiftMin } from "../swiftcompat/collections";
import { idiv, intSaturating, saturatingSum } from "../swiftcompat/int";
import { type ComponentParity } from "./support";

export interface ScoreDimension {
  name: string;
  /** 0–100. */
  score: number;
  detail: string;
}

export type ConsistencyGrade = "a" | "b" | "c" | "d" | "f";

export interface ConsistencyScoreModel {
  /** Empty below 10 trades. */
  dimensions: ScoreDimension[];
  overallScore: number;
  grade: ConsistencyGrade;
  /** Grade letter ("A"…"F"). */
  gradeLabel: string;
  /** The weakest dimension when its score is below 60 (the view's "Focus area"). */
  focusArea: ScoreDimension | null;
}

/** Swift `max(0, min(100, x))`. */
function clampScore(x: number): number {
  return swiftMax(0, swiftMin(100, x));
}

function winRateStability(sorted: readonly Trade[]): ScoreDimension {
  const n = sorted.length;
  const w = Math.max(5, idiv(n, 4));
  const rates: number[] = [];
  for (let i = 0; i <= n - w; i++) {
    let wins = 0;
    for (let j = i; j < i + w; j++) if (isWin(sorted[j] as Trade)) wins += 1;
    rates.push(wins / w);
  }
  if (rates.length === 0) return { name: "Win Rate", score: 50, detail: "Not enough data" };
  let total = 0;
  for (const r of rates) total += r;
  const mean = total / rates.length;
  let sq = 0;
  for (const r of rates) sq += (r - mean) * (r - mean);
  const variance = sq / rates.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  return {
    name: "Win Rate",
    score: clampScore((1 - cv) * 100),
    detail: cv > 0.3 ? "Win rate varies significantly between periods" : "Stable win rate",
  };
}

function profitFactorOfHalf(trades: readonly Trade[]): number {
  let gross = 0;
  let loss = 0;
  for (const t of trades) if (isWin(t)) gross += profitDouble(t);
  for (const t of trades) if (isLoss(t)) loss += profitDouble(t);
  loss = Math.abs(loss);
  return loss > 0 ? gross / loss : gross > 0 ? 10 : 0;
}

function profitFactorConsistency(sorted: readonly Trade[]): ScoreDimension {
  const half = idiv(sorted.length, 2);
  const pf1 = profitFactorOfHalf(sorted.slice(0, half));
  const pf2 = profitFactorOfHalf(sorted.slice(half));
  if (!(pf1 > 0 || pf2 > 0)) return { name: "P/F Stability", score: 0, detail: "No profitable periods" };
  const ratio = swiftMin(pf1, pf2) / swiftMax(swiftMax(pf1, pf2), 0.01);
  return {
    name: "P/F Stability",
    score: swiftMin(100, ratio * 100),
    detail: ratio < 0.5 ? "Profit factor differs significantly between halves" : "Consistent profitability",
  };
}

function drawdownRecovery(sorted: readonly Trade[], flavor: "dojix" | "greenwick"): ScoreDimension {
  let peak = 0;
  let cumulative = 0;
  const periods: number[] = [];
  let current = 0;
  for (const t of sorted) {
    cumulative += profitDouble(t);
    if (cumulative >= peak) {
      peak = cumulative;
      if (current > 0) {
        periods.push(current);
        current = 0;
      }
    } else current += 1;
  }
  if (current > 0) periods.push(current);
  if (periods.length === 0) return { name: "Recovery", score: 100, detail: "No drawdowns" };
  const n = sorted.length;
  const avgDD = saturatingSum(periods) / periods.length;
  const maxDD = seqMax(periods) ?? 0;
  const score = clampScore(100 - (avgDD / n) * 200 - (maxDD > n / 3 ? 20 : 0));
  return {
    name: "Recovery",
    score,
    detail: avgDD > 5 ? `Avg ${intSaturating(avgDD, flavor)} trades to recover from drawdowns` : "Quick recovery from drawdowns",
  };
}

function sizingDiscipline(sorted: readonly Trade[], greenwick: boolean): ScoreDimension {
  const sizes = sorted.map(quantity);
  let total = 0;
  for (const s of sizes) total += s;
  const mean = total / sizes.length;
  if (!(mean > 0)) return { name: "Sizing", score: 50, detail: "No sizing data" };
  let sq = 0;
  for (const s of sizes) sq += (s - mean) * (s - mean);
  const cv = Math.sqrt(sq / sizes.length) / mean;
  return {
    name: "Sizing",
    score: clampScore((1 - cv) * 100),
    detail:
      cv > 0.5
        ? `${greenwick ? "Position" : "Lot"} sizes vary widely — sign of revenge trading`
        : "Consistent position sizing",
  };
}

function timingConsistency(sorted: readonly Trade[]): ScoreDimension {
  const unique = new Set(sorted.map((t) => t.hour)).size;
  const concentration = 1 - unique / 24;
  return {
    name: "Timing",
    score: swiftMin(100, concentration * 120),
    detail: unique > 8 ? "Trading across too many hours — pick a session" : "Focused trading hours",
  };
}

const GRADE_LABEL: Readonly<Record<ConsistencyGrade, string>> = { a: "A", b: "B", c: "C", d: "D", f: "F" };

export function computeConsistencyScore(ctx: EngineContext, trades: readonly Trade[]): ConsistencyScoreModel {
  const greenwick = ctx.brand === "greenwick";
  let dimensions: ScoreDimension[] = [];
  if (trades.length >= 10) {
    const sorted = sortedByCloseAscending(trades);
    dimensions = [
      winRateStability(sorted),
      profitFactorConsistency(sorted),
      drawdownRecovery(sorted, greenwick ? "greenwick" : "dojix"),
      sizingDiscipline(sorted, greenwick),
      timingConsistency(sorted),
    ];
  }
  let overall = 0;
  if (dimensions.length > 0) {
    let total = 0;
    for (const d of dimensions) total += d.score;
    overall = total / dimensions.length;
  }
  const grade: ConsistencyGrade = overall >= 85 ? "a" : overall >= 70 ? "b" : overall >= 55 ? "c" : overall >= 40 ? "d" : "f";
  // `dimensions.min(by: score <)`: the first of equal minima.
  let weakest: ScoreDimension | null = null;
  for (const d of dimensions) if (weakest === null || d.score < weakest.score) weakest = d;
  return {
    dimensions,
    overallScore: overall,
    grade,
    gradeLabel: GRADE_LABEL[grade],
    focusArea: weakest !== null && weakest.score < 60 ? weakest : null,
  };
}

export const consistencyScoreComponent = defineComponent<BrandId, ConsistencyScoreModel>({
  id: "ConsistencyScore",
  brands: ["dojix", "greenwick"],
  tab: "behavioral",
  minTrades: 10,
  compute: (ctx, trades) => computeConsistencyScore(ctx, trades),
});

export const consistencyScoreParity: ComponentParity<ConsistencyScoreModel> = {
  component: "ConsistencyScore",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeConsistencyScore(ctx, trades),
  members: {
    dimensions: (m) => m.dimensions.map((d) => ({ name: d.name, score: d.score, detail: d.detail })),
    overallScore: (m) => m.overallScore,
    // `Grade` has no raw value and a computed `label` → {"$case", label}.
    grade: (m) => ({ $case: m.grade, label: m.gradeLabel }),
  },
};
