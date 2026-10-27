import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { DojixTrade, GreenwickTrade, TradingSession, VolatilityRegime } from "../model";
import { fxTrade, stTrade } from "../test-support/trades";
import {
  computeEdgeDecayMonitor,
  edgeDecayMonitorComponent,
  edgeDecayMonitorParity,
  edgeDecayStatus,
  type RollingPoint,
} from "./edge-decay-monitor";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const st = createEngineContext({ brand: "greenwick", now: 0 });
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 10, 0);

const series = (profits: readonly string[], extra: (i: number) => Partial<DojixTrade> = () => ({})) =>
  profits.map((p, i) => fxTrade({ netProfit: p, closeTime: T0 + i * 60_000, ...extra(i) }));

const point = (pf: number, expectancy: number): RollingPoint => ({ id: 0, tradeNumber: 1, date: 0, sharpe: 0, pf, expectancy });

describe("EdgeDecayMonitor rolling windows", () => {
  it("needs 30 trades and computes one point per full window", () => {
    expect(computeEdgeDecayMonitor(fx, series(Array(29).fill("1"))).rollingData).toEqual([]);
    const m = computeEdgeDecayMonitor(fx, series(Array(31).fill("1")));
    expect(m.rollingData).toHaveLength(2);
    expect(m.rollingData[0]).toEqual({ id: 29, tradeNumber: 30, date: T0 + 29 * 60_000, sharpe: 0, pf: 5, expectancy: 1, volRegime: "MED" });
  });

  it("uses a fractional win rate, caps PF at 5 and clamps Sharpe to ±3", () => {
    // 20 × +3, 10 × −2: PF = 60/20 = 3, WRf 2/3, expectancy = 2/3·3 − 1/3·2.
    const p = computeEdgeDecayMonitor(fx, series([...Array(20).fill("3"), ...Array(10).fill("-2")])).rollingData[0];
    expect(p?.pf).toBe(3);
    expect(p?.expectancy).toBeCloseTo((2 / 3) * 3 - (1 / 3) * 2, 12);
    const tight = computeEdgeDecayMonitor(fx, series([...Array(29).fill("10"), "10.01"])).rollingData[0];
    expect(tight?.sharpe).toBe(3);
    const neg = computeEdgeDecayMonitor(fx, series([...Array(29).fill("-10"), "-10.01"])).rollingData[0];
    expect(neg?.sharpe).toBe(-3);
    expect(neg?.pf).toBe(0);
    const big = computeEdgeDecayMonitor(fx, series([...Array(29).fill("100"), "-1"])).rollingData[0];
    expect(big?.pf).toBe(5);
  });

  it("dominant regime: first-appearance order, the first of tied counts wins (Swift: random)", () => {
    const regimes: VolatilityRegime[] = [...Array(15).fill("LOW"), ...Array(15).fill("HIGH")];
    expect(computeEdgeDecayMonitor(fx, series(Array(30).fill("1"), (i) => ({ volRegime: regimes[i] as VolatilityRegime }))).rollingData[0]?.volRegime).toBe("LOW");
    const mostly: VolatilityRegime[] = [...Array(14).fill("LOW"), ...Array(16).fill("HIGH")];
    expect(computeEdgeDecayMonitor(fx, series(Array(30).fill("1"), (i) => ({ volRegime: mostly[i] as VolatilityRegime }))).rollingData[0]?.volRegime).toBe("HIGH");
  });

  it("Greenwick points have no regime", () => {
    const trades = Array.from({ length: 30 }, (_, i) => stTrade({ netProfit: "1", closeTime: T0 + i * 60_000 }));
    expect(computeEdgeDecayMonitor(st, trades).rollingData[0]).not.toHaveProperty("volRegime");
  });
});

describe("EdgeDecayMonitor status", () => {
  it("compares the last 30 points with the 30 before them", () => {
    expect(edgeDecayStatus([point(2, 1)])).toBe("healthy");
    expect(edgeDecayStatus(Array(30).fill(point(9, 9)))).toBe("healthy"); // no prior points
    const run = (prior: RollingPoint, recent: RollingPoint, nPrior = 30) => edgeDecayStatus([...Array(nPrior).fill(prior), ...Array(30).fill(recent)]);
    expect(run(point(2, 1), point(1.75, 1))).toBe("healthy"); // drop 0.25 is not > 0.25
    expect(run(point(2, 1), point(1.7, 1))).toBe("warning");
    expect(run(point(2, 1), point(1.5, 1))).toBe("warning"); // 0.5 is not > 0.5
    expect(run(point(2, 1), point(1.4, 1))).toBe("decaying");
    expect(run(point(2, 1), point(2, 0.8))).toBe("warning"); // expectancy −20%
    expect(run(point(2, -1), point(2, -1.4))).toBe("decaying"); // −40% of |prior|
    expect(run(point(2, 0), point(2, -5))).toBe("healthy"); // prior expectancy 0 → no % drop
    // Only the 30 points before the recent 30 count as prior.
    expect(edgeDecayStatus([...Array(10).fill(point(0, 0)), ...Array(30).fill(point(2, 1)), ...Array(30).fill(point(2, 1))])).toBe("healthy");
    expect(run(point(2, 1), point(1, 1), 3)).toBe("decaying");
  });
});

describe("EdgeDecayMonitor diagnoses", () => {
  // 90 trades. First half: one trade a day, LONDON, LOW volatility, 75% winners.
  // Second half: three a day, LONDON/NY, HIGH volatility, 50% winners at worse R:R.
  const decaying = (): DojixTrade[] =>
    Array.from({ length: 90 }, (_, i) => {
      const first = i < 45;
      const session: TradingSession = first ? "LONDON" : i % 3 === 0 ? "NY" : "LONDON";
      const closeTime = first ? T0 + i * DAY : T0 + (45 + Math.floor((i - 45) / 3)) * DAY + ((i - 45) % 3) * 3_600_000;
      const netProfit = first ? (i % 4 !== 3 ? "10" : "-5") : i % 2 === 0 ? "5" : "-10";
      return fxTrade({ netProfit, closeTime, session, volRegime: first ? "LOW" : "HIGH" });
    });

  it("finds regime shift, overtrading, drift and per-session decay (Dojix)", () => {
    const trades = decaying();
    const m = computeEdgeDecayMonitor(fx, [...trades].reverse());
    expect(m.status).toBe("decaying");
    expect(m.hasEnoughData).toBe(true);
    const wr = (xs: DojixTrade[]) => (xs.filter((t) => Number(t.netProfit) > 0).length / xs.length) * 100;
    const london1 = wr(trades.slice(0, 45));
    const london2 = wr(trades.slice(45).filter((t) => t.session === "LONDON"));
    expect(london1 - london2).toBeGreaterThan(15);
    expect(m.diagnoses).toEqual([
      { dimension: "Regime Shift", detail: "Volatility shifted from LOW to HIGH", severity: "warning" },
      { dimension: "Overtrading", detail: "Trade frequency up 200% (1.0 → 3.0/day)", severity: "decaying" },
      { dimension: "Strategy Drift", detail: "New sessions: New York", severity: "warning" },
      {
        dimension: "London Decay",
        detail: `Win rate dropped ${london1.toFixed(0)}% → ${london2.toFixed(0)}%`,
        severity: london1 - london2 > 25 ? "decaying" : "warning",
      },
    ]);
  });

  it("is quiet when healthy or short", () => {
    const steady = series(Array.from({ length: 90 }, (_, i) => (i % 2 ? "10" : "-5")));
    const m = computeEdgeDecayMonitor(fx, steady);
    expect(m.status).toBe("healthy");
    expect(m.diagnoses).toEqual([]);
    const short = computeEdgeDecayMonitor(fx, decaying().slice(0, 59));
    expect(short.diagnoses).toEqual([]);
    expect(short.hasEnoughData).toBe(false);
  });

  it("overtrading between 1.3× and 1.5× is a warning", () => {
    const trades = decaying().map((t, i) => ({ ...t, closeTime: i < 45 ? T0 + i * DAY : T0 + 45 * DAY + Math.floor(((i - 45) * DAY) / 1.4) }));
    const ot = computeEdgeDecayMonitor(fx, trades).diagnoses.find((d) => d.dimension === "Overtrading");
    expect(ot?.severity).toBe("warning");
  });

  it("Greenwick: ET trading days, market sessions, no regime check", () => {
    const trades: GreenwickTrade[] = decaying().map((t) =>
      stTrade({ netProfit: t.netProfit, closeTime: t.closeTime + 5 * 3_600_000, session: t.session === "NY" ? "PRE_MARKET" : "REGULAR" }),
    );
    const m = computeEdgeDecayMonitor(st, trades);
    expect(m.status).toBe("decaying");
    expect(m.diagnoses.map((d) => d.dimension)).toEqual(["Overtrading", "Strategy Drift", "Regular Decay"]);
    expect(m.diagnoses[1]?.detail).toBe("New sessions: Pre-Market");
  });
});

describe("EdgeDecayMonitor wiring", () => {
  it("registry and parity encoders", () => {
    const reg = new AnalyticsRegistry().register(edgeDecayMonitorComponent);
    expect(reg.run("EdgeDecayMonitor", fx, series(Array(59).fill("1")))).toBeNull();
    expect(reg.run("EdgeDecayMonitor", fx, series(Array(60).fill("1")))).toMatchObject({ status: "healthy", hasEnoughData: true });
    expect(reg.list("greenwick", "advanced").map((c) => c.id)).toEqual(["EdgeDecayMonitor"]);
    const trades = series(Array(30).fill("1"), (i) => ({ ticket: String(1000 + i) }));
    const m = edgeDecayMonitorParity.compute(fx, [...trades].reverse(), undefined);
    if (!m) throw new Error("no model");
    const enc = (k: string) => edgeDecayMonitorParity.members[k]?.(m, fx);
    expect((enc("sorted") as string[])[0]).toBe("#1000");
    expect(enc("rollingData")).toEqual([
      { id: 29, tradeNumber: 30, date: new Date(T0 + 29 * 60_000).toISOString(), sharpe: 0, pf: 5, expectancy: 1, volRegime: "MED" },
    ]);
    expect(enc("status")).toEqual({ $case: "healthy", label: "Healthy", icon: "checkmark.seal.fill" });
    expect(enc("diagnoses")).toEqual([]);
    const d = computeEdgeDecayMonitor(fx, Array.from({ length: 90 }, (_, i) => fxTrade({ netProfit: i < 45 ? "10" : "-10", closeTime: T0 + i * DAY })));
    expect(edgeDecayMonitorParity.members.diagnoses?.(d, fx)).toEqual([
      { detail: "Win rate dropped 100% → 0%", dimension: "London Decay", severity: { $case: "decaying", label: "Decaying", icon: "chart.line.downtrend.xyaxis" } },
    ]);
    expect(edgeDecayMonitorParity.members.status?.(d, fx)).toEqual({ $case: "decaying", label: "Decaying", icon: "chart.line.downtrend.xyaxis" });
  });

  it("never throws and keeps points finite for storage-valid P&L", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { minLength: 0, maxLength: 75 }), (cents) => {
        const m = computeEdgeDecayMonitor(fx, series(cents.map((c) => String(c / 100))));
        for (const p of m.rollingData) for (const v of [p.pf, p.sharpe, p.expectancy]) expect(Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});
