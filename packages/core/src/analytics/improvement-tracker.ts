// ImprovementTracker (SPEC Appendix A): rolling win rate, average R and profit factor.
//
// Port of Dojix `Components/ImprovementTracker.swift:16-92,182-194` and Greenwick
// `Components/ImprovementTracker.swift` (identical computation). ASC; n ≥ 20; window
// w = max(10, n/10) (integer division); per window ending at i: WR% (breakevens in the
// denominator), mean R, PF (5 when there are wins and no losses, 0 with neither, capped at 5).
// Trend needs ≥ 10 points; halves split at count/2: improving when avgR rises by more than 0.1
// AND WR by more than 2; declining when avgR falls by more than 0.2 OR WR by more than 5.

import type { BrandId } from "../brand";
import { defineComponent } from "../engine/registry";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { isLoss, isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { swiftMin } from "../swiftcompat/collections";
import { idiv } from "../swiftcompat/int";
import { type ComponentParity } from "./support";

export interface RollingMetric {
  /** Index of the window's last trade (ASC). */
  id: number;
  tradeNumber: number;
  /** Percent. */
  rollingWinRate: number;
  rollingAvgR: number;
  /** Capped at 5. */
  rollingPF: number;
}

export type ImprovementTrend = "improving" | "stable" | "declining" | "insufficient";

export const IMPROVEMENT_TREND_INFO: Readonly<Record<ImprovementTrend, { label: string; icon: string; insight: string }>> = {
  improving: {
    label: "Improving",
    icon: "arrow.up.right.circle.fill",
    insight: "Your recent performance shows improvement in both win rate and risk management",
  },
  stable: { label: "Stable", icon: "equal.circle.fill", insight: "Performance is consistent — maintain your current approach" },
  declining: {
    label: "Declining",
    icon: "arrow.down.right.circle.fill",
    insight: "Recent metrics are declining — review recent trades for process drift",
  },
  insufficient: {
    label: "Need more data",
    icon: "questionmark.circle",
    insight: "Keep trading to build enough history for trend detection",
  },
};

export interface ImprovementTrackerModel {
  rollingMetrics: RollingMetric[];
  trend: ImprovementTrend;
  insightText: string;
}

function meanOf(xs: readonly RollingMetric[], f: (m: RollingMetric) => number): number {
  let total = 0;
  for (const x of xs) total += f(x);
  return total / xs.length;
}

export function computeImprovementTracker(trades: readonly Trade[]): ImprovementTrackerModel {
  const sorted = sortedByCloseAscending(trades);
  const n = sorted.length;
  const rolling: RollingMetric[] = [];
  if (n >= 20) {
    const w = Math.max(10, idiv(n, 10));
    for (let i = w - 1; i < n; i++) {
      const window = sorted.slice(i - w + 1, i + 1);
      let wins = 0;
      let rSum = 0;
      let grossWin = 0;
      let lossSum = 0;
      for (const t of window) rSum += t.rMultiple;
      for (const t of window) {
        if (isWin(t)) {
          wins += 1;
          grossWin += profitDouble(t);
        } else if (isLoss(t)) lossSum += profitDouble(t);
      }
      const grossLoss = Math.abs(lossSum);
      const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 5 : 0;
      rolling.push({
        id: i,
        tradeNumber: i + 1,
        rollingWinRate: (wins / window.length) * 100,
        rollingAvgR: rSum / window.length,
        rollingPF: swiftMin(pf, 5),
      });
    }
  }

  let trend: ImprovementTrend = "insufficient";
  if (rolling.length >= 10) {
    const half = idiv(rolling.length, 2);
    const first = rolling.slice(0, half);
    const second = rolling.slice(half);
    const firstR = meanOf(first, (m) => m.rollingAvgR);
    const secondR = meanOf(second, (m) => m.rollingAvgR);
    const firstWR = meanOf(first, (m) => m.rollingWinRate);
    const secondWR = meanOf(second, (m) => m.rollingWinRate);
    if (secondR > firstR + 0.1 && secondWR > firstWR + 2) trend = "improving";
    else if (secondR < firstR - 0.2 || secondWR < firstWR - 5) trend = "declining";
    else trend = "stable";
  }
  return { rollingMetrics: rolling, trend, insightText: IMPROVEMENT_TREND_INFO[trend].insight };
}

export const improvementTrackerComponent = defineComponent<BrandId, ImprovementTrackerModel>({
  id: "ImprovementTracker",
  brands: ["dojix", "greenwick"],
  tab: "behavioral",
  minTrades: 20,
  compute: (_ctx, trades) => computeImprovementTracker(trades),
});

export const improvementTrackerParity: ComponentParity<ImprovementTrackerModel> = {
  component: "ImprovementTracker",
  brands: ["dojix", "greenwick"],
  compute: (_ctx, trades) => computeImprovementTracker(trades),
  members: {
    rollingMetrics: (m) => m.rollingMetrics.map((r) => ({ ...r })),
    // `Trend` has no raw value and computed label/icon → {"$case", label, icon}.
    trend: (m) => ({ $case: m.trend, label: IMPROVEMENT_TREND_INFO[m.trend].label, icon: IMPROVEMENT_TREND_INFO[m.trend].icon }),
    insightText: (m) => m.insightText,
  },
};
