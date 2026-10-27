import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade, stTrade } from "../test-support/trades";
import { computeTagAnalytics, tagAnalyticsComponent, tagAnalyticsParity, tradesByTag } from "./tag-analytics";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const st = createEngineContext({ brand: "greenwick", now: 0, compat: "swift" });

describe("TagAnalytics", () => {
  const trades = [
    fxTrade({ netProfit: "100", rMultiple: 2, tags: ["breakout", "news"] }),
    fxTrade({ netProfit: "-40", rMultiple: -1, tags: ["breakout"] }),
    fxTrade({ netProfit: "-150", rMultiple: -1.5, tags: ["fade"] }),
    fxTrade({ netProfit: "0", rMultiple: 0, tags: [] }),
    fxTrade({ netProfit: "10", rMultiple: 0.5, tags: ["news", "news"] }),
  ];

  it("groups per tag (duplicates count twice) and sorts by |profit| descending", () => {
    const m = computeTagAnalytics(trades);
    expect(m.tagData.map((d) => d.tag)).toEqual(["fade", "news", "breakout"]);
    expect(m.tagData[0]).toEqual({ id: "fade", tag: "fade", profit: -150, tradeCount: 1, winRate: 0, avgR: -1.5 });
    expect(m.tagData[1]).toEqual({ id: "news", tag: "news", profit: 120, tradeCount: 3, winRate: 100, avgR: 1 });
    expect(m.tagData[2]).toEqual({ id: "breakout", tag: "breakout", profit: 60, tradeCount: 2, winRate: 50, avgR: 0.5 });
    expect(m.taggedTradeCount).toBe(4);
    expect(tradesByTag(trades).get("news")).toHaveLength(3);
  });

  it("breaks |profit| ties by first appearance and keeps 8 chart rows", () => {
    const many = Array.from({ length: 10 }, (_, i) => fxTrade({ netProfit: i % 2 ? "5" : "-5", tags: [`t${i}`] }));
    const m = computeTagAnalytics(many);
    expect(m.tagData.map((d) => d.tag)).toEqual(many.map((_, i) => `t${i}`));
    expect(m.chartData).toHaveLength(8);
  });

  it("returns null (empty state) without tags; Greenwick too", () => {
    const reg = new AnalyticsRegistry().register(tagAnalyticsComponent);
    expect(reg.run("TagAnalytics", fx, [fxTrade()])).toBeNull();
    expect(reg.run("TagAnalytics", st, [stTrade({ tags: ["gap"], netProfit: "3" })])).toMatchObject({ taggedTradeCount: 1 });
    expect(reg.list("dojix", "edgeReport").map((c) => c.id)).toEqual(["TagAnalytics"]);
  });

  it("encodes tagData and taggedTradeCount", () => {
    const m = tagAnalyticsParity.compute(fx, trades.slice(0, 1), undefined);
    expect(m && tagAnalyticsParity.members.tagData?.(m, fx)).toEqual([
      { id: "breakout", tag: "breakout", profit: 100, tradeCount: 1, winRate: 100, avgR: 2 },
      { id: "news", tag: "news", profit: 100, tradeCount: 1, winRate: 100, avgR: 2 },
    ]);
    expect(m && tagAnalyticsParity.members.taggedTradeCount?.(m, fx)).toBe(1);
  });
});

describe("TagAnalytics properties", () => {
  it("never throws on hostile tags and values; no NaN for valid trades", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: fc.integer({ min: -1e9, max: 1e9 }), tags: fc.array(fc.string({ maxLength: 4 }), { maxLength: 4 }), r: fc.double({ min: -1e6, max: 1e6, noNaN: true }) }), {
          maxLength: 25,
        }),
        (rows) => {
          const m = computeTagAnalytics(rows.map((r) => fxTrade({ netProfit: String(r.p), tags: r.tags, rMultiple: r.r })));
          let n = 0;
          for (const d of m.tagData) {
            for (const v of [d.winRate, d.avgR, d.profit]) expect(Number.isNaN(v)).toBe(false);
            n += d.tradeCount;
          }
          expect(n).toBe(rows.reduce((s, r) => s + r.tags.length, 0));
          expect(() => computeTagAnalytics([fxTrade({ netProfit: "x", rMultiple: NaN, tags: ["a"] })])).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});
