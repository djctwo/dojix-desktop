// Pairs / Symbols tab (Lot/ShareSizeAnalysis, WinLossDistribution, SlippageAnalysis,
// MAEMFEChart, Pair/SymbolAnalytics, DirectionalEdge) and the Overview cards
// (SessionRankingCard, StreakCard).
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { streaksOf } from "../metrics/metrics-calculator";
import { fxSeries, fxTrade, stTrade } from "../test-support/trades";
import { directionalEdge, directionStats } from "./directional-edge";
import { MAE_MFE_INSIGHT_TEXT, maeMfeChart, maeMfeRating } from "./mae-mfe";
import { sessionRanking } from "./session-ranking";
import { sizeAnalysis } from "./size-analysis";
import { slippageAnalysis } from "./slippage";
import { streakCard } from "./streak-card";
import { symbolAnalytics } from "./symbol-analytics";
import { winLossDistribution } from "./win-loss-distribution";

const NOW = Date.UTC(2026, 9, 21, 12, 0);
const fx = createEngineContext({ brand: "dojix", now: NOW, compat: "swift" });
const fxFixed = createEngineContext({ brand: "dojix", now: NOW, compat: "fixed" });
const st = createEngineContext({ brand: "greenwick", now: NOW, compat: "swift" });
const stFixed = createEngineContext({ brand: "greenwick", now: NOW, compat: "fixed" });

describe("Lot / ShareSizeAnalysis", () => {
  it("averages the size of wins and losses and flags oversizing above 1.2×", () => {
    const trades = [
      fxTrade({ lots: 0.1, netProfit: "10" }),
      fxTrade({ lots: 0.3, netProfit: "5" }),
      fxTrade({ lots: 0.5, netProfit: "-8" }),
      fxTrade({ lots: 9, netProfit: "0" }),
    ];
    const m = sizeAnalysis(fx, trades);
    expect(m.avgWinSize).toBeCloseTo(0.2, 15);
    expect(m.avgLossSize).toBe(0.5);
    expect(m.oversizingOnLosses).toBe(true);
    expect(m.enoughData).toBe(false);
    expect(m.points[3]).toEqual({ quantity: 9, pnl: 0 });
    expect(m.unit).toBe("lots");
    // 0.24 is not above 0.2 × 1.2 = 0.24 (exactly: 0.24 > 0.24000000000000002 is false).
    expect(sizeAnalysis(fx, [fxTrade({ lots: 0.2, netProfit: "1" }), fxTrade({ lots: 0.24, netProfit: "-1" })]).oversizingOnLosses).toBe(false);
  });

  it("uses shares in Greenwick and zeros without wins or losses", () => {
    const m = sizeAnalysis(st, [100, 200, 300, 400, 500].map((shares) => stTrade({ shares, netProfit: "0" })));
    expect([m.avgWinSize, m.avgLossSize, m.oversizingOnLosses, m.enoughData, m.unit]).toEqual([0, 0, false, true, "shares"]);
  });
});

describe("WinLossDistribution", () => {
  const f1 = fxSeries(["100", "50", "-30", "-20", "80"]);

  it("buckets the F1 set; the largest win falls outside on the Mac (D-01 swift)", () => {
    const m = winLossDistribution(fx, f1);
    expect([m.maxAbs, m.bucketSize, m.median]).toEqual([100, 20, 50]);
    expect(m.buckets.map((b) => [b.range, b.count, b.isProfit])).toEqual([
      ["-40", 1, false],
      ["-20", 1, false],
      ["40", 1, true],
      ["80", 1, true],
    ]);
  });

  it("PARITY D-01 fixed: the top bucket is closed at +maxAbs", () => {
    const m = winLossDistribution(fxFixed, f1);
    expect(m.buckets.map((b) => [b.range, b.count])).toEqual([
      ["-40", 1],
      ["-20", 1],
      ["40", 1],
      ["80", 2],
    ]);
    expect(m.buckets.at(-1)).toMatchObject({ low: 80, high: 100 });
    const total = (ms: typeof m) => ms.buckets.reduce((s, b) => s + b.count, 0);
    expect(total(m)).toBe(f1.length);
  });

  it("survives P&L beyond Int range (AnalyticsClampTests / HostileValueTests)", () => {
    const huge = [fxTrade({ netProfit: "-1e21" }), fxTrade({ netProfit: "1e21" })];
    const swift = winLossDistribution(fx, huge);
    expect(swift.buckets.length).toBeGreaterThan(0);
    expect(swift.buckets[0]?.range).toBe("-9223372036854775808");
    const fixed = winLossDistribution(fxFixed, huge);
    expect(fixed.buckets.map((b) => b.range)).toEqual(["-9223372036854775808", "9223372036854775807"]);
    const g = winLossDistribution(st, [stTrade({ netProfit: "-1000000000000000000000" }), stTrade({ netProfit: "25" })]);
    expect(g.buckets.length).toBeGreaterThan(0);
  });

  it("has no buckets when every P&L is zero; median of an even count", () => {
    const flat = winLossDistribution(fx, fxSeries(["0", "0"]));
    expect([flat.buckets, flat.median, flat.maxAbs]).toEqual([[], 0, 0]);
    expect(winLossDistribution(fx, fxSeries(["1", "4", "-2", "3"])).median).toBe(2);
    expect(winLossDistribution(stFixed, [])).toEqual({ buckets: [], median: null, maxAbs: 0, bucketSize: 0 });
  });
});

describe("SlippageAnalysis", () => {
  const slips = [0, 0.5, 1.0, 2.5, 3, 150, -1];
  const trades = slips.map((s, i) => fxTrade({ slippagePips: s, lots: 0.1, netProfit: String(i * 10) }));

  it("averages positive slippage and estimates its cost", () => {
    const m = slippageAnalysis(fx, trades);
    expect(m.tradesWithSlippage).toHaveLength(5);
    expect(m.avgSlippage).toBeCloseTo(31.4, 12);
    expect(m.totalSlippageCost).toBeCloseTo(157, 9);
    expect(m.highSlippageTrades).toBe(1);
    expect(m.showHighSlippageInsight).toBe(true);
    expect(m.unit).toBe("pips");
  });

  it("swift: closed buckets count edges twice and drop values above 100 (D-02)", () => {
    const m = slippageAnalysis(fx, trades);
    expect(m.buckets.map((b) => [b.label, b.count])).toEqual([
      ["0-0.5", 2],
      ["0.5-1", 2],
      ["1-2", 1],
      ["2-3", 2],
      ["3+", 1],
    ]);
    expect(m.buckets[0]?.avgPnL).toBe(5);
  });

  it("PARITY D-02 fixed: half-open buckets, the last open-ended", () => {
    const m = slippageAnalysis(fxFixed, trades);
    expect(m.buckets.map((b) => [b.label, b.count])).toEqual([
      ["0-0.5", 1],
      ["0.5-1", 1],
      ["1-2", 1],
      ["2-3", 1],
      ["3+", 2],
    ]);
    expect(m.buckets[4]?.avgPnL).toBe(45);
  });

  it("DojixTests testAvgSlippageCalculation; Greenwick costs points × shares", () => {
    expect(slippageAnalysis(fx, [fxTrade(), fxTrade(), fxTrade()]).avgSlippage).toBe(0.5);
    const g = slippageAnalysis(st, [stTrade({ slippagePoints: 0.02, shares: 100 }), stTrade({ slippagePoints: 0, shares: 1 })]);
    expect(g.totalSlippageCost).toBe(2);
    expect([g.unit, g.showHighSlippageInsight, g.highSlippageTrades]).toEqual(["pts", false, 0]);
    expect(slippageAnalysis(st, []).avgSlippage).toBe(0);
  });
});

describe("MAEMFEChart", () => {
  const trades = [
    fxTrade({ netProfit: "50", maePips: 10, mfePips: 30 }),
    fxTrade({ netProfit: "50", maePips: 5, mfePips: 20 }),
    fxTrade({ netProfit: "-30", maePips: 15, mfePips: 10 }),
  ];

  it("ratio and capture (DojixTests testMFEToMAERatio)", () => {
    const m = maeMfeChart(fx, trades);
    expect([m.avgMAE, m.avgMFE, m.mfeToMaeRatio]).toEqual([10, 20, 2]);
    expect(m.rating).toBe("good");
    expect(MAE_MFE_INSIGHT_TEXT[m.rating]).toMatch(/^Good trade management/);
    expect(m.showInsight).toBe(true);
    // Σ|p / max(0.1 × 10, 1)| = 130 over Σ MFE = 60.
    expect(m.captureRatio).toBeCloseTo(130 / 60, 14);
    expect(m.enoughData).toBe(false);
    expect(m.points).toHaveLength(3);
  });

  it("zero MAE gives ratio 0 and no insight (testMFEToMAERatioZeroMAE)", () => {
    const m = maeMfeChart(fx, [fxTrade({ netProfit: "50", maePips: 0, mfePips: 20 })]);
    expect([m.mfeToMaeRatio, m.showInsight, m.rating]).toEqual([0, false, "poor"]);
    expect(maeMfeRating(3)).toBe("excellent");
    expect(maeMfeRating(1)).toBe("average");
    expect(maeMfeChart(fx, [])).toMatchObject({ avgMAE: 0, avgMFE: 0, captureRatio: 0, points: [] });
  });

  it("PARITY D-18: unknown MAE/MFE are 0 on the Mac, skipped when fixed", () => {
    const withUnknown = [...trades, fxTrade({ netProfit: "100", maePips: null, mfePips: null })];
    const swift = maeMfeChart(fx, withUnknown);
    expect([swift.avgMAE, swift.avgMFE]).toEqual([7.5, 15]);
    expect(swift.captureRatio).toBeCloseTo(230 / 60, 14);
    expect(swift.points).toHaveLength(4);
    const fixed = maeMfeChart(fxFixed, withUnknown);
    expect([fixed.avgMAE, fixed.avgMFE, fixed.mfeToMaeRatio]).toEqual([10, 20, 2]);
    expect(fixed.captureRatio).toBeCloseTo(130 / 60, 14);
    expect(fixed.points).toHaveLength(3);
    const none = maeMfeChart(stFixed, [stTrade({ maePoints: null, mfePoints: null })]);
    expect([none.avgMAE, none.avgMFE, none.mfeToMaeRatio, none.showInsight, none.unit]).toEqual([null, null, 0, false, "pts"]);
  });

  it("keeps the ×10 for Greenwick shares", () => {
    const m = maeMfeChart(st, [stTrade({ netProfit: "200", shares: 100, mfePoints: 4 })]);
    expect(m.captureRatio).toBe(0.05);
  });
});

describe("Pair / SymbolAnalytics", () => {
  it("sorts symbols by P&L (ties keep first appearance) with per-direction splits", () => {
    const trades = [
      fxTrade({ symbol: "EURUSD", direction: "BUY", netProfit: "30", rMultiple: 1, closeTime: Date.UTC(2026, 0, 2) }),
      fxTrade({ symbol: "USDJPY", direction: "SELL", netProfit: "50", rMultiple: 2 }),
      fxTrade({ symbol: "EURUSD", direction: "SELL", netProfit: "-10", rMultiple: -1, closeTime: Date.UTC(2026, 0, 1) }),
      fxTrade({ symbol: "GBPUSD", direction: "BUY", netProfit: "20", rMultiple: 0 }),
      fxTrade({ symbol: "EURUSD", direction: "BUY", netProfit: "0", rMultiple: 0, closeTime: Date.UTC(2026, 0, 3) }),
    ];
    const m = symbolAnalytics(fx, trades);
    expect(m.cards.map((c) => [c.symbol, c.pnl])).toEqual([
      ["USDJPY", 50],
      ["EURUSD", 20],
      ["GBPUSD", 20],
    ]);
    const eur = m.cards[1];
    expect(eur).toMatchObject({ tradeCount: 3, winRate: (1 / 3) * 100, avgR: 0, buys: 2, sells: 1, buyPnL: 30, sellPnL: -10, confidence: "insufficient" });
    expect(eur?.equityCurve).toEqual([-10, 20, 20]);
    expect(symbolAnalytics(st, []).cards).toEqual([]);
  });
});

describe("DirectionalEdge", () => {
  it("splits long and short (DojixTests testDirectionalSplit)", () => {
    const trades = [
      ...Array.from({ length: 5 }, () => fxTrade({ direction: "BUY", netProfit: "50", rMultiple: 2 })),
      ...Array.from({ length: 5 }, () => fxTrade({ direction: "SELL", netProfit: "-20", rMultiple: -1 })),
    ];
    const m = directionalEdge(fx, trades);
    expect(m.buyStats).toEqual({ count: 5, totalPnL: 250, winRate: 100, avgR: 2, avgPnL: 50 });
    expect(m.sellStats).toEqual({ count: 5, totalPnL: -100, winRate: 0, avgR: -1, avgPnL: -20 });
    expect([m.betterDirection, m.betterAvgPnL, m.showInsight, m.sampleSize]).toEqual(["Long", 50, true, 10]);
  });

  it("calls a tie Short and needs 5 trades a side for the insight", () => {
    const m = directionalEdge(st, [stTrade({ direction: "BUY", netProfit: "10" }), stTrade({ direction: "SELL", netProfit: "10" })]);
    expect([m.betterDirection, m.showInsight]).toEqual(["Short", false]);
    expect(directionStats([])).toEqual({ count: 0, totalPnL: 0, winRate: 0, avgR: 0, avgPnL: 0 });
  });
});

describe("SessionRankingCard", () => {
  it("ranks non-empty sessions by P&L; ties keep enum order", () => {
    const trades = [
      fxTrade({ session: "NY", netProfit: "100" }),
      fxTrade({ session: "ASIAN", netProfit: "-50" }),
      fxTrade({ session: "LONDON", netProfit: "60" }),
      fxTrade({ session: "LONDON", netProfit: "40" }),
    ];
    expect(sessionRanking(fx, trades).sessions).toEqual([
      { rank: 1, session: "LONDON", name: "London", pnl: 100, trades: 2, winRate: 100 },
      { rank: 2, session: "NY", name: "New York", pnl: 100, trades: 1, winRate: 100 },
      { rank: 3, session: "ASIAN", name: "Asian", pnl: -50, trades: 1, winRate: 0 },
    ]);
    expect(sessionRanking(st, [stTrade({ session: "EXTENDED" })]).sessions[0]?.name).toBe("Extended");
  });
});

describe("StreakCard", () => {
  const desc = (...p: string[]) => fxSeries(p).reverse();

  it("counts the current run, best runs and the last 10 results (a breakeven counts as a loss)", () => {
    const m = streakCard(fx, desc("10", "10", "0", "10", "10", "10"));
    expect([m.currentStreak, m.bestWinStreak, m.bestLossStreak]).toEqual([3, 3, 0]);
    expect(m.recentResults).toEqual([true, true, false, true, true, true]);
    expect(m.isNearPersonalBest).toBeNull();
    const be = streakCard(fx, desc("-1", "-1", "0", "-1", "10", "0"));
    expect([be.currentStreak, be.bestLossStreak]).toEqual([-1, 2]);
    expect(streakCard(fx, desc(...Array(12).fill("5"))).recentResults).toHaveLength(10);
    expect(streakCard(fx, [])).toMatchObject({ currentStreak: 0, recentResults: [], hasTrades: false });
  });

  it("PARITY D-17: differs from MetricsCalculator on breakevens (kept in both modes)", () => {
    const asc = fxSeries(["5", "-5", "0"]);
    expect(streaksOf(asc).currentStreak).toBe(0);
    expect(streakCard(fx, asc).currentStreak).toBe(-2);
    expect(streakCard(fxFixed, asc).currentStreak).toBe(-2);
  });

  it("Greenwick shows the near-personal-best badge", () => {
    const g = (...p: string[]) => p.map((netProfit, i) => stTrade({ netProfit, closeTime: Date.UTC(2026, 0, 5) + i * 60_000 }));
    expect(streakCard(st, g("1", "1", "1")).isNearPersonalBest).toBe(true);
    expect(streakCard(st, g("1", "1", "1", "1", "1", "-1", "1", "1", "1", "1")).isNearPersonalBest).toBe(true);
    expect(streakCard(st, g("1", "1", "1", "1", "1", "-1", "1", "1", "1")).isNearPersonalBest).toBe(false);
    expect(streakCard(st, g("1", "1")).isNearPersonalBest).toBe(false);
  });
});
