// Property tests (fast-check) for the Greenwick-only analytics: no crash on hostile input, and
// no NaN or ±∞ in any number they output for input that passed storage validation (SPEC §4.3,
// Greenwick `TradeLimits`).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CompatMode } from "../../engine/compat";
import type { GreenwickTrade } from "../../model/trade";
import { SwiftDecimal } from "../../swiftcompat/decimal";
import { stTrade } from "../../test-support/trades";
import { computeDiversificationScore } from "./diversification-score";
import { computeEarningsImpact } from "./earnings-impact";
import { computeExecutionQuality } from "./execution-quality";
import { computeGapAnalysis } from "./gap-analysis";
import { computeIntradayEquityCurve } from "./intraday-equity-curve";
import { computeOpeningRange } from "./opening-range";
import { computeRegimeAnalysis } from "./regime-analysis";
import { computeSectorExposure } from "./sector-exposure";
import { computeVolumeAnalysis } from "./volume-analysis";

const ALL = (trades: readonly GreenwickTrade[], compat: CompatMode): unknown[] => [
  computeSectorExposure(trades),
  computeVolumeAnalysis(trades),
  computeGapAnalysis(trades),
  computeOpeningRange(trades),
  computeExecutionQuality(trades, compat),
  computeIntradayEquityCurve(trades),
  computeRegimeAnalysis(trades, compat),
  computeEarningsImpact(trades, compat),
  computeDiversificationScore(trades),
];

/** Every number reachable from `v` (trades excluded: they are the input). */
function numbers(v: unknown, out: number[] = [], seen = new Set<unknown>()): number[] {
  if (typeof v === "number") out.push(v);
  else if (v !== null && typeof v === "object" && !seen.has(v)) {
    seen.add(v);
    if ((v as { brand?: unknown }).brand === "greenwick") return out;
    const items = v instanceof Map ? [...v.values()] : Array.isArray(v) ? v : Object.values(v);
    for (const x of items) numbers(x, out, seen);
  }
  return out;
}

const MIN_T = Date.UTC(1900, 0, 1);
const MAX_T = Date.UTC(2200, 0, 1);
const amount = (max: number) =>
  fc
    .tuple(fc.bigInt({ min: -(10n ** 16n), max: 10n ** 16n }), fc.integer({ min: 0, max: 6 }))
    .map(([units, scale]) => SwiftDecimal.fromParts(units < 0n, units < 0n ? -units : units, -scale).toString())
    .filter((t) => Math.abs(Number(t)) <= max);
const price = amount(1e12).filter((t) => Number(t) >= 0);
const points = fc.double({ min: -1e9, max: 1e9, noNaN: true });

const validSt: fc.Arbitrary<GreenwickTrade> = fc
  .record({
    symbol: fc.constantFrom("FICT", "FAKE", "MOCK", "Café", "Café"),
    sector: fc.constantFrom("", "Technology", "Energy"),
    netProfit: amount(1e12),
    openPrice: price,
    closePrice: price,
    direction: fc.constantFrom("BUY", "SELL" as const),
    closeTime: fc.integer({ min: MIN_T + 30 * 86_400_000, max: MAX_T }),
    durationMin: fc.integer({ min: 0, max: 20_000 }),
    hour: fc.integer({ min: 0, max: 23 }),
    shares: fc.double({ min: 1e-6, max: 1e9, noNaN: true }),
    maePoints: fc.option(points, { nil: null }),
    mfePoints: fc.option(points, { nil: null }),
    slDistPoints: points,
    slippagePoints: points,
    rangeSize: points,
    rMultiple: points,
    volume: fc.integer({ min: 0, max: 1e12 }),
    avgVolume: fc.integer({ min: 0, max: 1e12 }),
  })
  .map((r) => stTrade(r));

const hostileNumber = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, -0, Number.MAX_VALUE));
const hostileText = fc.oneof(fc.string(), fc.constantFrom("nan", "inf", "1e127", "-1e-200", "0e1000", "", "9".repeat(200)));

const hostileSt: fc.Arbitrary<GreenwickTrade> = fc
  .record({
    symbol: fc.string(),
    sector: fc.string(),
    netProfit: hostileText,
    openPrice: hostileText,
    closePrice: hostileText,
    // Any year the calendar can represent (±270,000). Within a day of the JS Date limit,
    // ZonedCalendar.startOfDay has no midnight to return and throws; storage rejects anything
    // outside 1900–2200 (TradeLimits), so such a row never reaches the engine.
    openTime: fc.integer({ min: -8.63e15, max: 8.63e15 }),
    closeTime: fc.integer({ min: -8.63e15, max: 8.63e15 }),
    hour: fc.integer({ min: -1000, max: 1000 }),
    shares: hostileNumber,
    maePoints: fc.option(hostileNumber, { nil: null }),
    mfePoints: fc.option(hostileNumber, { nil: null }),
    slDistPoints: hostileNumber,
    slippagePoints: hostileNumber,
    rangeSize: hostileNumber,
    rMultiple: hostileNumber,
    volume: hostileNumber,
    avgVolume: hostileNumber,
  })
  .map((r) => stTrade(r));

const compat = fc.constantFrom("swift", "fixed" as const);

describe("Greenwick-only analytics: properties", () => {
  it("valid input: no NaN or ±∞ anywhere in the output, counts add up", () => {
    fc.assert(
      fc.property(fc.array(validSt, { maxLength: 40 }), compat, (trades, mode) => {
        const models = ALL(trades, mode);
        for (const n of numbers(models)) expect(Number.isFinite(n)).toBe(true);
        const e = computeEarningsImpact(trades, mode);
        expect(e.catalystTrades.length + e.normalTrades.length).toBe(trades.length);
        const s = computeSectorExposure(trades);
        expect(s.sectorStats.reduce((a, x) => a + x.tradeCount, 0)).toBe(trades.filter((t) => t.sector !== "").length);
        const r = computeRegimeAnalysis(trades, mode);
        expect(r.tradingDays.reduce((a, d) => a + d.trades.length, 0)).toBe(trades.length);
        const d = computeDiversificationScore(trades);
        for (const row of d.correlationMatrix) for (const c of row) expect(Math.abs(c)).toBeLessThanOrEqual(1 + 1e-9);
        const x = computeExecutionQuality(trades, mode);
        expect(x.executionScore).toBeGreaterThanOrEqual(0);
        expect(x.executionScore).toBeLessThanOrEqual(100);
      }),
      { numRuns: 300 },
    );
  });

  it("hostile input: never throws", () => {
    fc.assert(
      fc.property(fc.array(hostileSt, { maxLength: 30 }), compat, (trades, mode) => {
        ALL(trades, mode);
      }),
      { numRuns: 300 },
    );
  });
});
