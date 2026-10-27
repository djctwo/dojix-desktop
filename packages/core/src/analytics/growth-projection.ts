// GrowthProjection (SPEC Appendix A): equity projected from trade frequency and expectancy.
//
// Port of Dojix `Components/GrowthProjection.swift:9-33` and Greenwick
// `Components/GrowthProjection.swift:9-33` (identical). Both apps use the **computer's**
// calendar here (`Calendar.current`), so the desktop uses `ctx.localCalendar`.
// - tradesPerWeek: n ≥ 5, else 0; weeks = max(1, whole days from the first close to the last)
//   / 7 with **integer** division; tpw = weeks > 0 ? n / weeks : n (fewer than 7 days → n).
// - projectionData (expectancy > 0 and tpw > 0, else empty): for w = 0…months×4,
//   expected = E × tpw × w, conservative ×0.6, optimistic ×1.4. E = MetricsCalculator's
//   expectancy of the same trades.
// - months: @State, default 6 (picker 3 / 6 / 12). The harness also reads
//   `GrowthProjection[months3]` and `[months12]`.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { calculateMetrics, sortedByCloseAscending } from "../metrics/metrics-calculator";
import type { Trade } from "../model/trade";
import { swiftMax } from "../swiftcompat/collections";
import { idiv } from "../swiftcompat/int";
import { toRef, type ComponentParity } from "./support";

export interface GrowthPoint {
  week: number;
  conservative: number;
  expected: number;
  optimistic: number;
}

export interface GrowthProjectionModel {
  tradesPerWeek: number;
  projectionData: GrowthPoint[];
  months: number;
  /** MetricsCalculator expectancy (the "Exp/trade" pill). */
  expectancy: number;
  /** The "<months>mo target": the last point's expected value, null when empty. */
  target: number | null;
}

export interface GrowthProjectionOptions {
  /** 3, 6 (default) or 12. */
  months?: number;
}

export function computeGrowthProjection(
  ctx: EngineContext,
  trades: readonly Trade[],
  options: GrowthProjectionOptions = {},
): GrowthProjectionModel {
  const months = options.months ?? 6;
  const n = trades.length;
  let tradesPerWeek = 0;
  if (n >= 5) {
    const sorted = sortedByCloseAscending(trades);
    const first = (sorted[0] as Trade).closeTime;
    const last = (sorted[sorted.length - 1] as Trade).closeTime;
    const weeks = idiv(swiftMax(1, ctx.localCalendar.daysBetween(first, last)), 7);
    tradesPerWeek = weeks > 0 ? n / weeks : n;
  }
  const expectancy = calculateMetrics(trades, ctx).expectancy;
  const projectionData: GrowthPoint[] = [];
  if (expectancy > 0 && tradesPerWeek > 0) {
    const weeklyExpected = expectancy * tradesPerWeek;
    for (let w = 0; w <= months * 4; w++) {
      const expected = weeklyExpected * w;
      projectionData.push({ week: w, conservative: expected * 0.6, expected, optimistic: expected * 1.4 });
    }
  }
  const lastPoint = projectionData[projectionData.length - 1];
  return { tradesPerWeek, projectionData, months, expectancy, target: lastPoint ? lastPoint.expected : null };
}

export const growthProjectionComponent = defineComponent<BrandId, GrowthProjectionModel>({
  id: "GrowthProjection",
  brands: ["dojix", "greenwick"],
  tab: "risk",
  minTrades: 0,
  // Empty state: "Insufficient data for projection" (+ "Positive expectancy required" when
  // E ≤ 0); call computeGrowthProjection directly for the reason.
  compute: (ctx, trades) => {
    const m = computeGrowthProjection(ctx, trades);
    return m.projectionData.length === 0 ? null : m;
  },
});

const INSTANCES: Readonly<Record<string, GrowthProjectionOptions>> = { months3: { months: 3 }, months12: { months: 12 } };

export const growthProjectionParity: ComponentParity<GrowthProjectionModel> = {
  component: "GrowthProjection",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades, instance) => {
    if (instance === undefined) return computeGrowthProjection(ctx, trades);
    const opts = INSTANCES[instance];
    return opts ? computeGrowthProjection(ctx, trades, opts) : undefined;
  },
  members: {
    tradesPerWeek: (m) => m.tradesPerWeek,
    // Array of labelled tuples (week:, conservative:, expected:, optimistic:) → objects.
    projectionData: (m) => toRef(m.projectionData),
  },
};
