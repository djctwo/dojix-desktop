import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade, stTrade } from "../test-support/trades";
import { computePlaybookCatalog, playbookCatalogComponent, playbookCatalogParity, playbookSetupRef } from "./playbook-catalog";
import { computeTagAnalytics } from "./tag-analytics";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const st = createEngineContext({ brand: "greenwick", now: 0, compat: "swift" });

describe("PlaybookCatalog", () => {
  const t = (p: string, tags: string[], i: number, session: "LONDON" | "NY" | "ASIAN" = "LONDON", r = 1) =>
    fxTrade({ ticket: `${100 + i}`, netProfit: p, tags, session, rMultiple: r, closeTime: Date.UTC(2026, 0, 1) + i * 60_000 });

  it("computes per-setup metrics, sessions, the last 10 P&Ls and the classification", () => {
    // repository order (close desc): build ascending then reverse
    const asc = [
      t("50", ["keep"], 0, "LONDON"),
      t("-20", ["keep"], 1, "NY"),
      t("30", ["keep"], 2, "NY"),
      t("40", ["keep"], 3, "ASIAN"),
      t("-10", ["keep"], 4, "LONDON"),
      ...Array.from({ length: 6 }, (_, i) => t("-10", ["drop"], 5 + i, "ASIAN", -1)),
      t("10", ["drop"], 11, "LONDON", 1),
      t("5", ["review"], 12),
    ];
    const m = computePlaybookCatalog([...asc].reverse());
    expect(m.setups.map((s) => s.name)).toEqual(["keep", "drop", "review"]);
    const keep = m.setups[0];
    expect(keep).toMatchObject({ tradeCount: 5, winRate: 60, avgR: 1, totalPnL: 90, profitFactor: 4, classification: "KEEP" });
    expect(keep?.bestSession).toBe("LONDON"); // LONDON 40, NY 10, ASIAN 40: the first maximum in first-appearance order
    expect(keep?.worstSession).toBe("NY");
    expect(keep?.recentPnL).toEqual([50, -20, 30, 40, -10]);
    const drop = m.setups[1];
    expect(drop).toMatchObject({ tradeCount: 7, profitFactor: 10 / 60, classification: "DROP", totalPnL: -50 });
    expect(drop?.recentPnL).toHaveLength(7);
    expect(m.setups[2]).toMatchObject({ profitFactor: 99.99, classification: "REVIEW" });
    expect(m.keepSetups.map((s) => s.name)).toEqual(["keep"]);
    expect(m.dropSetups.map((s) => s.name)).toEqual(["drop"]);
    expect(m.reviewSetups.map((s) => s.name)).toEqual(["review"]);
  });

  it("keeps the last 10 by close time; PF 0 with neither wins nor losses; Greenwick sessions", () => {
    const asc = Array.from({ length: 12 }, (_, i) => t(String(i + 1), ["x"], i));
    expect(computePlaybookCatalog([...asc].reverse()).setups[0]?.recentPnL).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const flat = computePlaybookCatalog([1, 2, 3, 4, 5].map((i) => t("0", ["flat"], i))).setups[0];
    expect(flat).toMatchObject({ profitFactor: 0, classification: "DROP" });
    const g = computePlaybookCatalog([stTrade({ tags: ["gap"], netProfit: "1", session: "PRE_MARKET" })]).setups[0];
    expect(g).toMatchObject({ bestSession: "PRE_MARKET", worstSession: "PRE_MARKET", classification: "REVIEW" });
  });

  it("is registered on the behavioral tab with an empty state", () => {
    const reg = new AnalyticsRegistry().register(playbookCatalogComponent);
    expect(reg.run("PlaybookCatalog", fx, [fxTrade()])).toBeNull();
    expect(reg.run("PlaybookCatalog", st, [stTrade({ tags: ["a"] })])).not.toBeNull();
    expect(reg.list("greenwick", "behavioral").map((c) => c.id)).toEqual(["PlaybookCatalog"]);
  });

  it("encodes SetupData with trades as #ticket and the RefDumpable classification", () => {
    const trades = [t("5", ["solo"], 1)];
    const m = playbookCatalogParity.compute(fx, trades, undefined);
    const expected = {
      id: "solo",
      name: "solo",
      trades: ["#101"],
      tradeCount: 1,
      winRate: 100,
      avgR: 1,
      profitFactor: 99.99,
      totalPnL: 5,
      bestSession: "LONDON",
      worstSession: "LONDON",
      recentPnL: [5],
      classification: { $case: "review", $raw: "REVIEW", icon: "exclamationmark.triangle.fill" },
    };
    expect(m && playbookCatalogParity.members.setups?.(m, fx)).toEqual([expected]);
    expect(m && playbookCatalogParity.members.reviewSetups?.(m, fx)).toEqual([expected]);
    expect(m && playbookCatalogParity.members.keepSetups?.(m, fx)).toEqual([]);
    expect(m && playbookCatalogParity.members.dropSetups?.(m, fx)).toEqual([]);
    const keep = computePlaybookCatalog([1, 2, 3, 4, 5].map((i) => t("5", ["k"], i))).setups[0];
    expect(keep && (playbookSetupRef(keep) as { classification: unknown }).classification).toEqual({ $case: "keep", $raw: "KEEP", icon: "checkmark.seal.fill" });
  });

  it("never throws and yields no NaN for valid trades", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: fc.integer({ min: -1e6, max: 1e6 }), tags: fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 3 }), r: fc.double({ min: -50, max: 50, noNaN: true }) }), {
          maxLength: 25,
        }),
        (rows) => {
          const trades = rows.map((r, i) => fxTrade({ netProfit: String(r.p), tags: r.tags, rMultiple: r.r, closeTime: i * 1000 }));
          for (const s of computePlaybookCatalog(trades).setups) {
            for (const v of [s.winRate, s.avgR, s.profitFactor, s.totalPnL]) expect(Number.isNaN(v)).toBe(false);
            expect(Number.isFinite(s.profitFactor)).toBe(true);
          }
          for (const d of computeTagAnalytics(trades).tagData) for (const v of [d.winRate, d.avgR, d.profit]) expect(Number.isNaN(v)).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });
});
