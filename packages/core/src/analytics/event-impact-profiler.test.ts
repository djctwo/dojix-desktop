import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { DojixTrade, GreenwickTrade } from "../model/trade";
import { etWall, fxTrade, stTrade } from "../test-support/trades";
import {
  computeEventImpactProfiler,
  eventImpactProfilerComponent,
  eventImpactProfilerParity,
  eventTradingMonths,
  eventTypesFor,
  matchesEvent,
} from "./event-impact-profiler";

const utc = (y: number, m: number, d: number, h = 12, min = 0) => Date.UTC(y, m - 1, d, h, min);
const NOW = utc(2026, 12, 31);
const fxSwift = parityContext("dojix", NOW);
const fxFixed = createEngineContext({ brand: "dojix", now: NOW, compat: "fixed" });
const stSwift = parityContext("greenwick", NOW);
const stFixed = createEngineContext({ brand: "greenwick", now: NOW, compat: "fixed" });

const fxAt = (open: number, netProfit: string, extra: Partial<DojixTrade> = {}) =>
  fxTrade({ openTime: open, closeTime: open + 3_600_000, netProfit, ...extra });
const stAt = (open: number, netProfit: string, extra: Partial<GreenwickTrade> = {}) =>
  stTrade({ openTime: open, closeTime: open + 1_800_000, netProfit, ...extra });

// First Fridays of 2026 that are weekOfMonth 1 in Sunday-first, minDays-1 weeks (not Aug 7).
const NFP_DAYS: [number, number][] = [[1, 2], [2, 6], [3, 6], [4, 3], [5, 1], [6, 5], [7, 3], [9, 4], [10, 2], [11, 6]];
// FOMC-pattern Wednesdays (months {1,3,5,6,7}, day 15–28).
const FOMC_DAYS: [number, number][] = [[1, 21], [1, 28], [3, 18], [3, 25], [5, 20], [5, 27], [6, 17], [6, 24], [7, 15], [7, 22]];

const nfpTrades = () =>
  NFP_DAYS.map(([m, d], i) =>
    fxAt(utc(2026, m, d, 13), i < 8 ? "20" : "-10", {
      // stored hours: 3 pre (11, 12), 4 during (13, 14), 3 post (15, 16)
      hour: [11, 12, 12, 13, 13, 14, 14, 15, 16, 16][i] as number,
      rMultiple: i < 8 ? 1 : 0,
      symbol: i % 2 === 0 ? "EURUSD" : "USDJPY",
    }),
  );
const fomcLosers = (profit = "-5") => FOMC_DAYS.map(([m, d]) => fxAt(utc(2026, m, d, 19), profit, { hour: 19, symbol: "EURUSD" }));

describe("EventImpactProfiler event matching", () => {
  const fx = (c: string) => eventTypesFor("dojix").find((e) => e.caseName === c)!;
  const st = (c: string) => eventTypesFor("greenwick").find((e) => e.caseName === c)!;

  it("lists the Mac's event types per brand", () => {
    expect(eventTypesFor("dojix").map((e) => e.rawValue)).toEqual(["NFP", "FOMC", "CPI", "ECB", "BOE", "Mon Open", "Fri Close"]);
    expect(eventTypesFor("greenwick").map((e) => e.rawValue)).toEqual(["NFP", "FOMC", "CPI", "Earnings", "Jobs Report", "Mon Open", "Fri Close"]);
    expect(eventTypesFor("dojix").map((e) => e.typicalHour)).toEqual([13, 19, 13, 12, 12, 0, 21]);
    expect(eventTypesFor("greenwick").map((e) => e.typicalHour)).toEqual([8, 14, 8, 16, 8, 9, 15]);
  });

  it("matches the Dojix patterns", () => {
    const at = (t: number) => fxAt(t, "1");
    expect(matchesEvent(fxSwift, at(utc(2026, 1, 2)), fx("nfp"))).toBe(true);
    expect(matchesEvent(fxSwift, at(utc(2026, 1, 9)), fx("nfp"))).toBe(false);
    expect(matchesEvent(fxSwift, at(utc(2026, 3, 18)), fx("fomc"))).toBe(true);
    expect(matchesEvent(fxSwift, at(utc(2026, 3, 11)), fx("cpi"))).toBe(true);
    expect(matchesEvent(fxSwift, at(utc(2026, 3, 12, 11)), fx("ecb"))).toBe(true);
    expect(matchesEvent(fxSwift, at(utc(2026, 3, 12, 10)), fx("ecb"))).toBe(false);
    expect(matchesEvent(fxSwift, at(utc(2026, 3, 12, 10)), fx("boe"))).toBe(true);
    expect(matchesEvent(fxSwift, at(utc(2026, 3, 19, 12)), fx("boe"))).toBe(false); // day 19 > 14
    expect(matchesEvent(fxSwift, at(utc(2026, 3, 9, 8)), fx("mondayOpen"))).toBe(true);
    expect(matchesEvent(fxSwift, at(utc(2026, 3, 13, 18)), fx("fridayClose"))).toBe(true);
    expect(matchesEvent(fxSwift, at(utc(2026, 3, 13, 17)), fx("fridayClose"))).toBe(false);
  });

  it("matches Greenwick's Earnings and Jobs Report in ET; D-19 finds the week-0 Friday", () => {
    expect(matchesEvent(stSwift, stAt(etWall(2026, 3, 10, 16, 30), "1"), st("earnings"))).toBe(true);
    expect(matchesEvent(stSwift, stAt(etWall(2026, 3, 10, 19, 0), "1"), st("earnings"))).toBe(false);
    expect(matchesEvent(stSwift, stAt(etWall(2026, 6, 5, 8, 30), "1"), st("jobsReport"))).toBe(true);
    expect(matchesEvent(stSwift, stAt(etWall(2026, 6, 5, 15, 0), "1"), st("jobsReport"))).toBe(false);
    // Fri 1 May 2026 is week 0 in Monday/minDays-4 weeks: missed on the Mac, found in fixed mode
    const may1 = stAt(etWall(2026, 5, 1, 8, 30), "1");
    expect(matchesEvent(stSwift, may1, st("jobsReport"))).toBe(false);
    expect(matchesEvent(stSwift, may1, st("nfp"))).toBe(false);
    expect(matchesEvent(stFixed, may1, st("jobsReport"))).toBe(true);
    expect(matchesEvent(stFixed, may1, st("nfp"))).toBe(true);
    // Mon Open / Fri Close keep the Dojix thresholds in the profiler (hour < 9, ≥ 18)
    expect(matchesEvent(stSwift, stAt(etWall(2026, 3, 9, 9, 30), "1"), st("mondayOpen"))).toBe(false);
    expect(matchesEvent(stSwift, stAt(etWall(2026, 3, 13, 18, 0), "1"), st("fridayClose"))).toBe(true);
  });

  it("D-09: Dojix fixed mode matches in UTC, swift mode in the display zone", () => {
    const nySwift = createEngineContext({ brand: "dojix", now: NOW, compat: "swift", local: { tz: "America/New_York" } });
    const nyFixed = createEngineContext({ brand: "dojix", now: NOW, compat: "fixed", local: { tz: "America/New_York" } });
    // Fri 2 Jan 2026 03:00 UTC = Thu 1 Jan 22:00 in New York
    const t = fxAt(utc(2026, 1, 2, 3), "1");
    expect(matchesEvent(nySwift, t, fx("nfp"))).toBe(false);
    expect(matchesEvent(nyFixed, t, fx("nfp"))).toBe(true);
    // D-19 (Dojix): Fri 7 Aug 2026 is week 2 in Sunday-first weeks
    expect(matchesEvent(fxSwift, fxAt(utc(2026, 8, 7), "1"), fx("nfp"))).toBe(false);
    expect(matchesEvent(fxFixed, fxAt(utc(2026, 8, 7), "1"), fx("nfp"))).toBe(true);
  });
});

describe("EventImpactProfiler results", () => {
  it("profiles NFP: WRf, PF, avg R (R ≠ 0), timing windows on the stored hour, TRADE", () => {
    const m = computeEventImpactProfiler(fxSwift, nfpTrades());
    expect(m.results).toHaveLength(1);
    const r = m.results[0]!;
    expect(r.eventType.rawValue).toBe("NFP");
    expect(r.trades).toHaveLength(10);
    expect(r.winRate).toBe(0.8);
    expect(r.totalPnL).toBe(140);
    expect(r.avgPnL).toBe(14);
    expect(r.avgR).toBe(1);
    expect(r.profitFactor).toBe(8);
    expect(r.recommendation).toBe("TRADE");
    expect(r.preTrades.map((t) => t.hour)).toEqual([11, 12, 12]);
    expect(r.duringTrades.map((t) => t.hour)).toEqual([13, 13, 14, 14]);
    expect(r.postTrades.map((t) => t.hour)).toEqual([15, 16, 16]);
    expect(m.timing.pre).toEqual({ count: 3, winRate: 1, avgPnL: 20 });
    expect(m.timing.post.count).toBe(3);
    expect(m.eventTradeCount).toBe(10);
    expect(m.insightText).toBe("Best event: NFP — 80% WR, $+14.00 avg per trade.");
  });

  it("AVOID below .4 WR, CAUTION below 10 matches, PF 99 with no losses, sorted by count", () => {
    const cpi = [fxAt(utc(2026, 2, 10), "3"), fxAt(utc(2026, 3, 10), "4"), fxAt(utc(2026, 3, 11), "5")];
    const m = computeEventImpactProfiler(fxSwift, [...cpi, ...fomcLosers()]);
    expect(m.results.map((r) => r.eventType.rawValue)).toEqual(["FOMC", "CPI"]);
    const [fomc, c] = m.results;
    expect(fomc?.recommendation).toBe("AVOID");
    expect(fomc?.profitFactor).toBe(0);
    expect(c?.profitFactor).toBe(99);
    expect(c?.recommendation).toBe("CAUTION");
    expect(c?.avgR).toBe(1);
  });

  it("CAUTION between the bands; ties keep allCases order; fewer than 3 matches are dropped", () => {
    // 10 FOMC trades: 5 wins of 10 (WR .5) with PF 1 → CAUTION
    const mixed = FOMC_DAYS.map(([mo, d], i) => fxAt(utc(2026, mo, d, 19), i < 5 ? "10" : "-10"));
    expect(computeEventImpactProfiler(fxSwift, mixed).results[0]?.recommendation).toBe("CAUTION");
    const three = (t: number) => [fxAt(t, "1"), fxAt(t, "1"), fxAt(t, "1")];
    const tie = computeEventImpactProfiler(fxSwift, [...three(utc(2026, 3, 13, 18)), ...three(utc(2026, 3, 9, 8)), fxAt(utc(2026, 3, 18), "1")]);
    expect(tie.results.map((r) => r.eventType.caseName)).toEqual(["mondayOpen", "fridayClose"]);
  });

  it("counts trading months from the earliest open on the local calendar, at least 1", () => {
    expect(eventTradingMonths(fxSwift, [])).toBe(1);
    const ctx = createEngineContext({ brand: "greenwick", now: utc(2026, 4, 1), compat: "swift", local: { tz: "Europe/Berlin" } });
    expect(eventTradingMonths(ctx, [stAt(utc(2026, 2, 1), "1"), stAt(utc(2026, 1, 1), "1")])).toBe(3); // 90 days
    expect(eventTradingMonths(ctx, [stAt(utc(2026, 3, 20), "1")])).toBe(1);
    expect(eventTradingMonths(ctx, [stAt(utc(2026, 6, 1), "1")])).toBe(1); // future: negative days
  });

  it("insight: skipping the worst event (≥ 10 trades) with the monthly cost", () => {
    const ctx = parityContext("dojix", utc(2026, 7, 21)); // 200 days after 2 Jan → 6 months
    const m = computeEventImpactProfiler(ctx, [...nfpTrades(), ...fomcLosers()]);
    expect(m.tradingMonths).toBe(6);
    expect(m.insightText).toBe("Skipping FOMC could save ~$8/month (10 trades at $-5.00 avg).");
    const few = computeEventImpactProfiler(fxSwift, fomcLosers().slice(0, 6));
    expect(few.insightText).toBe("Need more event-day trades for a recommendation. Keep trading and check back.");
  });

  it("insight picks the first lowest / last highest average among events with ≥ 5 trades", () => {
    const cpiDays = [[2, 10], [3, 10], [3, 11], [11, 10], [11, 11]] as const;
    const cpi = (p: string) => cpiDays.map(([mo, d]) => fxAt(utc(2026, mo, d), p));
    // FOMC −5 avg (10 trades) vs CPI −50 avg (5 trades): the worst is CPI, but it has < 10 trades → best branch
    const m = computeEventImpactProfiler(fxSwift, [...fomcLosers("-5"), ...cpi("-50"), ...nfpTrades()]);
    expect(m.insightText).toBe("Best event: NFP — 80% WR, $+14.00 avg per trade.");
    // Two winners with the same average: max(by:) keeps the last one (CPI after NFP in count order)
    const n = computeEventImpactProfiler(fxSwift, [...NFP_DAYS.slice(0, 5).map(([mo, d]) => fxAt(utc(2026, mo, d, 13), "7")), ...cpi("7")]);
    expect(n.results.map((r) => r.eventType.rawValue)).toEqual(["NFP", "CPI"]);
    expect(n.insightText).toBe("Best event: CPI — 100% WR, $+7.00 avg per trade.");
  });

  it("compares event vs quiet days and builds the symbol-impact rows", () => {
    const quiet = [fxAt(utc(2026, 2, 17), "-1", { symbol: "EURUSD" }), fxAt(utc(2026, 2, 18), "-1", { symbol: "EURUSD" })];
    const m = computeEventImpactProfiler(fxSwift, [...nfpTrades(), ...quiet]);
    expect(m.quietStats).toEqual({ count: 2, winRate: 0, avgPnL: -1 });
    expect(m.eventStats.count).toBe(10);
    // EURUSD: 5 event trades (4 wins) vs 7 overall (4 wins); USDJPY: 5 event, 4 wins of 5 overall
    expect(m.symbolImpact.map((r) => r.symbol)).toEqual(["EURUSD", "USDJPY"]);
    expect(m.symbolImpact[0]).toMatchObject({ count: 5, eventWR: 0.8 });
    expect(m.symbolImpact[0]?.delta).toBeCloseTo(0.8 - 4 / 7, 15);
    expect(m.symbolImpact[1]?.delta).toBe(0);
  });

  it("shows from 30 trades in both brands", () => {
    const reg = new AnalyticsRegistry().register(eventImpactProfilerComponent);
    expect(reg.list("greenwick", "advanced").map((c) => c.id)).toEqual(["EventImpactProfiler"]);
    expect(reg.run("EventImpactProfiler", fxSwift, nfpTrades())).toBeNull();
    const thirty = [...nfpTrades(), ...nfpTrades(), ...nfpTrades()];
    expect((reg.run("EventImpactProfiler", fxSwift, thirty) as { results: unknown[] }).results).toHaveLength(1);
  });

  it("encodes results like the harness (RefDumpable EventType, raw recommendation)", () => {
    const trades = [fxAt(utc(2026, 2, 10), "3", { ticket: "1", hour: 11 }), fxAt(utc(2026, 3, 10), "4", { ticket: "2", hour: 13 }), fxAt(utc(2026, 3, 11), "5", { ticket: "3", hour: 16 })];
    const m = eventImpactProfilerParity.compute(fxSwift, trades, undefined)!;
    expect(eventImpactProfilerParity.members.results?.(m, fxSwift)).toEqual([
      {
        eventType: { $case: "cpi", $raw: "CPI", icon: "chart.line.uptrend.xyaxis", typicalHourUTC: 13, affectedCurrencies: ["USD"] },
        trades: ["#1", "#2", "#3"],
        winRate: 1,
        avgPnL: 4,
        avgR: 1,
        totalPnL: 12,
        profitFactor: 99,
        recommendation: "CAUTION",
        preTrades: ["#1"],
        duringTrades: ["#2"],
        postTrades: ["#3"],
      },
    ]);
    expect(eventImpactProfilerParity.members.tradingMonths?.(m, fxSwift)).toBe(10); // 10 Feb → 31 Dec = 324 days
    const st = [0, 1, 2].map((i) => stAt(etWall(2026, 3, 10 + i, 16, 30), "1", { ticket: String(10 + i), hour: 16 }));
    const sm = eventImpactProfilerParity.compute(stSwift, st, undefined)!;
    const enc = eventImpactProfilerParity.members.results?.(sm, stSwift) as { eventType: unknown }[];
    expect(enc[0]?.eventType).toEqual({ $case: "earnings", $raw: "Earnings", icon: "doc.text.fill", typicalHourET: 16, affectedSectors: ["Reporting"] });
  });
});

describe("EventImpactProfiler properties", () => {
  const money = fc.integer({ min: -1e9, max: 1e9 }).map((c) => String(c / 100));
  const open = fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2100, 0, 1) });
  function noNaN(v: unknown, path = "$"): void {
    if (typeof v === "number") expect(Number.isNaN(v), path).toBe(false);
    else if (Array.isArray(v)) v.forEach((x, i) => noNaN(x, `${path}[${i}]`));
    else if (v && typeof v === "object" && !("ticket" in v)) for (const [k, x] of Object.entries(v)) noNaN(x, `${path}.${k}`);
  }

  it("stays NaN-free on valid trades and never throws on hostile values", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ o: open, p: money, h: fc.integer({ min: 0, max: 23 }) }), { maxLength: 40 }),
        fc.constantFrom(fxSwift, fxFixed, stSwift, stFixed),
        (rows, ctx) => {
          const trades = rows.map(({ o, p, h }) => (ctx.brand === "dojix" ? fxAt(o, p, { hour: h }) : stAt(o, p, { hour: h })));
          const m = computeEventImpactProfiler(ctx, trades);
          noNaN(m);
          for (const r of m.results) {
            expect(r.trades.length).toBeGreaterThanOrEqual(3);
            expect(r.winRate).toBeGreaterThanOrEqual(0);
            expect(r.winRate).toBeLessThanOrEqual(1);
          }
          expect(m.tradingMonths).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(
        fc.array(fc.record({ o: open, p: fc.string(), h: fc.integer(), r: fc.double() }), { maxLength: 30 }),
        (rows) => {
          const trades = rows.map(({ o, p, h, r }) => fxAt(o, p, { hour: h, rMultiple: r }));
          expect(() => computeEventImpactProfiler(fxSwift, trades)).not.toThrow();
          expect(() => computeEventImpactProfiler(fxFixed, trades)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});
