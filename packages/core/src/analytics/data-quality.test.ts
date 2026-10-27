import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { etWall, fxSeries, fxTrade, stTrade } from "../test-support/trades";
import { computeDataQuality, dataQualityComponent, dataQualityParity } from "./data-quality";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const fxFixed = createEngineContext({ brand: "dojix", now: 0, compat: "fixed" });
const st = createEngineContext({ brand: "greenwick", now: 0 });

/** Ten clean Dojix trades on a Thursday, distinct close times. */
const clean = () => fxSeries(Array.from({ length: 10 }, (_, i) => String(i - 4)));

describe("DataQuality", () => {
  it("reports nothing for clean data and for no data", () => {
    expect(computeDataQuality(fx, clean())).toEqual({ issues: [], tradeCount: 10, allClear: true });
    expect(computeDataQuality(fx, [])).toEqual({ issues: [], tradeCount: 0, allClear: false });
  });

  it("runs the checks in the Mac's order with its messages", () => {
    const base = clean();
    const sat = Date.UTC(2026, 0, 17, 10, 0); // Saturday
    const trades = [
      ...base.slice(0, 6),
      fxTrade({ rMultiple: 0, closeTime: Date.UTC(2026, 1, 2, 1) }),
      fxTrade({ lots: 50, closeTime: Date.UTC(2026, 1, 2, 2) }),
      fxTrade({ durationMin: 0, closeTime: Date.UTC(2026, 1, 2, 3) }),
      fxTrade({ closeTime: base[0]?.closeTime ?? 0 }),
      fxTrade({ openTime: sat, closeTime: sat + 60_000 }),
    ];
    const m = computeDataQuality(fx, trades);
    expect(m.issues.map((i) => [i.severity, i.message, i.count])).toEqual([
      ["warning", "Trades with missing R-multiple (no SL set?)", 1],
      ["warning", "Trades with 5x+ average lot size", 1],
      ["info", "Trades with 0-minute duration", 1],
      ["warning", "Trades with identical close times", 1],
      ["info", "Trades opened on weekends", 1],
    ]);
    expect(m.allClear).toBe(false);
  });

  it("weekends follow the display calendar (Dojix)", () => {
    // Friday 23:30 UTC is Saturday in Tokyo.
    const t = fxTrade({ openTime: Date.UTC(2026, 0, 16, 23, 30), closeTime: Date.UTC(2026, 0, 16, 23, 50) });
    expect(computeDataQuality(fx, [t]).issues).toEqual([]);
    const tokyo = createEngineContext({ brand: "dojix", now: 0, local: { tz: "Asia/Tokyo" } });
    expect(computeDataQuality(tokyo, [t]).issues.map((i) => i.message)).toEqual(["Trades opened on weekends"]);
  });

  it("Greenwick: a Friday-evening ET trade is not a weekend one in any zone (TradingDayTests.swift:141-148)", () => {
    const friday = stTrade({ openTime: etWall(2026, 10, 23, 18, 20), closeTime: etWall(2026, 10, 23, 18, 50), rMultiple: 1, durationMin: 30 });
    const saturday = stTrade({ openTime: etWall(2026, 10, 24, 11, 0), closeTime: etWall(2026, 10, 24, 11, 30), rMultiple: 1, durationMin: 30 });
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Europe/Berlin"]) {
      const ctx = createEngineContext({ brand: "greenwick", now: 0, local: { tz } });
      expect(computeDataQuality(ctx, [friday]).issues).toEqual([]);
      expect(computeDataQuality(ctx, [friday, saturday]).issues.find((i) => i.message === "Trades opened on weekends")?.count).toBe(1);
    }
  });

  it("Greenwick says position size", () => {
    const trades = Array.from({ length: 6 }, (_, i) => stTrade({ shares: i === 0 ? 10_000 : 10, rMultiple: 1, closeTime: etWall(2026, 10, 20, 10, i) }));
    expect(computeDataQuality(st, trades).issues.map((i) => i.message)).toEqual(["Trades with 5x+ average position size"]);
  });

  it("MAE > 3×MFE is reported only above n/4 (integer division)", () => {
    const mk = (bad: number, n: number) =>
      fxSeries(Array.from({ length: n }, () => "1")).map((t, i) => (i < bad ? { ...t, maePips: 31, mfePips: 10 } : t));
    expect(computeDataQuality(fx, mk(2, 8)).issues).toEqual([]); // 2 > 8/4 = 2 is false
    expect(computeDataQuality(fx, mk(3, 8)).issues.map((i) => i.count)).toEqual([3]);
    expect(computeDataQuality(fx, mk(1, 3)).issues.map((i) => i.count)).toEqual([1]); // 3/4 = 0
    // MFE must be positive; exactly 3× is not "greater".
    const edge = fxSeries(["1", "1"]).map((t, i) => (i === 0 ? { ...t, maePips: 30, mfePips: 10 } : { ...t, maePips: 5, mfePips: 0 }));
    expect(computeDataQuality(fx, edge).issues).toEqual([]);
  });

  it("D-18: unknown MAE/MFE never counts (both modes)", () => {
    const trades = fxSeries(["1", "1"]).map((t) => ({ ...t, maePips: null, mfePips: null }));
    expect(computeDataQuality(fx, trades).issues).toEqual([]);
    expect(computeDataQuality(fxFixed, trades).issues).toEqual([]);
  });

  it("is registered and encodes issues like the harness", () => {
    const reg = new AnalyticsRegistry().register(dataQualityComponent);
    expect(reg.list("greenwick", "advanced").map((c) => c.id)).toEqual(["DataQuality"]);
    expect(reg.run("DataQuality", fx, [])).toBeNull();
    expect(reg.run("DataQuality", fx, clean())).toMatchObject({ allClear: true });
    const trades = [fxTrade({ durationMin: 0, closeTime: 1 }), fxTrade({ closeTime: 2, rMultiple: 0 })];
    const m = dataQualityParity.compute(fx, trades, undefined);
    expect(m && dataQualityParity.members.issues?.(m, fx)).toEqual([
      { count: 1, message: "Trades with missing R-multiple (no SL set?)", severity: { $case: "warning", icon: "exclamationmark.triangle.fill" } },
      { count: 1, message: "Trades with 0-minute duration", severity: { $case: "info", icon: "info.circle.fill" } },
    ]);
  });

  it("never throws on hostile input", () => {
    const num = fc.oneof(fc.double(), fc.constant(NaN), fc.constant(Infinity), fc.integer());
    fc.assert(
      fc.property(
        fc.array(fc.record({ lots: num, rMultiple: num, maePips: fc.option(num, { nil: null }), mfePips: fc.option(num, { nil: null }), durationMin: fc.integer() }), {
          maxLength: 20,
        }),
        fc.boolean(),
        (rows, fixed) => {
          const trades = rows.map((r, i) => fxTrade({ ...r, closeTime: Date.UTC(2026, 0, 1) + i * 1000 }));
          const m = computeDataQuality(fixed ? fxFixed : fx, trades);
          for (const i of m.issues) expect(Number.isInteger(i.count) && i.count > 0).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });
});
