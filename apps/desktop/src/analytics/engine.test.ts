import { describe, expect, it } from "vitest";
import {
  AnalyticsRegistry,
  calculateMetrics,
  createAnalyticsRegistry,
  defineComponent,
  placementFor,
  toEngineTrade,
} from "@dojix-desktop/core";
import { loadFixture } from "../mock/fixtures";
import { TEST_SETTINGS } from "../test-support/render";
import { AnalyticsEngine, cloneSafe } from "./engine";
import { createInlineClient } from "./inline";
import { foundationLocale, weekRule, environmentSettings } from "./settings";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const base = { now: NOW, settings: TEST_SETTINGS, filter: {} };

describe("AnalyticsEngine", () => {
  it("runs every component of a placement in registry order, with the Mac's guards", async () => {
    const rows = await loadFixture("f2", "dojix");
    const engine = new AnalyticsEngine();
    expect(engine.load(1, "dojix", rows)).toEqual({ datasetId: 1, count: 600, skipped: [] });
    const registry = createAnalyticsRegistry();
    for (const placement of ["overview", "timing", "sessions", "pairs", "risk", "behavioral", "advanced", "edgeReport", "propFirm"] as const) {
      const result = engine.run({ ...base, datasetId: 1, placement });
      expect(result.cards.map((c) => c.id)).toEqual(registry.list("dojix", placement).map((c) => c.id));
      expect(result.tradeCount).toBe(600);
      for (const card of result.cards) {
        expect(card.result.status, `${placement}/${card.id}`).not.toBe("error");
      }
    }
  });

  it("reports belowMin under a component's minimum, and the metrics core computes", async () => {
    const rows = await loadFixture("f1", "greenwick");
    const engine = new AnalyticsEngine();
    engine.load(7, "greenwick", rows);
    const result = engine.run({ ...base, datasetId: 7, placement: "advanced", metrics: true });
    const edgeDecay = result.cards.find((c) => c.id === "EdgeDecayMonitor");
    expect(edgeDecay?.result).toEqual({ status: "belowMin", minTrades: 60, tradeCount: 5 });
    const expected = calculateMetrics(rows.map((r) => toEngineTrade(r, "greenwick")), { brand: "greenwick", compat: "fixed" });
    expect(result.metrics).toEqual(expected);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("filters by symbol and date range on the brand calendar", async () => {
    const rows = await loadFixture("f2", "dojix");
    const engine = new AnalyticsEngine();
    engine.load(2, "dojix", rows);
    const eur = engine.run({ ...base, datasetId: 2, componentIds: [], filter: { symbol: "EURUSD" } });
    expect(eur.tradeCount).toBe(rows.filter((r) => r.symbol === "EURUSD").length);
    const recent = engine.run({ ...base, datasetId: 2, componentIds: [], filter: { dateRange: "last30" } });
    expect(recent.tradeCount).toBeGreaterThan(0);
    expect(recent.tradeCount).toBeLessThan(600);
    expect(engine.run({ ...base, datasetId: 2, componentIds: [], filter: { dateRange: "all" } }).tradeCount).toBe(600);
  });

  it("turns null into empty, throws into error, and foreign or unknown ids into errors", () => {
    const registry = new AnalyticsRegistry()
      .register(defineComponent({ id: "Nothing", brands: ["dojix"], tab: "timing", minTrades: 0, compute: () => null }))
      .register(
        defineComponent({
          id: "Throws",
          brands: ["dojix"],
          tab: "timing",
          minTrades: 0,
          compute: () => {
            throw new Error("component bug");
          },
        }),
      )
      .register(defineComponent({ id: "StocksOnly", brands: ["greenwick"], tab: "timing", minTrades: 0, compute: () => 1 }));
    const engine = new AnalyticsEngine(registry);
    engine.load(3, "dojix", []);
    const result = engine.run({ ...base, datasetId: 3, componentIds: ["Nothing", "Throws", "StocksOnly"] });
    expect(result.cards.map((c) => c.result)).toEqual([
      { status: "empty" },
      { status: "error", message: "component bug" },
      { status: "error", message: "StocksOnly is not part of this app" },
    ]);
    expect(() => engine.run({ ...base, datasetId: 3, componentIds: ["Missing"] })).toThrow(/unknown analytics component/);
    expect(() => engine.run({ ...base, datasetId: 99, placement: "timing" })).toThrow(/not loaded/);
  });

  it("skips rows the engine can't read", () => {
    const engine = new AnalyticsEngine();
    const bad = { id: 9, openTime: "not a date" } as never;
    expect(engine.load(4, "dojix", [bad]).skipped).toEqual([{ id: 9, reason: expect.stringContaining("openTime") }]);
  });

  it("cloneSafe replaces models structured clone can't send", () => {
    const safe = cloneSafe({
      datasetId: 1,
      tradeCount: 1,
      ms: 1,
      cards: [
        { id: "A", minTrades: 0, result: { status: "ok", model: { f: () => 1 } } },
        { id: "B", minTrades: 0, result: { status: "ok", model: { n: 1 } } },
        { id: "C", minTrades: 0, result: { status: "empty" } },
      ],
    });
    expect(safe.cards[0]?.result.status).toBe("error");
    expect(safe.cards[1]?.result.status).toBe("ok");
    expect(safe.cards[2]?.result.status).toBe("empty");
  });

  it("every placement the screens show exists in the registry for both brands", () => {
    const registry = createAnalyticsRegistry();
    for (const brand of ["dojix", "greenwick"] as const) {
      const placements = new Set(registry.list(brand).map((c) => placementFor(c, brand)));
      for (const p of ["overview", "timing", "sessions", "pairs", "risk", "behavioral", "advanced", "edgeReport"]) {
        expect(placements.has(p as never), `${brand}/${p}`).toBe(true);
      }
    }
  });

  it("the inline client wraps the engine", async () => {
    const client = createInlineClient();
    await client.load(5, "dojix", []);
    const result = await client.run({ ...base, datasetId: 5, componentIds: [] });
    expect(result.tradeCount).toBe(0);
    client.dispose();
  });
});

describe("engine settings", () => {
  it("reads the computer's zone, locale and week rule", () => {
    expect(foundationLocale("en-GB")).toBe("en_GB");
    expect(foundationLocale("zh-Hans-CN")).toBe("zh_Hans_CN");
    expect(weekRule("en-US")).toEqual({ weekStart: 1, minDaysInFirstWeek: 1 });
    expect(weekRule("de-DE")).toEqual({ weekStart: 2, minDaysInFirstWeek: 4 });
    expect(weekRule("not a tag!")).toEqual({ weekStart: 1, minDaysInFirstWeek: 1 });
    const s = environmentSettings();
    expect(s.compat).toBe("fixed");
    expect(s.tz.length).toBeGreaterThan(0);
  });
});
