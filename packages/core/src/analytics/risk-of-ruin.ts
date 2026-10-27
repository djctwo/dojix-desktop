// RiskOfRuin (SPEC Appendix A): probability of ruin, Kelly fraction and a risk level.
//
// Port of Dojix `Components/RiskOfRuin.swift:8-69,185-200` and Greenwick
// `Components/RiskOfRuin.swift:8-69,185-200` (the computation is identical; only fonts differ).
// - Win rate is a 0–1 **fraction** here (SPEC §3.1); breakevens count in the denominator.
// - avgWin / avgLoss over wins / losses (positive), 0 when none; rr = avgWin/avgLoss, 0 if no loss.
// - RoR = ((1 − edge)/(1 + edge))^20 with edge = w·rr − (1 − w); 1 when w ≤ 0, rr ≤ 0 or
//   edge ≤ 0; outside [0, 1) → 1 (base ≥ 1) or 0.
// - **D-04:** Swift returns 1 when w == 1 − w (exactly 50%), even with a positive edge
//   (RiskOfRuin.swift:42-43). `fixed` applies the general formula at 50% too.
// - Kelly = max(0, w − (1 − w)/rr), 0 when rr ≤ 0; half-Kelly is shown as Kelly/2.
// - Level: < .01 very low, < .05 low, < .2 moderate, < .5 high, else very high.
// - The view shows its empty state below 10 trades (RiskOfRuin.swift:110).

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { isLoss, isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { swiftMax } from "../swiftcompat/collections";
import type { ComponentParity } from "./support";

export type RoRLevel = "veryLow" | "low" | "moderate" | "high" | "veryHigh";

/** `RoRLevel.label` / `.icon` (RiskOfRuin.swift:71-103). */
export const ROR_LEVEL_INFO: Readonly<Record<RoRLevel, { label: string; icon: string }>> = {
  veryLow: { label: "Very Low", icon: "shield.checkmark.fill" },
  low: { label: "Low", icon: "shield.fill" },
  moderate: { label: "Moderate", icon: "exclamationmark.shield.fill" },
  high: { label: "High", icon: "exclamationmark.triangle.fill" },
  veryHigh: { label: "Very High", icon: "xmark.shield.fill" },
};

const INSIGHT_TEXT: Readonly<Record<RoRLevel, string>> = {
  veryLow: "Excellent risk profile — your edge protects capital well",
  low: "Good risk management — consider maintaining current position sizing",
  moderate: "Moderate risk — reduce position size or improve win rate to lower ruin probability",
  high: "High risk of ruin — significantly reduce risk per trade (use half-Kelly sizing)",
  veryHigh: "Critical — stop trading until edge improves. Current stats lead to account blowup",
};

export interface RiskOfRuinModel {
  /** Fraction 0–1. */
  winRate: number;
  avgWin: number;
  /** Positive. */
  avgLoss: number;
  rewardRiskRatio: number;
  /** Probability 0–1. */
  riskOfRuin: number;
  kellyFraction: number;
  /** UI: Kelly / 2 (the view prints `kellyFraction * 50` as a percent). */
  halfKelly: number;
  rorLevel: RoRLevel;
  insightIcon: string;
  insightText: string;
}

/** The ruin probability for a win fraction and reward:risk ratio (RiskOfRuin.swift:33-52). */
export function riskOfRuinFor(w: number, rr: number, compat: EngineContext["compat"]): number {
  if (!(w > 0) || !(rr > 0)) return 1;
  const edge = w * rr - (1 - w);
  if (!(edge > 0)) return 1;
  const q = 1 - w;
  // D-04: the Mac gives up at exactly 50% (w == q), whatever the edge.
  if (compat === "swift" && w === q) return 1;
  const base = (1 - edge) / (1 + edge);
  if (!(base >= 0 && base < 1)) return base >= 1 ? 1 : 0;
  return Math.pow(base, 20);
}

/** The level thresholds (RiskOfRuin.swift:63-69). */
export function rorLevelOf(ror: number): RoRLevel {
  if (ror < 0.01) return "veryLow";
  if (ror < 0.05) return "low";
  if (ror < 0.2) return "moderate";
  if (ror < 0.5) return "high";
  return "veryHigh";
}

export function computeRiskOfRuin(ctx: EngineContext, trades: readonly Trade[]): RiskOfRuinModel {
  const n = trades.length;
  let wins = 0;
  let winSum = 0;
  let losses = 0;
  let lossSum = 0;
  for (const t of trades) {
    if (isWin(t)) {
      wins += 1;
      winSum += profitDouble(t);
    } else if (isLoss(t)) {
      losses += 1;
      lossSum += profitDouble(t);
    }
  }
  const winRate = n === 0 ? 0 : wins / n;
  const avgWin = wins === 0 ? 0 : winSum / wins;
  const avgLoss = losses === 0 ? 0 : Math.abs(lossSum) / losses;
  const rewardRiskRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const riskOfRuin = riskOfRuinFor(winRate, rewardRiskRatio, ctx.compat);
  const kellyFraction = rewardRiskRatio > 0 ? swiftMax(0, winRate - (1 - winRate) / rewardRiskRatio) : 0;
  const rorLevel = rorLevelOf(riskOfRuin);
  return {
    winRate,
    avgWin,
    avgLoss,
    rewardRiskRatio,
    riskOfRuin,
    kellyFraction,
    halfKelly: kellyFraction / 2,
    rorLevel,
    insightIcon: rorLevel === "veryLow" || rorLevel === "low" ? "checkmark.circle" : "exclamationmark.circle",
    insightText: INSIGHT_TEXT[rorLevel],
  };
}

export const riskOfRuinComponent = defineComponent<BrandId, RiskOfRuinModel>({
  id: "RiskOfRuin",
  brands: ["dojix", "greenwick"],
  tab: "risk",
  minTrades: 10,
  compute: (ctx, trades) => computeRiskOfRuin(ctx, trades),
});

export const riskOfRuinParity: ComponentParity<RiskOfRuinModel> = {
  component: "RiskOfRuin",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeRiskOfRuin(ctx, trades),
  members: {
    winRate: (m) => m.winRate,
    avgWin: (m) => m.avgWin,
    avgLoss: (m) => m.avgLoss,
    rewardRiskRatio: (m) => m.rewardRiskRatio,
    riskOfRuin: (m) => m.riskOfRuin,
    kellyFraction: (m) => m.kellyFraction,
    // A private enum without raw values that is RefDumpable: {"$case", label, icon}.
    rorLevel: (m) => ({ $case: m.rorLevel, ...ROR_LEVEL_INFO[m.rorLevel] }),
    insightIcon: (m) => m.insightIcon,
    insightText: (m) => m.insightText,
  },
};
