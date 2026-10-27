import { describe, expect, it } from "vitest";
import { fxTrade, stTrade } from "../test-support/trades";
import { TRADING_CALENDAR } from "../time/us-market";
import { createEngineContext, parityContext } from "./context";
import { AnalyticsRegistry, defineComponent, placementFor } from "./registry";
import { createRng, resampled, shuffled } from "./rng";

describe("EngineContext", () => {
  it("gives Greenwick the ET calendar and Dojix the display calendar", () => {
    const st = createEngineContext({ brand: "greenwick", now: 0, local: { tz: "Europe/Berlin", weekStart: 2, minDaysInFirstWeek: 4 } });
    expect(st.calendar).toBe(TRADING_CALENDAR);
    expect(st.localCalendar.tz).toBe("Europe/Berlin");
    expect(st.compat).toBe("fixed");
    const fx = createEngineContext({ brand: "dojix", now: 0, local: { tz: "Asia/Kolkata" }, compat: "swift", brokerOffset: "Europe/Athens" });
    expect(fx.calendar).toBe(fx.localCalendar);
    expect(fx.calendar.spec).toEqual({ tz: "Asia/Kolkata", weekStart: 1, minDaysInFirstWeek: 1 });
    expect(fx.brokerOffset).toBe("Europe/Athens");
    expect(() => createEngineContext({ brand: "dojix", now: NaN })).toThrow(RangeError);
  });

  it("parity runs use UTC, POSIX weeks and swift compat", () => {
    const ctx = parityContext("dojix", 123);
    expect(ctx).toMatchObject({ brand: "dojix", now: 123, compat: "swift", brokerOffset: "utc" });
    expect(ctx.calendar.spec).toEqual({ tz: "UTC", weekStart: 1, minDaysInFirstWeek: 1 });
  });
});

describe("rng", () => {
  it("is deterministic per seed and in range", () => {
    const a = createRng(42);
    const b = createRng(42);
    const xs = Array.from({ length: 1000 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b.next()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(createRng(43).next()).not.toBe(createRng(42).next());
    expect(createRng(-1).seed).toBe(0xffffffff);
    const r = createRng(1);
    for (let i = 0; i < 100; i++) {
      const v = r.nextInt(6);
      expect(Number.isInteger(v) && v >= 0 && v < 6).toBe(true);
    }
    expect(() => r.nextInt(0)).toThrow(RangeError);
    expect(() => createRng(Infinity)).toThrow(RangeError);
  });

  it("shuffles without loss and resamples with replacement", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const s = shuffled(items, createRng(7));
    expect([...s].sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = resampled(items, createRng(7), 50);
    expect(b).toHaveLength(50);
    expect(b.every((x) => items.includes(x))).toBe(true);
    expect(resampled([], createRng(1))).toEqual([]);
    expect(resampled(items, createRng(1))).toHaveLength(8);
  });
});

describe("AnalyticsRegistry", () => {
  const count = defineComponent({
    id: "TradeCount",
    brands: ["dojix", "greenwick"],
    tab: { dojix: "overview", greenwick: "risk" },
    minTrades: 2,
    compute: (_ctx, trades) => trades.length,
  });
  const fxOnly = defineComponent({
    id: "FxOnly",
    brands: ["dojix"],
    tab: "pulse",
    minTrades: 0,
    compute: () => "fx",
  });

  it("registers, lists by brand and placement, and runs with the guard", () => {
    const reg = new AnalyticsRegistry().register(count).register(fxOnly);
    expect(reg.list("dojix").map((c) => c.id)).toEqual(["TradeCount", "FxOnly"]);
    expect(reg.list("greenwick", "risk").map((c) => c.id)).toEqual(["TradeCount"]);
    expect(reg.list("greenwick", "overview")).toEqual([]);
    expect(reg.get("FxOnly")?.id).toBe("FxOnly");
    const fx = createEngineContext({ brand: "dojix", now: 0 });
    const st = createEngineContext({ brand: "greenwick", now: 0 });
    expect(reg.run("TradeCount", fx, [fxTrade()])).toBeNull();
    expect(reg.run("TradeCount", fx, [fxTrade(), fxTrade()])).toBe(2);
    expect(reg.run("TradeCount", st, [stTrade(), stTrade(), stTrade()])).toBe(3);
    expect(reg.run("FxOnly", st, [])).toBeNull();
    expect(() => reg.run("Nope", fx, [])).toThrow(/unknown/);
    expect(placementFor(count, "greenwick")).toBe("risk");
    expect(placementFor(fxOnly, "greenwick")).toBeUndefined();
  });

  it("rejects bad registrations", () => {
    const reg = new AnalyticsRegistry().register(count);
    expect(() => reg.register(count)).toThrow(/twice/);
    expect(() => reg.register({ ...fxOnly, id: "X", brands: [] })).toThrow(/no brand/);
    expect(() => reg.register({ ...fxOnly, id: "Y", minTrades: -1 })).toThrow(/minTrades/);
    expect(() => reg.register({ ...count, id: "Z", tab: { dojix: "overview" } })).toThrow(/no placement for greenwick/);
  });
});
