// DrawdownChart (SPEC Appendix A): the running drawdown below the equity peak.
//
// Port of Dojix `Components/DrawdownChart.swift:8-23` and Greenwick
// `Components/DrawdownChart.swift:8-23` (identical computation). ASC by close time;
// cumulative and peak both start at 0; dd = cum − peak (≤ 0). The header's "Max" is
// `drawdownData.map(\.drawdown).min()` (line 32).

import type { BrandId } from "../brand";
import { defineComponent } from "../engine/registry";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { seqMin, swiftMax } from "../swiftcompat/collections";
import { toRef, type ComponentParity } from "./support";

export interface DrawdownPoint {
  /** Close time, epoch ms. */
  date: number;
  /** ≤ 0: dollars below the running peak. */
  drawdown: number;
}

export interface DrawdownChartModel {
  drawdownData: DrawdownPoint[];
  /** The header's "Max": the lowest drawdown, null when there are no trades. */
  maxDrawdown: number | null;
}

export function computeDrawdownChart(trades: readonly Trade[]): DrawdownChartModel {
  const data: DrawdownPoint[] = [];
  let cumulative = 0;
  let peak = 0;
  for (const t of sortedByCloseAscending(trades)) {
    cumulative += profitDouble(t);
    peak = swiftMax(peak, cumulative);
    data.push({ date: t.closeTime, drawdown: cumulative - peak });
  }
  return { drawdownData: data, maxDrawdown: seqMin(data.map((p) => p.drawdown)) ?? null };
}

export const drawdownChartComponent = defineComponent<BrandId, DrawdownChartModel>({
  id: "DrawdownChart",
  brands: ["dojix", "greenwick"],
  tab: { dojix: "overview", greenwick: "risk" },
  minTrades: 1,
  compute: (_ctx, trades) => computeDrawdownChart(trades),
});

export const drawdownChartParity: ComponentParity<DrawdownChartModel> = {
  component: "DrawdownChart",
  brands: ["dojix", "greenwick"],
  compute: (_ctx, trades) => computeDrawdownChart(trades),
  members: { drawdownData: (m) => toRef(m.drawdownData, { dates: ["date"] }) },
};
