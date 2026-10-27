import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { Trade } from "../model/trade";
import { fxTrade, stTrade } from "../test-support/trades";
import { checklistAnalyticsComponent, checklistAnalyticsParity, computeChecklistAnalytics } from "./checklist-analytics";

const fx = createEngineContext({ brand: "dojix", now: 0 });

function rows(spec: readonly [string, Record<string, boolean>][]): Trade[] {
  return spec.map(([p, checklist], i) => fxTrade({ ticket: String(100 + i), netProfit: p, checklist }));
}

const DATA: [string, Record<string, boolean>][] = [
  ["30", { "Wait for close": true, "Risk 1%": true }],
  ["-10", { "Wait for close": false, "Risk 1%": true }],
  ["20", { "Wait for close": true, "Risk 1%": false }],
  ["-20", { "Wait for close": false, "Risk 1%": false }],
  ["10", { "Wait for close": true, "Risk 1%": true }],
  ["5", {}],
];

describe("ChecklistAnalytics", () => {
  it("needs 5 trades with checklist data", () => {
    const m = computeChecklistAnalytics(rows(DATA.slice(0, 4)));
    expect(m.hasData).toBe(false);
    expect(m.clTrades).toHaveLength(4);
    expect(m.ruleStats).toEqual([]);
    expect(m.overallCompliance).toBe(0);
    // The two averages don't depend on hasData (Swift line 58-67).
    expect(m.allFollowedAvg).toBe(30);
    expect(m.anyBrokenAvg).toBeCloseTo(-10 / 3, 12);
  });

  it("computes per-rule impact, compliance and the summary averages", () => {
    const m = computeChecklistAnalytics(rows(DATA));
    expect(m.hasData).toBe(true);
    expect(m.clTrades).toHaveLength(5);
    expect(m.totalTrades).toBe(6);
    expect(m.ruleStats).toEqual([
      {
        id: "Wait for close",
        rule: "Wait for close",
        complianceRate: 60,
        avgPnLFollowed: 20,
        avgPnLBroken: -15,
        dollarImpact: 35,
        winRateFollowed: 100,
        winRateBroken: 0,
      },
      {
        id: "Risk 1%",
        rule: "Risk 1%",
        complianceRate: 60,
        avgPnLFollowed: 10,
        avgPnLBroken: 0,
        dollarImpact: 10,
        winRateFollowed: (2 / 3) * 100,
        winRateBroken: 50,
      },
    ]);
    expect(m.overallCompliance).toBe(60);
    expect(m.allFollowedAvg).toBe(20);
    expect(m.anyBrokenAvg).toBeCloseTo(-10 / 3, 12);
  });

  it("handles rules never followed or never broken, and ties by first appearance", () => {
    const m = computeChecklistAnalytics(
      rows(Array.from({ length: 5 }, () => ["4", { B: true, A: false }] as [string, Record<string, boolean>])),
    );
    expect(m.ruleStats.map((r) => [r.rule, r.complianceRate, r.avgPnLFollowed, r.avgPnLBroken, r.winRateFollowed, r.winRateBroken])).toEqual([
      ["B", 100, 4, 0, 100, 0],
      ["A", 0, 0, 4, 0, 100],
    ]);
    expect(m.allFollowedAvg).toBe(0);
    const tie = computeChecklistAnalytics(rows(Array.from({ length: 5 }, () => ["1", { X: true, Y: true }] as [string, Record<string, boolean>])));
    expect(tie.ruleStats.map((r) => r.rule)).toEqual(["X", "Y"]);
    expect(tie.anyBrokenAvg).toBe(0);
  });

  it("is registered for both brands and encodes trades and rule stats", () => {
    const reg = new AnalyticsRegistry().register(checklistAnalyticsComponent);
    const st = createEngineContext({ brand: "greenwick", now: 0 });
    expect(reg.list("greenwick", "behavioral").map((c) => c.id)).toEqual(["ChecklistAnalytics"]);
    expect(reg.run("ChecklistAnalytics", st, [stTrade({ checklist: { A: true } })])).toBeNull();
    expect(reg.run("ChecklistAnalytics", fx, rows(DATA))).toMatchObject({ overallCompliance: 60 });
    const m = checklistAnalyticsParity.compute(fx, rows(DATA), undefined);
    if (!m) throw new Error("model");
    const enc = (k: string) => checklistAnalyticsParity.members[k]?.(m, fx);
    expect(enc("clTrades")).toEqual(["#100", "#101", "#102", "#103", "#104"]);
    expect(enc("hasData")).toBe(true);
    expect((enc("ruleStats") as unknown[])[0]).toMatchObject({ id: "Wait for close", dollarImpact: 35 });
    expect([enc("overallCompliance"), enc("allFollowedAvg"), enc("anyBrokenAvg")]).toEqual([60, 20, m.anyBrokenAvg]);
  });

  it("never yields NaN and never throws (property)", () => {
    const money = fc.integer({ min: -1e8, max: 1e8 }).map((c) => String(c / 100));
    const checklist = fc.dictionary(fc.string({ maxLength: 6 }), fc.boolean(), { maxKeys: 4 });
    fc.assert(
      fc.property(fc.array(fc.tuple(money, checklist), { maxLength: 40 }), (spec) => {
        const m = computeChecklistAnalytics(rows(spec));
        const nums = [m.overallCompliance, m.allFollowedAvg, m.anyBrokenAvg];
        for (const r of m.ruleStats) nums.push(r.complianceRate, r.avgPnLFollowed, r.avgPnLBroken, r.dollarImpact, r.winRateFollowed, r.winRateBroken);
        for (const v of nums) expect(Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
