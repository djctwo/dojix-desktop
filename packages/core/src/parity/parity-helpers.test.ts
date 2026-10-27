import { describe, expect, it } from "vitest";
import { parityContext } from "../engine/context";
import { fxSeries } from "../test-support/trades";
import { compareParity, decodeReferenceNumber } from "./compare";
import { decodeReferenceNow, parseReferenceFile, registerParityResolver, resolveParityOutput } from "./reference";

describe("compareParity (SPEC §10.1)", () => {
  it("uses 1e-9 relative tolerance for doubles", () => {
    expect(compareParity(100, 100 + 1e-8)).toEqual([]);
    expect(compareParity(100, 100 + 1e-6)).toHaveLength(1);
    expect(compareParity(0, 5e-10)).toEqual([]);
    expect(compareParity(0, 2e-9)).toHaveLength(1);
  });

  it("is exact for integers when asked, and for strings and booleans", () => {
    expect(compareParity(3, 3 + 1e-12, { exactIntegers: true })).toHaveLength(1);
    expect(compareParity(3, 3, { exactIntegers: true })).toEqual([]);
    expect(compareParity("9:00", "09:00")).toHaveLength(1);
    expect(compareParity(true, true)).toEqual([]);
    expect(compareParity(null, null)).toEqual([]);
    expect(compareParity("x", 1)).toHaveLength(1);
  });

  it("matches ±∞ and NaN, including string spellings", () => {
    expect(compareParity("inf", Infinity)).toEqual([]);
    expect(compareParity("-Infinity", -Infinity)).toEqual([]);
    expect(compareParity("+inf", 1e308)).toHaveLength(1);
    expect(compareParity(Infinity, -Infinity)).toHaveLength(1);
    expect(compareParity("nan", NaN)).toEqual([]);
    expect(compareParity(NaN, 1)).toHaveLength(1);
    expect(compareParity(1, Infinity)).toHaveLength(1);
    expect(decodeReferenceNumber("hello")).toBeUndefined();
    expect(decodeReferenceNumber(null)).toBeUndefined();
  });

  it("walks arrays and objects and reports paths", () => {
    expect(compareParity([1, { a: 2 }], [1, { a: 2 }])).toEqual([]);
    expect(compareParity({ a: [1, 2] }, { a: [1, 3] })).toEqual([{ path: "$.a[1]", expected: 2, actual: 3 }]);
    expect(compareParity([1], [1, 2])).toHaveLength(1);
    expect(compareParity([1], "x")).toHaveLength(1);
    expect(compareParity({ a: 1 }, [1])).toHaveLength(1);
    expect(compareParity({ a: 1 }, { a: 1, b: 2 })).toEqual([{ path: "$.b", expected: undefined, actual: 2 }]);
  });
});

describe("reference files", () => {
  const good = { source_sha: "614bd6a", xcode: "16.4", tz: "UTC", locale: "en_US_POSIX", now: 1_793_000_000, outputs: { "Metrics.winRate": 60 } };

  it("parse with brand and fixture from the path", () => {
    const r = parseReferenceFile("../../golden/reference/dojix/F1-tiny.json", good);
    expect(r).toMatchObject({ brand: "dojix", fixture: "F1-tiny", sourceSha: "614bd6a", now: 1_793_000_000_000 });
    expect(parseReferenceFile("golden\\reference\\greenwick\\sub/F7.json", good).fixture).toBe("sub/F7");
  });

  it("reject malformed files", () => {
    expect(() => parseReferenceFile("golden/fixtures/x.json", good)).toThrow(/not a reference path/);
    expect(() => parseReferenceFile("golden/reference/other/F1.json", good)).toThrow(/unknown brand/);
    expect(() => parseReferenceFile("golden/reference/dojix/F1.json", null)).toThrow(/not an object/);
    expect(() => parseReferenceFile("golden/reference/dojix/F1.json", { ...good, xcode: 16 })).toThrow(/xcode/);
    expect(() => parseReferenceFile("golden/reference/dojix/F1.json", { ...good, outputs: [] })).toThrow(/outputs/);
  });

  it("decode now in seconds, ms or ISO text", () => {
    expect(decodeReferenceNow(1_793_000_000)).toBe(1_793_000_000_000);
    expect(decodeReferenceNow(1_793_000_000_000)).toBe(1_793_000_000_000);
    expect(decodeReferenceNow("2026-10-27T00:00:00Z")).toBe(Date.UTC(2026, 9, 27));
    expect(() => decodeReferenceNow("soon")).toThrow(TypeError);
    expect(() => decodeReferenceNow(undefined)).toThrow(TypeError);
  });
});

describe("resolvers", () => {
  const ctx = parityContext("dojix", 0);
  const trades = fxSeries(["100", "50", "-30", "-20", "80"]);

  it("resolve Metrics.* keys", () => {
    expect(resolveParityOutput("Metrics.expectancy", ctx, trades)).toEqual({ value: 36, integer: false });
    expect(resolveParityOutput("Metrics.totalTrades", ctx, trades)).toEqual({ value: 5, integer: true });
    expect(resolveParityOutput("Metrics.nope", ctx, trades)).toBeUndefined();
    expect(resolveParityOutput("WinLossDistribution.median", ctx, trades)).toBeUndefined();
  });

  it("accept new prefixes once", () => {
    registerParityResolver("Test.", (key) => (key === "Test.one" ? { value: 1 } : undefined), ["Test.one"]);
    expect(resolveParityOutput("Test.one", ctx, trades)).toEqual({ value: 1, integer: true });
    expect(resolveParityOutput("Test.two", ctx, trades)).toBeUndefined();
    expect(() => registerParityResolver("Test.", () => undefined)).toThrow(/twice/);
  });
});
