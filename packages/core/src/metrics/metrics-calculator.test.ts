import { describe, expect, it } from "vitest";
import { fxSeries, fxTrade, stTrade } from "../test-support/trades";
import { calculateMetrics, EMPTY_METRICS, maxDrawdownOf, sharpeOf, sortedByCloseAscending, streaksOf } from "./metrics-calculator";

const FX = { brand: "dojix", compat: "swift" } as const;
const ST = { brand: "greenwick", compat: "swift" } as const;

describe("MetricsCalculator — ported from Dojix DojixTests/MetricsCalculatorTests.swift", () => {
  it("testEmptyTrades", () => {
    expect(calculateMetrics([], FX)).toEqual(EMPTY_METRICS);
  });

  it("testSingleWinningTrade", () => {
    const m = calculateMetrics([fxTrade({ netProfit: "50" })], FX);
    expect(m).toMatchObject({ totalTrades: 1, wins: 1, losses: 0, winRate: 100, totalProfit: 50, grossProfit: 50, grossLoss: 0 });
    expect(m).toMatchObject({ averageWin: 50, averageLoss: 0, bestTrade: 50 });
  });

  it("testSingleLosingTrade", () => {
    const m = calculateMetrics([fxTrade({ netProfit: "-30" })], FX);
    expect(m).toMatchObject({ totalTrades: 1, wins: 0, losses: 1, winRate: 0, totalProfit: -30, worstTrade: -30 });
  });

  it("testMixedTrades", () => {
    const m = calculateMetrics(fxSeries(["100", "50", "-30", "-20", "80"]), FX);
    expect(m.totalTrades).toBe(5);
    expect(m.wins).toBe(3);
    expect(m.losses).toBe(2);
    expect(m.winRate).toBeCloseTo(60, 10);
    expect(m.totalProfit).toBe(180);
    expect(m.grossProfit).toBe(230);
    expect(m.grossLoss).toBe(50);
    expect(m.profitFactor).toBeCloseTo(230 / 50, 12);
    expect(m.averageWin).toBeCloseTo(230 / 3, 12);
    expect(m.averageLoss).toBe(25);
    expect(m.bestTrade).toBe(100);
    expect(m.worstTrade).toBe(-30);
  });

  it("testProfitFactorAllWins", () => {
    expect(calculateMetrics(fxSeries(["50", "100"]), FX).profitFactor).toBe(Infinity);
  });

  it("testMaxDrawdown", () => {
    // Equity 100, 150, 50, 30, 130 → peak 150, trough 30 → 120
    expect(calculateMetrics(fxSeries(["100", "50", "-100", "-20", "100"]), FX).maxDrawdown).toBe(120);
  });

  it("testStreaks / testCurrentStreakNegative", () => {
    const m = calculateMetrics(fxSeries(["10", "20", "30", "-10", "-20", "15"]), FX);
    expect([m.maxWinStreak, m.maxLossStreak, m.currentStreak]).toEqual([3, 2, 1]);
    expect(calculateMetrics(fxSeries(["50", "-10", "-20"]), FX).currentStreak).toBe(-2);
  });

  it("testAverageDuration", () => {
    const trades = [30, 60, 90].map((d, i) => fxTrade({ netProfit: String(10 - i * 7), durationMin: d }));
    expect(calculateMetrics(trades, FX).averageDuration).toBe(60);
  });
});

describe("F1 tiny set [100, 50, −30, −20, 80] (SPEC §10.3)", () => {
  it("has the hand-checked headline numbers", () => {
    const m = calculateMetrics(fxSeries(["100", "50", "-30", "-20", "80"]).reverse(), FX); // repository order
    expect(m.expectancy).toBe(36);
    expect(m.maxDrawdown).toBe(50);
    expect(m.sharpeRatio).toBe(0.6872431934890912);
    expect(m.calmarRatio).toBe(3.6);
  });
});

describe("sentinels and edge cases", () => {
  it("profit factor is 0 with no wins and no losses; Calmar 10 / 0 without drawdown", () => {
    const be = calculateMetrics(fxSeries(["0", "0"]), FX);
    expect(be.profitFactor).toBe(0);
    expect(be.winRate).toBe(0);
    expect(be.calmarRatio).toBe(0);
    expect(be.sharpeRatio).toBe(0); // σ = 0
    expect(calculateMetrics(fxSeries(["10", "20"]), FX).calmarRatio).toBe(10);
  });

  it("breakevens count in the win-rate denominator and weigh on the loss side of expectancy", () => {
    const m = calculateMetrics(fxSeries(["100", "0", "-50", "0"]), FX);
    expect(m.winRate).toBe(25);
    expect(m.expectancy).toBe(0.25 * 100 - 0.75 * 50);
  });

  it("a breakeven changes no streak and makes the current streak 0", () => {
    const m = calculateMetrics(fxSeries(["10", "0", "20", "-5", "0"]), FX);
    expect([m.maxWinStreak, m.maxLossStreak, m.currentStreak]).toEqual([2, 1, 0]);
  });

  it("drawdown starts from zero (an opening loss is drawdown)", () => {
    expect(calculateMetrics(fxSeries(["-40", "10"]), FX).maxDrawdown).toBe(40);
  });

  it("sorts ascending by close time, stable for ties, whatever the input order", () => {
    const t = fxSeries(["-10", "30", "-50"]);
    const shuffled = [t[2], t[0], t[1]] as typeof t;
    expect(calculateMetrics(shuffled, FX).maxDrawdown).toBe(calculateMetrics(t, FX).maxDrawdown);
    const tie = [fxTrade({ netProfit: "5", closeTime: 1 }), fxTrade({ netProfit: "-5", closeTime: 1 })];
    expect(sortedByCloseAscending(tie).map((x) => x.netProfit)).toEqual(["5", "-5"]);
    expect(sortedByCloseAscending([...tie].reverse()).map((x) => x.netProfit)).toEqual(["-5", "5"]);
  });

  it("sums totals in input order (floating-point)", () => {
    const t = fxSeries(["0.1", "0.2", "0.3"]);
    const total = calculateMetrics(t, FX).totalProfit;
    // Foundation's 0.1 is 1/10 (exact nearest), 0.2 = 2/10, 0.3 = 3/10
    expect(total).toBe(1 / 10 + 2 / 10 + 3 / 10);
  });

  it("converts money with Foundation's Decimal → Double", () => {
    expect(calculateMetrics([fxTrade({ netProfit: "0.07" })], FX).totalProfit).toBe(0.06999999999999999);
  });

  it("helpers handle empty input", () => {
    expect(sharpeOf([])).toBe(0);
    expect(maxDrawdownOf([])).toBe(0);
    expect(streaksOf([])).toEqual({ maxWinStreak: 0, maxLossStreak: 0, currentStreak: 0 });
  });
});

describe("costs (DECISIONS #3)", () => {
  it("Dojix reports net after costs = total − costs", () => {
    const m = calculateMetrics(
      [fxTrade({ netProfit: "100", commission: "7", swap: "-2.5" }), fxTrade({ netProfit: "-20", commission: "3" })],
      FX,
    );
    expect(m.totalCommissions).toBe(10);
    expect(m.totalSwap).toBe(-2.5);
    expect(m.totalCosts).toBe(7.5);
    expect(m.netProfitAfterCosts).toBe(72.5);
  });

  it("Greenwick's P&L is already net", () => {
    const m = calculateMetrics([stTrade({ netProfit: "100", commission: "7" })], ST);
    expect(m.totalCosts).toBe(7);
    expect(m.netProfitAfterCosts).toBe(100);
  });
});

describe("MAE / MFE averages (PARITY D-18)", () => {
  const trades = [fxTrade({ netProfit: "1", maePips: 10, mfePips: 30 }), fxTrade({ netProfit: "1", maePips: null, mfePips: null })];

  it("swift compat averages unknowns as 0, like the Mac storage", () => {
    const m = calculateMetrics(trades, FX);
    expect(m.averageMAE).toBe(5);
    expect(m.averageMFE).toBe(15);
  });

  it("fixed mode averages known values only and is null when none are known", () => {
    const m = calculateMetrics(trades, { brand: "dojix", compat: "fixed" });
    expect(m.averageMAE).toBe(10);
    expect(m.averageMFE).toBe(30);
    const none = calculateMetrics([stTrade({ netProfit: "1", maePoints: null, mfePoints: null })], {
      brand: "greenwick",
      compat: "fixed",
    });
    expect(none.averageMAE).toBeNull();
    expect(none.averageMFE).toBeNull();
  });

  it("averages R over every trade", () => {
    expect(calculateMetrics([fxTrade({ rMultiple: 2 }), fxTrade({ rMultiple: -1 })], FX).averageRMultiple).toBe(0.5);
  });
});
