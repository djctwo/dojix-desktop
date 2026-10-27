import { describe, expect, it } from "vitest";
import {
  groupByFirstAppearance,
  maxBy,
  minBy,
  seqMax,
  seqMin,
  stableSorted,
  sumInOrder,
  swiftMax,
  swiftMin,
} from "./collections";

const byValue = (a: { v: number }, b: { v: number }) => a.v < b.v;

describe("max(by:) / min(by:) tie behaviour", () => {
  const items = [
    { v: 1, id: "a" },
    { v: 5, id: "b" },
    { v: 0, id: "c" },
    { v: 5, id: "d" },
    { v: 0, id: "e" },
  ];

  it("max(by:) returns the FIRST maximum (Tier B: TradeComparison on dojix/f3-all-breakeven picks the first of six 0.00 trades)", () => {
    expect(maxBy(items, byValue)?.id).toBe("b");
  });

  it("min(by:) returns the FIRST minimum (TradeComparison worst)", () => {
    expect(minBy(items, byValue)?.id).toBe("c");
  });

  it("returns undefined on empty input", () => {
    expect(maxBy([], byValue)).toBeUndefined();
    expect(minBy([], byValue)).toBeUndefined();
    expect(seqMax([])).toBeUndefined();
    expect(seqMin([])).toBeUndefined();
  });

  it("[Double].max()/min() treat NaN the Swift way", () => {
    expect(seqMax([1, 3, 2])).toBe(3);
    expect(seqMin([1, 3, -2])).toBe(-2);
    // max: result < e is false against NaN, so a NaN element is skipped and a leading NaN sticks.
    expect(seqMax([1, NaN, 2])).toBe(2);
    expect(seqMax([1, 2, NaN])).toBe(2);
    expect(seqMax([NaN, 1, 2])).toBeNaN();
    expect(Math.max(1, NaN, 2)).toBeNaN(); // the JS behaviour this differs from
    // min: e < result is false against NaN, so a leading NaN sticks.
    expect(seqMin([NaN, 1, 2])).toBeNaN();
    expect(seqMin([1, NaN, 0])).toBe(0);
  });
});

describe("global max/min", () => {
  it("max(x, y) returns y on ties and ignores a NaN y", () => {
    expect(swiftMax(1, 2)).toBe(2);
    expect(Object.is(swiftMax(0, -0), -0)).toBe(true); // y >= x → y
    expect(swiftMax(1, NaN)).toBe(1);
    expect(swiftMax(NaN, 1)).toBeNaN();
  });

  it("min(x, y) returns x on ties", () => {
    expect(swiftMin(1, 2)).toBe(1);
    expect(Object.is(swiftMin(0, -0), 0)).toBe(true);
    expect(swiftMin(1, NaN)).toBe(1);
    expect(swiftMin(NaN, 1)).toBeNaN();
  });
});

describe("stableSorted", () => {
  it("keeps input order for ties, like Swift 5's sort", () => {
    const rows = [
      { v: 2, id: "a" },
      { v: 1, id: "b" },
      { v: 2, id: "c" },
      { v: 1, id: "d" },
    ];
    expect(stableSorted(rows, byValue).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
    expect(stableSorted(rows, (a, b) => a.v > b.v).map((r) => r.id)).toEqual(["a", "c", "b", "d"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]); // input untouched
  });
});

describe("groupByFirstAppearance", () => {
  it("orders groups by first appearance", () => {
    const g = groupByFirstAppearance(["b1", "a1", "b2", "c1", "a2"], (s) => s[0]);
    expect([...g.keys()]).toEqual(["b", "a", "c"]);
    expect(g.get("a")).toEqual(["a1", "a2"]);
  });
});

describe("sumInOrder", () => {
  it("sums left to right (order changes the floating-point result)", () => {
    expect(sumInOrder([0.1, 0.2, 0.3])).toBe(0.1 + 0.2 + 0.3);
    expect(sumInOrder([0.3, 0.2, 0.1])).toBe(0.3 + 0.2 + 0.1);
    expect(sumInOrder([0.1, 0.2, 0.3])).not.toBe(sumInOrder([0.3, 0.2, 0.1]));
  });
});
