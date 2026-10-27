// Registry entries for the nine Greenwick-only analytics components (SPEC App. A, team E4).
// Placement = the Mac Dashboard category (Greenwick `Views/DashboardView.swift:149-266`);
// `minTrades` = the component's own guard. `compute` returns null for the card's empty state (the
// UI tells the states apart by the trade count; the messages are in each module's comments).

import { defineComponent, type AnalyticsComponent, type AnalyticsRegistry } from "../../engine/registry";
import { computeDiversificationScore } from "./diversification-score";
import { computeEarningsImpact } from "./earnings-impact";
import { computeExecutionQuality } from "./execution-quality";
import { computeGapAnalysis } from "./gap-analysis";
import { computeIntradayEquityCurve } from "./intraday-equity-curve";
import { computeOpeningRange } from "./opening-range";
import { computeRegimeAnalysis } from "./regime-analysis";
import { computeSectorExposure } from "./sector-exposure";
import { computeVolumeAnalysis } from "./volume-analysis";

const ST = ["greenwick"] as const;

export const SectorExposure = defineComponent({
  id: "SectorExposure",
  brands: ST,
  tab: "pairs",
  minTrades: 0,
  compute: (_ctx, trades) => {
    const m = computeSectorExposure(trades);
    return m.hasSectorData ? m : null;
  },
});

export const VolumeAnalysis = defineComponent({
  id: "VolumeAnalysis",
  brands: ST,
  tab: "pairs",
  minTrades: 0,
  compute: (_ctx, trades) => {
    const m = computeVolumeAnalysis(trades);
    return m.hasVolumeData ? m : null;
  },
});

export const GapAnalysis = defineComponent({
  id: "GapAnalysis",
  brands: ST,
  tab: "timing",
  minTrades: 0,
  compute: (_ctx, trades) => {
    const m = computeGapAnalysis(trades);
    return m.hasEnoughData ? m : null;
  },
});

export const OpeningRangeAnalysis = defineComponent({
  id: "OpeningRangeAnalysis",
  brands: ST,
  tab: "timing",
  minTrades: 0,
  compute: (_ctx, trades) => {
    const m = computeOpeningRange(trades);
    return m.hasData ? m : null;
  },
});

export const ExecutionQuality = defineComponent({
  id: "ExecutionQuality",
  brands: ST,
  tab: "risk",
  minTrades: 10,
  compute: (ctx, trades) => {
    const m = computeExecutionQuality(trades, ctx.compat);
    return m.tradesWithSlippage.length > 0 ? m : null;
  },
});

export const IntradayEquityCurve = defineComponent({
  id: "IntradayEquityCurve",
  brands: ST,
  tab: "advanced",
  minTrades: 10,
  compute: (_ctx, trades) => {
    const m = computeIntradayEquityCurve(trades);
    return m.hasMarketHourTrades ? m : null;
  },
});

export const RegimeAnalysis = defineComponent({
  id: "RegimeAnalysis",
  brands: ST,
  tab: "advanced",
  minTrades: 10,
  compute: (ctx, trades) => {
    const m = computeRegimeAnalysis(trades, ctx.compat);
    return m.tradingDays.length >= 3 ? m : null;
  },
});

export const EarningsImpact = defineComponent({
  id: "EarningsImpact",
  brands: ST,
  tab: "advanced",
  minTrades: 20,
  compute: (ctx, trades) => computeEarningsImpact(trades, ctx.compat),
});

export const DiversificationScore = defineComponent({
  id: "DiversificationScore",
  brands: ST,
  tab: "pairs",
  minTrades: 10,
  compute: (_ctx, trades) => {
    const m = computeDiversificationScore(trades);
    return m.symbols.length >= 2 ? m : null;
  },
});

/** The nine components, in the Mac's Dashboard order within each category. */
export const GREENWICK_ONLY_COMPONENTS: readonly AnalyticsComponent<"greenwick", unknown>[] = [
  OpeningRangeAnalysis,
  GapAnalysis,
  SectorExposure,
  VolumeAnalysis,
  DiversificationScore,
  ExecutionQuality,
  IntradayEquityCurve,
  RegimeAnalysis,
  EarningsImpact,
];

/** Adds the nine components to a registry. */
export function registerGreenwickOnlyComponents(registry: AnalyticsRegistry): AnalyticsRegistry {
  for (const c of GREENWICK_ONLY_COMPONENTS) registry.register(c);
  return registry;
}
