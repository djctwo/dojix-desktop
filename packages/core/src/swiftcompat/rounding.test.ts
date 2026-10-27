import { describe, expect, it } from "vitest";
import { swiftRounded } from "./rounding";

describe("swiftRounded", () => {
  it(".rounded() is half away from zero (PositionSizer.swift:35), unlike Math.round", () => {
    expect(swiftRounded(2.5)).toBe(3);
    expect(swiftRounded(-2.5)).toBe(-3);
    expect(Math.round(-2.5)).toBe(-2); // the JS trap this avoids
    expect(swiftRounded(0.49999999999999994)).toBe(0);
    expect(swiftRounded(1.4999)).toBe(1);
  });

  it("keeps the sign of zero", () => {
    expect(Object.is(swiftRounded(-0.4), -0)).toBe(true);
    expect(Object.is(swiftRounded(0.4), 0)).toBe(true);
    expect(Object.is(swiftRounded(-0), -0)).toBe(true);
  });

  it("supports the other rules", () => {
    expect(swiftRounded(2.5, "toNearestOrEven")).toBe(2);
    expect(swiftRounded(3.5, "toNearestOrEven")).toBe(4);
    expect(swiftRounded(-2.5, "toNearestOrEven")).toBe(-2);
    expect(swiftRounded(2.6, "toNearestOrEven")).toBe(3);
    expect(swiftRounded(2.4, "toNearestOrEven")).toBe(2);
    expect(swiftRounded(2.1, "up")).toBe(3);
    expect(swiftRounded(-2.1, "down")).toBe(-3);
    expect(swiftRounded(-2.9, "towardZero")).toBe(-2);
    expect(swiftRounded(-2.1, "awayFromZero")).toBe(-3);
    expect(swiftRounded(2.1, "awayFromZero")).toBe(3);
  });

  it("passes non-finite values through", () => {
    expect(swiftRounded(NaN)).toBeNaN();
    expect(swiftRounded(Infinity)).toBe(Infinity);
    expect(swiftRounded(-Infinity, "toNearestOrEven")).toBe(-Infinity);
  });

  it("rounds PositionSizer lots to 0.01 the Swift way", () => {
    const lots = 0.125; // exactly representable: a true tie
    expect(swiftRounded(lots * 100) / 100).toBe(0.13);
    expect(swiftRounded(-lots * 100) / 100).toBe(-0.13);
  });
});
