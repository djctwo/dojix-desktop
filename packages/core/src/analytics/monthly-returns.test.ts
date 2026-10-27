import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { etWall, fxTrade, stTrade } from "../test-support/trades";
import { computeMonthlyReturns, monthlyReturnsComponent, monthlyReturnsParity } from "./monthly-returns";

const utc = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h);
const fx = parityContext("dojix", 0);

describe("MonthlyReturns", () => {
  const trades = [
    fxTrade({ closeTime: utc(2026, 2, 3), netProfit: "-40" }),
    fxTrade({ closeTime: utc(2025, 12, 30), netProfit: "25" }),
    fxTrade({ closeTime: utc(2026, 1, 20), netProfit: "100" }),
    fxTrade({ closeTime: utc(2026, 1, 5), netProfit: "-20" }),
    fxTrade({ closeTime: utc(2026, 1, 6), netProfit: "0" }),
  ];

  it("groups by YYYY-MM, sorted, with profit, count and WR%", () => {
    const m = computeMonthlyReturns(fx, trades);
    expect(m.monthlyData).toEqual([
      { id: "2025-12", year: 2025, month: 12, profit: 25, tradeCount: 1, winRate: 100 },
      { id: "2026-01", year: 2026, month: 1, profit: 80, tradeCount: 3, winRate: (1 / 3) * 100 },
      { id: "2026-02", year: 2026, month: 2, profit: -40, tradeCount: 1, winRate: 0 },
    ]);
    expect(m.years).toEqual([2025, 2026]);
    expect([...m.yearTotals]).toEqual([[2025, 25], [2026, 40]]);
    expect(m.best?.id).toBe("2026-01");
    expect(m.worst?.id).toBe("2026-02");
  });

  it("best is the first of equal maxima, worst the first of equal minima", () => {
    const m = computeMonthlyReturns(fx, [
      fxTrade({ closeTime: utc(2026, 1, 5), netProfit: "10" }),
      fxTrade({ closeTime: utc(2026, 2, 5), netProfit: "10" }),
    ]);
    expect(m.best?.id).toBe("2026-01");
    expect(m.worst?.id).toBe("2026-01");
    expect(computeMonthlyReturns(fx, [])).toEqual({ monthlyData: [], years: [], yearTotals: new Map(), best: null, worst: null });
  });

  it("uses the Dojix display zone for the month", () => {
    const tokyo = createEngineContext({ brand: "dojix", now: 0, local: { tz: "Asia/Tokyo" } });
    const t = fxTrade({ closeTime: utc(2026, 1, 31, 20) }); // 1 Feb in Tokyo
    expect(computeMonthlyReturns(tokyo, [t]).monthlyData[0]?.id).toBe("2026-02");
    expect(computeMonthlyReturns(fx, [t]).monthlyData[0]?.id).toBe("2026-01");
  });

  it("Greenwick: a month-end after-hours trade stays in its ET month (TradingDayTests.swift:166-172)", () => {
    // Fri 31 Jul 2026 18:50 ET = Sat 1 Aug 00:50 in Berlin
    const trade = stTrade({ openTime: etWall(2026, 7, 31, 18, 20), closeTime: etWall(2026, 7, 31, 18, 50), netProfit: "125" });
    for (const tz of ["UTC", "Europe/Berlin", "Asia/Tokyo", "America/Los_Angeles"]) {
      const ctx = createEngineContext({ brand: "greenwick", now: 0, local: { tz } });
      expect(computeMonthlyReturns(ctx, [trade]).monthlyData.map((m) => m.id), tz).toEqual(["2026-07"]);
    }
    const m = computeMonthlyReturns(parityContext("greenwick", 0), [trade]);
    expect(m.best?.id).toBe("2026-07");
    expect(computeMonthlyReturns(parityContext("greenwick", 0), []).best).toBeNull();
  });

  it("registers on the Mac tabs and encodes like the harness", () => {
    const reg = new AnalyticsRegistry().register(monthlyReturnsComponent);
    expect(reg.list("dojix", "overview").map((c) => c.id)).toEqual(["MonthlyReturns"]);
    expect(reg.list("greenwick", "risk").map((c) => c.id)).toEqual(["MonthlyReturns"]);
    expect(reg.run("MonthlyReturns", fx, [])).toBeNull();
    expect((reg.run("MonthlyReturns", fx, trades) as { years: number[] }).years).toEqual([2025, 2026]);
    const m = monthlyReturnsParity.compute(fx, trades.slice(0, 1), undefined)!;
    expect(monthlyReturnsParity.members.monthlyData?.(m, fx)).toEqual([{ id: "2026-02", year: 2026, month: 2, profit: -40, tradeCount: 1, winRate: 0 }]);
    expect(monthlyReturnsParity.members.years?.(m, fx)).toEqual([2026]);
  });

  it("property: counts add up, keys are sorted and nothing is NaN on valid input; hostile money never throws", () => {
    const row = fc.record({
      t: fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2100, 0, 1) }),
      p: fc.integer({ min: -1e9, max: 1e9 }).map((c) => String(c / 100)),
    });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 50 }), fc.constantFrom("dojix", "greenwick" as const), (rows, brand) => {
        const ctx = parityContext(brand, 0);
        const trades = rows.map(({ t, p }) => (brand === "dojix" ? fxTrade({ closeTime: t, netProfit: p }) : stTrade({ closeTime: t, netProfit: p })));
        const m = computeMonthlyReturns(ctx, trades);
        expect(m.monthlyData.reduce((s, x) => s + x.tradeCount, 0)).toBe(trades.length);
        for (let i = 1; i < m.monthlyData.length; i++) expect(m.monthlyData[i - 1]!.id < m.monthlyData[i]!.id).toBe(true);
        for (const x of m.monthlyData) {
          expect(Number.isNaN(x.profit) || Number.isNaN(x.winRate)).toBe(false);
          expect(x.month).toBeGreaterThanOrEqual(1);
          expect(x.month).toBeLessThanOrEqual(12);
        }
      }),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 20 }), (ps) => {
        expect(() => computeMonthlyReturns(fx, ps.map((p) => fxTrade({ netProfit: p })))).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
