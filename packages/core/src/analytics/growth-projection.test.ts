import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade, stTrade } from "../test-support/trades";
import { computeGrowthProjection, growthProjectionComponent, growthProjectionParity } from "./growth-projection";

const fx = createEngineContext({ brand: "dojix", now: 0 });
const DAY = 86_400_000;
const start = Date.UTC(2026, 0, 5, 12);

/** n trades of `profit`, spread evenly over `days` days. */
const spread = (n: number, days: number, profit = "15") =>
  Array.from({ length: n }, (_, i) => fxTrade({ netProfit: profit, closeTime: start + Math.round((i * days * DAY) / (n - 1)) })).reverse();

describe("GrowthProjection", () => {
  it("5 trades/week × $15 × 24 weeks = $1,800 (DojixTests/AnalyticsComponentTests.swift:345-355)", () => {
    const m = computeGrowthProjection(fx, spread(10, 14)); // 14 days → 2 weeks → 5 per week
    expect(m.tradesPerWeek).toBe(5);
    expect(m.expectancy).toBe(15);
    expect(m.months).toBe(6);
    expect(m.projectionData).toHaveLength(25);
    expect(m.projectionData[24]).toEqual({ week: 24, conservative: 1800 * 0.6, expected: 1800, optimistic: 1800 * 1.4 });
    expect(m.projectionData[0]).toEqual({ week: 0, conservative: 0, expected: 0, optimistic: 0 });
    expect(m.target).toBe(1800);
  });

  it("weeks = max(1, days) / 7 with integer division; under 7 days uses n", () => {
    expect(computeGrowthProjection(fx, spread(6, 6)).tradesPerWeek).toBe(6); // 6 / 7 = 0 weeks
    expect(computeGrowthProjection(fx, spread(6, 0)).tradesPerWeek).toBe(6); // same instant → max(1, 0)
    expect(computeGrowthProjection(fx, spread(6, 20)).tradesPerWeek).toBe(3); // 20 / 7 = 2
    expect(computeGrowthProjection(fx, spread(4, 20)).tradesPerWeek).toBe(0); // n < 5
  });

  it("counts days on the computer's calendar (Calendar.current), also for Greenwick", () => {
    // Exactly 7 × 24 h across the EU fall-back night: 7 wall days in UTC, 6 in Berlin.
    const first = Date.UTC(2026, 9, 21, 10);
    const last = first + 7 * DAY;
    const trades = [stTrade({ netProfit: "10", closeTime: last }), ...Array.from({ length: 4 }, () => stTrade({ netProfit: "10", closeTime: first }))];
    const utc = createEngineContext({ brand: "greenwick", now: 0, local: { tz: "UTC" } });
    const berlin = createEngineContext({ brand: "greenwick", now: 0, local: { tz: "Europe/Berlin" } });
    expect(computeGrowthProjection(utc, trades).tradesPerWeek).toBe(5);
    expect(computeGrowthProjection(berlin, trades).tradesPerWeek).toBe(5); // 0 weeks → n
    const longer = [stTrade({ netProfit: "10", closeTime: last + 7 * DAY }), ...trades];
    expect(computeGrowthProjection(utc, longer).tradesPerWeek).toBe(6 / 2);
    expect(computeGrowthProjection(berlin, longer).tradesPerWeek).toBe(6 / 1); // 13 wall days
  });

  it("is empty without a positive expectancy; the component then shows its empty state", () => {
    const losing = spread(10, 14, "-5");
    const m = computeGrowthProjection(fx, losing);
    expect(m.projectionData).toEqual([]);
    expect(m.target).toBeNull();
    const reg = new AnalyticsRegistry().register(growthProjectionComponent);
    expect(reg.run("GrowthProjection", fx, losing)).toBeNull();
    expect(reg.run("GrowthProjection", fx, spread(10, 14))).toMatchObject({ tradesPerWeek: 5 });
  });

  it("resolves the default, months3 and months12 instances", () => {
    const trades = spread(10, 14);
    const at = (inst: string | undefined) => {
      const m = growthProjectionParity.compute(fx, trades, inst);
      if (!m) throw new Error("model");
      return growthProjectionParity.members.projectionData?.(m, fx) as unknown[];
    };
    expect(at(undefined)).toHaveLength(25);
    expect(at("months3")).toHaveLength(13);
    expect(at("months12")).toHaveLength(49);
    expect(at("months3")[12]).toEqual({ week: 12, conservative: 900 * 0.6, expected: 900, optimistic: 900 * 1.4 });
    expect(growthProjectionParity.compute(fx, trades, "months7")).toBeUndefined();
    const m = growthProjectionParity.compute(fx, trades, undefined);
    expect(m && growthProjectionParity.members.tradesPerWeek?.(m, fx)).toBe(5);
  });

  it("never throws or yields NaN for valid input (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: fc.integer({ min: -1e8, max: 1e8 }), t: fc.integer({ min: 0, max: 400 * DAY }) }), { maxLength: 30 }),
        (rows) => {
          const m = computeGrowthProjection(fx, rows.map((r) => fxTrade({ netProfit: String(r.p / 100), closeTime: start + r.t })));
          expect(Number.isNaN(m.tradesPerWeek)).toBe(false);
          for (const p of m.projectionData) expect([p.conservative, p.expected, p.optimistic].some(Number.isNaN)).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });
});
