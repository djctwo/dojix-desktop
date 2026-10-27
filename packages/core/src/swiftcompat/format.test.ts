import { describe, expect, it } from "vitest";
import {
  asCompactCurrency,
  asCurrency,
  asPercent,
  asPips,
  asPoints,
  asProfitFactor,
  asRMultiple,
  formatFixed,
  icuRoundHalfEven,
  swiftFormat,
} from "./format";
import { INT_MAX, INT_MIN } from "./int";

describe("formatFixed (printf %.Nf)", () => {
  it("rounds the exact binary value half-to-even, unlike toFixed", () => {
    expect(formatFixed(0.125, 2)).toBe("0.12"); // exact tie → even
    expect((0.125).toFixed(2)).toBe("0.13"); // the JS trap
    expect(formatFixed(0.375, 2)).toBe("0.38");
    expect(formatFixed(2.5, 0)).toBe("2");
    expect(formatFixed(3.5, 0)).toBe("4");
    expect(formatFixed(1.005, 2)).toBe("1.00"); // binary 1.00499999…
    expect(formatFixed(2.675, 2)).toBe("2.67");
  });

  it("keeps a minus sign on negative zero and on negatives that round to zero", () => {
    expect(formatFixed(-0, 2)).toBe("-0.00");
    expect((-0).toFixed(2)).toBe("0.00");
    expect(formatFixed(-0.001, 2)).toBe("-0.00");
    expect(formatFixed(-0.125, 2)).toBe("-0.12");
  });

  it("prints non-finite values like printf and never uses exponent notation", () => {
    expect(formatFixed(NaN, 2)).toBe("nan");
    expect(formatFixed(Infinity, 1)).toBe("inf");
    expect(formatFixed(-Infinity, 1)).toBe("-inf");
    expect(formatFixed(1e21, 0)).toBe("1000000000000000000000");
    expect(formatFixed(1e22, 1)).toBe("10000000000000000000000.0");
    expect(formatFixed(5e-324, 3)).toBe("0.000");
    expect(formatFixed(123.456)).toBe("123.456000");
  });

  it("validates the precision", () => {
    expect(() => formatFixed(1, -1)).toThrow(RangeError);
    expect(() => formatFixed(1, 1.5)).toThrow(RangeError);
  });
});

describe("swiftFormat (String(format:))", () => {
  it("formats the conversions the apps use", () => {
    expect(swiftFormat("%.1fR", 1.25)).toBe("1.2R"); // RMultipleChart bucket label
    expect(swiftFormat("%02d-%02d UTC", 7, 9)).toBe("07-09 UTC"); // KillZone label
    expect(swiftFormat("%04d-%02d-%02d", 2026, 3, 8)).toBe("2026-03-08"); // dayKey
    expect(swiftFormat("%.1f%%", 65.44)).toBe("65.4%");
    expect(swiftFormat("%d trades", 12)).toBe("12 trades");
    expect(swiftFormat("%@ / %s", "a", "b")).toBe("a / b");
    expect(swiftFormat("%ld|%lld|%i|%u", 1, 2, 3, 4)).toBe("1|2|3|4");
  });

  it("supports flags, width and precision", () => {
    expect(swiftFormat("%5d|%-5d|%+d|% d", 42, 42, 42, 42)).toBe("   42|42   |+42| 42");
    expect(swiftFormat("%08.2f", -3.14159)).toBe("-0003.14");
    expect(swiftFormat("%+.1f", 2.25)).toBe("+2.2");
    expect(swiftFormat("%.3d", 7)).toBe("007");
    expect(swiftFormat("%F", Infinity)).toBe("INF");
    expect(swiftFormat("%6.2s|", "abcdef")).toBe("    ab|");
    expect(swiftFormat("%08.1f", NaN)).toBe("     nan");
    expect(swiftFormat("%d", 5n)).toBe("5");
  });

  it("prints Swift's Int.max digits for the saturated value", () => {
    expect(swiftFormat("%d", INT_MAX)).toBe("9223372036854775807");
    expect(swiftFormat("%d", INT_MIN)).toBe("-9223372036854775808");
  });

  it("fails loudly on misuse", () => {
    expect(() => swiftFormat("%d", 1.5)).toThrow(TypeError);
    expect(() => swiftFormat("%d", "x")).toThrow(TypeError);
    expect(() => swiftFormat("%f", "x")).toThrow(TypeError);
    expect(() => swiftFormat("%d")).toThrow(RangeError);
    expect(() => swiftFormat("%e", 1)).toThrow(RangeError);
    expect(() => swiftFormat("%x", 1)).toThrow(RangeError);
    expect(swiftFormat("100%%")).toBe("100%");
  });
});

describe("Double+Formatting (both apps)", () => {
  // Dojix DojixTests/FormattingTests.swift:23-65
  it("matches the Mac formatting tests", () => {
    expect(asPips(12.5)).toBe("12.5 pips");
    expect(asPips(0)).toBe("0.0 pips");
    expect(asPips(-3.2)).toBe("-3.2 pips");
    expect(asPercent(65.4)).toBe("65.4%");
    expect(asPercent(100)).toBe("100.0%");
    expect(asRMultiple(1.5)).toBe("1.50R");
    expect(asRMultiple(-0.3)).toBe("-0.30R");
    expect(asProfitFactor(1.85)).toBe("1.85");
    expect(asProfitFactor(0)).toBe("0.00");
    expect(asCompactCurrency(15300)).toContain("15.3K");
    expect(asCompactCurrency(1200000)).toContain("1.2M");
    expect(asCompactCurrency(500)).toContain("500.00");
    expect(asCompactCurrency(-5000)).toBe("-$5.0K");
    expect(asCurrency(1234.56)).toBe("$1,234.56");
    expect(asCurrency(-500)).toBe("-$500.00");
    expect(asCurrency(0)).toBe("$0.00");
    expect(asCurrency(250.75)).toBe("$250.75");
  });

  it("shows an infinite profit factor as 99.99", () => {
    expect(asProfitFactor(Infinity)).toBe("99.99");
    expect(asProfitFactor(-Infinity)).toBe("99.99");
    expect(asPoints(12.5)).toBe("12.5 pts");
  });

  it("rounds currency like ICU: shortest digits, half-even", () => {
    expect(asCurrency(2.675)).toBe("$2.68"); // printf would say 2.67
    expect(asCurrency(0.125)).toBe("$0.12");
    expect(asCurrency(0.135)).toBe("$0.14");
    expect(asCurrency(1234567.891)).toBe("$1,234,567.89");
    expect(asCurrency(0.005)).toBe("$0.00");
    expect(asCurrency(0.0051)).toBe("$0.01");
    expect(asCurrency(1e-7)).toBe("$0.00");
    expect(asCurrency(9.995)).toBe("$10.00");
    expect(asCurrency(-0)).toBe("-$0.00");
    expect(asCurrency(NaN)).toBe("NaN");
    expect(asCurrency(Infinity)).toBe("$∞");
    expect(asCurrency(-Infinity)).toBe("-$∞");
    expect(icuRoundHalfEven(1e21, 2)).toBe("1000000000000000000000.00");
  });

  it("compact currency keeps the Mac thresholds", () => {
    expect(asCompactCurrency(999.99)).toBe("$999.99");
    expect(asCompactCurrency(999999)).toBe("$1000.0K");
  });
});
