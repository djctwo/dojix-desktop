import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { calculateMetrics } from "../metrics/metrics-calculator";
import type { DojixTrade } from "../model/trade";
import { etWall, fxTrade, stTrade } from "../test-support/trades";
import { computeDailyBrief, dailyBriefComponent, dailyBriefParity, generateBriefSignals } from "./daily-brief";

const LONDON_NOW = Date.UTC(2026, 0, 20, 10, 0); // 10:00 UTC → London
const fx = createEngineContext({ brand: "dojix", now: LONDON_NOW });

/** Repository order (close time descending): `profits[0]` is the newest trade. */
function series(profits: readonly string[], extra: Partial<DojixTrade> = {}): DojixTrade[] {
  const start = Date.UTC(2026, 0, 15, 10, 0);
  return profits.map((p, i) => fxTrade({ netProfit: p, closeTime: start - i * 100_000, ...extra }));
}

describe("DailyBrief", () => {
  it("needs 5 trades", () => {
    expect(computeDailyBrief(fx, series(["1", "2", "3", "4"]))).toEqual({ signals: [], generateSignals: [] });
    const reg = new AnalyticsRegistry().register(dailyBriefComponent);
    expect(reg.run("DailyBrief", fx, series(["1", "2", "3", "4"]))).toBeNull();
    expect(reg.list("dojix", "overview").map((c) => c.id)).toEqual(["DailyBrief"]);
    expect(reg.list("greenwick", "overview").map((c) => c.id)).toEqual(["DailyBrief"]);
    expect(reg.run("DailyBrief", fx, series(["1", "2", "3", "4", "5"]))).toMatchObject({ signals: [{ priority: 2 }, { priority: 3 }, { priority: 4 }] });
  });

  it("hot streak, current session and top pair, sorted by priority", () => {
    const trades = series([...Array(10).fill("10"), ...Array(10).fill("1")]);
    const m = computeDailyBrief(fx, trades);
    expect(m.generateSignals.map((s) => s.priority)).toEqual([1, 2, 3]);
    expect(m.signals).toEqual(m.generateSignals);
    const [hot, session, pair] = m.generateSignals;
    expect(hot).toMatchObject({
      icon: "arrow.up.right",
      title: "Hot streak — last 10 trades trending up",
      detail: "Recent P&L $100.00 vs previous $10.00. Win rate 100.0%.",
      value: "$100.00",
      tone: "green",
    });
    expect(session).toMatchObject({
      title: "London session: edge based on 20 trades",
      detail: "Your London history: 100.0% WR, $110.00 total.",
      value: "100.0%",
      tone: "green",
    });
    expect(pair).toMatchObject({ title: "GBPUSD is your top performer", detail: "20 trades, 100.0% win rate.", value: "$110.00", tone: "blue" });
  });

  it("dip, worst pair, drawdown warning; top 3 only", () => {
    // newest 10 lose 5 each (−50), previous 10 win 10 each (+100)
    const gbp = series([...Array(10).fill("-5"), ...Array(10).fill("10")]);
    const eur = series(["-20", "-20", "-20", "-20", "-20"], { symbol: "EURUSD", session: "ASIAN" }).map((t) => ({
      ...t,
      closeTime: t.closeTime - 10_000_000,
    }));
    const trades = [...gbp, ...eur];
    const m = computeDailyBrief(fx, trades);
    const titles = m.generateSignals.map((s) => s.title);
    expect(titles).toEqual([
      "Performance dip — last 10 trades negative",
      "EURUSD is costing you -$100.00",
      "London session: edge based on 20 trades",
      "GBPUSD is your top performer",
    ]);
    expect(m.signals.map((x) => x.title)).toEqual(titles.slice(0, 3));
    expect(m.generateSignals[0]).toMatchObject({ value: "-$50.00", tone: "red", priority: 0 });
    expect(m.generateSignals[1]).toMatchObject({ value: null, detail: "5 trades at 0.0% WR. Consider sitting out or reducing size." });
    // total = 100 − 50 − 100 = −50: not profitable → no drawdown signal
    // Add a drawdown case: profitable total smaller than the max drawdown.
    const dd = series(["1", "1", "20", "-60", "50"]); // ascending 50, −60, 20, 1, 1: total 12, max DD 60
    const ddm = computeDailyBrief(fx, dd);
    expect(ddm.generateSignals[0]).toMatchObject({ title: "Drawdown exceeds total profit", priority: 0, tone: "amber" });
    expect(ddm.generateSignals.find((s) => s.title.startsWith("London session"))?.title).toBe("London session: edge based on 5 trades");
  });

  it("caution session and high Sharpe", () => {
    const trades = series(["-1", "-1", "-2", "-1", "-1"]);
    const m = computeDailyBrief(fx, trades);
    expect(m.generateSignals[0]).toMatchObject({
      title: "GBPUSD is costing you -$6.00",
      priority: 1,
    });
    expect(m.generateSignals[1]).toMatchObject({
      icon: "exclamationmark.triangle.fill",
      title: "London session: caution based on 5 trades",
      tone: "amber",
    });
    const sharpe = series(["10", "11", "10", "11", "10"]);
    const s = computeDailyBrief(fx, sharpe);
    expect(s.generateSignals.at(-1)).toMatchObject({ title: "Excellent risk-adjusted returns", priority: 4 });
    const expected = calculateMetrics(sharpe, fx).sharpeRatio;
    expect(s.generateSignals.at(-1)?.value).toBe(expected.toFixed(2));
    expect(s.signals).toHaveLength(3);
    expect(s.generateSignals).toHaveLength(3);
  });

  it("sums in Decimal: 0.1 + 0.2 − 0.3 is exactly 0, so no trend signal", () => {
    // newest 10 = [0.1, 0.2, −0.3, 0 ×7] (double sum 5.55e-17 > 0); previous 10 = −1 each
    const trades = series(["0.1", "0.2", "-0.3", ...Array(7).fill("0"), ...Array(10).fill("-1")], { session: "ASIAN" });
    const titles = computeDailyBrief(fx, trades).generateSignals.map((s) => s.title);
    expect(titles.some((t) => t.startsWith("Hot streak"))).toBe(false);
    expect(titles.some((t) => t.startsWith("Performance dip"))).toBe(false);
  });

  it("Greenwick: ET session from now, by symbol", () => {
    const now = etWall(2026, 10, 22, 11, 0); // Thursday, regular session
    const st = createEngineContext({ brand: "greenwick", now });
    const trades = ["5", "6", "-1", "4", "3"].map((p, i) => stTrade({ netProfit: p, closeTime: now - (i + 1) * 3_600_000 }));
    const m = computeDailyBrief(st, trades);
    expect(m.generateSignals.map((s) => s.title)).toEqual([
      "Regular session: edge based on 5 trades",
      "FICT is your top performer",
    ]);
    // Pre-market now: no session signal for regular-session trades
    const pre = createEngineContext({ brand: "greenwick", now: etWall(2026, 10, 22, 7, 0) });
    expect(computeDailyBrief(pre, trades).generateSignals.map((s) => s.title)).toEqual(["FICT is your top performer"]);
  });

  it("accepts the Dashboard's metrics", () => {
    const trades = series(["1", "2", "3", "4", "5"]);
    const m = generateBriefSignals(fx, trades, { ...calculateMetrics(trades, fx), sharpeRatio: 2 });
    expect(m.some((s) => s.value === "2.00")).toBe(true);
  });

  it("parity encodes signals without the colour", () => {
    const ctx = parityContext("dojix", LONDON_NOW);
    const trades = series(["-1", "-1", "-2", "-1", "-1"]);
    const m = dailyBriefParity.compute(ctx, trades, undefined);
    const enc = m && (dailyBriefParity.members.signals?.(m, ctx) as Record<string, unknown>[]);
    expect(enc?.[0]).toEqual({
      icon: "xmark.circle.fill",
      title: "GBPUSD is costing you -$\u00a06.00", // en_US_POSIX, the harness locale
      detail: "5 trades at 0.0% WR. Consider sitting out or reducing size.",
      value: null,
      priority: 1,
    });
    expect(m && dailyBriefParity.members.generateSignals?.(m, ctx)).toHaveLength(2);
    expect(dailyBriefParity.compute(ctx, trades, "x")).toBeUndefined();
  });

  it("properties: never throws; storage-valid input gives finite-text signals", () => {
    const money = fc.integer({ min: -100_000_000, max: 100_000_000 }).map((c) => (c / 100).toString());
    fc.assert(
      fc.property(fc.array(money, { maxLength: 30 }), fc.integer({ min: 0, max: 23 }), (ps, h) => {
        const ctx = createEngineContext({ brand: "dojix", now: Date.UTC(2026, 0, 20, h) });
        const m = computeDailyBrief(ctx, series(ps));
        expect(m.signals.length).toBeLessThanOrEqual(3);
        for (const s of m.generateSignals) expect(`${s.title}${s.detail}${s.value ?? ""}`).not.toMatch(/nan|NaN/);
      }),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 25 }), (ps) => {
        computeDailyBrief(fx, series(ps));
      }),
      { numRuns: 50 },
    );
  });
});
