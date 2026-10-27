// The E2 analytics components (Timing, Sessions and Pairs / Symbols tabs, plus the Overview
// cards) as registry entries (SPEC §7.3). `compute` returns the component's model, or null for
// the Mac's empty state; `minTrades` is the Mac's own "Need at least N trades" guard (the
// registry returns null below it and the view shows that message).
//
// Placements follow FORMULA_INDEX (formulas.ts), which follows the Mac Dashboard categories.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { AnalyticsRegistry, defineComponent, type AnalyticsComponent } from "../engine/registry";
import type { Trade } from "../model/trade";
import { dayOfWeekChart } from "./day-of-week";
import { directionalEdge } from "./directional-edge";
import { durationAnalysis } from "./duration-analysis";
import { hourlyPnL } from "./hourly-pnl";
import { killZoneOptimizer } from "./kill-zone";
import { MAE_MFE_MIN_TRADES, maeMfeChart } from "./mae-mfe";
import { performanceSummary } from "./performance-summary";
import { periodComparison } from "./period-comparison";
import { rMultipleChart } from "./r-multiple";
import { SEQUENCE_MIN_TRADES, sequenceAnalysis } from "./sequence-analysis";
import { sessionHeatmap } from "./session-heatmap";
import { sessionIntelligence } from "./session-intelligence";
import { sessionRanking } from "./session-ranking";
import { SIZE_ANALYSIS_MIN_TRADES, sizeAnalysis } from "./size-analysis";
import { slippageAnalysis } from "./slippage";
import { streakCard } from "./streak-card";
import { streakTimeline } from "./streak-timeline";
import { symbolAnalytics } from "./symbol-analytics";
import { tradeCalendar } from "./trade-calendar";
import { tradeTimeHeatmap } from "./trade-time-heatmap";
import { weeklyHeatmap } from "./weekly-heatmap";
import { WHAT_TO_CUT_MIN_TRADES, whatToCut } from "./what-to-cut";
import { winLossDistribution } from "./win-loss-distribution";

const BOTH: readonly BrandId[] = ["dojix", "greenwick"];

type Compute<M> = (ctx: EngineContext, trades: readonly Trade[]) => M | null;

/** Null for no trades (the Mac's "No trades yet" / "No trade data" states), else the model. */
function unlessEmpty<M>(f: (ctx: EngineContext, trades: readonly Trade[]) => M): Compute<M> {
  return (ctx, trades) => (trades.length === 0 ? null : f(ctx, trades));
}

function shared<M>(id: string, tab: AnalyticsComponent["tab"], minTrades: number, compute: Compute<M>): AnalyticsComponent<BrandId, M> {
  return defineComponent<BrandId, M>({ id, brands: BOTH, tab, minTrades, compute });
}

// --- Timing ----------------------------------------------------------------------------------

export const HourlyPnLChart = shared("HourlyPnLChart", "timing", 0, hourlyPnL);
export const DurationAnalysis = shared("DurationAnalysis", "timing", 0, unlessEmpty(durationAnalysis));
export const DayOfWeekChart = shared("DayOfWeekChart", "timing", 0, unlessEmpty(dayOfWeekChart));
export const TradeTimeHeatmap = shared("TradeTimeHeatmap", "timing", 0, unlessEmpty(tradeTimeHeatmap));
/** Shows the month of `ctx.now`; the UI calls `tradeCalendar(ctx, trades, month)` to navigate. */
export const TradeCalendar = shared("TradeCalendar", "timing", 0, (ctx, trades) => tradeCalendar(ctx, trades));
export const WeeklyHeatmap = shared("WeeklyHeatmap", { dojix: "overview", greenwick: "timing" }, 0, unlessEmpty(weeklyHeatmap));

// --- Sessions --------------------------------------------------------------------------------

export const RMultipleChart = shared("RMultipleChart", "sessions", 0, unlessEmpty(rMultipleChart));
export const PerformanceSummary = shared("PerformanceSummary", { dojix: "overview", greenwick: "sessions" }, 0, performanceSummary);
export const StreakTimeline = shared("StreakTimeline", "sessions", 0, unlessEmpty(streakTimeline));
export const SessionHeatmap = shared("SessionHeatmap", "sessions", 0, unlessEmpty(sessionHeatmap));
export const SessionIntelligence = shared("SessionIntelligence", "sessions", 0, unlessEmpty(sessionIntelligence));
export const SequenceAnalysis = shared("SequenceAnalysis", "sessions", SEQUENCE_MIN_TRADES, sequenceAnalysis);
export const WhatToCutAdvisor = shared("WhatToCutAdvisor", "sessions", WHAT_TO_CUT_MIN_TRADES, whatToCut);
export const KillZoneOptimizer = shared("KillZoneOptimizer", "sessions", 30, killZoneOptimizer);
/** The Month period (the Mac's default pill); the UI calls `periodComparison(ctx, trades, period)`. */
export const PeriodComparison = shared("PeriodComparison", { dojix: "overview", greenwick: "sessions" }, 0, (ctx, trades) =>
  periodComparison(ctx, trades),
);

// --- Pairs / Symbols -------------------------------------------------------------------------

export const LotSizeAnalysis = defineComponent({
  id: "LotSizeAnalysis",
  brands: ["dojix"],
  tab: "pairs",
  minTrades: SIZE_ANALYSIS_MIN_TRADES,
  compute: sizeAnalysis,
});
export const ShareSizeAnalysis = defineComponent({
  id: "ShareSizeAnalysis",
  brands: ["greenwick"],
  tab: "pairs",
  minTrades: SIZE_ANALYSIS_MIN_TRADES,
  compute: sizeAnalysis,
});
export const WinLossDistribution = shared("WinLossDistribution", "pairs", 0, winLossDistribution);
export const SlippageAnalysis = shared("SlippageAnalysis", "pairs", 0, (ctx, trades) => {
  const m = slippageAnalysis(ctx, trades);
  return m.tradesWithSlippage.length === 0 ? null : m;
});
export const MAEMFEChart = shared("MAEMFEChart", "pairs", MAE_MFE_MIN_TRADES, maeMfeChart);
export const PairAnalytics = defineComponent({ id: "PairAnalytics", brands: ["dojix"], tab: "pairs", minTrades: 0, compute: symbolAnalytics });
export const SymbolAnalytics = defineComponent({ id: "SymbolAnalytics", brands: ["greenwick"], tab: "pairs", minTrades: 0, compute: symbolAnalytics });
export const DirectionalEdge = shared("DirectionalEdge", "pairs", 0, unlessEmpty(directionalEdge));

// --- Overview --------------------------------------------------------------------------------

export const SessionRankingCard = shared("SessionRankingCard", "overview", 0, unlessEmpty(sessionRanking));
export const StreakCard = shared("StreakCard", "overview", 0, unlessEmpty(streakCard));

/** Every E2 component, in the order above. */
export const E2_COMPONENTS: readonly AnalyticsComponent<BrandId, unknown>[] = [
  HourlyPnLChart,
  DurationAnalysis,
  DayOfWeekChart,
  TradeTimeHeatmap,
  TradeCalendar,
  WeeklyHeatmap,
  RMultipleChart,
  PerformanceSummary,
  StreakTimeline,
  SessionHeatmap,
  SessionIntelligence,
  SequenceAnalysis,
  WhatToCutAdvisor,
  KillZoneOptimizer,
  PeriodComparison,
  LotSizeAnalysis as AnalyticsComponent<BrandId, unknown>,
  ShareSizeAnalysis as AnalyticsComponent<BrandId, unknown>,
  WinLossDistribution,
  SlippageAnalysis,
  MAEMFEChart,
  PairAnalytics as AnalyticsComponent<BrandId, unknown>,
  SymbolAnalytics as AnalyticsComponent<BrandId, unknown>,
  DirectionalEdge,
  SessionRankingCard,
  StreakCard,
];

/** Registers every E2 component in `registry` (a new one by default). */
export function registerE2Components(registry: AnalyticsRegistry = new AnalyticsRegistry()): AnalyticsRegistry {
  for (const c of E2_COMPONENTS) registry.register(c);
  return registry;
}
