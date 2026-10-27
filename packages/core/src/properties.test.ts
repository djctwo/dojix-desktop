// Property tests (fast-check): nothing in the core may crash on hostile input, and nothing may
// produce NaN for input that passed storage validation (SPEC §4.3 limits).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allEdgeConditions, edgeByDay, edgeByHour, edgeBySession } from "./metrics/edges";
import { calculateMetrics, type PortfolioMetrics } from "./metrics/metrics-calculator";
import type { DojixTrade, GreenwickTrade, Trade } from "./model/trade";
import { profitDouble } from "./model/accessors";
import { fxTrade, stTrade } from "./test-support/trades";
import { idiv, irem } from "./swiftcompat/int";
import { SwiftDecimal } from "./swiftcompat/decimal";
import { formatFixed, swiftFormat } from "./swiftcompat/format";
import { swiftRounded } from "./swiftcompat/rounding";
import { etSession, TRADING_CALENDAR, tradingDay } from "./time/us-market";
import { ZonedCalendar } from "./time/zoned-calendar";
import { fxSessionAt } from "./time/fx-sessions";

const MIN_T = Date.UTC(1900, 0, 1);
const MAX_T = Date.UTC(2200, 0, 1);

/** Decimal text within the storage money limit (±1e12), up to 8 decimals. */
const moneyText = fc
  .tuple(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.integer({ min: 0, max: 8 }))
  .map(([units, scale]) => SwiftDecimal.fromParts(units < 0n, units < 0n ? -units : units, -scale - 0).toString())
  .filter((t) => Math.abs(Number(t)) <= 1e12);

const metric = fc.double({ min: -1e9, max: 1e9, noNaN: true });
const instant = fc.integer({ min: MIN_T, max: MAX_T });

const validFx: fc.Arbitrary<DojixTrade> = fc
  .record({
    netProfit: moneyText,
    commission: moneyText,
    swap: moneyText,
    closeTime: instant,
    durationMin: fc.integer({ min: 0, max: 5_270_400 }),
    maePips: fc.option(metric, { nil: null }),
    mfePips: fc.option(metric, { nil: null }),
    rMultiple: metric,
    hour: fc.integer({ min: 0, max: 23 }),
    session: fc.constantFrom("ASIAN", "LONDON", "NY_OVERLAP", "NY", "LATE" as const),
    lots: fc.double({ min: 0, max: 1e6, noNaN: true }),
  })
  .map((r) => fxTrade(r as Partial<DojixTrade>));

const validSt: fc.Arbitrary<GreenwickTrade> = fc
  .record({
    netProfit: moneyText,
    closeTime: instant,
    durationMin: fc.integer({ min: 0, max: 10_519_200 }),
    maePoints: fc.option(metric, { nil: null }),
    mfePoints: fc.option(metric, { nil: null }),
    rMultiple: metric,
    sector: fc.constantFrom("", "Technology", "Energy"),
  })
  .map((r) => stTrade(r));

const hostileText = fc.oneof(
  fc.string(),
  fc.constantFrom("nan", "-nan", "inf", "1e127", "-1e-200", "1e40000", "0e1000", "--1", "1..2", "", " ", "\u0000", "9".repeat(200)),
  moneyText,
);
const hostileNumber = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, -0, Number.MAX_VALUE));

const hostileFx: fc.Arbitrary<Trade> = fc
  .record({
    netProfit: hostileText,
    commission: hostileText,
    swap: hostileText,
    closeTime: fc.integer({ min: -8.64e15, max: 8.64e15 }),
    durationMin: fc.oneof(fc.integer(), fc.constantFrom(2 ** 62, -(2 ** 62))),
    maePips: fc.option(hostileNumber, { nil: null }),
    mfePips: fc.option(hostileNumber, { nil: null }),
    rMultiple: hostileNumber,
    hour: fc.integer({ min: -1000, max: 1000 }),
    dayOfWeek: fc.string(),
    symbol: fc.string(),
  })
  .map((r) => fxTrade(r));

function finiteOrInf(m: PortfolioMetrics): void {
  for (const [k, v] of Object.entries(m)) {
    if (v === null) continue;
    expect(Number.isNaN(v), k).toBe(false);
    if (k !== "profitFactor") expect(Number.isFinite(v), k).toBe(true);
  }
}

describe("metrics never crash and stay finite on valid input", () => {
  it("Dojix", () => {
    fc.assert(
      fc.property(fc.array(validFx, { maxLength: 60 }), fc.constantFrom("swift", "fixed" as const), (trades, compat) => {
        const m = calculateMetrics(trades, { brand: "dojix", compat });
        finiteOrInf(m);
        expect(m.totalTrades).toBe(trades.length);
        expect(m.wins + m.losses).toBeLessThanOrEqual(trades.length);
        expect(m.maxDrawdown).toBeGreaterThanOrEqual(0);
        expect(m.winRate).toBeGreaterThanOrEqual(0);
        expect(m.winRate).toBeLessThanOrEqual(100);
        if (m.profitFactor === Infinity) expect(m.losses).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it("Greenwick, and the breakdowns add up to the total", () => {
    fc.assert(
      fc.property(fc.array(validSt, { minLength: 1, maxLength: 60 }), (trades) => {
        const m = calculateMetrics(trades, { brand: "greenwick", compat: "fixed" });
        finiteOrInf(m);
        for (const edges of [edgeByHour(trades), edgeByDay(trades), edgeBySession(trades)]) {
          expect(edges.reduce((s, e) => s + e.tradeCount, 0)).toBe(trades.length);
          const sum = edges.reduce((s, e) => s + e.profit, 0);
          expect(Math.abs(sum - m.totalProfit)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(m.totalProfit)) + 1e-3);
          for (let i = 1; i < edges.length; i++) expect((edges[i - 1] as { profit: number }).profit).toBeGreaterThanOrEqual((edges[i] as { profit: number }).profit);
        }
        const conditions = allEdgeConditions(trades, 1 + (trades.length % 7), "greenwick");
        for (const c of conditions) {
          expect(Number.isNaN(c.expectancy) || Number.isNaN(c.monthlyImpact) || Number.isNaN(c.winRate)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never throw on hostile rows (values the storage layer would have refused)", () => {
    fc.assert(
      fc.property(fc.array(hostileFx, { maxLength: 30 }), (trades) => {
        expect(() => calculateMetrics(trades, { brand: "dojix", compat: "swift" })).not.toThrow();
        expect(() => calculateMetrics(trades, { brand: "dojix", compat: "fixed" })).not.toThrow();
        expect(() => edgeByHour(trades)).not.toThrow();
        expect(() => edgeBySession(trades)).not.toThrow();
        expect(() => allEdgeConditions(trades, 3, "dojix")).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

describe("Decimal", () => {
  it("parsing never throws and round-trips its canonical text", () => {
    fc.assert(
      fc.property(hostileText, (text) => {
        const d = SwiftDecimal.parse(text);
        if (d === null || d.isNaN) return;
        const again = SwiftDecimal.parse(d.toString());
        expect(again?.compare(d)).toBe(0);
      }),
      { numRuns: 1000 },
    );
  });

  it("Foundation's conversion stays within a few ulps of the nearest double", () => {
    fc.assert(
      fc.property(moneyText, (text) => {
        const d = SwiftDecimal.parse(text) as SwiftDecimal;
        const f = d.toDouble("foundation");
        const n = d.toDouble("nearest");
        expect(Math.abs(f - n)).toBeLessThanOrEqual(Math.abs(n) * 1e-15 + 1e-300);
        expect(Math.sign(f)).toBe(d.sign());
      }),
      { numRuns: 1000 },
    );
  });

  it("adds exactly", () => {
    fc.assert(
      fc.property(moneyText, moneyText, (a, b) => {
        const sum = (SwiftDecimal.parse(a) as SwiftDecimal).add(SwiftDecimal.parse(b) as SwiftDecimal);
        const scale = 10n ** 8n;
        const toUnits = (t: string) => {
          const [i = "0", f = ""] = t.replace("-", "").split(".");
          const v = BigInt(i) * scale + BigInt(f.padEnd(8, "0"));
          return t.startsWith("-") ? -v : v;
        };
        expect(toUnits(sum.toString())).toBe(toUnits(a) + toUnits(b));
      }),
      { numRuns: 500 },
    );
  });
});

describe("numbers and text", () => {
  it("idiv and irem satisfy a = q·b + r with |r| < |b|", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer().filter((b) => b !== 0), (a, b) => {
        const q = idiv(a, b);
        const r = irem(a, b);
        expect(q * b + r).toBe(a);
        expect(Math.abs(r)).toBeLessThan(Math.abs(b));
      }),
    );
  });

  it("swiftRounded moves at most half a unit and breaks ties away from zero", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e15, max: 1e15, noNaN: true }), (x) => {
        const r = swiftRounded(x);
        expect(Number.isInteger(r)).toBe(true);
        expect(Math.abs(r - x)).toBeLessThanOrEqual(0.5);
        if (Math.abs(r - x) === 0.5) expect(Math.abs(r)).toBeGreaterThan(Math.abs(x));
      }),
      { numRuns: 1000 },
    );
  });

  it("formatFixed is within half a unit of the last place and never throws", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e15, max: 1e15 }), fc.integer({ min: 0, max: 10 }), (x, p) => {
        const s = formatFixed(x, p);
        expect(Math.abs(Number(s) - x)).toBeLessThanOrEqual(0.5 * 10 ** -p * (1 + 1e-9) + Math.abs(x) * 1e-15);
        expect(s.startsWith("-")).toBe(x < 0 || Object.is(x, -0));
      }),
      { numRuns: 1000 },
    );
    fc.assert(fc.property(fc.double(), (x) => void swiftFormat("%.2f|%08.3f", x, x)));
  });
});

describe("calendars", () => {
  const zones = ["UTC", "America/New_York", "Europe/Berlin", "Asia/Kolkata", "Australia/Lord_Howe", "America/Santiago", "Pacific/Chatham"];
  const calendar = fc
    .record({
      tz: fc.constantFrom(...zones),
      weekStart: fc.integer({ min: 1, max: 7 }),
      minDaysInFirstWeek: fc.integer({ min: 1, max: 7 }),
    })
    .map((spec) => new ZonedCalendar(spec));

  it("start of day / week / month bracket the instant and are idempotent", () => {
    fc.assert(
      fc.property(calendar, instant, (cal, t) => {
        const sod = cal.startOfDay(t);
        expect(sod).toBeLessThanOrEqual(t);
        expect(cal.isSameDay(sod, t)).toBe(true);
        expect(cal.startOfDay(sod)).toBe(sod);
        expect(cal.startOfWeek(t)).toBeLessThanOrEqual(sod);
        expect(cal.startOfMonth(t)).toBeLessThanOrEqual(sod);
        const w = cal.weekOfYear(t);
        expect(w.weekOfYear).toBeGreaterThanOrEqual(1);
        expect(w.weekOfYear).toBeLessThanOrEqual(53);
        expect(Math.abs(w.yearForWeekOfYear - cal.fields(t).year)).toBeLessThanOrEqual(1);
        const wom = cal.weekOfMonth(t);
        expect(wom).toBeGreaterThanOrEqual(0);
        expect(wom).toBeLessThanOrEqual(6);
      }),
      { numRuns: 500 },
    );
  });

  it("wall fields round-trip and day arithmetic is consistent", () => {
    fc.assert(
      fc.property(calendar, instant, fc.integer({ min: -400, max: 400 }), (cal, t, n) => {
        const f = cal.fields(t);
        const back = cal.fields(cal.instantFromWall(f.year, f.month, f.day, f.hour, f.minute, f.second, f.millisecond));
        expect([back.year, back.month, back.day, back.hour, back.minute]).toEqual([f.year, f.month, f.day, f.hour, f.minute]);
        const later = cal.addDays(t, n);
        expect(cal.daysBetween(t, later)).toBe(n);
      }),
      { numRuns: 500 },
    );
  });

  it("sessions never throw for any storable instant", () => {
    fc.assert(
      fc.property(instant, (t) => {
        expect(["PRE_MARKET", "REGULAR", "AFTER_HOURS", "EXTENDED"]).toContain(etSession(t));
        expect(TRADING_CALENDAR.isSameDay(tradingDay({ closeTime: t }), t)).toBe(true);
        expect(fxSessionAt(t)).toMatch(/^(ASIAN|LONDON|NY_OVERLAP|NY|LATE)$/);
      }),
      { numRuns: 500 },
    );
  });
});

describe("money conversion matches the trade accessor", () => {
  it("profitDouble = Foundation conversion of the text", () => {
    fc.assert(
      fc.property(moneyText, (text) => {
        expect(profitDouble(fxTrade({ netProfit: text }))).toBe((SwiftDecimal.parse(text) as SwiftDecimal).toDouble());
      }),
    );
  });
});
