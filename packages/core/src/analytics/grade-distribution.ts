// GradeDistribution (SPEC Appendix A): share of trades per TradeGrader letter.
//
// Port of Dojix `Components/GradeDistribution.swift:16-56` and Greenwick
// `Components/GradeDistribution.swift:16-56` (identical computation; the grades themselves use
// each brand's TradeGrader). Every trade is graded against `MetricsCalculator.calculate` of the
// whole set. Buckets in A…F order, empty letters omitted, percent = count / n × 100.
// averageScore = Double(Σ Int totals) / n. The view needs n ≥ 5 (line 63) and shows the A+B and
// D+F shares (lines 99-102) and a colour band at 70 / 50.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import type { Trade } from "../model/trade";
import type { ComponentParity } from "./support";
import { gradeTrades, TRADE_GRADE_LETTERS, type TradeGradeLetter } from "./trade-grader";

/** `GradeDistribution.GradeBucket` (stored: id, grade, count, percent; colour omitted). */
export interface GradeBucket {
  id: TradeGradeLetter;
  grade: TradeGradeLetter;
  count: number;
  /** Percent of all trades. */
  percent: number;
}

export interface GradeDistributionModel {
  gradeData: GradeBucket[];
  averageScore: number;
  /** View: A + B share, percent (0 for no trades). */
  abPercent: number;
  /** View: D + F share, percent. */
  dfPercent: number;
}

export function computeGradeDistribution(ctx: Pick<EngineContext, "brand" | "compat">, trades: readonly Trade[]): GradeDistributionModel {
  if (trades.length === 0) return { gradeData: [], averageScore: 0, abPercent: 0, dfPercent: 0 };
  const graded = gradeTrades(ctx, trades);
  const counts: Record<TradeGradeLetter, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  let totalScore = 0;
  for (const { grade } of graded) {
    counts[grade.overall] += 1;
    totalScore += grade.total;
  }
  const n = trades.length;
  const gradeData: GradeBucket[] = [];
  for (const g of TRADE_GRADE_LETTERS) {
    const count = counts[g];
    if (count > 0) gradeData.push({ id: g, grade: g, count, percent: (count / n) * 100 });
  }
  const share = (letters: readonly TradeGradeLetter[]) => {
    let c = 0;
    for (const b of gradeData) if (letters.includes(b.grade)) c += b.count;
    return (c / n) * 100;
  };
  return { gradeData, averageScore: totalScore / n, abPercent: share(["A", "B"]), dfPercent: share(["D", "F"]) };
}

export const gradeDistributionComponent = defineComponent<BrandId, GradeDistributionModel>({
  id: "GradeDistribution",
  brands: ["dojix", "greenwick"],
  tab: "behavioral",
  minTrades: 5,
  compute: (ctx, trades) => computeGradeDistribution(ctx, trades),
});

export const gradeDistributionParity: ComponentParity<GradeDistributionModel> = {
  component: "GradeDistribution",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeGradeDistribution(ctx, trades),
  members: {
    gradeData: (m) => m.gradeData.map((b) => ({ id: b.id, grade: b.grade, count: b.count, percent: b.percent })),
    averageScore: (m) => m.averageScore,
  },
};
