import { describe, expect, it } from "vitest";
import { idiv, INT_MAX, INT_MIN, intSaturating, irem, saturatingAverage, saturatingSum } from "./int";

describe("idiv (Swift Int /)", () => {
  it("truncates toward zero, unlike Math.floor", () => {
    expect(idiv(7, 2)).toBe(3);
    expect(idiv(-7, 2)).toBe(-3); // Math.floor would give -4
    expect(idiv(7, -2)).toBe(-3);
    expect(idiv(-7, -2)).toBe(3);
    expect(Object.is(idiv(-1, 2), 0)).toBe(true); // never -0
  });

  it("matches GrowthProjection's weeks = max(1, days) / 7 (Components/GrowthProjection.swift:15)", () => {
    expect(idiv(13, 7)).toBe(1);
    expect(idiv(1, 7)).toBe(0);
  });

  it("is exact beyond 2^53", () => {
    expect(idiv(2 ** 60, 3)).toBe(Number(2n ** 60n / 3n));
    expect(idiv(INT_MIN, 2)).toBe(-(2 ** 62));
  });

  it("throws where Swift traps", () => {
    expect(() => idiv(1, 0)).toThrow(RangeError);
    expect(() => idiv(INT_MIN, -1)).toThrow(RangeError);
    expect(() => idiv(1.5, 1)).toThrow(RangeError);
  });

  it("irem follows the dividend's sign and traps on zero", () => {
    expect(irem(-7, 2)).toBe(-1);
    expect(irem(7, -2)).toBe(1);
    expect(Object.is(irem(-4, 2), 0)).toBe(true);
    expect(() => irem(1, 0)).toThrow(RangeError);
    expect(() => irem(1.5, 1)).toThrow(RangeError);
  });
});

describe("intSaturating (Int(saturating:))", () => {
  // Dojix DojixTests/AnalyticsClampTests.swift:9-15
  it("matches the Mac's clamp tests", () => {
    for (const flavor of ["dojix", "greenwick"] as const) {
      expect(intSaturating(NaN, flavor)).toBe(0);
      expect(intSaturating(Infinity, flavor)).toBe(INT_MAX);
      expect(intSaturating(-Infinity, flavor)).toBe(INT_MIN);
      expect(intSaturating(1e21, flavor)).toBe(INT_MAX);
      expect(intSaturating(-1e21, flavor)).toBe(INT_MIN);
      expect(intSaturating(42.9, flavor)).toBe(42);
      expect(intSaturating(-42.9, flavor)).toBe(-42);
      expect(Object.is(intSaturating(-0.5, flavor), 0)).toBe(true);
    }
  });

  it("reproduces the Dojix literal 9.223_372_036_854_775e18 = 2^63 - 1024 (Numeric+Safe.swift:14)", () => {
    const edge = 2 ** 63 - 1024;
    expect(9.223_372_036_854_775e18).toBe(edge);
    expect(intSaturating(edge, "dojix")).toBe(INT_MAX);
    expect(intSaturating(edge, "greenwick")).toBe(edge); // Int+Saturating.swift:12 compares with 2^63
    expect(intSaturating(-edge, "dojix")).toBe(INT_MIN);
    expect(intSaturating(-edge, "greenwick")).toBe(-edge);
    expect(intSaturating(2 ** 63, "greenwick")).toBe(INT_MAX);
  });

  it("defaults to the Greenwick flavour", () => {
    expect(intSaturating(2 ** 63 - 1024)).toBe(2 ** 63 - 1024);
  });
});

describe("saturatingSum / saturatingAverage", () => {
  // AnalyticsClampTests.swift:16-19
  it("matches the Mac's clamp tests", () => {
    expect(saturatingSum([INT_MAX, 5])).toBe(INT_MAX);
    expect(saturatingSum([INT_MIN, -5])).toBe(INT_MIN);
    expect(saturatingAverage([INT_MAX, INT_MAX], "dojix")).toBe(INT_MAX);
    expect(saturatingAverage([])).toBe(0);
  });

  it("keeps adding after an overflow, like the Swift reduce (Numeric+Safe.swift:26-32)", () => {
    // Swift: total = .max after the overflow, then .max + (-10) = .max - 10.
    expect(saturatingSum([INT_MAX, 5, -10])).toBe(Number(2n ** 63n - 1n - 10n));
    expect(saturatingSum([1, 2, 3])).toBe(6);
    expect(saturatingSum([])).toBe(0);
  });

  it("averages in Double then truncates toward zero", () => {
    expect(saturatingAverage([30, 60, 90])).toBe(60); // MetricsCalculatorTests.testAverageDuration
    expect(saturatingAverage([1, 2])).toBe(1);
    expect(saturatingAverage([-1, -2])).toBe(-1);
  });

  it("rejects non-integers", () => {
    expect(() => saturatingSum([1.5])).toThrow(RangeError);
  });
});
