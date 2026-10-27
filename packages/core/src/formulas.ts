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
/**
 * An implemented Greenwick-only component (E4, `analytics/greenwick/`). Registry entries:
 * `analytics/greenwick/components.ts`; parity resolvers: `analytics/greenwick/parity.ts`.
 */
const st = (
  id: string,
  placement: AnalyticsPlacement,
  file: string,
  exports: readonly string[],
  divergences?: readonly string[],
  note?: string,
): FormulaEntry => ({
  id,
  spec: "App. A",
  brands: ST,
  placement: at(undefined, placement),
  owner: "E4",
  status: "implemented",
  module: `analytics/greenwick/${file}`,
  exports,
  ...(divergences ? { divergences } : {}),
  ...(note ? { note } : {}),
});
const e3 = (
  id: string,
  brands: readonly BrandId[],
  placement: Partial<Record<BrandId, AnalyticsPlacement>>,
  module: string,
  exports: readonly string[],
  extra: { divergences?: readonly string[]; note?: string } = {},
): FormulaEntry => ({ id, spec: "App. A", brands, placement, owner: "E3", status: "implemented", module, exports, ...extra });

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
  done("HourlyPnLChart", "analytics/hourly-pnl.ts", ["hourlyPnL"], BOTH, at("timing", "timing"), undefined, "best = the first maximum (maxBy)"),
  done("WinLossDistribution", "analytics/win-loss-distribution.ts", ["winLossDistribution"], BOTH, at("pairs", "pairs"), ["D-01"]),
  e3("DrawdownChart", BOTH, at("overview", "risk"), "analytics/drawdown-chart.ts", ["computeDrawdownChart", "drawdownChartComponent", "drawdownChartParity"]),
  e3("TradeComparison", BOTH, at("behavioral", "behavioral"), "analytics/trade-comparison.ts", ["computeTradeComparison", "tradeComparisonComponent", "tradeComparisonParity"], { note: "best = maxBy, worst = minBy (both the first of ties)" }),
  done("DurationAnalysis", "analytics/duration-analysis.ts", ["durationAnalysis", "DURATION_RANGES"], BOTH, at("timing", "timing")),
  done("DayOfWeekChart", "analytics/day-of-week.ts", ["dayOfWeekChart"], BOTH, at("timing", "timing")),
  done("RMultipleChart", "analytics/r-multiple.ts", ["rMultipleChart", "R_MULTIPLE_RANGES"], BOTH, at("sessions", "sessions")),
  done("PerformanceSummary", "analytics/performance-summary.ts", ["performanceSummary"], BOTH, at("overview", "sessions")),
  done("StreakTimeline", "analytics/streak-timeline.ts", ["streakTimeline"], BOTH, at("sessions", "sessions")),
  done("SlippageAnalysis", "analytics/slippage.ts", ["slippageAnalysis", "SLIPPAGE_RANGES"], BOTH, at("pairs", "pairs"), ["D-02"]),
  done("MAEMFEChart", "analytics/mae-mfe.ts", ["maeMfeChart", "maeMfeRating"], BOTH, at("pairs", "pairs"), ["D-18"]),
  e3("TagAnalytics", BOTH, at("edgeReport", "edgeReport"), "analytics/tag-analytics.ts", ["computeTagAnalytics", "tagAnalyticsComponent", "tagAnalyticsParity"]),
  done("SessionRankingCard", "analytics/session-ranking.ts", ["sessionRanking"], BOTH, at("overview", "overview")),
  e3("ExpectancyCurve", BOTH, at("risk", "risk"), "analytics/expectancy-curve.ts", ["computeExpectancyCurve", "expectancyCurveComponent", "expectancyCurveParity"]),
  e3("PositionSizer", BOTH, at("risk", "risk"), "analytics/position-sizer.ts", ["computePositionSizer", "positionSizerComponent", "positionSizerParity"], { note: "swiftRounded (half away from zero)" }),
  done("PairAnalytics / SymbolAnalytics", "analytics/symbol-analytics.ts", ["symbolAnalytics"], BOTH, at("pairs", "pairs")),
  e3("GradeDistribution", BOTH, at("behavioral", "behavioral"), "analytics/grade-distribution.ts", ["computeGradeDistribution", "gradeDistributionComponent", "gradeDistributionParity"]),
  e3("GrowthProjection", BOTH, at("risk", "risk"), "analytics/growth-projection.ts", ["computeGrowthProjection", "growthProjectionComponent", "growthProjectionParity"], { note: "ctx.localCalendar.daysBetween; idiv" }),
  done("StreakCard", "analytics/streak-card.ts", ["streakCard"], BOTH, at("overview", "overview"), ["D-17"]),
  done("DirectionalEdge", "analytics/directional-edge.ts", ["directionalEdge", "directionStats"], BOTH, at("pairs", "pairs")),
  e3("DataQuality", BOTH, at("advanced", "advanced"), "analytics/data-quality.ts", ["computeDataQuality", "dataQualityComponent", "dataQualityParity"]),
  done("TradeTimeHeatmap", "analytics/trade-time-heatmap.ts", ["tradeTimeHeatmap", "tradeTimeOpacity"], BOTH, at("timing", "timing")),
  done("WeeklyHeatmap", "analytics/weekly-heatmap.ts", ["weeklyHeatmap", "weeklyStreak"], BOTH, at("overview", "timing"), undefined, "ZonedCalendar.weekOfYear"),
  e3("MonthlyReturns", BOTH, at("overview", "risk"), "analytics/monthly-returns.ts", ["computeMonthlyReturns", "monthlyReturnsComponent", "monthlyReturnsParity"]),
  done("TradeCalendar", "analytics/trade-calendar.ts", ["tradeCalendar", "tradeCalendarGrid", "shiftMonth"], BOTH, at("timing", "timing")),
  e3("BenchmarkComparison", BOTH, at("advanced", "advanced"), "analytics/benchmark-comparison.ts", ["computeBenchmarkComparison", "benchmarkComparisonComponent", "benchmarkComparisonParity"]),
  e3("TimeToMFEAnalysis", BOTH, at("advanced", "advanced"), "analytics/time-to-mfe-analysis.ts", ["computeTimeToMFEAnalysis", "timeToMFEAnalysisComponent", "timeToMFEAnalysisParity"], { note: "integer-division median (idiv)" }),
  done("SessionHeatmap", "analytics/session-heatmap.ts", ["sessionHeatmap", "sessionHeatmapOpacity"], BOTH, at("sessions", "sessions")),
  done("SessionIntelligence", "analytics/session-intelligence.ts", ["sessionIntelligence", "sessionRecommendation"], BOTH, at("sessions", "sessions")),
  e3("CommissionAnalytics", BOTH, at("risk", "risk"), "analytics/commission-analytics.ts", ["computeCommissionAnalytics", "commissionAnalyticsComponent", "commissionAnalyticsParity"]),
  e3("EmotionalAnalytics", BOTH, at("behavioral", "behavioral"), "analytics/emotional-analytics.ts", ["computeEmotionalAnalytics", "emotionalAnalyticsComponent", "emotionalAnalyticsParity"]),
  e3("ImprovementTracker", BOTH, at("behavioral", "behavioral"), "analytics/improvement-tracker.ts", ["computeImprovementTracker", "improvementTrackerComponent", "improvementTrackerParity"]),
  e3("RiskOfRuin", BOTH, at("risk", "risk"), "analytics/risk-of-ruin.ts", ["computeRiskOfRuin", "riskOfRuinComponent", "riskOfRuinParity"], { divergences: ["D-04"] }),
  e3("MonteCarloSimulation", BOTH, at("risk", "risk"), "analytics/monte-carlo-simulation.ts", ["computeMonteCarloSimulation", "monteCarloSimulationComponent", "monteCarloSimulationParity"], { divergences: ["D-05"], note: "swift compat: seeded shuffle without replacement; fixed: seeded bootstrap (engine/rng.ts resampled). Parity: the members the Mac randomises are nondeterministic in the reference (warn only); the invariants are compared" }),
  done("SequenceAnalysis", "analytics/sequence-analysis.ts", ["sequenceAnalysis", "sequencePattern"], BOTH, at("sessions", "sessions")),
  e3("StrategyCheckpoints", BOTH, at("advanced", "advanced"), "analytics/strategy-checkpoints.ts", ["computeStrategyCheckpoints", "strategyCheckpointsComponent", "strategyCheckpointsParity", "compareAtCheckpoint", "checkpointMetrics"]),
  e3("ChecklistAnalytics", BOTH, at("behavioral", "behavioral"), "analytics/checklist-analytics.ts", ["computeChecklistAnalytics", "checklistAnalyticsComponent", "checklistAnalyticsParity"]),
  e3("ConsistencyScore", BOTH, at("behavioral", "behavioral"), "analytics/consistency-score.ts", ["computeConsistencyScore", "consistencyScoreComponent", "consistencyScoreParity"]),
  done("WhatToCutAdvisor", "analytics/what-to-cut.ts", ["whatToCut", "whatToCutCsvRows"], BOTH, at("sessions", "sessions"), undefined, "allEdgeConditions + tradingDayCount"),
  done("KillZoneOptimizer", "analytics/kill-zone.ts", ["killZoneOptimizer", "killZoneCsvRows"], BOTH, at("sessions", "sessions"), ["D-08"]),
  e3("ExitAnalysis", BOTH, at("risk", "risk"), "analytics/exit-analysis.ts", ["computeExitAnalysis", "exitAnalysisComponent", "exitAnalysisParity"], { divergences: ["D-03"] }),
  done("PeriodComparison", "analytics/period-comparison.ts", ["periodComparison", "percentChange"], BOTH, at("overview", "sessions"), undefined, "ctx.localCalendar + ctx.now"),
  e3("EdgeDecayMonitor", BOTH, at("advanced", "advanced"), "analytics/edge-decay-monitor.ts", ["computeEdgeDecayMonitor", "edgeDecayMonitorComponent", "edgeDecayMonitorParity"]),
  e3("BehavioralAnalytics", BOTH, at("risk", "risk"), "analytics/behavioral-analytics.ts", ["computeBehavioralAnalytics", "behavioralAnalyticsComponent", "behavioralAnalyticsParity"]),
  e3("PairCorrelation / SymbolCorrelation", BOTH, at("advanced", "advanced"), "analytics/pair-correlation.ts", ["computeCorrelation", "computePairCorrelation", "computeSymbolCorrelation", "pairCorrelationComponent", "symbolCorrelationComponent", "pairCorrelationParity", "symbolCorrelationParity"]),
  e3("CalendarCorrelation", BOTH, at("advanced", "advanced"), "analytics/calendar-correlation.ts", ["computeCalendarCorrelation", "calendarCorrelationComponent", "calendarCorrelationParity"], { divergences: ["D-09", "D-19"], note: "ZonedCalendar.weekOfMonth" }),
  e3("EventImpactProfiler", BOTH, at("advanced", "advanced"), "analytics/event-impact-profiler.ts", ["computeEventImpactProfiler", "eventImpactProfilerComponent", "eventImpactProfilerParity"], { divergences: ["D-09", "D-19"] }),
  e3("PropFirmTracker / PropFirmStatusBadge", BOTH, at("propFirm", "propFirm"), "analytics/prop-firm-tracker.ts", ["computePropFirmTracker", "computePropFirmStatusBadge", "propFirmTrackerComponent", "propFirmStatusBadgeComponent", "propFirmTrackerParity", "propFirmStatusBadgeParity"], { note: "Greenwick's PropFirmStatusBadge sits on its Dashboard overview (DashboardView.swift:122); the tracker on the Prop Firm tab" }),
  e3("DrawdownRecovery", BOTH, at("risk", "risk"), "analytics/drawdown-recovery.ts", ["computeDrawdownRecovery", "drawdownRecoveryComponent", "drawdownRecoveryParity"], { divergences: ["D-20"] }),
  e3("PlaybookCatalog", BOTH, at("behavioral", "behavioral"), "analytics/playbook-catalog.ts", ["computePlaybookCatalog", "playbookCatalogComponent", "playbookCatalogParity"]),
  e3("DailyBrief", BOTH, at("overview", "overview"), "analytics/daily-brief.ts", ["computeDailyBrief", "dailyBriefComponent", "dailyBriefParity"], { note: "Decimal sums: swiftcompat decimalSum" }),
  e3("ShareableSummary", BOTH, at("advanced", "advanced"), "analytics/shareable-summary.ts", ["computeShareableSummary", "shareableSummaryComponent", "shareableSummaryParity"]),
  e3("TradeGrader", BOTH, {}, "analytics/trade-grader.ts", ["gradeTrade", "gradeTrades", "tradeGraderParity"], { note: "per-trade grade; FX and ST variants; no registry entry (shown per trade and through GradeDistribution)" }),

  // --- Appendix A, Dojix only ------------------------------------------------------------------
  e3("PostCloseAnalysis", FX, at("edgeReport"), "analytics/post-close-analysis.ts", ["computePostCloseAnalysis", "postCloseAnalysisComponent", "postCloseAnalysisParity"]),
  e3("NetCurrencyExposure", FX, at("risk"), "analytics/net-currency-exposure.ts", ["computeNetCurrencyExposure", "netCurrencyExposureComponent", "netCurrencyExposureParity"]),
  e3("Pulse edge signal", FX, at("pulse"), "analytics/pulse-edge-signal.ts", ["computePulseEdgeSignals", "pulseEdgeSignalComponent"], { divergences: ["D-28"], note: "pure function of ctx.now; the UI recomputes it on hour/session change and after the calendar loads (D-28). Not read by the Tier B harness" }),

  // --- Appendix A, Greenwick only -------------------------------------------------------------
  st("SectorExposure", "pairs", "sector-exposure.ts", ["computeSectorExposure"]),
  st("VolumeAnalysis", "pairs", "volume-analysis.ts", ["computeVolumeAnalysis", "relativeVolume"], undefined, "closed ranges share edges (RVOL 0.5/1.5/3 count twice; > 1000 in none), as on the Mac"),
  st("GapAnalysis", "timing", "gap-analysis.ts", ["computeGapAnalysis", "findGapTrades", "gapStats"], undefined, "ET open day keys (D-13, parity); prev close = maxBy, today's open = minBy"),
  st("OpeningRangeAnalysis", "timing", "opening-range.ts", ["computeOpeningRange", "minutesSinceOpen"]),
  st("ExecutionQuality", "risk", "execution-quality.ts", ["computeExecutionQuality", "executionScoreParts", "executionScoreLabel"]),
  st("IntradayEquityCurve", "advanced", "intraday-equity-curve.ts", ["computeIntradayEquityCurve"]),
  st("RegimeAnalysis", "advanced", "regime-analysis.ts", ["computeRegimeAnalysis", "classifyRegime"], ["D-18"], "current-regime tie: desktop keeps maxBy over first appearance (Mac: dictionary order)"),
  st("EarningsImpact", "advanced", "earnings-impact.ts", ["computeEarningsImpact", "tradeVolatility", "earningsRecommendation"], ["D-18"], "catalyst day = ET close day (the Swift code; SPEC said open day)"),
  st("DiversificationScore", "pairs", "diversification-score.ts", ["computeDiversificationScore", "diversificationPearsonCorrelation", "diversificationGrade"]),
];

/** Index entries for one owner (e.g. what's left for E2). */
export function formulasOwnedBy(team: EngineTeam): FormulaEntry[] {
  return FORMULA_INDEX.filter((f) => f.owner === team);
}
