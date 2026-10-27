// The E2 registry entries, the CSV export text and the parity resolvers.
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { FORMULA_INDEX } from "../formulas";
import { resolveParityOutput } from "../parity/reference";
import { etWall, fxSeries, fxTrade, stTrade } from "../test-support/trades";
import { analyticsCsvContent, isSwiftDouble, sanitizeCsvField } from "./csv";
import { E2_COMPONENTS, registerE2Components } from "./e2";
import { E2_INTEGER_KEYS, E2_PARITY_COMPONENTS, refDate, refTrade, resolveE2Output } from "./e2.parity";
import { killZoneCsvRows, killZoneOptimizer } from "./kill-zone";

const NOW = Date.UTC(2026, 9, 21, 12, 0);

describe("E2 registry", () => {
  const registry = registerE2Components();
  const fx = createEngineContext({ brand: "dojix", now: NOW });
  const st = createEngineContext({ brand: "greenwick", now: NOW });

  it("places every component where FORMULA_INDEX says", () => {
    const placements = new Map<string, unknown>();
    for (const f of FORMULA_INDEX.filter((x) => x.owner === "E2")) {
      for (const id of f.id.split(" / ")) placements.set(id, f.placement);
    }
    expect(E2_COMPONENTS).toHaveLength(25);
    for (const c of E2_COMPONENTS) {
      const p = placements.get(c.id) as Record<string, string> | undefined;
      expect(p, c.id).toBeDefined();
      for (const b of c.brands) {
        const tab = typeof c.tab === "string" ? c.tab : c.tab[b];
        expect(tab, `${c.id} ${b}`).toBe(p?.[b]);
      }
    }
    expect(FORMULA_INDEX.filter((x) => x.owner === "E2").every((x) => x.status === "implemented")).toBe(true);
  });

  it("lists each brand's components per tab", () => {
    expect(registry.list("dojix", "pairs").map((c) => c.id)).toEqual([
      "LotSizeAnalysis",
      "WinLossDistribution",
      "SlippageAnalysis",
      "MAEMFEChart",
      "PairAnalytics",
      "DirectionalEdge",
    ]);
    expect(registry.list("greenwick", "pairs").map((c) => c.id)).toContain("ShareSizeAnalysis");
    expect(registry.list("greenwick", "timing").map((c) => c.id)).toEqual([
      "HourlyPnLChart",
      "DurationAnalysis",
      "DayOfWeekChart",
      "TradeTimeHeatmap",
      "TradeCalendar",
      "WeeklyHeatmap",
    ]);
    expect(registry.list("dojix", "overview").map((c) => c.id)).toEqual([
      "WeeklyHeatmap",
      "PerformanceSummary",
      "PeriodComparison",
      "SessionRankingCard",
      "StreakCard",
    ]);
    expect(() => registerE2Components(registry)).toThrow(/twice/);
    expect(registerE2Components(new AnalyticsRegistry()).list("greenwick")).toHaveLength(23);
  });

  it("returns null for the Mac's empty states and guards", () => {
    for (const c of E2_COMPONENTS) {
      for (const ctx of [fx, st]) {
        if (!c.brands.includes(ctx.brand)) continue;
        const out = registry.run(c.id, ctx, []);
        const alwaysShown = ["HourlyPnLChart", "TradeCalendar", "PerformanceSummary", "PeriodComparison", "WinLossDistribution", "PairAnalytics", "SymbolAnalytics"];
        if (alwaysShown.includes(c.id)) expect(out, c.id).not.toBeNull();
        else expect(out, c.id).toBeNull();
      }
    }
    const four = fxSeries(["1", "2", "3", "-4"]);
    expect(registry.run("MAEMFEChart", fx, four)).toBeNull();
    expect(registry.run("LotSizeAnalysis", fx, [...four, fxTrade()])).not.toBeNull();
    expect(registry.run("SlippageAnalysis", fx, [fxTrade({ slippagePips: 0 })])).toBeNull();
    expect(registry.run("SlippageAnalysis", fx, [fxTrade({ slippagePips: 1 })])).not.toBeNull();
    expect(registry.run("ShareSizeAnalysis", fx, [])).toBeNull();
    expect(registry.run("KillZoneOptimizer", fx, fxSeries(Array(30).fill("1")))).not.toBeNull();
    expect(registry.run("WhatToCutAdvisor", fx, fxSeries(Array(29).fill("1")))).toBeNull();
    expect(registry.run("SequenceAnalysis", fx, fxSeries(Array(20).fill("1")))).toMatchObject({ stats: { ww: 19 } });
    expect(registry.run("DirectionalEdge", st, [stTrade()])).toMatchObject({ sampleSize: 1 });
  });
});

describe("analytics CSV", () => {
  it("recognises what Swift's Double(String) parses", () => {
    for (const ok of ["-12.50", "+3", ".5", "5.", "1e5", "-2E-3", "nan", "-inf", "Infinity", "0x1p3", "0x.8"]) expect(isSwiftDouble(ok), ok).toBe(true);
    for (const bad of ["", " 1", "1 ", "1,5", "=1", "e5", "--1", "0x", "1e", "abc"]) expect(isSwiftDouble(bad), bad).toBe(false);
  });

  it("sanitises formula prefixes, quotes and control characters", () => {
    expect(sanitizeCsvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(sanitizeCsvField("-12.50")).toBe("-12.50");
    expect(sanitizeCsvField("@x")).toBe("'@x");
    expect(sanitizeCsvField("a,b")).toBe('"a,b"');
    expect(sanitizeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(sanitizeCsvField("a\r\nb\u0007​")).toBe("ab");
    expect(sanitizeCsvField("\n=1+1")).toBe("'=1+1");
    expect(sanitizeCsvField("")).toBe("");
  });

  it("joins the export rows", () => {
    const m = killZoneOptimizer(createEngineContext({ brand: "dojix", now: NOW }), fxSeries(Array(10).fill("2")));
    const text = analyticsCsvContent(killZoneCsvRows(m));
    expect(text).toBe(
      ["Type,Window,P&L,Win Rate,Trades,Monthly Impact", "Recommend,10-11 UTC,20.00,100.0,10,420.00", "", "Hour,P&L,Trades,Win Rate", "10:00,20.00,10,100.0"].join("\n"),
    );
    expect(analyticsCsvContent([["=cmd", "-5", "x,y"]])).toBe(`'=cmd,-5,"x,y"`);
  });
});

describe("E2 parity resolvers", () => {
  const ctx = parityContext("dojix", NOW);
  const trades = [
    fxTrade({ ticket: "7", netProfit: "-30", hour: 9, dayOfWeek: "Tue", session: "NY", direction: "SELL", closeTime: Date.UTC(2026, 9, 20, 9) }),
    fxTrade({ ticket: "6", netProfit: "100", hour: 9, dayOfWeek: "Mon", closeTime: Date.UTC(2026, 9, 19, 9) }),
    fxTrade({ ticket: "5", netProfit: "50", hour: 14, dayOfWeek: "Mon", closeTime: Date.UTC(2026, 8, 14, 14) }),
  ];

  it("encodes trades and dates like the Swift harness", () => {
    expect(refTrade(trades[0] as never)).toBe("#7");
    expect(refDate(Date.UTC(2026, 0, 15, 10))).toBe("2026-01-15T10:00:00.000Z");
  });

  it("answers every member the harness reads", () => {
    const keys: Record<string, unknown> = {
      "HourlyPnLChart.hourlyData": [
        { count: 2, hour: 9, pnl: 70 },
        { count: 1, hour: 14, pnl: 50 },
      ],
      "DurationAnalysis.buckets": [{ id: "30-60m", label: "30-60m", profit: 120, tradeCount: 3, winRate: (2 / 3) * 100, avgR: 1 }],
      "DayOfWeekChart.data": [
        { id: "Mon", day: "Mon", profit: 150, tradeCount: 2, winRate: 100 },
        { id: "Tue", day: "Tue", profit: -30, tradeCount: 1, winRate: 0 },
      ],
      "TradeTimeHeatmap.maxAbsPnL": 100,
      "TradeCalendar.firstWeekdayOffset": 4,
      "TradeCalendar[lastTradeMonth].firstWeekdayOffset": 4,
      "WeeklyHeatmap.calculateStreak": 2,
      "RMultipleChart.medianR": 1,
      "PerformanceSummary.thisWeekTrades": ["#7", "#6"],
      "PerformanceSummary.lastMonthTrades": ["#5"],
      "StreakTimeline.segments": [
        { isWin: true, count: 2, startIndex: 0 },
        { isWin: false, count: 1, startIndex: 2 },
      ],
      "SessionHeatmap.sortedActiveHours": [9, 14],
      "SessionHeatmap.dateRangeLabel": "Sep 14 – Oct 20, 2026 · 2 active hours · 3 trades",
      "SequenceAnalysis.sortedTrades": ["#5", "#6", "#7"],
      "SequenceAnalysis.stats": null,
      "WhatToCutAdvisor.tradingDays": 3,
      "WhatToCutAdvisor.negativeConditions": [],
      "WhatToCutAdvisor.worstCondition": null,
      "WhatToCutAdvisor.hasEnoughData": false,
      "KillZoneOptimizer.recommendWindows": [],
      "KillZoneOptimizer.topWindowMonthlyPnL": 0,
      "PeriodComparison.currentPeriodTrades": ["#7", "#6"], // 30 days back: 14 Sep is in the previous period
      "PeriodComparison.previousPeriodTrades": ["#5"],
      "PeriodComparison[week].previousPeriodTrades": [],
      "PeriodComparison[quarter].currentPeriodTrades": ["#7", "#6", "#5"],
      "LotSizeAnalysis.avgLotsWins": 0.1,
      "WinLossDistribution.buckets": [
        { count: 1, isProfit: false, range: "-40" },
        { count: 1, isProfit: true, range: "40" },
      ],
      "SlippageAnalysis.highSlippageTrades": 0,
      "SlippageAnalysis.tradesWithSlippage": ["#7", "#6", "#5"],
      "MAEMFEChart.insightText": "Good trade management — 2:1+ favorable ratio",
      "MAEMFEChart.insightIcon": "checkmark.circle",
      "PairAnalytics.pairGroups": [{ symbol: "GBPUSD", trades: ["#7", "#6", "#5"] }],
      "DirectionalEdge.sellTrades": ["#7"],
      "DirectionalEdge.buyStats": { count: 2, totalPnL: 150, winRate: 100, avgR: 1, avgPnL: 75 },
      "SessionRankingCard.sessions": [
        { name: "London", pnl: 150, rank: 1, trades: 2, winRate: 100 },
        { name: "New York", pnl: -30, rank: 2, trades: 1, winRate: 0 },
      ],
      "StreakCard.sortedTrades": ["#5", "#6", "#7"],
      "StreakCard.currentStreak": -1,
    };
    for (const [key, expected] of Object.entries(keys)) {
      expect(resolveParityOutput(key, ctx, trades)?.value, key).toEqual(expected);
    }
    expect(resolveParityOutput("StreakCard.currentStreak", ctx, trades)?.integer).toBe(true);
    expect(resolveParityOutput("StreakCard.recentResults", ctx, trades)?.integer).toBe(false);
  });

  it("covers the remaining members with the Swift shapes", () => {
    const all = [
      "TradeTimeHeatmap.cells",
      "TradeCalendar.dailyPnL",
      "TradeCalendar.daysInMonth",
      "WeeklyHeatmap.weeklyData",
      "WeeklyHeatmap.maxAbsProfit",
      "RMultipleChart.buckets",
      "RMultipleChart.avgR",
      "RMultipleChart.bestR",
      "RMultipleChart.worstR",
      "PerformanceSummary.thisMonthTrades",
      "SessionHeatmap.heatmapData",
      "SessionHeatmap.maxAbsProfit",
      "SessionIntelligence.sessionData",
      "WhatToCutAdvisor.totalPotentialSavings",
      "KillZoneOptimizer.tradingDays",
      "KillZoneOptimizer.hourlyStats",
      "KillZoneOptimizer.avoidWindows",
      "PeriodComparison.comparisons",
      "LotSizeAnalysis.avgLotsLosses",
      "ShareSizeAnalysis.avgSharesWins",
      "ShareSizeAnalysis.avgSharesLosses",
      "SlippageAnalysis.avgSlippage",
      "SlippageAnalysis.totalSlippageCost",
      "SlippageAnalysis.buckets",
      "MAEMFEChart.captureRatio",
      "MAEMFEChart.avgMAE",
      "MAEMFEChart.avgMFE",
      "MAEMFEChart.mfeToMaeRatio",
      "SymbolAnalytics.symbolGroups",
      "DirectionalEdge.buyTrades",
      "DirectionalEdge.sellStats",
      "StreakCard.bestWinStreak",
      "StreakCard.bestLossStreak",
      "StreakCard.recentResults",
    ];
    for (const key of all) expect(resolveE2Output(key, ctx, trades), key).toBeDefined();
    expect(resolveE2Output("TradeCalendar.dailyPnL", ctx, trades)?.value).toEqual({
      "2026-09-14T00:00:00.000Z": 50,
      "2026-10-19T00:00:00.000Z": 100,
      "2026-10-20T00:00:00.000Z": -30,
    });
    expect((resolveE2Output("TradeCalendar[lastTradeMonth].daysInMonth", ctx, trades)?.value as string[])[0]).toBe("2026-10-01T00:00:00.000Z");
    expect(resolveE2Output("SessionIntelligence.sessionData", ctx, trades)?.value).toEqual([
      {
        avgR: 1,
        id: "LONDON",
        profit: 150,
        profitFactor: Infinity,
        recommendation: { $case: "neutral", icon: "minus.circle", label: "OK" },
        session: "LONDON",
        tradeCount: 2,
        winRate: 100,
      },
      {
        avgR: 1,
        id: "NY",
        profit: -30,
        profitFactor: 0,
        recommendation: { $case: "reduce", icon: "arrow.down.circle", label: "REDUCE" },
        session: "NY",
        tradeCount: 1,
        winRate: 0,
      },
    ]);
    const comparisons = resolveE2Output("PeriodComparison.comparisons", ctx, trades)?.value as { id: string; current: string }[];
    expect(comparisons.map((c) => `${c.id}=${c.current}`)).toEqual(["pnl=$\u00a070.00", "wr=50.0%", "pf=3.33", "avgr=1.00R", "trades=2", "dd=$\u00a030.00"]);
  });

  it("answers the windows, conditions and Greenwick-only members", () => {
    const many = [
      ...Array.from({ length: 20 }, (_, i) => fxTrade({ hour: 9, symbol: "EURUSD", netProfit: "-10", closeTime: Date.UTC(2026, 0, 5 + (i % 5), 9) })),
      ...Array.from({ length: 20 }, (_, i) => fxTrade({ hour: 14, symbol: "GBPUSD", netProfit: "30", closeTime: Date.UTC(2026, 0, 5 + (i % 5), 14) })),
    ];
    const worst = resolveE2Output("WhatToCutAdvisor.worstCondition", ctx, many)?.value;
    expect(worst).toMatchObject({ dimension: "Hour", label: "9:00", tradeCount: 20, monthlyImpact: -840, id: "Hour_9:00" });
    expect(resolveE2Output("KillZoneOptimizer.recommendWindows", ctx, many)?.value).toEqual([
      { count: 20, endHour: 14, label: "14-15 UTC", monthlyImpact: 2520, pnl: 600, startHour: 14, winRate: 100 },
    ]);
    const g = parityContext("greenwick", NOW);
    const st = [stTrade({ ticket: "1", netProfit: "5", closeTime: etWall(2026, 10, 19, 10, 0) })];
    expect(resolveE2Output("StreakCard.isNearPersonalBest", g, st)?.value).toBe(false);
    expect(resolveE2Output("StreakCard.isNearPersonalBest", ctx, trades)).toBeUndefined();
    expect(resolveE2Output("SequenceAnalysis.stats", ctx, many)?.value).toMatchObject({ pattern: expect.any(String) });
  });

  it("rejects keys it doesn't cover", () => {
    expect(resolveE2Output("Metrics.winRate", ctx, trades)).toBeUndefined();
    expect(resolveE2Output("HourlyPnLChart.body", ctx, trades)).toBeUndefined();
    expect(resolveE2Output("HourlyPnLChart[week].hourlyData", ctx, trades)).toBeUndefined();
    expect(resolveE2Output("PerformanceSummary.calendar", ctx, trades)).toBeUndefined();
    expect(resolveE2Output("not a key", ctx, trades)).toBeUndefined();
    expect(E2_PARITY_COMPONENTS).toContain("SymbolAnalytics");
    expect(E2_INTEGER_KEYS).toContain("KillZoneOptimizer.tradingDays");
    expect(E2_INTEGER_KEYS).toContain("TradeCalendar[lastTradeMonth].firstWeekdayOffset");
  });
});
