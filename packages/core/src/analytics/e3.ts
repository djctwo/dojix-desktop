// Team E3's analytics components (SPEC Appendix A: Risk, Behavioral, Advanced, PropFirm, Edge
// Report, DailyBrief, TradeGrader and the Dojix-only PostClose, NetCurrencyExposure and Pulse):
// the registry list and the Tier B parity resolvers.

import type { AnalyticsComponent } from "../engine/registry";
import { AnalyticsRegistry } from "../engine/registry";
import type { BrandId } from "../brand";
import { registerComponentParity, type ComponentParity } from "./support";
import { behavioralAnalyticsComponent, behavioralAnalyticsParity } from "./behavioral-analytics";
import { benchmarkComparisonComponent, benchmarkComparisonParity } from "./benchmark-comparison";
import { calendarCorrelationComponent, calendarCorrelationParity } from "./calendar-correlation";
import { checklistAnalyticsComponent, checklistAnalyticsParity } from "./checklist-analytics";
import { commissionAnalyticsComponent, commissionAnalyticsParity } from "./commission-analytics";
import { consistencyScoreComponent, consistencyScoreParity } from "./consistency-score";
import { dailyBriefComponent, dailyBriefParity } from "./daily-brief";
import { dataQualityComponent, dataQualityParity } from "./data-quality";
import { drawdownChartComponent, drawdownChartParity } from "./drawdown-chart";
import { drawdownRecoveryComponent, drawdownRecoveryParity } from "./drawdown-recovery";
import { edgeDecayMonitorComponent, edgeDecayMonitorParity } from "./edge-decay-monitor";
import { emotionalAnalyticsComponent, emotionalAnalyticsParity } from "./emotional-analytics";
import { eventImpactProfilerComponent, eventImpactProfilerParity } from "./event-impact-profiler";
import { exitAnalysisComponent, exitAnalysisParity } from "./exit-analysis";
import { expectancyCurveComponent, expectancyCurveParity } from "./expectancy-curve";
import { gradeDistributionComponent, gradeDistributionParity } from "./grade-distribution";
import { growthProjectionComponent, growthProjectionParity } from "./growth-projection";
import { improvementTrackerComponent, improvementTrackerParity } from "./improvement-tracker";
import { monteCarloSimulationComponent, monteCarloSimulationParity } from "./monte-carlo-simulation";
import { monthlyReturnsComponent, monthlyReturnsParity } from "./monthly-returns";
import { netCurrencyExposureComponent, netCurrencyExposureParity } from "./net-currency-exposure";
import { pairCorrelationComponent, symbolCorrelationComponent, pairCorrelationParity, symbolCorrelationParity } from "./pair-correlation";
import { playbookCatalogComponent, playbookCatalogParity } from "./playbook-catalog";
import { positionSizerComponent, positionSizerParity } from "./position-sizer";
import { postCloseAnalysisComponent, postCloseAnalysisParity } from "./post-close-analysis";
import { propFirmTrackerComponent, propFirmStatusBadgeComponent, propFirmTrackerParity, propFirmStatusBadgeParity } from "./prop-firm-tracker";
import { pulseEdgeSignalComponent } from "./pulse-edge-signal";
import { riskOfRuinComponent, riskOfRuinParity } from "./risk-of-ruin";
import { shareableSummaryComponent, shareableSummaryParity } from "./shareable-summary";
import { strategyCheckpointsComponent, strategyCheckpointsParity } from "./strategy-checkpoints";
import { tagAnalyticsComponent, tagAnalyticsParity } from "./tag-analytics";
import { timeToMFEAnalysisComponent, timeToMFEAnalysisParity } from "./time-to-mfe-analysis";
import { tradeComparisonComponent, tradeComparisonParity } from "./trade-comparison";
import { tradeGraderParity } from "./trade-grader";

/** Every E3 component (the UI orders them within a tab). */
export const E3_COMPONENTS: readonly AnalyticsComponent<BrandId, unknown>[] = [
  behavioralAnalyticsComponent as AnalyticsComponent<BrandId, unknown>,
  benchmarkComparisonComponent as AnalyticsComponent<BrandId, unknown>,
  calendarCorrelationComponent as AnalyticsComponent<BrandId, unknown>,
  checklistAnalyticsComponent as AnalyticsComponent<BrandId, unknown>,
  commissionAnalyticsComponent as AnalyticsComponent<BrandId, unknown>,
  consistencyScoreComponent as AnalyticsComponent<BrandId, unknown>,
  dailyBriefComponent as AnalyticsComponent<BrandId, unknown>,
  dataQualityComponent as AnalyticsComponent<BrandId, unknown>,
  drawdownChartComponent as AnalyticsComponent<BrandId, unknown>,
  drawdownRecoveryComponent as AnalyticsComponent<BrandId, unknown>,
  edgeDecayMonitorComponent as AnalyticsComponent<BrandId, unknown>,
  emotionalAnalyticsComponent as AnalyticsComponent<BrandId, unknown>,
  eventImpactProfilerComponent as AnalyticsComponent<BrandId, unknown>,
  exitAnalysisComponent as AnalyticsComponent<BrandId, unknown>,
  expectancyCurveComponent as AnalyticsComponent<BrandId, unknown>,
  gradeDistributionComponent as AnalyticsComponent<BrandId, unknown>,
  growthProjectionComponent as AnalyticsComponent<BrandId, unknown>,
  improvementTrackerComponent as AnalyticsComponent<BrandId, unknown>,
  monteCarloSimulationComponent as AnalyticsComponent<BrandId, unknown>,
  monthlyReturnsComponent as AnalyticsComponent<BrandId, unknown>,
  netCurrencyExposureComponent as AnalyticsComponent<BrandId, unknown>,
  pairCorrelationComponent as AnalyticsComponent<BrandId, unknown>,
  symbolCorrelationComponent as AnalyticsComponent<BrandId, unknown>,
  playbookCatalogComponent as AnalyticsComponent<BrandId, unknown>,
  positionSizerComponent as AnalyticsComponent<BrandId, unknown>,
  postCloseAnalysisComponent as AnalyticsComponent<BrandId, unknown>,
  propFirmTrackerComponent as AnalyticsComponent<BrandId, unknown>,
  propFirmStatusBadgeComponent as AnalyticsComponent<BrandId, unknown>,
  pulseEdgeSignalComponent as AnalyticsComponent<BrandId, unknown>,
  riskOfRuinComponent as AnalyticsComponent<BrandId, unknown>,
  shareableSummaryComponent as AnalyticsComponent<BrandId, unknown>,
  strategyCheckpointsComponent as AnalyticsComponent<BrandId, unknown>,
  tagAnalyticsComponent as AnalyticsComponent<BrandId, unknown>,
  timeToMFEAnalysisComponent as AnalyticsComponent<BrandId, unknown>,
  tradeComparisonComponent as AnalyticsComponent<BrandId, unknown>,
];

/** How the Tier B harness reads each E3 component (TradeGrader included; Monte Carlo has none: random on the Mac, D-05). */
export const E3_PARITY: readonly ComponentParity<never>[] = [
  behavioralAnalyticsParity as unknown as ComponentParity<never>,
  benchmarkComparisonParity as unknown as ComponentParity<never>,
  calendarCorrelationParity as unknown as ComponentParity<never>,
  checklistAnalyticsParity as unknown as ComponentParity<never>,
  commissionAnalyticsParity as unknown as ComponentParity<never>,
  consistencyScoreParity as unknown as ComponentParity<never>,
  dailyBriefParity as unknown as ComponentParity<never>,
  dataQualityParity as unknown as ComponentParity<never>,
  drawdownChartParity as unknown as ComponentParity<never>,
  drawdownRecoveryParity as unknown as ComponentParity<never>,
  edgeDecayMonitorParity as unknown as ComponentParity<never>,
  emotionalAnalyticsParity as unknown as ComponentParity<never>,
  eventImpactProfilerParity as unknown as ComponentParity<never>,
  exitAnalysisParity as unknown as ComponentParity<never>,
  expectancyCurveParity as unknown as ComponentParity<never>,
  gradeDistributionParity as unknown as ComponentParity<never>,
  growthProjectionParity as unknown as ComponentParity<never>,
  improvementTrackerParity as unknown as ComponentParity<never>,
  monteCarloSimulationParity as unknown as ComponentParity<never>,
  monthlyReturnsParity as unknown as ComponentParity<never>,
  netCurrencyExposureParity as unknown as ComponentParity<never>,
  pairCorrelationParity as unknown as ComponentParity<never>,
  symbolCorrelationParity as unknown as ComponentParity<never>,
  playbookCatalogParity as unknown as ComponentParity<never>,
  positionSizerParity as unknown as ComponentParity<never>,
  postCloseAnalysisParity as unknown as ComponentParity<never>,
  propFirmTrackerParity as unknown as ComponentParity<never>,
  propFirmStatusBadgeParity as unknown as ComponentParity<never>,
  riskOfRuinParity as unknown as ComponentParity<never>,
  shareableSummaryParity as unknown as ComponentParity<never>,
  strategyCheckpointsParity as unknown as ComponentParity<never>,
  tagAnalyticsParity as unknown as ComponentParity<never>,
  timeToMFEAnalysisParity as unknown as ComponentParity<never>,
  tradeComparisonParity as unknown as ComponentParity<never>,
  tradeGraderParity as unknown as ComponentParity<never>,
];

/** Adds the E3 components to a registry. */
export function registerE3Components(registry: AnalyticsRegistry = new AnalyticsRegistry()): AnalyticsRegistry {
  for (const c of E3_COMPONENTS) registry.register(c);
  return registry;
}

let parityRegistered = false;

/** Registers the E3 parity resolvers once (the parity suite calls it). */
export function registerE3Parity(): void {
  if (parityRegistered) return;
  parityRegistered = true;
  for (const p of E3_PARITY) registerComponentParity(p);
}
