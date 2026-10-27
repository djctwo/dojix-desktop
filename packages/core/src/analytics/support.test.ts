import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { resolveParityOutput } from "../parity/reference";
import { fxSeries, fxTrade } from "../test-support/trades";
import { clamp, countWins, mean, parseComponentKey, refDate, registerComponentParity, sumProfit, toRef } from "./support";

describe("analytics support", () => {
  it("sums, counts and averages like the Swift reduce", () => {
    const trades = fxSeries(["0.1", "0.2", "-0.3", "0"]);
    expect(sumProfit(trades)).toBe(0.1 + 0.2 - 0.3);
    expect(countWins(trades)).toBe(2);
    expect(mean([1, 2, 4])).toBeCloseTo(7 / 3, 15);
    expect(mean([])).toBeNaN();
  });

  it("clamps with Swift's min/max (NaN stays NaN)", () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(42, 0, 100)).toBe(42);
    expect(clamp(NaN, 0, 100)).toBeNaN();
    expect(clamp(Infinity, 0, 100)).toBe(100);
  });

  it("encodes values like the harness", () => {
    const t = fxTrade({ ticket: "9000000000000000001" });
    expect(refDate(Date.UTC(2026, 9, 27, 1, 2, 3, 4))).toBe("2026-10-27T01:02:03.004Z");
    expect(
      toRef(
        { when: Date.UTC(2026, 0, 1), n: 1.5, t, list: [t], m: new Map([[3, { when: 0 }]]), u: undefined, ui: "x", z: null },
        { dates: ["when"], omit: ["ui"] },
      ),
    ).toEqual({
      when: "2026-01-01T00:00:00.000Z",
      n: 1.5,
      t: "#9000000000000000001",
      list: ["#9000000000000000001"],
      m: { "3": { when: "1970-01-01T00:00:00.000Z" } },
      z: null,
    });
    expect(toRef(undefined)).toBeNull();
    expect(toRef("s")).toBe("s");
  });

  it("parses component keys with and without an instance", () => {
    expect(parseComponentKey("RiskOfRuin.riskOfRuin")).toEqual({ component: "RiskOfRuin", instance: undefined, member: "riskOfRuin" });
    expect(parseComponentKey("PositionSizer[balance25k_risk2].suggestedLots")).toEqual({
      component: "PositionSizer",
      instance: "balance25k_risk2",
      member: "suggestedLots",
    });
    expect(parseComponentKey("Metrics.edgeByHour[x]")).toBeNull();
  });

  it("registers resolvers that cache one model per trades array and instance", () => {
    let calls = 0;
    registerComponentParity<{ n: number; inst: string }>({
      component: "SupportTestProbe",
      brands: ["dojix"],
      compute: (_ctx, trades, instance) => {
        calls += 1;
        return instance === "none" ? undefined : { n: trades.length, inst: instance ?? "" };
      },
      members: { n: (m) => m.n, inst: (m) => m.inst },
      integerMembers: ["n"],
    });
    const ctx = parityContext("dojix", 0);
    const trades = fxSeries(["1", "2"]);
    expect(resolveParityOutput("SupportTestProbe.n", ctx, trades)).toEqual({ value: 2, integer: true });
    expect(resolveParityOutput("SupportTestProbe.inst", ctx, trades)).toEqual({ value: "", integer: false });
    expect(calls).toBe(1);
    expect(resolveParityOutput("SupportTestProbe[a].inst", ctx, trades)).toEqual({ value: "a", integer: false });
    expect(resolveParityOutput("SupportTestProbe[none].inst", ctx, trades)).toBeUndefined();
    expect(resolveParityOutput("SupportTestProbe.missing", ctx, trades)).toBeUndefined();
    expect(resolveParityOutput("SupportTestProbe.n", createEngineContext({ brand: "greenwick", now: 0 }), [])).toBeUndefined();
    expect(resolveParityOutput("SupportTestProbe.n.x", ctx, trades)).toBeUndefined();
  });
});
