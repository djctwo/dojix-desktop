// Property tests for the E2 components (fast-check): valid journals never produce NaN or ±∞
// (except the profit-factor sentinels), hostile rows never throw, and a few invariants hold.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BrandId } from "../brand";
import { createEngineContext, type EngineContext } from "../engine/context";
import type { DojixTrade, GreenwickTrade, Trade } from "../model/trade";
import { SwiftDecimal } from "../swiftcompat/decimal";
import { fxTrade, stTrade } from "../test-support/trades";
import { dayOfWeekChart } from "./day-of-week";
import { directionalEdge } from "./directional-edge";
import { durationAnalysis } from "./duration-analysis";
import { hourlyPnL } from "./hourly-pnl";
import { killZoneOptimizer } from "./kill-zone";
import { maeMfeChart } from "./mae-mfe";
import { performanceSummary } from "./performance-summary";
import { periodComparison } from "./period-comparison";
import { rMultipleChart } from "./r-multiple";
import { sequenceAnalysis } from "./sequence-analysis";
import { sessionHeatmap } from "./session-heatmap";
import { sessionIntelligence } from "./session-intelligence";
import { sessionRanking } from "./session-ranking";
import { sizeAnalysis } from "./size-analysis";
import { slippageAnalysis } from "./slippage";
import { streakCard } from "./streak-card";
import { streakTimeline } from "./streak-timeline";
import { symbolAnalytics } from "./symbol-analytics";
import { tradeCalendar } from "./trade-calendar";
import { tradeTimeHeatmap } from "./trade-time-heatmap";
import { weeklyHeatmap } from "./weekly-heatmap";
import { whatToCut } from "./what-to-cut";
import { winLossDistribution } from "./win-loss-distribution";

const COMPUTES: readonly [string, (ctx: EngineContext, trades: readonly Trade[]) => unknown][] = [
  ["hourlyPnL", hourlyPnL],
  ["durationAnalysis", durationAnalysis],
  ["dayOfWeekChart", dayOfWeekChart],
  ["tradeTimeHeatmap", tradeTimeHeatmap],
  ["tradeCalendar", (c, t) => tradeCalendar(c, t, t[0]?.closeTime ?? c.now)],
  ["weeklyHeatmap", weeklyHeatmap],
  ["rMultipleChart", rMultipleChart],
  ["performanceSummary", performanceSummary],
  ["streakTimeline", streakTimeline],
  ["sessionHeatmap", sessionHeatmap],
  ["sessionIntelligence", sessionIntelligence],
  ["sequenceAnalysis", sequenceAnalysis],
  ["whatToCut", whatToCut],
  ["killZoneOptimizer", killZoneOptimizer],
  ["periodComparison", periodComparison],
  ["periodComparison(week)", (c, t) => periodComparison(c, t, "week")],
  ["sizeAnalysis", sizeAnalysis],
  ["winLossDistribution", winLossDistribution],
  ["slippageAnalysis", slippageAnalysis],
  ["maeMfeChart", maeMfeChart],
  ["symbolAnalytics", symbolAnalytics],
  ["directionalEdge", directionalEdge],
  ["sessionRanking", sessionRanking],
  ["streakCard", streakCard],
];

const MIN_T = Date.UTC(1990, 0, 1);
const MAX_T = Date.UTC(2100, 0, 1);
const NOW = Date.UTC(2026, 9, 21, 12);

const moneyText = fc
  .tuple(fc.bigInt({ min: -(10n ** 17n), max: 10n ** 17n }), fc.integer({ min: 0, max: 6 }))
  .map(([units, scale]) => SwiftDecimal.fromParts(units < 0n, units < 0n ? -units : units, -scale).toString());
/** Pips / points / R to 0.01, as imports store them. */
const metric = fc.integer({ min: -100_000_000, max: 100_000_000 }).map((x) => x / 100);
const closeTime = fc.oneof(fc.integer({ min: MIN_T, max: MAX_T }), fc.integer({ min: NOW - 200 * 86_400_000, max: NOW + 86_400_000 }));
const common = {
  netProfit: moneyText,
  closeTime,
  durationMin: fc.integer({ min: 0, max: 100_000 }),
  rMultiple: metric,
  hour: fc.integer({ min: 0, max: 23 }),
  direction: fc.constantFrom("BUY" as const, "SELL" as const),
  dayOfWeek: fc.constantFrom("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"),
  symbol: fc.constantFrom("EURUSD", "GBPUSD", "USDJPY", "FICT"),
};

const validFx: fc.Arbitrary<Trade> = fc
  .record({
    ...common,
    lots: fc.double({ min: 0.01, max: 1000, noNaN: true }),
    maePips: fc.option(metric, { nil: null }),
    mfePips: fc.option(metric, { nil: null }),
    slippagePips: fc.double({ min: -10, max: 500, noNaN: true }),
    session: fc.constantFrom("ASIAN", "LONDON", "NY_OVERLAP", "NY", "LATE" as const),
  })
  .map((r) => fxTrade({ ...r, openTime: r.closeTime - r.durationMin * 60_000 } as Partial<DojixTrade>));

const validSt: fc.Arbitrary<Trade> = fc
  .record({
    ...common,
    shares: fc.double({ min: 0.0001, max: 1e6, noNaN: true }),
    maePoints: fc.option(metric, { nil: null }),
    mfePoints: fc.option(metric, { nil: null }),
    slippagePoints: fc.double({ min: -10, max: 500, noNaN: true }),
    session: fc.constantFrom("PRE_MARKET", "REGULAR", "AFTER_HOURS", "EXTENDED" as const),
  })
  .map((r) => stTrade({ ...r, openTime: r.closeTime - r.durationMin * 60_000 } as Partial<GreenwickTrade>));

const storable = fc.integer({ min: -62_167_219_200_000, max: 253_402_300_799_999 });
const hostileNumber = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, -0));
const hostileFx: fc.Arbitrary<Trade> = fc
  .record({
    netProfit: fc.oneof(fc.string(), fc.constantFrom("nan", "1e127", "-1e40000", "", "9".repeat(60)), moneyText),
    // Any instant GRDB date text can hold (years 0000–9999; stored times are text).
    closeTime: storable,
    openTime: storable,
    durationMin: fc.oneof(fc.integer(), fc.constantFrom(2 ** 62, -(2 ** 62))),
    maePips: fc.option(hostileNumber, { nil: null }),
    mfePips: fc.option(hostileNumber, { nil: null }),
    rMultiple: hostileNumber,
    lots: hostileNumber,
    slippagePips: hostileNumber,
    hour: fc.integer({ min: -1000, max: 1000 }),
    dayOfWeek: fc.string(),
    symbol: fc.string(),
  })
  .map((r) => fxTrade(r));

/** Every number reachable from `value`, with its path (trades inside models are skipped). */
function numbers(value: unknown, path: string, out: [string, number][], seen = new Set<unknown>()): [string, number][] {
  if (typeof value === "number") out.push([path, value]);
  else if (value instanceof Map) for (const [k, v] of value) numbers(v, `${path}[${String(k)}]`, out, seen);
  else if (Array.isArray(value)) value.forEach((v, i) => numbers(v, `${path}[${i}]`, out, seen));
  else if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    if ("brand" in value && "ticket" in value) return out; // a Trade
    for (const [k, v] of Object.entries(value)) numbers(v, `${path}.${k}`, out, seen);
  }
  return out;
}

/** Profit-factor sentinels (+∞, and the NaN / ±∞ PF change of PeriodComparison) are Mac behaviour. */
function allowedNonFinite(path: string): boolean {
  return /profitFactor$/.test(path) || /comparisons\[2\]\.(currentValue|previousValue|change)$/.test(path);
}

function contexts(brand: BrandId): EngineContext[] {
  return [
    createEngineContext({ brand, now: NOW, compat: "swift" }),
    createEngineContext({ brand, now: NOW, compat: "fixed", local: { tz: "Europe/Berlin", weekStart: 2, minDaysInFirstWeek: 4 } }),
  ];
}

describe("E2 components on valid journals", () => {
  for (const [brand, arb] of [
    ["dojix", validFx],
    ["greenwick", validSt],
  ] as const) {
    it(`${brand}: no NaN or ±∞ outside the PF sentinels`, () => {
      fc.assert(
        fc.property(fc.array(arb, { maxLength: 45 }), (trades) => {
          const sorted = [...trades].sort((a, b) => b.closeTime - a.closeTime);
          for (const ctx of contexts(brand)) {
            for (const [name, compute] of COMPUTES) {
              for (const [path, v] of numbers(compute(ctx, sorted), name, [])) {
                if (allowedNonFinite(path)) continue;
                expect(Number.isFinite(v), `${ctx.compat} ${path} = ${v}`).toBe(true);
              }
            }
          }
        }),
        { numRuns: 60 },
      );
    });
  }

  it("partitions: hours, durations, sessions and symbols add up to the trade count", () => {
    fc.assert(
      fc.property(fc.array(validFx, { maxLength: 60 }), (trades) => {
        const ctx = createEngineContext({ brand: "dojix", now: NOW });
        const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
        expect(sum(hourlyPnL(ctx, trades).hourlyData.map((h) => h.count))).toBe(trades.length);
        expect(sum(durationAnalysis(ctx, trades).buckets.map((b) => b.tradeCount))).toBe(trades.length);
        expect(sum(sessionRanking(ctx, trades).sessions.map((s) => s.trades))).toBe(trades.length);
        expect(sum(symbolAnalytics(ctx, trades).cards.map((c) => c.tradeCount))).toBe(trades.length);
        expect(sum(streakTimeline(ctx, trades).segments.map((s) => s.count))).toBe(trades.length);
        expect(sum(rMultipleChart(ctx, trades).buckets.map((b) => b.count))).toBe(trades.filter((t) => t.rMultiple >= -100 && t.rMultiple < 100).length);
        // D-01 fixed: every P&L lands in exactly one bucket.
        const dist = winLossDistribution(ctx, trades);
        if (dist.buckets.length > 0) expect(sum(dist.buckets.map((b) => b.count))).toBe(trades.length);
        // D-02 fixed: every non-negative slippage lands in exactly one bucket.
        const slip = slippageAnalysis(ctx, trades);
        expect(sum(slip.buckets.map((b) => b.count))).toBe(trades.filter((t) => (t as DojixTrade).slippagePips >= 0).length);
        const streak = streakCard(ctx, trades);
        expect(Math.abs(streak.currentStreak)).toBeLessThanOrEqual(trades.length);
        const cal = tradeCalendar(ctx, trades, trades[0]?.closeTime ?? NOW);
        expect(cal.leadingBlankCount).toBeGreaterThanOrEqual(0);
        expect(cal.leadingBlankCount).toBeLessThan(7);
      }),
      { numRuns: 150 },
    );
  });
});

describe("E2 components on hostile rows", () => {
  it("never throw", () => {
    fc.assert(
      fc.property(fc.array(hostileFx, { maxLength: 25 }), (trades) => {
        for (const ctx of contexts("dojix")) {
          for (const [name, compute] of COMPUTES) {
            if (name === "tradeCalendar") continue; // takes a month the UI picked, not a row's time
            expect(() => compute(ctx, trades), name).not.toThrow();
          }
          expect(() => tradeCalendar(ctx, trades)).not.toThrow();
        }
      }),
      { numRuns: 150 },
    );
  });
});
