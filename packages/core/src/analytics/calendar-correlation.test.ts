import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { Trade } from "../model/trade";
import { etWall, fxTrade, stTrade } from "../test-support/trades";
import {
  calendarCorrelationComponent,
  calendarCorrelationParity,
  computeCalendarCorrelation,
  knownEventsForDate,
  newsCalendar,
  newsDateFields,
} from "./calendar-correlation";

const utc = (y: number, m: number, d: number, h = 12, min = 0) => Date.UTC(y, m - 1, d, h, min);
const fxAt = (open: number, netProfit = "10", extra: Parameters<typeof fxTrade>[0] = {}) =>
  fxTrade({ openTime: open, closeTime: open + 3_600_000, netProfit, ...extra });
const stAt = (open: number, netProfit = "10", extra: Parameters<typeof stTrade>[0] = {}) =>
  stTrade({ openTime: open, closeTime: open + 1_800_000, netProfit, ...extra });

const fxSwift = parityContext("dojix", utc(2026, 12, 31));
const fxFixed = createEngineContext({ brand: "dojix", now: utc(2026, 12, 31), compat: "fixed" });
const stSwift = parityContext("greenwick", utc(2026, 12, 31));
const stFixed = createEngineContext({ brand: "greenwick", now: utc(2026, 12, 31), compat: "fixed" });

describe("CalendarCorrelation heuristics (Dojix)", () => {
  it("finds every Dojix event on its pattern (Sunday-first POSIX weeks, UTC)", () => {
    // Fri 2 Jan 2026: week 1 → NFP; 19:00 → also Friday Close
    expect(knownEventsForDate(fxSwift, utc(2026, 1, 2, 19))).toEqual(["NFP (Non-Farm Payrolls)", "Friday Close"]);
    // Wed 18 Mar: FOMC month, day 15–28
    expect(knownEventsForDate(fxSwift, utc(2026, 3, 18))).toEqual(["FOMC"]);
    // Wed 18 Feb: not an FOMC month
    expect(knownEventsForDate(fxSwift, utc(2026, 2, 18))).toEqual([]);
    // Thu 12 Mar 13:00: ECB (day 7–21, hour 11–15) + BOE (day 1–14, hour 10–14)
    expect(knownEventsForDate(fxSwift, utc(2026, 3, 12, 13))).toEqual(["ECB Rate Decision", "BOE Rate Decision"]);
    // Same Thursday at 16:00: neither hour window
    expect(knownEventsForDate(fxSwift, utc(2026, 3, 12, 16))).toEqual([]);
    // Thu 12 Feb 12:00: BOE month but not ECB
    expect(knownEventsForDate(fxSwift, utc(2026, 2, 12, 12))).toEqual(["BOE Rate Decision"]);
    // Tue 10 Mar: CPI
    expect(knownEventsForDate(fxSwift, utc(2026, 3, 10))).toEqual(["CPI Release"]);
    // Wed 11 Mar: CPI only (FOMC needs day ≥ 15)
    expect(knownEventsForDate(fxSwift, utc(2026, 3, 11))).toEqual(["CPI Release"]);
    // Mon 9 Mar 08:59 → Monday Open; 09:00 → not
    expect(knownEventsForDate(fxSwift, utc(2026, 3, 9, 8, 59))).toEqual(["Monday Open"]);
    expect(knownEventsForDate(fxSwift, utc(2026, 3, 9, 9))).toEqual([]);
    // Fri 13 Mar 17:59 → nothing; 18:00 → Friday Close
    expect(knownEventsForDate(fxSwift, utc(2026, 3, 13, 17, 59))).toEqual([]);
    expect(knownEventsForDate(fxSwift, utc(2026, 3, 13, 18))).toEqual(["Friday Close"]);
  });

  it("swift mode: NFP is weekOfMonth == 1 of the display calendar, so Sun-first weeks miss Fri 7 Aug 2026 (D-19 red)", () => {
    // 1 Aug 2026 is a Saturday: week 1 is that single day, Fri 7 Aug is week 2
    expect(newsDateFields(fxSwift, utc(2026, 8, 7)).weekOfMonth).toBe(2);
    expect(knownEventsForDate(fxSwift, utc(2026, 8, 7))).toEqual([]);
    // D-19 green: the first Friday of the month
    expect(knownEventsForDate(fxFixed, utc(2026, 8, 7))).toEqual(["NFP (Non-Farm Payrolls)"]);
    // …and never the second Friday
    expect(knownEventsForDate(fxFixed, utc(2026, 8, 14))).toEqual([]);
  });

  it("swift mode reads the display zone; fixed mode reads UTC (D-09)", () => {
    const tokyoSwift = createEngineContext({ brand: "dojix", now: 0, compat: "swift", local: { tz: "Asia/Tokyo" } });
    const tokyoFixed = createEngineContext({ brand: "dojix", now: 0, compat: "fixed", local: { tz: "Asia/Tokyo" } });
    // Fri 1 May 2026 20:00 UTC = Sat 2 May 05:00 in Tokyo
    const t = utc(2026, 5, 1, 20);
    expect(knownEventsForDate(tokyoSwift, t)).toEqual([]);
    expect(knownEventsForDate(tokyoFixed, t)).toEqual(["NFP (Non-Farm Payrolls)", "Friday Close"]);
    expect(newsCalendar(tokyoSwift).tz).toBe("Asia/Tokyo");
    expect(newsCalendar(tokyoFixed).tz).toBe("UTC");
  });
});

describe("CalendarCorrelation heuristics (Greenwick, ET)", () => {
  it("has no ECB/BOE and the ET Monday/Friday thresholds", () => {
    // Thu 12 Mar 2026 09:00 ET: the Dojix ECB/BOE pattern, nothing in Greenwick
    expect(knownEventsForDate(stSwift, etWall(2026, 3, 12, 9, 0))).toEqual([]);
    expect(knownEventsForDate(stSwift, etWall(2026, 3, 9, 9, 59))).toEqual(["Monday Open"]);
    expect(knownEventsForDate(stSwift, etWall(2026, 3, 9, 10, 0))).toEqual([]);
    expect(knownEventsForDate(stSwift, etWall(2026, 3, 13, 14, 59))).toEqual([]);
    expect(knownEventsForDate(stSwift, etWall(2026, 3, 13, 15, 0))).toEqual(["Friday Close"]);
    expect(knownEventsForDate(stSwift, etWall(2026, 3, 18, 14, 0))).toEqual(["FOMC"]);
  });

  it("reads ET, not the computer's zone", () => {
    const berlin = createEngineContext({ brand: "greenwick", now: 0, compat: "swift", local: { tz: "Europe/Berlin" } });
    // Fri 13 Mar 2026 19:30 ET is Saturday in Berlin: still a Friday Close
    expect(knownEventsForDate(berlin, etWall(2026, 3, 13, 19, 30))).toEqual(["Friday Close"]);
  });

  it("Monday-first minDays-4 weeks put Fri 1 May 2026 in week 0 (D-19 red → green)", () => {
    const fri = etWall(2026, 5, 1, 9, 0);
    expect(newsDateFields(stSwift, fri).weekOfMonth).toBe(0);
    expect(knownEventsForDate(stSwift, fri)).toEqual([]);
    expect(knownEventsForDate(stFixed, fri)).toEqual(["NFP (Non-Farm Payrolls)"]);
    // A month whose first Friday is in week 1 matches in both modes (Fri 5 Jun 2026)
    expect(knownEventsForDate(stSwift, etWall(2026, 6, 5, 9, 0))).toEqual(["NFP (Non-Farm Payrolls)"]);
    expect(knownEventsForDate(stFixed, etWall(2026, 6, 5, 9, 0))).toEqual(["NFP (Non-Farm Payrolls)"]);
  });
});

describe("CalendarCorrelation analysis", () => {
  const trades: Trade[] = [
    fxAt(utc(2026, 1, 2, 19), "30", { rMultiple: 2 }), // NFP + Friday Close, win
    fxAt(utc(2026, 3, 18), "-10", { rMultiple: -1 }), // FOMC, loss
    fxAt(utc(2026, 3, 18), "0", { rMultiple: 0 }), // FOMC, breakeven (R 0 ignored)
    fxAt(utc(2026, 2, 17), "5", { rMultiple: 0.5 }), // Tue 17 Feb: quiet
    fxAt(utc(2026, 2, 18), "-3", { rMultiple: 0 }), // quiet
  ];

  it("splits event and quiet days and counts each event of a trade", () => {
    const { analysis: a } = computeCalendarCorrelation(fxSwift, trades);
    expect(a.eventDayTrades).toEqual(trades.slice(0, 3));
    expect(a.quietDayTrades).toEqual(trades.slice(3));
    expect([...a.eventBreakdown.keys()]).toEqual(["NFP (Non-Farm Payrolls)", "Friday Close", "FOMC"]);
    expect(a.eventBreakdown.get("FOMC")).toEqual({ count: 2, wins: 0, totalPnL: -10, winRate: 0, avgPnL: -5 });
    expect(a.eventBreakdown.get("Friday Close")).toEqual({ count: 1, wins: 1, totalPnL: 30, winRate: 1, avgPnL: 30 });
    expect(a.eventDayWinRate).toBeCloseTo(1 / 3, 15);
    expect(a.quietDayWinRate).toBe(0.5);
    expect(a.eventDayAvgPnL).toBeCloseTo(20 / 3, 12);
    expect(a.quietDayAvgPnL).toBe(1);
    expect(a.eventDayAvgR).toBe(0.5); // (2 − 1) / 2, R = 0 skipped
    expect(a.quietDayAvgR).toBe(0.5);
  });

  it("builds the top-events list and the insight text", () => {
    const m = computeCalendarCorrelation(fxSwift, trades);
    expect(m.topEvents.map((e) => e.event)).toEqual(["FOMC", "NFP (Non-Farm Payrolls)", "Friday Close"]);
    expect(m.insightText).toBe("You average $5.67 more per trade on event days.");
    const similar = computeCalendarCorrelation(fxSwift, [fxAt(utc(2026, 3, 18), "1"), fxAt(utc(2026, 2, 17), "1.5")]);
    expect(similar.insightText).toBe("Your performance is similar on event and quiet days.");
    const quiet = computeCalendarCorrelation(fxSwift, [fxAt(utc(2026, 3, 18), "-5"), fxAt(utc(2026, 2, 17), "5")]);
    expect(quiet.insightText).toBe("You average $10.00 more per trade on quiet days.");
  });

  it("returns zeros for no trades", () => {
    const { analysis: a } = computeCalendarCorrelation(stSwift, []);
    expect([a.eventDayWinRate, a.quietDayWinRate, a.eventDayAvgPnL, a.quietDayAvgPnL, a.eventDayAvgR, a.quietDayAvgR]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("shows only from 20 trades, in both brands", () => {
    const reg = new AnalyticsRegistry().register(calendarCorrelationComponent);
    expect(reg.list("dojix", "advanced").map((c) => c.id)).toEqual(["CalendarCorrelation"]);
    expect(reg.list("greenwick", "advanced").map((c) => c.id)).toEqual(["CalendarCorrelation"]);
    expect(reg.run("CalendarCorrelation", fxSwift, Array.from({ length: 19 }, () => fxAt(utc(2026, 3, 18))))).toBeNull();
    const twenty = Array.from({ length: 20 }, () => stAt(etWall(2026, 3, 18, 14, 0)));
    const m = reg.run("CalendarCorrelation", stSwift, twenty) as ReturnType<typeof computeCalendarCorrelation>;
    expect(m.analysis.eventBreakdown.get("FOMC")?.count).toBe(20);
  });

  it("encodes the analysis as the harness does (trades as #ticket, stats with computed extras)", () => {
    const t1 = fxAt(utc(2026, 3, 18), "4", { ticket: "11", rMultiple: 1 });
    const t2 = fxAt(utc(2026, 2, 17), "-2", { ticket: "12", rMultiple: 0 });
    const m = calendarCorrelationParity.compute(fxSwift, [t1, t2], undefined);
    expect(m && calendarCorrelationParity.members.analysis?.(m, fxSwift)).toEqual({
      eventDayTrades: ["#11"],
      quietDayTrades: ["#12"],
      eventBreakdown: { FOMC: { count: 1, wins: 1, totalPnL: 4, winRate: 1, avgPnL: 4 } },
      eventDayWinRate: 1,
      quietDayWinRate: 0,
      eventDayAvgPnL: 4,
      quietDayAvgPnL: -2,
      eventDayAvgR: 1,
      quietDayAvgR: 0,
    });
  });
});

const MIN_T = Date.UTC(1990, 0, 1);
const MAX_T = Date.UTC(2100, 0, 1);
const money = fc.integer({ min: -1e9, max: 1e9 }).map((c) => String(c / 100));
const hostileText = fc.oneof(fc.string(), fc.constantFrom("nan", "inf", "1e40000", "", "--1"), money);
const hostileNumber = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, -0));

function noNaN(v: unknown, path = "$"): void {
  if (typeof v === "number") expect(Number.isNaN(v), path).toBe(false);
  else if (v instanceof Map) for (const [k, x] of v) noNaN(x, `${path}.${String(k)}`);
  else if (Array.isArray(v)) v.forEach((x, i) => noNaN(x, `${path}[${i}]`));
  else if (v && typeof v === "object" && !("ticket" in v)) for (const [k, x] of Object.entries(v)) noNaN(x, `${path}.${k}`);
}

describe("CalendarCorrelation properties", () => {
  it("never throws on hostile values and stays NaN-free on valid ones", () => {
    const valid = fc
      .record({ open: fc.integer({ min: MIN_T, max: MAX_T }), p: money, r: fc.double({ min: -1e9, max: 1e9, noNaN: true }) })
      .map(({ open, p, r }) => fxAt(open, p, { rMultiple: r }));
    const hostile = fc
      .record({ open: fc.integer({ min: MIN_T, max: MAX_T }), p: hostileText, r: hostileNumber })
      .map(({ open, p, r }) => fxAt(open, p, { rMultiple: r }));
    fc.assert(
      fc.property(fc.array(valid, { maxLength: 40 }), fc.constantFrom(fxSwift, fxFixed, stSwift), (trades, ctx) => {
        const m = computeCalendarCorrelation(ctx, trades);
        noNaN(m);
        expect(m.analysis.eventDayTrades.length + m.analysis.quietDayTrades.length).toBe(trades.length);
      }),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(fc.array(hostile, { maxLength: 30 }), (trades) => {
        expect(() => computeCalendarCorrelation(fxSwift, trades)).not.toThrow();
        expect(() => computeCalendarCorrelation(fxFixed, trades)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
