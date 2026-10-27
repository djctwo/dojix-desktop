import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { calculateMetrics } from "../metrics/metrics-calculator";
import { resolveParityOutput } from "../parity/reference";
import { fxSeries, stTrade } from "../test-support/trades";
import { registerComponentParity } from "./support";
import {
  checkpointMetrics,
  compareAtCheckpoint,
  computeStrategyCheckpoints,
  fixtureCheckpoint,
  strategyCheckpointsComponent,
  strategyCheckpointsParity,
} from "./strategy-checkpoints";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const st = createEngineContext({ brand: "greenwick", now: 0 });
const T0 = Date.UTC(2026, 0, 15, 10, 0);

describe("StrategyCheckpoints", () => {
  it("splits at the checkpoint (before <, after ≥) and sorts each side ascending", () => {
    const asc = fxSeries(["10", "-5", "20", "30", "-10", "40"]);
    const repo = [...asc].reverse();
    const cp = { id: 1, date: asc[3]?.closeTime ?? 0, title: "New stop rule", description: "" };
    const c = compareAtCheckpoint(fx, repo, cp);
    expect(c.beforeTrades).toEqual(asc.slice(0, 3));
    expect(c.afterTrades).toEqual(asc.slice(3));
    expect(c.before).toEqual({ tradeCount: 3, winRate: (2 / 3) * 100, profitFactor: 6, expectancy: c.before.expectancy, avgR: 1, maxDrawdown: 5, sharpe: c.before.sharpe });
    expect(c.after.maxDrawdown).toBe(10);
    expect(c.comparable).toBe(false);
    expect(c.confidenceSampleSize).toBe(3);
  });

  it("metrics(for:) sums in ascending order and is all zeros when empty", () => {
    const asc = fxSeries(["0.1", "0.2", "-0.3", "0.7"]);
    expect(checkpointMetrics(fx, asc).expectancy).toBe(calculateMetrics(asc, fx).expectancy);
    expect(checkpointMetrics(fx, [])).toEqual({ tradeCount: 0, winRate: 0, profitFactor: 0, expectancy: 0, avgR: 0, maxDrawdown: 0, sharpe: 0 });
    expect(checkpointMetrics(fx, fxSeries(["1"])).profitFactor).toBe(Infinity);
  });

  it("compares only with ≥ 5 trades on each side", () => {
    const trades = fxSeries(Array(10).fill("1"));
    const at = (i: number) => compareAtCheckpoint(fx, trades, { id: null, date: trades[i]?.closeTime ?? 0, title: "x", description: "" });
    expect(at(5).comparable).toBe(true);
    expect(at(4).comparable).toBe(false);
    expect(at(6).comparable).toBe(false);
    expect(computeStrategyCheckpoints(fx, trades).checkpoints).toEqual([]);
  });

  it("works for Greenwick", () => {
    const trades = [stTrade({ netProfit: "5", closeTime: T0 }), stTrade({ netProfit: "-2", closeTime: T0 + 1000 })];
    const m = computeStrategyCheckpoints(st, trades, [{ id: null, date: T0 + 500, title: "x", description: "" }]);
    expect(m.checkpoints[0]?.before.tradeCount).toBe(1);
    expect(m.checkpoints[0]?.after.winRate).toBe(0);
  });

  it("the registry has no checkpoints: the Mac's empty state", () => {
    const reg = new AnalyticsRegistry().register(strategyCheckpointsComponent);
    expect(reg.run("StrategyCheckpoints", fx, fxSeries(["1"]))).toBeNull();
    expect(reg.list("dojix", "advanced").map((c) => c.id)).toEqual(["StrategyCheckpoints"]);
  });

  it("reproduces the harness's split key (fixture checkpoint at the median close)", () => {
    const asc = fxSeries(["10", "-5", "20", "30"]);
    expect(fixtureCheckpoint([...asc].reverse()).date).toBe(asc[2]?.closeTime);
    expect(fixtureCheckpoint([]).date).toBe(0);
    const m = strategyCheckpointsParity.compute(fx, asc, undefined);
    if (!m) throw new Error("no model");
    const split = strategyCheckpointsParity.members.split?.(m, fx) as Record<string, unknown>[];
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({
      date: new Date(asc[2]?.closeTime ?? 0).toISOString(),
      beforeCount: 2,
      afterCount: 2,
      before: { tradeCount: 2, winRate: 50, profitFactor: 2, avgR: 1, maxDrawdown: 5 },
    });
    expect(Object.keys(split[0] ?? {}).sort()).toEqual(["after", "afterCount", "before", "beforeCount", "date"]);
    // Through the resolver registry (registered under a probe name to keep this test isolated).
    registerComponentParity({ ...strategyCheckpointsParity, component: "StrategyCheckpointsProbe" });
    expect(resolveParityOutput("StrategyCheckpointsProbe.split", parityContext("dojix", 0), asc)?.value).toEqual(split);
  });

  it("never throws; counts add up", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -100_000, max: 100_000 }), { maxLength: 30 }), fc.integer({ min: -5, max: 40 }), (cents, k) => {
        const trades = fxSeries(cents.map((c) => String(c / 100)));
        const c = compareAtCheckpoint(fx, trades, { id: null, date: T0 + k * 100_000, title: "", description: "" });
        expect(c.before.tradeCount + c.after.tradeCount).toBe(trades.length);
        for (const v of [c.before.winRate, c.after.expectancy, c.after.sharpe]) expect(Number.isNaN(v)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
