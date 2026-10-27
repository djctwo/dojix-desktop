// Wiring of the E3 components: registry placements, and a parity resolver for every value the
// Tier B harness reads from them (member lists from tools/swift-ref/prepare.mjs --dry-run at the
// PARITY.md pins).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BrandId } from "../brand";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { FORMULA_INDEX } from "../formulas";
import { resolveParityOutput } from "../parity/reference";
import type { Trade } from "../model/trade";
import { fxTrade, stTrade } from "../test-support/trades";
import { E3_COMPONENTS, E3_PARITY, registerE3Components, registerE3Parity } from "./e3";

const HARNESS_MEMBERS: Record<BrandId, Record<string, readonly string[]>> = {
  dojix: {
    BehavioralAnalytics: ["report"],
    BenchmarkComparison: ["comparisons"],
    CalendarCorrelation: ["analysis"],
    ChecklistAnalytics: ["clTrades", "hasData", "ruleStats", "overallCompliance", "allFollowedAvg", "anyBrokenAvg"],
    CommissionAnalytics: ["hasCostData", "totalCommissions", "totalSwap", "totalCosts", "avgCostPerTrade", "grossProfit", "costPercent", "symbolCosts"],
    ConsistencyScore: ["dimensions", "overallScore", "grade"],
    DailyBrief: ["signals", "generateSignals"],
    DataQuality: ["issues"],
    DrawdownChart: ["drawdownData"],
    DrawdownRecovery: ["sortedTrades", "equityCurve", "drawdownEvents", "avgRecoveryTrades", "deepestEvent", "longestEvent", "isCurrentlyInDrawdown", "percentTimeInDrawdown", "drawdownPhaseStats", "recoveryPhaseStats", "drawdownPhaseTrades", "recoveryPhaseTrades"],
    EdgeDecayMonitor: ["sorted", "rollingData", "status", "diagnoses"],
    EmotionalAnalytics: ["metrics"],
    EventImpactProfiler: ["results", "tradingMonths"],
    ExitAnalysis: ["validTrades", "avgExitEfficiency", "totalMoneyLeftOnTable", "winners", "earlyExitPercent", "avgPostClose15m", "avgPostClose30m", "distributionBuckets", "exitsEarly", "insightText"],
    ExpectancyCurve: ["projectionPoints", "deviation"],
    GradeDistribution: ["gradeData", "averageScore"],
    GrowthProjection: ["tradesPerWeek", "projectionData"],
    ImprovementTracker: ["rollingMetrics", "trend", "insightText"],
    MonteCarloSimulation: ["result"],
    MonthlyReturns: ["monthlyData", "years"],
    NetCurrencyExposure: ["exposures", "maxAbsExposure", "totalAbsExposure", "concentration", "correlatedInsights"],
    PairCorrelation: ["pairs", "pairDailyPnL", "correlationMatrix", "dataQualitySummary"],
    PlaybookCatalog: ["setups", "keepSetups", "reviewSetups", "dropSetups"],
    PositionSizer: ["balance", "riskPerTrade", "avgSLPips", "suggestedLots", "currentAvgLots", "isSizingAligned"],
    PostCloseAnalysis: ["avgPostClose15m", "avgPostClose30m", "earlyExitCount", "earlyExitPercent", "winContinuation", "lossContinuation"],
    PropFirmTracker: ["totalPnL", "currentBalance", "profitTargetDollars", "maxDailyLossDollars", "maxDrawdownDollars", "dailyPnL", "maxDrawdown", "dailyLossBreached", "drawdownBreached", "tradingDays"],
    RiskOfRuin: ["winRate", "avgWin", "avgLoss", "rewardRiskRatio", "riskOfRuin", "kellyFraction", "rorLevel", "insightIcon", "insightText"],
    ShareableSummary: ["summaryText"],
    TagAnalytics: ["tagData", "taggedTradeCount"],
    TimeToMFEAnalysis: ["validTrades", "buckets", "medianTimeToMFE", "avgHoldTime", "avgExitEfficiency", "isOverholding"],
    TradeComparison: ["bestTrade", "worstTrade"],
  },
  greenwick: {
    BehavioralAnalytics: ["report"],
    BenchmarkComparison: ["comparisons"],
    CalendarCorrelation: ["analysis"],
    ChecklistAnalytics: ["clTrades", "hasData", "ruleStats", "overallCompliance", "allFollowedAvg", "anyBrokenAvg"],
    CommissionAnalytics: ["hasCostData", "totalCommissions", "totalSwap", "totalCosts", "avgCostPerTrade", "grossProfit", "costPercent", "symbolCosts"],
    ConsistencyScore: ["dimensions", "overallScore", "grade"],
    DailyBrief: ["signals", "generateSignals"],
    DataQuality: ["issues"],
    DrawdownChart: ["drawdownData"],
    DrawdownRecovery: ["sortedTrades", "equityCurve", "drawdownEvents", "avgRecoveryTrades", "deepestEvent", "longestEvent", "isCurrentlyInDrawdown", "percentTimeInDrawdown", "drawdownPhaseStats", "recoveryPhaseStats", "drawdownPhaseTrades", "recoveryPhaseTrades"],
    EdgeDecayMonitor: ["sorted", "rollingData", "status", "diagnoses"],
    EmotionalAnalytics: ["metrics"],
    EventImpactProfiler: ["results", "tradingMonths"],
    ExitAnalysis: ["validTrades", "avgExitEfficiency", "totalMoneyLeftOnTable", "winners", "earlyExitPercent", "distributionBuckets", "exitsEarly", "insightText"],
    ExpectancyCurve: ["projectionPoints", "deviation"],
    GradeDistribution: ["gradeData", "averageScore"],
    GrowthProjection: ["tradesPerWeek", "projectionData"],
    ImprovementTracker: ["rollingMetrics", "trend", "insightText"],
    MonteCarloSimulation: ["result"],
    MonthlyReturns: ["monthlyData", "years"],
    PlaybookCatalog: ["setups", "keepSetups", "reviewSetups", "dropSetups"],
    PositionSizer: ["balance", "riskPerTrade", "avgSLPoints", "suggestedShares", "currentAvgShares", "isSizingAligned"],
    PropFirmStatusBadge: ["accountSize", "maxDailyLossPercent", "maxDrawdownPercent", "profitTargetPercent", "totalPnL", "dailyPnL", "maxDailyLossDollars", "maxDrawdownDollars", "profitTargetDollars", "maxDrawdown", "dailyLossBreached", "drawdownBreached", "isBreached", "profitProgress", "dailyLossUsed", "dailyLossWarning"],
    PropFirmTracker: ["totalPnL", "currentBalance", "profitTargetDollars", "maxDailyLossDollars", "maxDrawdownDollars", "dailyPnL", "maxDrawdown", "dailyLossBreached", "dailyLossUsedPercent", "drawdownBreached", "tradingDays"],
    RiskOfRuin: ["winRate", "avgWin", "avgLoss", "rewardRiskRatio", "riskOfRuin", "kellyFraction", "rorLevel", "insightIcon", "insightText"],
    ShareableSummary: ["summaryText"],
    SymbolCorrelation: ["symbols", "symbolDailyPnL", "correlationMatrix", "dataQualitySummary"],
    TagAnalytics: ["tagData", "taggedTradeCount"],
    TimeToMFEAnalysis: ["validTrades", "buckets", "medianTimeToMFE", "avgHoldTime", "avgExitEfficiency", "isOverholding"],
    TradeComparison: ["bestTrade", "worstTrade"],
  },
};

/** Extra instances the harness builds (prepare.mjs EXTRA_INSTANCES). */
const INSTANCES: Record<string, readonly string[]> = {
  PositionSizer: ["balance25k_risk2"],
  GrowthProjection: ["months3", "months12"],
  PropFirmTracker: ["custom"],
};

/** Random on the Mac (unseeded shuffle): only invariants are compared (D-05). */
const NOT_RESOLVED = new Set(["MonteCarloSimulation.result"]);

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 5, 9, 0);

function journal(brand: BrandId, n: number): Trade[] {
  const out: Trade[] = [];
  const pairs = ["EURUSD", "GBPJPY", "AUDUSD"];
  const symbols = ["FICTA", "FICTB", "FICTC"];
  for (let i = 0; i < n; i++) {
    const closeTime = START + i * (DAY / 3) + (i % 5) * 600_000;
    const profit = String(((i * 37) % 23) - 9 + (i % 4) * 0.25);
    const common = {
      closeTime,
      durationMin: 15 + (i % 7) * 10,
      netProfit: profit,
      commission: i % 3 === 0 ? "-1.5" : "0",
      swap: i % 5 === 0 ? "-0.4" : "0",
      rMultiple: (((i * 37) % 23) - 9) / 6,
      hour: 7 + (i % 12),
      tags: i % 2 === 0 ? ["breakout"] : i % 3 === 0 ? ["pullback", "news"] : [],
      emotion: ["CALM", "FOMO", "ANXIOUS", ""][i % 4] as string,
      checklist: i % 2 === 0 ? { "Waited for the close": i % 3 !== 0, "Stop at structure": true } : {},
      timeToMFEMin: 5 + (i % 9) * 7,
    };
    out.push(
      brand === "dojix"
        ? fxTrade({ ...common, symbol: pairs[i % 3] as string, lots: 0.1 + (i % 3) * 0.1, maePips: 4 + (i % 6), mfePips: 6 + (i % 8), session: (["ASIAN", "LONDON", "NY_OVERLAP", "NY", "LATE"] as const)[i % 5] ?? "LONDON" })
        : stTrade({ ...common, symbol: symbols[i % 3] as string, shares: 50 + (i % 4) * 25, maePoints: 0.2 + (i % 5) * 0.1, mfePoints: 0.3 + (i % 7) * 0.2, slDistPoints: 0.5, sector: i % 2 ? "Technology" : "" }),
    );
  }
  // Repository order: close time descending.
  return out.sort((a, b) => b.closeTime - a.closeTime);
}

describe("E3 components", () => {
  it("register once each, with a placement per brand", () => {
    const reg = registerE3Components();
    expect(new Set(E3_COMPONENTS.map((c) => c.id)).size).toBe(E3_COMPONENTS.length);
    expect(() => registerE3Components(reg)).toThrow(/twice/);
    expect(reg.list("dojix").length).toBeGreaterThan(30);
    expect(reg.list("greenwick").length).toBeGreaterThan(28);
    expect(reg.list("dojix", "pulse").map((c) => c.id)).toEqual(["PulseEdgeSignal"]);
  });

  it("are all marked implemented in FORMULA_INDEX", () => {
    const e3 = FORMULA_INDEX.filter((f) => f.owner === "E3");
    expect(e3.length).toBe(34);
    expect(e3.filter((f) => f.status !== "implemented").map((f) => f.id)).toEqual([]);
  });

  for (const brand of ["dojix", "greenwick"] as const) {
    it(`run on a fictional ${brand} journal without throwing`, () => {
      const reg = new AnalyticsRegistry();
      registerE3Components(reg);
      const ctx = createEngineContext({ brand, now: START + 70 * DAY, seed: 7 });
      for (const size of [0, 1, 5, 25, 90]) {
        const trades = journal(brand, size);
        for (const c of reg.list(brand)) expect(() => reg.run(c.id, ctx, trades), `${c.id} n=${size}`).not.toThrow();
      }
    });
  }

  it("resolve every value the Tier B harness reads", () => {
    registerE3Parity();
    registerE3Parity(); // idempotent
    expect(E3_PARITY.length).toBeGreaterThan(30);
    for (const brand of ["dojix", "greenwick"] as const) {
      const trades = journal(brand, 90);
      const ctx = parityContext(brand, START + 70 * DAY);
      for (const [component, members] of Object.entries(HARNESS_MEMBERS[brand])) {
        for (const instance of ["", ...(INSTANCES[component] ?? [])]) {
          for (const member of members) {
            const key = `${component}${instance ? `[${instance}]` : ""}.${member}`;
            const hit = resolveParityOutput(key, ctx, trades);
            if (NOT_RESOLVED.has(key)) expect(hit, key).toBeUndefined();
            else expect(hit, `${brand} ${key}`).toBeDefined();
          }
        }
      }
      expect(resolveParityOutput("TradeGrader.grades", ctx, trades)).toBeDefined();
      expect(resolveParityOutput("StrategyCheckpoints.split", ctx, trades)).toBeDefined();
    }
  });

  it("never throw on random journals (property)", () => {
    const reg = registerE3Components(new AnalyticsRegistry());
    fc.assert(
      fc.property(fc.constantFrom("dojix", "greenwick" as const), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 2 ** 31 }), (brand, n, seed) => {
        const ctx = createEngineContext({ brand: brand as BrandId, now: START + 30 * DAY, seed });
        const trades = journal(brand as BrandId, n);
        for (const c of reg.list(brand as BrandId)) reg.run(c.id, ctx, trades);
      }),
      { numRuns: 40 },
    );
  });
});
