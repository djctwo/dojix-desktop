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
  planned("LotSizeAnalysis / ShareSizeAnalysis", "E2", BOTH, at("pairs", "pairs")),
  planned("HourlyPnLChart", "E2", BOTH, at("timing", "timing"), undefined, "best = the last maximum (maxBy)"),
  planned("WinLossDistribution", "E2", BOTH, at("pairs", "pairs"), ["D-01"]),
  planned("DrawdownChart", "E3", BOTH, at("overview", "risk")),
  planned("TradeComparison", "E3", BOTH, at("behavioral", "behavioral"), undefined, "best = maxBy (last of ties), worst = minBy (first)"),
  planned("DurationAnalysis", "E2", BOTH, at("timing", "timing")),
  planned("DayOfWeekChart", "E2", BOTH, at("timing", "timing")),
  planned("RMultipleChart", "E2", BOTH, at("sessions", "sessions")),
  planned("PerformanceSummary", "E2", BOTH, at("overview", "sessions")),
  planned("StreakTimeline", "E2", BOTH, at("sessions", "sessions")),
  planned("SlippageAnalysis", "E2", BOTH, at("pairs", "pairs"), ["D-02"]),
  planned("MAEMFEChart", "E2", BOTH, at("pairs", "pairs"), ["D-18"]),
  planned("TagAnalytics", "E3", BOTH, at("edgeReport", "edgeReport")),
  planned("SessionRankingCard", "E2", BOTH, at("overview", "overview")),
  planned("ExpectancyCurve", "E3", BOTH, at("risk", "risk")),
  planned("PositionSizer", "E3", BOTH, at("risk", "risk"), undefined, "swiftRounded (half away from zero)"),
  planned("PairAnalytics / SymbolAnalytics", "E2", BOTH, at("pairs", "pairs")),
  planned("GradeDistribution", "E3", BOTH, at("behavioral", "behavioral")),
  planned("GrowthProjection", "E3", BOTH, at("risk", "risk"), undefined, "ctx.localCalendar.daysBetween; idiv"),
  planned("StreakCard", "E2", BOTH, at("overview", "overview"), ["D-17"]),
  planned("DirectionalEdge", "E2", BOTH, at("pairs", "pairs")),
  planned("DataQuality", "E3", BOTH, at("advanced", "advanced")),
  planned("TradeTimeHeatmap", "E2", BOTH, at("timing", "timing")),
  planned("WeeklyHeatmap", "E2", BOTH, at("overview", "timing"), undefined, "ZonedCalendar.weekOfYear"),
  planned("MonthlyReturns", "E3", BOTH, at("overview", "risk")),
  planned("TradeCalendar", "E2", BOTH, at("timing", "timing")),
  planned("BenchmarkComparison", "E3", BOTH, at("advanced", "advanced")),
  planned("TimeToMFEAnalysis", "E3", BOTH, at("advanced", "advanced"), undefined, "integer-division median (idiv)"),
  planned("SessionHeatmap", "E2", BOTH, at("sessions", "sessions")),
  planned("SessionIntelligence", "E2", BOTH, at("sessions", "sessions")),
  planned("CommissionAnalytics", "E3", BOTH, at("risk", "risk")),
  planned("EmotionalAnalytics", "E3", BOTH, at("behavioral", "behavioral")),
  planned("ImprovementTracker", "E3", BOTH, at("behavioral", "behavioral")),
  planned("RiskOfRuin", "E3", BOTH, at("risk", "risk"), ["D-04"]),
  planned("MonteCarloSimulation", "E3", BOTH, at("risk", "risk"), ["D-05"], "engine/rng.ts resampled() for the fixed bootstrap"),
  planned("SequenceAnalysis", "E2", BOTH, at("sessions", "sessions")),
  planned("StrategyCheckpoints", "E3", BOTH, at("advanced", "advanced")),
  planned("ChecklistAnalytics", "E3", BOTH, at("behavioral", "behavioral")),
  planned("ConsistencyScore", "E3", BOTH, at("behavioral", "behavioral")),
  planned("WhatToCutAdvisor", "E2", BOTH, at("sessions", "sessions"), undefined, "allEdgeConditions + tradingDayCount"),
  planned("KillZoneOptimizer", "E2", BOTH, at("sessions", "sessions"), ["D-08"]),
  planned("ExitAnalysis", "E3", BOTH, at("risk", "risk"), ["D-03"]),
  planned("PeriodComparison", "E2", BOTH, at("overview", "sessions"), undefined, "ctx.localCalendar + ctx.now"),
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
  st("SectorExposure", "pairs", "sector-exposure.ts", ["computeSectorExposure"]),
  st("VolumeAnalysis", "pairs", "volume-analysis.ts", ["computeVolumeAnalysis", "relativeVolume"], undefined, "closed ranges share edges (RVOL 0.5/1.5/3 count twice; > 1000 in none), as on the Mac"),
  st("GapAnalysis", "timing", "gap-analysis.ts", ["computeGapAnalysis", "findGapTrades", "gapStats"], undefined, "ET open day keys (D-13, parity); prev close = maxBy, today's open = minBy"),
  st("OpeningRangeAnalysis", "timing", "opening-range.ts", ["computeOpeningRange", "minutesSinceOpen"]),
  st("ExecutionQuality", "risk", "execution-quality.ts", ["computeExecutionQuality", "executionScoreParts", "executionScoreLabel"]),
  st("IntradayEquityCurve", "advanced", "intraday-equity-curve.ts", ["computeIntradayEquityCurve"]),
  st("RegimeAnalysis", "advanced", "regime-analysis.ts", ["computeRegimeAnalysis", "classifyRegime"], ["D-18"], "current-regime tie: desktop keeps maxBy over first appearance (Mac: dictionary order)"),
  st("EarningsImpact", "advanced", "earnings-impact.ts", ["computeEarningsImpact", "tradeVolatility", "earningsRecommendation"], ["D-18"], "catalyst day = ET close day (the Swift code; SPEC said open day)"),
  st("DiversificationScore", "pairs", "diversification-score.ts", ["computeDiversificationScore", "pearsonCorrelation", "diversificationGrade"]),
];

/** Index entries for one owner (e.g. what's left for E2). */
export function formulasOwnedBy(team: EngineTeam): FormulaEntry[] {
  return FORMULA_INDEX.filter((f) => f.owner === team);
}
