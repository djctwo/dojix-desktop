import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade, stTrade } from "../test-support/trades";
import { computeRiskOfRuin, riskOfRuinComponent, riskOfRuinFor, riskOfRuinParity, rorLevelOf } from "./risk-of-ruin";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const fxFixed = createEngineContext({ brand: "dojix", now: 0, compat: "fixed" });
const st = createEngineContext({ brand: "greenwick", now: 0, compat: "swift" });

const series = (wins: number, win: string, losses: number, loss: string) => [
  ...Array.from({ length: wins }, () => fxTrade({ netProfit: win })),
  ...Array.from({ length: losses }, () => fxTrade({ netProfit: loss })),
];

describe("RiskOfRuin", () => {
  it("win rate, R:R and Kelly (DojixTests/AnalyticsComponentTests.swift:56-100)", () => {
    // :56-65 — 7 wins, 3 losses = 70% (a fraction here)
    const a = computeRiskOfRuin(fx, series(7, "50", 3, "-30"));
    expect(a.winRate).toBeCloseTo(0.7, 3);
    // :67-82 — avg win 50, avg loss 30 → R:R 1.667
    const b = computeRiskOfRuin(fx, series(5, "50", 5, "-30"));
    expect(b.avgWin).toBeCloseTo(50, 2);
    expect(b.avgLoss).toBeCloseTo(30, 2);
    expect(b.rewardRiskRatio).toBeCloseTo(1.667, 2);
    // :84-91 — Kelly = W − (1 − W)/R with 60%, 1.5 → 0.333
    const c = computeRiskOfRuin(fx, series(6, "45", 4, "-30"));
    expect(c.kellyFraction).toBeCloseTo(0.333, 2);
    expect(c.halfKelly).toBeCloseTo(0.1667, 3);
    // :93-100 — 40% at 1.0 R:R → negative Kelly, clamped to 0; no edge → ruin 1
    const d = computeRiskOfRuin(fx, series(4, "30", 6, "-30"));
    expect(d.kellyFraction).toBe(0);
    expect(d.riskOfRuin).toBe(1);
    expect(d.rorLevel).toBe("veryHigh");
  });

  it("computes ((1 − edge)/(1 + edge))^20 with a positive edge", () => {
    const m = computeRiskOfRuin(fx, series(7, "50", 3, "-30"));
    const edge = 0.7 * (50 / 30) - 0.3;
    expect(m.riskOfRuin).toBeCloseTo(Math.pow((1 - edge) / (1 + edge), 20), 15);
    expect(m.rorLevel).toBe("veryLow");
    expect(m.insightIcon).toBe("checkmark.circle");
    expect(m.insightText).toMatch(/^Excellent risk profile/);
    expect(m.kellyFraction).toBeCloseTo(0.7 - 0.3 / (50 / 30), 12);
  });

  it("guards: no trades, no wins, no losses, base < 0", () => {
    const empty = computeRiskOfRuin(fx, []);
    expect(empty).toMatchObject({ winRate: 0, avgWin: 0, avgLoss: 0, rewardRiskRatio: 0, riskOfRuin: 1, kellyFraction: 0, rorLevel: "veryHigh" });
    const allWins = computeRiskOfRuin(fx, series(10, "10", 0, "0"));
    expect(allWins.rewardRiskRatio).toBe(0); // no losses → rr 0 → ruin 1
    expect(allWins.riskOfRuin).toBe(1);
    expect(riskOfRuinFor(0, 2, "swift")).toBe(1);
    expect(riskOfRuinFor(NaN, 2, "swift")).toBe(1);
    expect(riskOfRuinFor(0.6, NaN, "swift")).toBe(1);
    expect(riskOfRuinFor(0.9, 2, "swift")).toBe(0); // edge 1.7 → base < 0 → 0
  });

  it("counts breakevens in the denominator", () => {
    const m = computeRiskOfRuin(fx, [...series(5, "10", 4, "-10"), fxTrade({ netProfit: "0" })]);
    expect(m.winRate).toBe(0.5);
  });

  it("D-04: the Mac returns 100% at exactly 50% even with an edge; fixed uses the formula", () => {
    const trades = series(5, "50", 5, "-30");
    const mac = computeRiskOfRuin(fx, trades);
    expect(mac.riskOfRuin).toBe(1); // red on the Mac
    expect(mac.rorLevel).toBe("veryHigh");
    const fixed = computeRiskOfRuin(fxFixed, trades);
    expect(fixed.riskOfRuin).toBeCloseTo(Math.pow(0.5, 20), 18); // edge 1/3 → base 0.5
    expect(fixed.rorLevel).toBe("veryLow");
  });

  it("levels at the thresholds", () => {
    expect(rorLevelOf(0.0099)).toBe("veryLow");
    expect(rorLevelOf(0.01)).toBe("low");
    expect(rorLevelOf(0.05)).toBe("moderate");
    expect(rorLevelOf(0.2)).toBe("high");
    expect(rorLevelOf(0.5)).toBe("veryHigh");
    expect(rorLevelOf(NaN)).toBe("veryHigh");
  });

  it("is the same for Greenwick", () => {
    const fxM = computeRiskOfRuin(fx, series(6, "45", 4, "-30"));
    const stM = computeRiskOfRuin(st, [
      ...Array.from({ length: 6 }, () => stTrade({ netProfit: "45" })),
      ...Array.from({ length: 4 }, () => stTrade({ netProfit: "-30" })),
    ]);
    expect(stM).toEqual(fxM);
  });

  it("registers with the 10-trade guard and encodes the level as the harness does", () => {
    const reg = new AnalyticsRegistry().register(riskOfRuinComponent);
    expect(reg.run("RiskOfRuin", fx, series(5, "1", 4, "-1"))).toBeNull();
    expect(reg.run("RiskOfRuin", fx, series(5, "1", 5, "-1"))).not.toBeNull();
    const m = riskOfRuinParity.compute(fx, series(6, "45", 4, "-30"), undefined);
    if (!m) throw new Error("model");
    const enc = Object.fromEntries(Object.entries(riskOfRuinParity.members).map(([k, f]) => [k, f(m, fx)]));
    expect(enc.rorLevel).toEqual({ $case: m.rorLevel, label: expect.any(String), icon: expect.any(String) });
    expect(Object.keys(enc).sort()).toEqual(
      ["avgLoss", "avgWin", "insightIcon", "insightText", "kellyFraction", "rewardRiskRatio", "riskOfRuin", "rorLevel", "winRate"],
    );
  });

  it("never throws and stays in [0, 1] for storage-valid input (property)", () => {
    const money = fc.integer({ min: -1_000_000, max: 1_000_000 }).map((c) => String(c / 100));
    fc.assert(
      fc.property(fc.array(money, { maxLength: 40 }), fc.boolean(), (ps, fixed) => {
        const m = computeRiskOfRuin(fixed ? fxFixed : fx, ps.map((p) => fxTrade({ netProfit: p })));
        for (const v of [m.winRate, m.avgWin, m.avgLoss, m.rewardRiskRatio, m.riskOfRuin, m.kellyFraction]) {
          expect(Number.isNaN(v)).toBe(false);
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(m.riskOfRuin).toBeGreaterThanOrEqual(0);
        expect(m.riskOfRuin).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});
