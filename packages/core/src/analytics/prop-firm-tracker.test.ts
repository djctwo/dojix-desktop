import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { etWall, fxSeries, fxTrade, stTrade } from "../test-support/trades";
import {
  computePropFirmStatusBadge,
  computePropFirmTracker,
  DEFAULT_PROP_FIRM_SETTINGS,
  propFirmMaxDrawdown,
  propFirmStatusBadgeComponent,
  propFirmStatusBadgeParity,
  propFirmTrackerComponent,
  propFirmTrackerParity,
} from "./prop-firm-tracker";

const NOW = Date.UTC(2026, 0, 15, 18, 0);
const fx = createEngineContext({ brand: "dojix", now: NOW });

describe("PropFirmTracker", () => {
  it("uses the Mac defaults and computes balance, limits and drawdown", () => {
    // F1 order ascending [100, 50, −30, −20, 80]; all close on 2026-01-15 (today)
    const trades = fxSeries(["100", "50", "-30", "-20", "80"]).reverse();
    const m = computePropFirmTracker(fx, trades);
    expect(m.settings).toEqual(DEFAULT_PROP_FIRM_SETTINGS);
    expect(m.totalPnL).toBe(180);
    expect(m.currentBalance).toBe(100_180);
    expect(m.profitTargetDollars).toBe(8000);
    expect(m.maxDailyLossDollars).toBe(5000);
    expect(m.maxDrawdownDollars).toBe(10_000);
    expect(m.dailyPnL).toBe(180);
    expect(m.maxDrawdown).toBe(50);
    expect(m.dailyLossBreached).toBe(false);
    expect(m.drawdownBreached).toBe(false);
    expect(m.tradingDays).toBe(1);
    expect(m.status).toBe("none");
    expect(m.profitProgress).toBeCloseTo(180 / 8000, 15);
    expect(m.dailyLossProgress).toBe(0);
    expect(m.drawdownProgress).toBeCloseTo(50 / 10_000, 15);
  });

  it("flags daily-loss and drawdown breaches", () => {
    const trades = [
      fxTrade({ netProfit: "-6000", closeTime: NOW - 3_600_000 }),
      fxTrade({ netProfit: "-5000", closeTime: Date.UTC(2026, 0, 10) }),
    ];
    const m = computePropFirmTracker(fx, trades);
    expect(m.dailyPnL).toBe(-6000);
    expect(m.dailyLossBreached).toBe(true);
    expect(m.maxDrawdown).toBe(11_000);
    expect(m.drawdownBreached).toBe(true);
    expect(m.tradingDays).toBe(2);
    expect(m.status).toBe("breached");
    expect(m.dailyLossProgress).toBe(1);
    expect(m.dailyLossUsedPercent).toBe(1);
    // exactly at the limit is not a breach (strict >)
    const edge = computePropFirmTracker(fx, [fxTrade({ netProfit: "-5000", closeTime: NOW })]);
    expect(edge.dailyLossBreached).toBe(false);
  });

  it("drawdown ignores a NaN step the way the comparison loop does", () => {
    // Unparseable text is NaN; `cumulative > peak` is false, so the peak never becomes NaN.
    expect(propFirmMaxDrawdown(fxSeries(["10", "x", "5"]))).toBe(0);
  });

  it("Dojix 'today' is the display calendar's day", () => {
    const berlin = createEngineContext({ brand: "dojix", now: Date.UTC(2026, 0, 15, 23, 30), local: { tz: "Europe/Berlin" } });
    const t = fxTrade({ netProfit: "-10", closeTime: Date.UTC(2026, 0, 15, 22, 30) }); // 23:30 Berlin, 15th... now 00:30 the 16th
    expect(computePropFirmTracker(berlin, [t]).dailyPnL).toBe(0);
    expect(computePropFirmTracker(createEngineContext({ brand: "dojix", now: Date.UTC(2026, 0, 15, 23, 30) }), [t]).dailyPnL).toBe(-10);
  });

  it("Greenwick uses the New York trading day (TradingDayTests.swift:153-163)", () => {
    const morning = stTrade({ netProfit: "50", openTime: etWall(2026, 10, 23, 9, 45), closeTime: etWall(2026, 10, 23, 10, 0) });
    const evening = stTrade({ netProfit: "-200", openTime: etWall(2026, 10, 23, 18, 20), closeTime: etWall(2026, 10, 23, 18, 50) });
    for (const tz of ["Europe/Berlin", "Asia/Tokyo", "America/Los_Angeles"]) {
      const fri = createEngineContext({ brand: "greenwick", now: etWall(2026, 10, 23, 19, 30), local: { tz } });
      const sat = createEngineContext({ brand: "greenwick", now: etWall(2026, 10, 24, 10, 0), local: { tz } });
      expect(computePropFirmTracker(fri, [morning, evening]).tradingDays).toBe(1);
      expect(computePropFirmTracker(fri, [morning, evening]).dailyPnL).toBeCloseTo(-150, 3);
      expect(computePropFirmTracker(sat, [morning, evening]).dailyPnL).toBeCloseTo(0, 3);
    }
  });

  it("Greenwick header escalates caution / danger by the daily limit used", () => {
    const now = etWall(2026, 10, 23, 15, 0);
    const st = createEngineContext({ brand: "greenwick", now });
    const at = (loss: string) => computePropFirmTracker(st, [stTrade({ netProfit: loss, closeTime: now - 60_000 })]);
    expect(at("-3700").status).toBe("none");
    expect(at("-3750").status).toBe("caution");
    expect(at("-4500").status).toBe("danger");
    expect(at("-5001").status).toBe("breached");
    expect(at("-3750").dailyLossUsedPercent).toBe(0.75);
    // Dojix has no caution/danger states
    const fxm = computePropFirmTracker(fx, [fxTrade({ netProfit: "-4600", closeTime: NOW })]);
    expect(fxm.status).toBe("none");
  });

  it("takes custom settings and handles zero limits", () => {
    const m = computePropFirmTracker(fx, [fxTrade({ netProfit: "-100", closeTime: NOW })], {
      accountSize: 0,
      profitTarget: 0,
      maxDailyLoss: 0,
      maxTotalDrawdown: 0,
    });
    expect(m.profitProgress).toBe(0);
    expect(m.dailyLossUsedPercent).toBe(0);
    expect(m.dailyLossBreached).toBe(true);
    expect(m.drawdownBreached).toBe(true);
  });

  it("is registered on the prop-firm tab for both brands", () => {
    const reg = new AnalyticsRegistry().register(propFirmTrackerComponent).register(propFirmStatusBadgeComponent);
    expect(reg.list("dojix", "propFirm").map((c) => c.id)).toEqual(["PropFirmTracker"]);
    expect(reg.list("greenwick", "propFirm").map((c) => c.id)).toEqual(["PropFirmTracker"]);
    expect(reg.list("greenwick", "overview").map((c) => c.id)).toEqual(["PropFirmStatusBadge"]);
    expect(reg.run("PropFirmTracker", fx, [])).toMatchObject({ totalPnL: 0, tradingDays: 0 });
    const st = createEngineContext({ brand: "greenwick", now: NOW });
    expect(reg.run("PropFirmStatusBadge", st, [])).toBeNull();
    expect(reg.run("PropFirmStatusBadge", fx, [fxTrade()])).toBeNull();
    expect(reg.run("PropFirmStatusBadge", st, [stTrade({ netProfit: "5" })])).toMatchObject({ statusLabel: "ON TRACK" });
  });

  it("parity: default and [custom] instances", () => {
    const ctx = parityContext("dojix", NOW);
    const trades = fxSeries(["100", "-30"]);
    const def = propFirmTrackerParity.compute(ctx, trades, undefined);
    const custom = propFirmTrackerParity.compute(ctx, trades, "custom");
    expect(propFirmTrackerParity.compute(ctx, trades, "other")).toBeUndefined();
    expect(def && propFirmTrackerParity.members.profitTargetDollars?.(def, ctx)).toBe(8000);
    expect(custom && propFirmTrackerParity.members.profitTargetDollars?.(custom, ctx)).toBe(5000);
    expect(custom && propFirmTrackerParity.members.maxDailyLossDollars?.(custom, ctx)).toBe(2000);
    expect(custom && propFirmTrackerParity.members.maxDrawdownDollars?.(custom, ctx)).toBe(4000);
    expect(Object.keys(propFirmTrackerParity.members).sort()).toEqual(
      [
        "totalPnL",
        "currentBalance",
        "profitTargetDollars",
        "maxDailyLossDollars",
        "maxDrawdownDollars",
        "dailyPnL",
        "maxDrawdown",
        "dailyLossBreached",
        "dailyLossUsedPercent",
        "drawdownBreached",
        "tradingDays",
      ].sort(),
    );
    expect(def && propFirmTrackerParity.members.tradingDays?.(def, ctx)).toBe(1);
  });
});

describe("PropFirmStatusBadge (Greenwick)", () => {
  const now = etWall(2026, 10, 23, 15, 0);
  const st = createEngineContext({ brand: "greenwick", now });
  const day = (p: string, minutesAgo = 1) => stTrade({ netProfit: p, closeTime: now - minutesAgo * 60_000 });

  it("computes the badge values and warning ladder", () => {
    const m = computePropFirmStatusBadge(st, [day("2000"), day("-4000", 2)]);
    expect(m).toMatchObject({
      accountSize: 100_000,
      maxDailyLossPercent: 5,
      maxDrawdownPercent: 10,
      profitTargetPercent: 8,
      totalPnL: -2000,
      dailyPnL: -2000,
      maxDailyLossDollars: 5000,
      maxDrawdownDollars: 10_000,
      profitTargetDollars: 8000,
      maxDrawdown: 4000,
      isBreached: false,
      profitProgress: 0,
      dailyLossUsed: 0.4,
      dailyLossWarning: "none",
      statusLabel: "ON TRACK",
    });
    expect(computePropFirmStatusBadge(st, [day("-3800")]).statusLabel).toBe("CAUTION");
    expect(computePropFirmStatusBadge(st, [day("-4600")]).statusLabel).toBe("DANGER");
    expect(computePropFirmStatusBadge(st, [day("-5100")])).toMatchObject({ dailyLossWarning: "breached", statusLabel: "BREACHED", isBreached: true });
    // drawdown breach from an older day with no loss today
    const old = stTrade({ netProfit: "-20000", closeTime: etWall(2026, 10, 1, 12, 0) });
    expect(computePropFirmStatusBadge(st, [old])).toMatchObject({ drawdownBreached: true, statusLabel: "BREACHED", dailyLossWarning: "none" });
    expect(computePropFirmStatusBadge(st, [day("4000")]).profitProgress).toBe(0.5);
    expect(computePropFirmStatusBadge(st, [day("40000")]).profitProgress).toBe(1);
    const zero = computePropFirmStatusBadge(st, [day("-1")], { accountSize: 0, profitTarget: 8, maxDailyLoss: 5, maxTotalDrawdown: 10 });
    expect(zero.profitProgress).toBe(0);
    expect(zero.dailyLossUsed).toBe(0);
  });

  it("parity encodes the warning as the Swift case name", () => {
    const ctx = parityContext("greenwick", now);
    const m = propFirmStatusBadgeParity.compute(ctx, [day("-4600")], undefined);
    expect(m && propFirmStatusBadgeParity.members.dailyLossWarning?.(m, ctx)).toBe("danger");
    expect(m && propFirmStatusBadgeParity.members.isBreached?.(m, ctx)).toBe(false);
    expect(propFirmStatusBadgeParity.compute(ctx, [], "x")).toBeUndefined();
    expect(Object.keys(propFirmStatusBadgeParity.members)).toHaveLength(16);
  });
});

describe("PropFirm properties", () => {
  const money = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }).map((c) => (c / 100).toString());
  it("never throws and never yields NaN for storage-valid trades", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: money, t: fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) }) }), { maxLength: 20 }),
        fc.boolean(),
        (rows, greenwick) => {
          const ctx = createEngineContext({ brand: greenwick ? "greenwick" : "dojix", now: NOW });
          const trades = rows.map((r) => (greenwick ? stTrade({ netProfit: r.p, closeTime: r.t }) : fxTrade({ netProfit: r.p, closeTime: r.t })));
          const m = computePropFirmTracker(ctx, trades);
          const b = computePropFirmStatusBadge(ctx, trades);
          for (const v of [...Object.values(m), ...Object.values(b)]) if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
          expect(m.profitProgress).toBeGreaterThanOrEqual(0);
          expect(m.profitProgress).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("does not throw on hostile text", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 6 }), (ps) => {
        computePropFirmTracker(fx, ps.map((p) => fxTrade({ netProfit: p })));
      }),
      { numRuns: 100 },
    );
  });
});
