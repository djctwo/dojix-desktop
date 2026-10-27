// ExpectancyCurve (SPEC Appendix A): actual cumulative P&L against E × trade number.
//
// Port of Dojix `Components/ExpectancyCurve.swift:8-31` and Greenwick
// `Components/ExpectancyCurve.swift:8-31` (identical).
// - projectionPoints: n ≥ 10 and E ≠ 0 (MetricsCalculator expectancy), else empty; ASC by
//   close time; actual = running total; projected = E × (i + 1); trade = i + 1.
// - deviation (header text): "—" when empty; else pct = (lastA − lastP) / |lastP| × 100
//   (0 if lastP == 0), "+" prefix when the difference is ≥ 0, `%.0f%%` (printf half-even),
//   then " vs expected".

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { calculateMetrics, sortedByCloseAscending } from "../metrics/metrics-calculator";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { swiftFormat } from "../swiftcompat/format";
import { toRef, type ComponentParity } from "./support";

export interface ExpectancyPoint {
  trade: number;
  actual: number;
  projected: number;
}

export interface ExpectancyCurveModel {
  projectionPoints: ExpectancyPoint[];
  deviation: string;
  /** MetricsCalculator expectancy ("Expected ($x/trade)" legend). */
  expectancy: number;
}

export function computeExpectancyCurve(ctx: EngineContext, trades: readonly Trade[]): ExpectancyCurveModel {
  const expectancy = calculateMetrics(trades, ctx).expectancy;
  const projectionPoints: ExpectancyPoint[] = [];
  if (trades.length >= 10 && expectancy !== 0) {
    let cumulative = 0;
    sortedByCloseAscending(trades).forEach((t, i) => {
      cumulative += profitDouble(t);
      projectionPoints.push({ trade: i + 1, actual: cumulative, projected: expectancy * (i + 1) });
    });
  }
  const last = projectionPoints[projectionPoints.length - 1];
  let deviation = "—";
  if (last) {
    const diff = last.actual - last.projected;
    const pct = last.projected !== 0 ? (diff / Math.abs(last.projected)) * 100 : 0;
    deviation = `${diff >= 0 ? "+" : ""}${swiftFormat("%.0f%%", pct)} vs expected`;
  }
  return { projectionPoints, deviation, expectancy };
}

export const expectancyCurveComponent = defineComponent<BrandId, ExpectancyCurveModel>({
  id: "ExpectancyCurve",
  brands: ["dojix", "greenwick"],
  tab: "risk",
  minTrades: 10,
  compute: (ctx, trades) => {
    const m = computeExpectancyCurve(ctx, trades);
    return m.projectionPoints.length === 0 ? null : m;
  },
});

export const expectancyCurveParity: ComponentParity<ExpectancyCurveModel> = {
  component: "ExpectancyCurve",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeExpectancyCurve(ctx, trades),
  members: {
    projectionPoints: (m) => toRef(m.projectionPoints),
    deviation: (m) => m.deviation,
  },
};
