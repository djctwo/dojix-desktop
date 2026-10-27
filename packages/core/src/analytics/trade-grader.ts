// TradeGrader (SPEC §3.3 and Appendix A "TradeGrader FX" / "TradeGrader ST"): a 0–100 grade per
// trade from four 0–25 sub-scores (R, execution, timing, management).
//
// Port of Dojix `Components/TradeGrader.swift:34-171` and Greenwick
// `Components/TradeGrader.swift:34-161`. Brand differences:
// - Execution: Dojix adds +5 for `usedFVG`; Greenwick has no FVG (lines 72-94 vs 72-91).
// - Timing: Dojix sessions London/NY Overlap 10, NY 7, Asian 5, Late 2, hours (UTC)
//   7–9 or 12–14 → 10, 9–12 or 14–16 → 7, 16–21 → 4, else 1, then bias WITH +5 / NEUTRAL +2.
//   Greenwick sessions Regular 10, Pre-market 7, After-hours 5, Extended 2, hours (ET) 9–10 or
//   15–16 → 10, 10–12 or 13–15 → 7, 4–9 → 4, else 1, no bias (lines 97-121).
// - Management, win: Dojix scores `postClose30m` (< 5 → 10, < 15 → 6, else 2); Greenwick scores
//   `exitEfficiency` (> 60 → 10, > 30 → 6, else / nil → 2).
//
// Swift traps reproduced:
// - `averageDuration` is an Int: `max(avgDur, 1)`, and the loss "quick cut" threshold
//   `max(avgDur / 2, 5)` uses Int division (truncating, `idiv`).
// - Closed ranges overlap (`7...9` then `9...12`): the first matching branch wins.
// - A NaN R / ratio / slippage fails every `>=` / `<=` test and falls to the last branch.
// - Unknown MAE/MFE (PARITY D-18) is read as 0 here in **both** compat modes: D-18 covers
//   averages and display ("—"), not grading, and the Mac's ratio rule already treats a zero MAE
//   and MFE as "no excursion data" (ratio 0 → +3). Changing that would be a new divergence.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { calculateMetrics, type PortfolioMetrics } from "../metrics/metrics-calculator";
import { exitEfficiency, isWin, maeRaw, mfeRaw, slippage } from "../model/accessors";
import type { DojixTrade, GreenwickTrade, Trade } from "../model/trade";
import { swiftMax, swiftMin } from "../swiftcompat/collections";
import { idiv } from "../swiftcompat/int";
import type { ComponentParity } from "./support";

export type TradeGradeLetter = "A" | "B" | "C" | "D" | "F";

/** `TradeGrader.TradeGrade` (TradeGrader.swift:6-31). */
export interface TradeGrade {
  overall: TradeGradeLetter;
  rScore: number;
  executionScore: number;
  timingScore: number;
  managementScore: number;
  total: number;
}

/** `TradeGrade.Grade` raw values in declaration order. */
export const TRADE_GRADE_LETTERS: readonly TradeGradeLetter[] = ["A", "B", "C", "D", "F"];

/** Letter for a total (TradeGrader.swift:41-46): ≥80 A, ≥65 B, ≥50 C, ≥35 D, else F. */
export function gradeLetter(total: number): TradeGradeLetter {
  if (total >= 80) return "A";
  if (total >= 65) return "B";
  if (total >= 50) return "C";
  if (total >= 35) return "D";
  return "F";
}

/** `gradeRMultiple` (TradeGrader.swift:60-70, both brands). */
export function gradeRMultiple(r: number): number {
  if (r >= 3.0) return 25;
  if (r >= 2.0) return 22;
  if (r >= 1.5) return 20;
  if (r >= 1.0) return 17;
  if (r >= 0.5) return 13;
  if (r >= 0) return 8;
  if (r >= -0.5) return 5;
  if (r >= -1.0) return 3;
  return 0;
}

/** `gradeExecution` (Dojix TradeGrader.swift:74-94, Greenwick :74-91). */
export function gradeExecution(t: Trade): number {
  const mae = maeRaw(t) ?? 0;
  const mfe = mfeRaw(t) ?? 0;
  const ratio = mae > 0 ? mfe / mae : mfe > 0 ? 10 : 0;
  let score = 0;
  if (ratio >= 3) score += 15;
  else if (ratio >= 2) score += 12;
  else if (ratio >= 1.5) score += 10;
  else if (ratio >= 1) score += 7;
  else score += 3;
  const slip = slippage(t);
  if (slip <= 0.5) score += 5;
  else if (slip <= 1.0) score += 3;
  else if (slip <= 2.0) score += 1;
  if (t.brand === "dojix" && t.usedFVG) score += 5;
  return swiftMin(25, score);
}

const within = (h: number, lo: number, hi: number) => h >= lo && h <= hi;

function gradeTimingFx(t: DojixTrade): number {
  let score = 0;
  switch (t.session) {
    case "LONDON":
    case "NY_OVERLAP":
      score += 10;
      break;
    case "NY":
      score += 7;
      break;
    case "ASIAN":
      score += 5;
      break;
    case "LATE":
      score += 2;
      break;
  }
  const h = t.hour;
  if (within(h, 7, 9) || within(h, 12, 14)) score += 10;
  else if (within(h, 9, 12) || within(h, 14, 16)) score += 7;
  else if (within(h, 16, 21)) score += 4;
  else score += 1;
  if (t.biasAtEntry === "WITH") score += 5;
  else if (t.biasAtEntry === "NEUTRAL") score += 2;
  return swiftMin(25, score);
}

function gradeTimingSt(t: GreenwickTrade): number {
  let score = 0;
  switch (t.session) {
    case "REGULAR":
      score += 10;
      break;
    case "PRE_MARKET":
      score += 7;
      break;
    case "AFTER_HOURS":
      score += 5;
      break;
    case "EXTENDED":
      score += 2;
      break;
  }
  const h = t.hour;
  if (within(h, 9, 10) || within(h, 15, 16)) score += 10;
  else if (within(h, 10, 12) || within(h, 13, 15)) score += 7;
  else if (within(h, 4, 9)) score += 4;
  else score += 1;
  return swiftMin(25, score);
}

/** `gradeTiming` (Dojix TradeGrader.swift:97-132, Greenwick :94-122). */
export function gradeTiming(t: Trade): number {
  return t.brand === "dojix" ? gradeTimingFx(t) : gradeTimingSt(t);
}

/** `gradeManagement` (Dojix TradeGrader.swift:135-171, Greenwick :125-161). */
export function gradeManagement(t: Trade, metrics: Pick<PortfolioMetrics, "averageDuration">, ctx: Pick<EngineContext, "compat">): number {
  let score = 0;
  const win = isWin(t);
  if (t.hitBreakeven && win) score += 5;

  const avgDur = swiftMax(metrics.averageDuration, 1);
  const durRatio = t.durationMin / avgDur;
  if (durRatio >= 0.5 && durRatio <= 2.0) score += 10;
  else if (durRatio >= 0.25 && durRatio <= 3.0) score += 6;
  else score += 2;

  if (win) {
    if (t.brand === "dojix") {
      if (t.postClose30m < 5) score += 10;
      else if (t.postClose30m < 15) score += 6;
      else score += 2;
    } else {
      const eff = exitEfficiency(t, ctx.compat);
      if (eff !== null && eff > 60) score += 10;
      else if (eff !== null && eff > 30) score += 6;
      else score += 2;
    }
  } else if (t.durationMin <= swiftMax(idiv(avgDur, 2), 5)) {
    score += 8;
  } else {
    score += 4;
  }
  return swiftMin(25, score);
}

/** `TradeGrader.grade(_:portfolioMetrics:)` (TradeGrader.swift:34-56). */
export function gradeTrade(
  trade: Trade,
  portfolioMetrics: Pick<PortfolioMetrics, "averageDuration">,
  ctx: Pick<EngineContext, "compat">,
): TradeGrade {
  const rScore = gradeRMultiple(trade.rMultiple);
  const executionScore = gradeExecution(trade);
  const timingScore = gradeTiming(trade);
  const managementScore = gradeManagement(trade, portfolioMetrics, ctx);
  const total = rScore + executionScore + timingScore + managementScore;
  return { overall: gradeLetter(total), rScore, executionScore, timingScore, managementScore, total };
}

export interface GradedTrade<T extends Trade = Trade> {
  trade: T;
  grade: TradeGrade;
}

/** Grades every trade against the metrics of the whole set (how the Mac grades the journal). */
export function gradeTrades<T extends Trade>(ctx: Pick<EngineContext, "brand" | "compat">, trades: readonly T[]): GradedTrade<T>[] {
  const metrics = calculateMetrics(trades, ctx);
  return trades.map((trade) => ({ trade, grade: gradeTrade(trade, metrics, ctx) }));
}

/**
 * Harness key "TradeGrader.grades" (tools/swift-ref RefPipeline): `(ticket: String, grade:
 * TradeGrade)` per journal trade, graded against `MetricsCalculator.calculate(from: journal)`.
 */
export const tradeGraderParity: ComponentParity<GradedTrade[]> = {
  component: "TradeGrader",
  brands: ["dojix", "greenwick"] as readonly BrandId[],
  compute: (ctx, trades) => gradeTrades(ctx, trades),
  members: {
    grades: (graded) => graded.map((g) => ({ ticket: g.trade.ticket, grade: { ...g.grade } })),
  },
};
