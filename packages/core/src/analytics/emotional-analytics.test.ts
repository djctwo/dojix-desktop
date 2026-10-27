import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { Trade } from "../model/trade";
import { fxTrade, stTrade } from "../test-support/trades";
import { computeEmotionalAnalytics, emotionalAnalyticsComponent, emotionalAnalyticsParity } from "./emotional-analytics";

const fx = createEngineContext({ brand: "dojix", now: 0 });

function tagged(rows: readonly [string, string][]): Trade[] {
  return rows.map(([emotion, p]) => fxTrade({ emotion, netProfit: p }));
}

describe("EmotionalAnalytics", () => {
  it("needs 10 trades with a known emotion", () => {
    const nine = tagged(Array.from({ length: 9 }, () => ["CALM", "1"] as [string, string]));
    const noise = [fxTrade({ emotion: "" }), fxTrade({ emotion: "HAPPY" })];
    expect(computeEmotionalAnalytics([...nine, ...noise])).toEqual({ metrics: null, taggedCount: 9 });
  });

  it("groups per emotion with a fractional win rate, sorted by average P&L", () => {
    const m = computeEmotionalAnalytics(
      tagged([
        ["CALM", "30"],
        ["FOMO", "-20"],
        ["CALM", "-10"],
        ["FOMO", "0"],
        ["REVENGE", "-50"],
        ["CALM", "40"],
        ["CONFIDENT", "10"],
        ["CONFIDENT", "10"],
        ["FOMO", "5"],
        ["CALM", "0"],
      ]),
    ).metrics;
    expect(m?.map((r) => [r.emotion, r.count, r.wins, r.totalPnL, r.winRate, r.avgPnL])).toEqual([
      ["CALM", 4, 2, 60, 0.5, 15],
      ["CONFIDENT", 2, 2, 20, 1, 10],
      ["FOMO", 3, 1, -15, 1 / 3, -5],
      ["REVENGE", 1, 0, -50, 0, -50],
    ]);
    expect(m?.[3]?.displayName).toBe("Revenge");
  });

  it("keeps first-appearance order for equal averages (the Mac's order is random)", () => {
    const rows: [string, string][] = [];
    for (let i = 0; i < 5; i++) rows.push(["BORED", "2"], ["ANXIOUS", "2"]);
    expect(computeEmotionalAnalytics(tagged(rows)).metrics?.map((r) => r.emotion)).toEqual(["BORED", "ANXIOUS"]);
  });

  it("shows the card only with ≥ 2 emotions; encodes EmotionMetric", () => {
    const reg = new AnalyticsRegistry().register(emotionalAnalyticsComponent);
    expect(reg.list("greenwick", "behavioral").map((c) => c.id)).toEqual(["EmotionalAnalytics"]);
    const one = Array.from({ length: 10 }, () => stTrade({ emotion: "CALM", netProfit: "3" }));
    const st = createEngineContext({ brand: "greenwick", now: 0 });
    expect(reg.run("EmotionalAnalytics", st, one)).toBeNull();
    const two = [...one, stTrade({ emotion: "FOMO", netProfit: "-3" })];
    expect((reg.run("EmotionalAnalytics", st, two) as unknown[]).length).toBe(2);
    const model = emotionalAnalyticsParity.compute(fx, two, undefined);
    expect(model && emotionalAnalyticsParity.members.metrics?.(model, fx)).toEqual([
      { id: "CALM", emotion: "CALM", count: 10, wins: 10, totalPnL: 30, winRate: 1, avgPnL: 3 },
      { id: "FOMO", emotion: "FOMO", count: 1, wins: 0, totalPnL: -3, winRate: 0, avgPnL: -3 },
    ]);
    const none = emotionalAnalyticsParity.compute(fx, [], undefined);
    expect(none && emotionalAnalyticsParity.members.metrics?.(none, fx)).toBeNull();
  });

  it("never yields NaN for valid input (property)", () => {
    const emotions = fc.constantFrom("CALM", "CONFIDENT", "ANXIOUS", "FRUSTRATED", "REVENGE", "FOMO", "BORED", "", "x");
    const money = fc.integer({ min: -1e8, max: 1e8 }).map((c) => String(c / 100));
    fc.assert(
      fc.property(fc.array(fc.tuple(emotions, money), { maxLength: 60 }), (rows) => {
        const m = computeEmotionalAnalytics(tagged(rows));
        for (const r of m.metrics ?? []) {
          for (const v of [r.winRate, r.avgPnL, r.totalPnL]) expect(Number.isFinite(v)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
