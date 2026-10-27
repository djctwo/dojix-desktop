import { describe, expect, it } from "vitest";
import { parityContext } from "../engine/context";
import { fxSeries } from "../test-support/trades";
import { compareParity, decodeReferenceNumber, pathWithin } from "./compare";
import { coveredBy, coveringIds, isProposal, parseDivergences, unapprovedHeadlineFixes } from "./divergences";
import { decodeReferenceNow, parseReferenceFile, referenceContext, registerParityResolver, resolveParityOutput } from "./reference";

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

  it("names mismatches from the given root", () => {
    expect(compareParity({ a: 1 }, { a: 2 }, {}, "outputs.X")).toEqual([{ path: "outputs.X.a", expected: 1, actual: 2 }]);
  });

  it("compares nondeterministic arrays as multisets, under the same equality rule", () => {
    const opts = { unordered: ["outputs.C.symbolCosts"] };
    const mac = [{ s: "B", c: 2 }, { s: "A", c: 2 }, { s: "C", c: 0.8 }];
    const desk = [{ s: "A", c: 2 }, { s: "C", c: 0.8 + 1e-12 }, { s: "B", c: 2 }];
    expect(compareParity(mac, desk, {}, "outputs.C.symbolCosts")).not.toEqual([]);
    expect(compareParity(mac, desk, opts, "outputs.C.symbolCosts")).toEqual([]);
    // Below a listed path too; an unmatched element is reported against a spare one.
    expect(compareParity({ x: [1, 2] }, { x: [2, 1] }, { unordered: ["outputs.C"] }, "outputs.C")).toEqual([]);
    expect(compareParity([1, 2, 2], [2, 1, 3], opts, "outputs.C.symbolCosts")).toEqual([
      { path: "outputs.C.symbolCosts[2]", expected: 2, actual: 3 },
    ]);
    expect(compareParity([1], [1, 2], opts, "outputs.C.symbolCosts")).toHaveLength(1);
    // Other paths stay ordered.
    expect(compareParity([1, 2], [2, 1], opts, "outputs.D")).toHaveLength(2);
  });

  it("matches paths by prefix at . and [ boundaries only", () => {
    expect(pathWithin("outputs.A.b", "outputs.A")).toBe(true);
    expect(pathWithin("outputs.A[3]", "outputs.A")).toBe(true);
    expect(pathWithin("outputs.A", "outputs.A")).toBe(true);
    expect(pathWithin("outputs.AB", "outputs.A")).toBe(false);
  });
});

describe("golden/divergences.yaml", () => {
  const yaml = [
    "# comment",
    "- id: D-01",
    "  app: both",
    "  headline: false",
    "  approved: true",
    '  reason: "WinLossDistribution top bucket"',
    "  test: packages/core/src/analytics/x.test.ts",
    '  affects: ["outputs.WinLossDistribution"]',
    "  fixtures: []",
    "- id: D-15",
    "  app: dojix",
    "  headline: false",
    "  approved: true",
    "  reason: bare text",
    "  test: null",
    '  affects: ["import.parsed", "outputs.*"]',
    '  fixtures: ["dojix/f5-ctrader"]',
  ].join("\n");

  it("parses the flat subset", () => {
    const d = parseDivergences(yaml);
    expect(d.map((x) => [x.id, x.app, x.test])).toEqual([
      ["D-01", "both", "packages/core/src/analytics/x.test.ts"],
      ["D-15", "dojix", null],
    ]);
    expect(d[1]?.reason).toBe("bare text");
  });

  it("covers paths by brand, fixture and affects pattern", () => {
    const d = parseDivergences(yaml);
    expect(coveredBy(d, "greenwick/f1-tiny", "outputs.WinLossDistribution.buckets[0]")?.id).toBe("D-01");
    expect(coveredBy(d, "greenwick/f1-tiny", "outputs.WinLossDistributionX")).toBeUndefined();
    expect(coveredBy(d, "dojix/f5-ctrader", "outputs.Metrics.winRate")?.id).toBe("D-15");
    expect(coveredBy(d, "dojix/f5-oanda", "outputs.Metrics.winRate")).toBeUndefined();
    expect(coveredBy(d, "greenwick/f5-ctrader", "import.parsed")).toBeUndefined();
    expect(coveringIds(d, "dojix/f5-ctrader", "outputs.WinLossDistribution")).toEqual(["D-01", "D-15"]);
  });

  it("proposals cover nothing; an implemented headline fix needs approval", () => {
    const proposal = parseDivergences(yaml.replace("approved: true\n  reason: bare", "approved: false\n  reason: bare"));
    expect(proposal.map(isProposal)).toEqual([false, true]);
    expect(coveredBy(proposal, "dojix/f5-ctrader", "import.parsed")).toBeUndefined();
    expect(unapprovedHeadlineFixes(proposal)).toEqual([]);
    const headline = parseDivergences(yaml.replace("headline: false\n  approved: true\n  reason: \"Win", "headline: true\n  approved: false\n  reason: \"Win"));
    expect(unapprovedHeadlineFixes(headline)).toEqual(["D-01"]);
  });

  it("rejects unsupported syntax and incomplete entries", () => {
    expect(() => parseDivergences("id: D-01")).toThrow(/unsupported syntax/);
    expect(() => parseDivergences("- id: D-01\n  app: both")).toThrow(/missing headline/);
    expect(() => parseDivergences(yaml.replace('["dojix/f5-ctrader"]', '"x"'))).toThrow(/must be lists/);
    expect(() => parseDivergences(yaml.replace("app: dojix", "app: other"))).toThrow(/unknown app/);
    expect(parseDivergences('- id: X\n  app: both\n  headline: false\n  approved: false\n  reason: [bad\n  test: null\n  affects: []\n  fixtures: []')[0]?.reason).toBe("[bad");
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

  it("read the environment, import section and markers, with defaults for older files", () => {
    const full = {
      ...good,
      fixture: "dojix/f7-ctrader-utc",
      tz: "Europe/Berlin",
      locale: "en_GB",
      firstWeekday: 2,
      minimumDaysInFirstWeek: 4,
      import: { journal: [] },
      skipped: { "X.y": "crash" },
      nondeterministic: ["outputs.A"],
    };
    const r = parseReferenceFile("golden/reference/dojix/f7-ctrader-utc@Europe-Berlin_en_GB.json", full);
    expect(r).toMatchObject({ fixture: "f7-ctrader-utc@Europe-Berlin_en_GB", fixtureId: "dojix/f7-ctrader-utc", firstWeekday: 2, minimumDaysInFirstWeek: 4 });
    expect(r.skipped).toEqual({ "X.y": "crash" });
    expect(r.nondeterministic).toEqual(["outputs.A"]);
    const ctx = referenceContext(r);
    expect(ctx).toMatchObject({ locale: "en_GB", compat: "swift", now: 1_793_000_000_000 });
    expect(ctx.calendar.spec).toEqual({ tz: "Europe/Berlin", weekStart: 2, minDaysInFirstWeek: 4 });
    expect(referenceContext(r, "fixed").compat).toBe("fixed");
    const old = parseReferenceFile("golden/reference/greenwick/f1@Asia-Tokyo_ja_JP.json", good);
    expect(old).toMatchObject({ fixtureId: "greenwick/f1", firstWeekday: 1, minimumDaysInFirstWeek: 1, import: {}, skipped: {}, nondeterministic: [] });
    expect(() => parseReferenceFile("golden/reference/dojix/F1.json", { ...good, firstWeekday: 1.5 })).toThrow(/firstWeekday/);
    expect(() => parseReferenceFile("golden/reference/dojix/F1.json", { ...good, skipped: [] })).toThrow(/skipped/);
    expect(() => parseReferenceFile("golden/reference/dojix/F1.json", { ...good, nondeterministic: [1] })).toThrow(/nondeterministic/);
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
