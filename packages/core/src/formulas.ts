// Where each formula of SPEC §3.3 and Appendix A lives (or will live), who owns it, and which
// PARITY divergences touch it. `formulas.test.ts` checks every `module` exists and exports the
// listed names, so this index can't drift from the code. Teams add their component here when
// they land it (status "implemented", module + exports filled in).

import type { BrandId } from "./brand";
import type { AnalyticsPlacement } from "./engine/registry";

export type EngineTeam = "E1" | "E2" | "E3" | "E4" | "I1" | "I2";

export interface FormulaEntry {
  /** Component type name on the Mac, or "Metrics.<field>" / helper name for §3.3. */
  id: string;
  spec: "§3.1" | "§3.3" | "App. A";
  brands: readonly BrandId[];
  /** Where the Mac shows it (per brand when it differs). */
  placement?: Partial<Record<BrandId, AnalyticsPlacement>>;
  owner: EngineTeam;
  status: "implemented" | "planned";
  /** Path under packages/core/src (implemented entries). */
  module?: string;
  /** Exported names in `module` that implement it. */
  exports?: readonly string[];
  /** PARITY.md divergence ids that change it in `fixed` mode. */
  divergences?: readonly string[];
  note?: string;
}

const BOTH: readonly BrandId[] = ["dojix", "greenwick"];
const FX: readonly BrandId[] = ["dojix"];
const ST: readonly BrandId[] = ["greenwick"];

const at = (dojix?: AnalyticsPlacement, greenwick?: AnalyticsPlacement): Partial<Record<BrandId, AnalyticsPlacement>> => {
  const p: Partial<Record<BrandId, AnalyticsPlacement>> = {};
  if (dojix) p.dojix = dojix;
  if (greenwick) p.greenwick = greenwick;
  return p;
};

const MC = "metrics/metrics-calculator.ts";
const EDGES = "metrics/edges.ts";

const metric = (field: string, exports: readonly string[] = ["calculateMetrics"], divergences?: readonly string[]): FormulaEntry => ({
  id: `Metrics.${field}`,
  spec: "§3.3",
  brands: BOTH,
  owner: "E1",
  status: "implemented",
  module: MC,
  exports,
  ...(divergences ? { divergences } : {}),
});

const planned = (
  id: string,
  owner: EngineTeam,
  brands: readonly BrandId[],
  placement: Partial<Record<BrandId, AnalyticsPlacement>>,
  divergences?: readonly string[],
  note?: string,
): FormulaEntry => ({
  id,
  spec: "App. A",
  brands,
  placement,
  owner,
  status: "planned",
  ...(divergences ? { divergences } : {}),
  ...(note ? { note } : {}),
});

/** An E2 component that has landed: its module and exports, then the `planned` arguments. */
const done = (
  id: string,
  module: string,
  exports: readonly string[],
  brands: readonly BrandId[],
  placement: Partial<Record<BrandId, AnalyticsPlacement>>,
  divergences?: readonly string[],
  note?: string,
): FormulaEntry => ({
  ...planned(id, "E2", brands, placement, divergences, note),
  status: "implemented",
  module,
  exports,
});

export const FORMULA_INDEX: readonly FormulaEntry[] = [
  // --- §3.3 headline (E1, done) --------------------------------------------------------------
  metric("totalTrades"),
  metric("wins"),
  metric("losses"),
  metric("winRate"),
  metric("totalProfit"),
  metric("grossProfit"),
  metric("grossLoss"),
  metric("profitFactor", ["calculateMetrics", "profitFactorOf"]),
  metric("averageWin"),
  metric("averageLoss"),
  metric("expectancy", ["calculateMetrics", "expectancyOf"]),
  metric("maxDrawdown", ["calculateMetrics", "maxDrawdownOf"]),
  metric("streaks", ["calculateMetrics", "streaksOf"]),
  metric("averageDuration"),
  metric("sharpeRatio", ["calculateMetrics", "sharpeOf"]),
  metric("calmarRatio"),
  metric("averageRMultiple"),
  metric("averageMAE", ["calculateMetrics"], ["D-18"]),
  metric("averageMFE", ["calculateMetrics"], ["D-18"]),
  metric("bestTrade"),
  metric("worstTrade"),
  metric("totalCosts"),
  metric("netProfitAfterCosts"),
  {
    id: "edgeBy{Hour,Session,Day,Pair,Bias,VolRegime,Symbol,Sector}",
    spec: "§3.3",
    brands: BOTH,
    owner: "E1",
    status: "implemented",
    module: EDGES,
    exports: ["edgeByHour", "edgeBySession", "edgeByDay", "edgeByPair", "edgeByBias", "edgeByVolRegime", "edgeBySymbol", "edgeBySector"],
  },
  { id: "confidence", spec: "§3.3", brands: BOTH, owner: "E1", status: "implemented", module: EDGES, exports: ["confidenceLevel", "isActionable"] },
  { id: "allEdgeConditions", spec: "§3.3", brands: BOTH, owner: "E1", status: "implemented", module: EDGES, exports: ["allEdgeConditions", "edgeDimensions"] },
  {
    id: "tradingDays",
    spec: "§3.3",
    brands: BOTH,
    owner: "E1",
    status: "implemented",
    module: "metrics/trading-days.ts",
    exports: ["tradingDayCount"],
    divergences: ["D-08"],
    note: "KillZone passes by: 'open' in swift compat (Dojix), 'close' in fixed",
  },
  {
    id: "FX sessions (app + file buckets)",
    spec: "§3.3",
    brands: FX,
    owner: "E1",
    status: "implemented",
    module: "time/fx-sessions.ts",
    exports: ["fxSessionAt", "fxSessionForHour", "fxActiveSessions", "fxTimeToNextSession", "fxSidebarHoursLeft", "fxFileSessionForHour", "utcHour", "utcShortDayName"],
  },
  {
    id: "ST sessions + trading calendar",
    spec: "§3.1",
    brands: ST,
    owner: "E1",
    status: "implemented",
    module: "time/us-market.ts",
    exports: ["etSession", "etSessionIgnoringWeekend", "etTimeToNextSession", "tradingDay", "tradingWeekday", "entryWeekday", "dailyPnL", "pnlOnTradingDayOf", "groupedByTradingWeekday", "etTradingDayCount", "TRADING_CALENDAR"],
  },
  {
    id: "Brand calendars (day / week / month buckets)",
    spec: "§3.1",
    brands: BOTH,
    owner: "E1",
    status: "implemented",
    module: "time/zoned-calendar.ts",
    exports: ["ZonedCalendar", "UTC_POSIX_CALENDAR"],
  },
  { id: "Date filters", spec: "§3.1", brands: BOTH, owner: "E1", status: "implemented", module: "time/date-ranges.ts", exports: ["dateRangeCutoff"] },
  {
    id: "Trade.exitEfficiency / moneyLeftOnTable",
    spec: "App. A",
    brands: BOTH,
    owner: "E1",
    status: "implemented",
    module: "model/accessors.ts",
    exports: ["exitEfficiency", "moneyLeftOnTable"],
  },
  {
    id: "FX / ST generic derived values (slDist, R)",
    spec: "§3.3",
    brands: BOTH,
    owner: "I1",
    status: "planned",
    divergences: ["D-06"],
    note: "computed at import time (packages/importers); I2 owns the Greenwick side",
  },

  // --- Appendix A, shared ------------------------------------------------------------------
  done("LotSizeAnalysis / ShareSizeAnalysis", "analytics/size-analysis.ts", ["sizeAnalysis"], BOTH, at("pairs", "pairs")),
  done("HourlyPnLChart", "analytics/hourly-pnl.ts", ["hourlyPnL"], BOTH, at("timing", "timing"), undefined, "best = the last maximum (maxBy)"),
  done("WinLossDistribution", "analytics/win-loss-distribution.ts", ["winLossDistribution"], BOTH, at("pairs", "pairs"), ["D-01"]),
  planned("DrawdownChart", "E3", BOTH, at("overview", "risk")),
  planned("TradeComparison", "E3", BOTH, at("behavioral", "behavioral"), undefined, "best = maxBy (last of ties), worst = minBy (first)"),
  done("DurationAnalysis", "analytics/duration-analysis.ts", ["durationAnalysis", "DURATION_RANGES"], BOTH, at("timing", "timing")),
  done("DayOfWeekChart", "analytics/day-of-week.ts", ["dayOfWeekChart"], BOTH, at("timing", "timing")),
  done("RMultipleChart", "analytics/r-multiple.ts", ["rMultipleChart", "R_MULTIPLE_RANGES"], BOTH, at("sessions", "sessions")),
  done("PerformanceSummary", "analytics/performance-summary.ts", ["performanceSummary"], BOTH, at("overview", "sessions")),
  done("StreakTimeline", "analytics/streak-timeline.ts", ["streakTimeline"], BOTH, at("sessions", "sessions")),
  done("SlippageAnalysis", "analytics/slippage.ts", ["slippageAnalysis", "SLIPPAGE_RANGES"], BOTH, at("pairs", "pairs"), ["D-02"]),
  done("MAEMFEChart", "analytics/mae-mfe.ts", ["maeMfeChart", "maeMfeRating"], BOTH, at("pairs", "pairs"), ["D-18"]),
  planned("TagAnalytics", "E3", BOTH, at("edgeReport", "edgeReport")),
  done("SessionRankingCard", "analytics/session-ranking.ts", ["sessionRanking"], BOTH, at("overview", "overview")),
  planned("ExpectancyCurve", "E3", BOTH, at("risk", "risk")),
  planned("PositionSizer", "E3", BOTH, at("risk", "risk"), undefined, "swiftRounded (half away from zero)"),
  done("PairAnalytics / SymbolAnalytics", "analytics/symbol-analytics.ts", ["symbolAnalytics"], BOTH, at("pairs", "pairs")),
  planned("GradeDistribution", "E3", BOTH, at("behavioral", "behavioral")),
  planned("GrowthProjection", "E3", BOTH, at("risk", "risk"), undefined, "ctx.localCalendar.daysBetween; idiv"),
  done("StreakCard", "analytics/streak-card.ts", ["streakCard"], BOTH, at("overview", "overview"), ["D-17"]),
  done("DirectionalEdge", "analytics/directional-edge.ts", ["directionalEdge", "directionStats"], BOTH, at("pairs", "pairs")),
  planned("DataQuality", "E3", BOTH, at("advanced", "advanced")),
  done("TradeTimeHeatmap", "analytics/trade-time-heatmap.ts", ["tradeTimeHeatmap", "tradeTimeOpacity"], BOTH, at("timing", "timing")),
  done("WeeklyHeatmap", "analytics/weekly-heatmap.ts", ["weeklyHeatmap", "weeklyStreak"], BOTH, at("overview", "timing"), undefined, "ZonedCalendar.weekOfYear"),
  planned("MonthlyReturns", "E3", BOTH, at("overview", "risk")),
  done("TradeCalendar", "analytics/trade-calendar.ts", ["tradeCalendar", "tradeCalendarGrid", "shiftMonth"], BOTH, at("timing", "timing")),
  planned("BenchmarkComparison", "E3", BOTH, at("advanced", "advanced")),
  planned("TimeToMFEAnalysis", "E3", BOTH, at("advanced", "advanced"), undefined, "integer-division median (idiv)"),
  done("SessionHeatmap", "analytics/session-heatmap.ts", ["sessionHeatmap", "sessionHeatmapOpacity"], BOTH, at("sessions", "sessions")),
  done("SessionIntelligence", "analytics/session-intelligence.ts", ["sessionIntelligence", "sessionRecommendation"], BOTH, at("sessions", "sessions")),
  planned("CommissionAnalytics", "E3", BOTH, at("risk", "risk")),
  planned("EmotionalAnalytics", "E3", BOTH, at("behavioral", "behavioral")),
  planned("ImprovementTracker", "E3", BOTH, at("behavioral", "behavioral")),
  planned("RiskOfRuin", "E3", BOTH, at("risk", "risk"), ["D-04"]),
  planned("MonteCarloSimulation", "E3", BOTH, at("risk", "risk"), ["D-05"], "engine/rng.ts resampled() for the fixed bootstrap"),
  done("SequenceAnalysis", "analytics/sequence-analysis.ts", ["sequenceAnalysis", "sequencePattern"], BOTH, at("sessions", "sessions")),
  planned("StrategyCheckpoints", "E3", BOTH, at("advanced", "advanced")),
  planned("ChecklistAnalytics", "E3", BOTH, at("behavioral", "behavioral")),
  planned("ConsistencyScore", "E3", BOTH, at("behavioral", "behavioral")),
  done("WhatToCutAdvisor", "analytics/what-to-cut.ts", ["whatToCut", "whatToCutCsvRows"], BOTH, at("sessions", "sessions"), undefined, "allEdgeConditions + tradingDayCount"),
  done("KillZoneOptimizer", "analytics/kill-zone.ts", ["killZoneOptimizer", "killZoneCsvRows"], BOTH, at("sessions", "sessions"), ["D-08"]),
  planned("ExitAnalysis", "E3", BOTH, at("risk", "risk"), ["D-03"]),
  done("PeriodComparison", "analytics/period-comparison.ts", ["periodComparison", "percentChange"], BOTH, at("overview", "sessions"), undefined, "ctx.localCalendar + ctx.now"),
  planned("EdgeDecayMonitor", "E3", BOTH, at("advanced", "advanced")),
  planned("BehavioralAnalytics", "E3", BOTH, at("risk", "risk")),
  planned("PairCorrelation / SymbolCorrelation", "E3", BOTH, at("advanced", "advanced")),
  planned("CalendarCorrelation", "E3", BOTH, at("advanced", "advanced"), ["D-09", "D-19"], "ZonedCalendar.weekOfMonth"),
  planned("EventImpactProfiler", "E3", BOTH, at("advanced", "advanced"), ["D-09", "D-19"]),
  planned("PropFirmTracker / PropFirmStatusBadge", "E3", BOTH, at("propFirm", "propFirm")),
  planned("DrawdownRecovery", "E3", BOTH, at("risk", "risk"), ["D-20"]),
  planned("PlaybookCatalog", "E3", BOTH, at("behavioral", "behavioral")),
  planned("DailyBrief", "E3", BOTH, at("overview", "overview"), undefined, "Decimal sums: swiftcompat decimalSum"),
  planned("ShareableSummary", "E3", BOTH, at("advanced", "advanced")),
  planned("TradeGrader", "E3", BOTH, {}, undefined, "per-trade grade; FX and ST variants"),

  // --- Appendix A, Dojix only ------------------------------------------------------------------
  planned("PostCloseAnalysis", "E3", FX, at("edgeReport")),
  planned("NetCurrencyExposure", "E3", FX, at("risk")),
  planned("Pulse edge signal", "E3", FX, at("pulse"), ["D-28"]),

  // --- Appendix A, Greenwick only -------------------------------------------------------------
  planned("SectorExposure", "E4", ST, at(undefined, "pairs")),
  planned("VolumeAnalysis", "E4", ST, at(undefined, "pairs")),
  planned("GapAnalysis", "E4", ST, at(undefined, "timing")),
  planned("OpeningRangeAnalysis", "E4", ST, at(undefined, "timing")),
  planned("ExecutionQuality", "E4", ST, at(undefined, "risk")),
  planned("IntradayEquityCurve", "E4", ST, at(undefined, "advanced")),
  planned("RegimeAnalysis", "E4", ST, at(undefined, "advanced")),
  planned("EarningsImpact", "E4", ST, at(undefined, "advanced")),
  planned("DiversificationScore", "E4", ST, at(undefined, "pairs")),
];

/** Index entries for one owner (e.g. what's left for E2). */
export function formulasOwnedBy(team: EngineTeam): FormulaEntry[] {
  return FORMULA_INDEX.filter((f) => f.owner === team);
}
