import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { DojixTrade, GreenwickTrade, Trade } from "../model/trade";
import { etWall, fxTrade, stTrade } from "../test-support/trades";
import {
  behavioralAnalyticsComponent,
  behavioralAnalyticsParity,
  clampedScore,
  computeBehavioralAnalytics,
  type BehaviorReport,
} from "./behavioral-analytics";

const fx = createEngineContext({ brand: "dojix", now: 0 });
const st = createEngineContext({ brand: "greenwick", now: 0 });
const H = 3_600_000;
const BASE = Date.UTC(2026, 0, 5, 0, 0);

/** Trades closing `step` ms apart (ascending), returned in repository order (close descending). */
function series(n: number, step: number, make: (i: number, close: number) => Partial<DojixTrade>): DojixTrade[] {
  const out: DojixTrade[] = [];
  for (let i = 0; i < n; i++) {
    const close = BASE + i * step;
    out.push(fxTrade({ netProfit: "10", lots: 1, closeTime: close, openTime: close - H, ...make(i, close) }));
  }
  return out.reverse();
}

function report(ctx: typeof fx, trades: readonly Trade[]): BehaviorReport {
  const r = computeBehavioralAnalytics(ctx, trades).report;
  if (r === null) throw new Error("expected a report");
  return r;
}

describe("BehavioralAnalytics", () => {
  it("needs 15 trades", () => {
    expect(computeBehavioralAnalytics(fx, series(14, 2 * H, () => ({}))).report).toBeNull();
    expect(computeBehavioralAnalytics(fx, series(15, 2 * H, () => ({}))).report).not.toBeNull();
  });

  it("scores a clean history 100 / A", () => {
    const r = report(fx, series(20, 2 * H, () => ({})));
    expect(r.disciplineScore).toBe(100);
    expect(r.grade).toBe("A");
    expect(r.avgDailyTrades).toBe(10); // 40 h from midnight: 12 + 8 trades on 2 days
    expect(r.dimensions.map((d) => [d.name, d.score, d.detail])).toEqual([
      ["Overtrading", 100, "No overtrading days detected"],
      ["Revenge", 100, "No revenge trades detected"],
      ["Tilt Control", 100, "No tilt episodes detected"],
      ["Size Discipline", 100, "Consistent lot sizing after wins and losses"],
    ]);
    expect(r.dimensions.map((d) => d.icon)).toEqual(["speedometer", "flame", "brain.head.profile", "scalemass"]);
  });

  it("trap: with no loss in the history the 'after a loss' size defaults to 1 (Swift line 101-102)", () => {
    // All wins with 0.1 lots: avgAfterLoss = 1 (empty), avgAfterWin = 0.1 → ratio 10 → score 0.
    const r = report(fx, series(20, 2 * H, () => ({ lots: 0.1 })));
    expect(r.sizeEscalation).toBeCloseTo(10, 12);
    expect(r.dimensions[3]?.score).toBe(0);
    expect(r.disciplineScore).toBe(75);
  });

  it("flags overtrading days above max(2 × average, 5)", () => {
    // 10 trades on one day, then 10 single-trade days: avg 20/11, threshold 5.
    const trades = series(20, 0, (i) => {
      const close = i < 10 ? BASE + i * 10 * 60_000 : BASE + (i - 9) * 24 * H;
      return { closeTime: close, openTime: close - H };
    });
    const r = report(fx, trades);
    expect(r.overtradingDays).toBe(1);
    expect(r.overtradingDaysPnL).toBe(100);
    expect(r.dimensions[0]).toMatchObject({ score: 75, detail: "1 day with 2× avg volume ($100.00 P&L)" });
    expect(r.disciplineScore).toBe(93); // (75 + 300) / 4, integer division
    expect(r.grade).toBe("A");
  });

  it("counts revenge entries 0–600 s after a loss closes", () => {
    const at = (gapS: number) =>
      series(20, 2 * H, (i, close) =>
        i === 5 ? { netProfit: "-10" } : i === 6 ? { openTime: close - 2 * H + gapS * 1000 } : {},
      );
    const r = report(fx, at(600));
    expect(r.revengeTrades).toBe(1);
    expect(r.revengeWinRate).toBe(1);
    expect(r.revengePnL).toBe(10);
    // 1/20 = 5 % → 100 − 50 = 50
    expect(r.dimensions[1]).toMatchObject({ score: 50, detail: "1 trades within 10m of a loss (100% WR, $10.00)" });
    expect(r.disciplineScore).toBe(87);
    expect(report(fx, at(601)).revengeTrades).toBe(0);
    expect(report(fx, at(0)).revengeTrades).toBe(1);
    expect(report(fx, at(-1)).revengeTrades).toBe(0);
  });

  it("detects tilt (≥ 3 losses closing within 60 min), capped at n/5", () => {
    const trades = series(15, 20 * 60_000, (i) => (i < 4 ? { netProfit: "-10" } : {}));
    const r = report(fx, trades);
    expect(r.tiltEvents).toBe(2);
    expect(r.dimensions[2]).toMatchObject({ score: 60, detail: "2 tilt events (3+ losses in 1hr)" });
    expect(r.disciplineScore).toBe(90);
    // 15 losses in a row 1 min apart: 13 raw events, capped at 15/5 = 3
    const capped = report(fx, series(15, 60_000, () => ({ netProfit: "-1" })));
    expect(capped.tiltEvents).toBe(3);
    expect(capped.dimensions[2]?.score).toBe(40);
  });

  it("grades size escalation after losses (breakevens count as losses)", () => {
    // Alternating win / loss: sizes after a win are the odd trades, after a loss the even ones.
    const alt = (afterWin: number, afterLoss: number) =>
      series(16, 2 * H, (i) => ({ netProfit: i % 2 === 0 ? "10" : "-10", lots: i % 2 === 1 ? afterWin : afterLoss }));
    const sizeOf = (r: BehaviorReport) => r.dimensions[3];
    expect(sizeOf(report(fx, alt(2, 2.1)))?.score).toBe(100); // 1.05
    expect(sizeOf(report(fx, alt(2, 2.4)))?.score).toBe(75); // 1.2
    expect(sizeOf(report(fx, alt(2, 3)))).toMatchObject({ score: 50, detail: "Lots 50% larger after losses — emotional sizing" });
    expect(sizeOf(report(fx, alt(2, 4)))?.score).toBe(20); // 100 − 80
    expect(sizeOf(report(fx, alt(1, 10)))?.score).toBe(0); // max(0, Int(−620))
    // A breakeven before a trade puts it on the "after loss" side.
    const be = series(16, 2 * H, (i) => ({ netProfit: i % 2 === 0 ? "0" : "10", lots: i % 2 === 1 ? 3 : 2 }));
    expect(report(fx, be).sizeEscalation).toBe(1.5);
  });

  it("Greenwick: ET trading days, shares, clampedScore", () => {
    // Two trades on the same ET day (one after 20:00 ET, already the next UTC day).
    const mk = (i: number): GreenwickTrade => {
      const close = i === 0 ? etWall(2026, 10, 23, 20, 30) : etWall(2026, 10, 23, 10, 0) - (i - 1) * 24 * H;
      return stTrade({ netProfit: "5", closeTime: close, openTime: close - H });
    };
    const trades = Array.from({ length: 15 }, (_, i) => mk(i));
    const r = report(st, trades);
    expect(r.avgDailyTrades).toBe(15 / 14);
    expect(report(fx, trades).avgDailyTrades).toBe(1); // in UTC the 20:30 ET close is the next day
    const alt = Array.from({ length: 16 }, (_, i) =>
      stTrade({ netProfit: i % 2 === 0 ? "10" : "-10", closeTime: BASE + i * 2 * H, openTime: BASE + i * 2 * H - H, shares: i % 2 === 1 ? 100 : 300 }),
    );
    expect(report(st, alt).dimensions[3]).toMatchObject({
      score: 0,
      detail: "Shares 200% larger after losses — emotional sizing",
    });
    const flat = Array.from({ length: 15 }, (_, i) => stTrade({ netProfit: "1", closeTime: BASE + i * 2 * H, openTime: BASE + i * 2 * H - H }));
    expect(report(st, flat).dimensions[3]?.detail).toBe("Consistent position sizing after wins and losses");
  });

  it("clampedScore maps non-finite and out-of-range values (Greenwick line 33-36)", () => {
    expect(clampedScore(Infinity)).toBe(100);
    expect(clampedScore(-Infinity)).toBe(0);
    expect(clampedScore(NaN)).toBe(0);
    expect(clampedScore(150)).toBe(100);
    expect(clampedScore(-3)).toBe(0);
    expect(clampedScore(42.9)).toBe(42);
    expect(Object.is(clampedScore(-0), 0)).toBe(true);
  });

  // Dojix AnalyticsClampTests.swift:25-43
  it("survives extreme lot ratios (Dojix testBehavioralScoreWithExtremeLotRatio)", () => {
    const trades = Array.from({ length: 30 }, (_, i) => {
      const win = i % 2 === 0;
      const close = 1_767_225_600_000 + i * 7_200_000;
      return fxTrade({ ticket: String(i), lots: win ? 1e-15 : 1_000_000, netProfit: win ? "10" : "-10", closeTime: close, openTime: close - H });
    });
    const r = report(fx, trades);
    expect(r.disciplineScore).toBeGreaterThanOrEqual(0);
    expect(r.disciplineScore).toBeLessThanOrEqual(100);
    const zeroed = trades.map((t) => (t.lots < 1 ? { ...t, lots: 0 } : t));
    expect(computeBehavioralAnalytics(fx, zeroed).report).not.toBeNull();
  });

  // Greenwick HostileValueTests.swift:36-52
  it("survives crafted share sizes (Greenwick testCraftedShareSizesDoNotCrashTheRiskTab)", () => {
    const trades = Array.from({ length: 20 }, (_, i) => {
      const open = 1_772_000_000_000 + i * 3_600_000;
      return stTrade({
        ticket: String(5_000_000 + i),
        netProfit: i % 2 === 0 ? "10" : "-10",
        shares: i % 2 === 0 ? 1e9 : 1e-12,
        openTime: open,
        closeTime: open + 1_800_000,
      });
    });
    const r = computeBehavioralAnalytics(st, trades).report;
    expect(r).not.toBeNull();
    expect(r?.disciplineScore).toBeGreaterThanOrEqual(0);
    expect(r?.disciplineScore).toBeLessThanOrEqual(100);
    for (const d of r?.dimensions ?? []) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
    }
  });

  it("is registered on the Risk tab of both brands and encodes the report", () => {
    const reg = new AnalyticsRegistry().register(behavioralAnalyticsComponent);
    expect(reg.list("dojix", "risk").map((c) => c.id)).toEqual(["BehavioralAnalytics"]);
    expect(reg.list("greenwick", "risk").map((c) => c.id)).toEqual(["BehavioralAnalytics"]);
    expect(reg.run("BehavioralAnalytics", fx, series(14, H, () => ({})))).toBeNull();
    const trades = series(15, 2 * H, () => ({}));
    expect(reg.run("BehavioralAnalytics", fx, trades)).toMatchObject({ disciplineScore: 100 });
    const m = behavioralAnalyticsParity.compute(fx, trades, undefined);
    const enc = m && (behavioralAnalyticsParity.members.report?.(m, fx) as Record<string, unknown>);
    expect(Object.keys(enc ?? {}).sort()).toEqual([
      "avgDailyTrades",
      "dimensions",
      "disciplineScore",
      "grade",
      "overtradingDays",
      "overtradingDaysPnL",
      "revengePnL",
      "revengeTrades",
      "revengeWinRate",
      "sizeEscalation",
      "tiltEvents",
    ]);
    expect((enc?.dimensions as unknown[])[0]).toEqual({ name: "Overtrading", score: 100, detail: "No overtrading days detected", icon: "speedometer" });
    const empty = behavioralAnalyticsParity.compute(fx, [], undefined);
    expect(empty && behavioralAnalyticsParity.members.report?.(empty, fx)).toBeNull();
  });

  it("never throws, and scores stay within 0–100 (property)", () => {
    const money = fc.integer({ min: -1_000_000, max: 1_000_000 }).map((c) => String(c / 100));
    const size = fc.oneof(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.constantFrom(0, 1e-15, 1e12));
    const arb = fc.array(
      fc.record({ p: money, gapMin: fc.integer({ min: 0, max: 3000 }), lots: size, dur: fc.integer({ min: 0, max: 600 }) }),
      { minLength: 15, maxLength: 40 },
    );
    fc.assert(
      fc.property(arb, fc.boolean(), (rows, greenwick) => {
        let close = BASE;
        const trades: Trade[] = rows.map((r) => {
          close += r.gapMin * 60_000;
          const common = { netProfit: r.p, closeTime: close, openTime: close - r.dur * 60_000 };
          return greenwick ? stTrade({ ...common, shares: r.lots }) : fxTrade({ ...common, lots: r.lots });
        });
        const rep = report(greenwick ? st : fx, trades);
        expect(rep.disciplineScore).toBeGreaterThanOrEqual(0);
        expect(rep.disciplineScore).toBeLessThanOrEqual(100);
        for (const d of rep.dimensions) expect(d.score >= 0 && d.score <= 100).toBe(true);
        for (const v of [rep.overtradingDaysPnL, rep.revengePnL, rep.revengeWinRate, rep.avgDailyTrades]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        // sizeEscalation may be +∞ or NaN on the Mac too (tiny sizes after wins); never thrown.
      }),
      { numRuns: 150 },
    );
    // Hostile values: NaN / ∞ sizes and times must not throw.
    const hostile = series(15, H, (i) => ({ lots: i % 3 === 0 ? NaN : i % 3 === 1 ? Infinity : -1, netProfit: i % 2 ? "-1e12" : "1e12" }));
    expect(() => computeBehavioralAnalytics(fx, hostile)).not.toThrow();
  });
});
