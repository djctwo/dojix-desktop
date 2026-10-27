import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { DojixTrade } from "../model/trade";
import { fxSeries, fxTrade, stTrade } from "../test-support/trades";
import {
  computeDrawdownRecovery,
  drawdownRecoveryComponent,
  drawdownRecoveryParity,
  phaseStatsOf,
  recoveryInsights,
  refPhaseStats,
  type PhaseStats,
} from "./drawdown-recovery";

const swift = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const fixed = createEngineContext({ brand: "dojix", now: 0, compat: "fixed" });
const pad = (n: number, p = "10") => Array.from({ length: n }, () => p);

describe("DrawdownRecovery", () => {
  it("finds one recovered drawdown (DojixTests/AnalyticsComponentTests.swift:267-300)", () => {
    // 14 × +10 then +50, +50, −100, −50, +50, +100: below the peak at 16, 17, 18; recovered at 19.
    const trades = fxSeries([...pad(14), "50", "50", "-100", "-50", "50", "100"]).reverse();
    const m = computeDrawdownRecovery(swift, trades);
    expect(m.sortedTrades.map((t) => t.closeTime)).toEqual([...trades].reverse().map((t) => t.closeTime));
    expect(m.drawdownEvents).toHaveLength(1);
    const e = m.drawdownEvents[0];
    expect(e).toMatchObject({
      startIndex: 16,
      endIndex: 19,
      troughIndex: 17,
      depthDollar: 150,
      depthPercent: 62.5,
      peakAtStart: 240,
      duration: 3,
      recoveryTrades: 2,
      isRecovered: true,
    });
    expect(e?.startDate).toBe(m.sortedTrades[16]?.closeTime);
    expect(e?.troughDate).toBe(m.sortedTrades[17]?.closeTime);
    expect(e?.endDate).toBe(m.sortedTrades[19]?.closeTime);
    expect(m.avgRecoveryTrades).toBe(2);
    expect(m.isCurrentlyInDrawdown).toBe(false);
    expect(m.percentTimeInDrawdown).toBe(15); // 3 of 20 points below the peak
    expect(m.equityCurve[17]).toMatchObject({ id: 17, tradeNumber: 18, drawdownDollar: -150, drawdownPercent: -62.5 });
    expect(m.drawdownPhaseTrades).toEqual(m.sortedTrades.slice(16, 18));
    expect(m.recoveryPhaseTrades).toEqual(m.sortedTrades.slice(18, 20));
    expect(m.deepestEvent).toBe(e);
    expect(m.longestEvent).toBe(e);
  });

  it("D-20: an open drawdown lasts last − start + 1 on the Mac, last − start when fixed", () => {
    const trades = fxSeries([...pad(18), "-50", "-10"]);
    const mac = computeDrawdownRecovery(swift, trades);
    expect(mac.drawdownEvents[0]).toMatchObject({ startIndex: 18, endIndex: 19, troughIndex: 19, duration: 2, recoveryTrades: 0, isRecovered: false });
    expect(mac.isCurrentlyInDrawdown).toBe(true);
    expect(computeDrawdownRecovery(fixed, trades).drawdownEvents[0]?.duration).toBe(1);
    // recovered events use idx − start in both modes
    const rec = fxSeries([...pad(17), "-10", "-10", "30"]);
    expect(computeDrawdownRecovery(swift, rec).drawdownEvents[0]?.duration).toBe(2);
    expect(computeDrawdownRecovery(fixed, rec).drawdownEvents[0]?.duration).toBe(2);
    expect(computeDrawdownRecovery(swift, rec).avgRecoveryTrades).toBe(1);
  });

  it("closes a drawdown on an exact return to the peak; the first max is the trough", () => {
    const m = computeDrawdownRecovery(swift, fxSeries([...pad(15), "-10", "10", "-20", "-0", "20"]));
    // cum 150 | 140 (dd) | 150 (= peak → recovered) | 130 | 130 (depth equal → trough stays) | 150
    expect(m.drawdownEvents.map((e) => [e.startIndex, e.troughIndex, e.endIndex])).toEqual([
      [15, 15, 16],
      [17, 17, 19],
    ]);
  });

  it("deepest and longest take the last of equal events (max(by:))", () => {
    const m = computeDrawdownRecovery(swift, fxSeries([...pad(14), "-10", "10", "-10", "10", "-10", "10"]));
    expect(m.drawdownEvents).toHaveLength(3);
    expect(m.deepestEvent).toBe(m.drawdownEvents[2]);
    expect(m.longestEvent).toBe(m.drawdownEvents[2]);
    expect(m.topEvents).toEqual(m.drawdownEvents); // stable sort keeps equal depths in order
    expect(m.moreEventsCount).toBe(0);
  });

  it("keeps the top 10 events by depth and counts the rest", () => {
    const ps: string[] = [];
    for (let i = 1; i <= 12; i++) ps.push(String(-i), String(i));
    const m = computeDrawdownRecovery(swift, fxSeries(["100", ...ps]));
    expect(m.drawdownEvents).toHaveLength(12);
    expect(m.topEvents.map((e) => e.depthDollar)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(m.moreEventsCount).toBe(2);
  });

  it("reports 0% while the peak is not positive", () => {
    const m = computeDrawdownRecovery(swift, fxSeries(["-10", ...pad(19, "1")]));
    expect(m.equityCurve[0]).toMatchObject({ drawdownDollar: -10, drawdownPercent: 0 });
    expect(m.drawdownEvents[0]).toMatchObject({ peakAtStart: 0, depthPercent: 0, depthDollar: 10 });
  });

  it("needs 20 trades for the curve and the events", () => {
    const m = computeDrawdownRecovery(swift, fxSeries([...pad(10), "-5", ...pad(8)]));
    expect(m.equityCurve).toEqual([]);
    expect(m.drawdownEvents).toEqual([]);
    expect(m.percentTimeInDrawdown).toBe(0);
    expect(m.avgRecoveryTrades).toBe(0);
    expect(m.deepestEvent).toBeNull();
    expect(m.drawdownPhaseStats).toEqual({ avgSize: 0, winRate: 0, tradeCount: 0, symbolBreakdown: [], sessionBreakdown: [] });
    expect(m.insights).toEqual(["Behavior is consistent between drawdown and recovery phases"]);
    const reg = new AnalyticsRegistry().register(drawdownRecoveryComponent);
    expect(reg.run("DrawdownRecovery", swift, m.sortedTrades)).toBeNull();
    expect(reg.run("DrawdownRecovery", swift, fxSeries(pad(20)))).toMatchObject({ drawdownEvents: [] });
  });

  it("phase stats: counts by symbol and session, ties broken by first appearance", () => {
    const t = (symbol: string, session: DojixTrade["session"], netProfit: string, lots: number) => fxTrade({ symbol, session, netProfit, lots });
    const s = phaseStatsOf([t("EURUSD", "ASIAN", "5", 1), t("GBPUSD", "LONDON", "-5", 2), t("GBPUSD", "LONDON", "0", 3), t("EURUSD", "NY", "1", 2)]);
    expect(s).toEqual({
      avgSize: 2,
      winRate: 50,
      tradeCount: 4,
      symbolBreakdown: [
        { symbol: "EURUSD", count: 2 },
        { symbol: "GBPUSD", count: 2 },
      ],
      sessionBreakdown: [
        { session: "LONDON", count: 2 },
        { session: "ASIAN", count: 1 },
        { session: "NY", count: 1 },
      ],
    });
    expect(refPhaseStats(s, "dojix")).toEqual({
      avgLotSize: 2,
      winRate: 50,
      tradeCount: 4,
      pairBreakdown: [
        { pair: "EURUSD", count: 2 },
        { pair: "GBPUSD", count: 2 },
      ],
      sessionBreakdown: s.sessionBreakdown,
    });
    expect(refPhaseStats(s, "greenwick")).toEqual({
      avgShareSize: 2,
      winRate: 50,
      tradeCount: 4,
      symbolBreakdown: s.symbolBreakdown,
      sessionBreakdown: s.sessionBreakdown,
    });
  });

  it("builds the recovery insights per brand", () => {
    const base: PhaseStats = { avgSize: 1, winRate: 40, tradeCount: 5, symbolBreakdown: [{ symbol: "EURUSD", count: 5 }], sessionBreakdown: [{ session: "ASIAN", count: 5 }] };
    const rec: PhaseStats = { ...base, avgSize: 0.5, winRate: 60, symbolBreakdown: [{ symbol: "USDJPY", count: 5 }], sessionBreakdown: [{ session: "NY_OVERLAP", count: 5 }] };
    expect(recoveryInsights(base, rec, "dojix")).toEqual([
      "Win rate improves by 20pp during recoveries",
      "Lot sizes reduce during recovery -- disciplined risk management",
      "Session shift: Asian during drawdowns, NY Overlap during recoveries",
      "Pair shift: EURUSD during drawdowns, USDJPY during recoveries",
    ]);
    const worse = { ...base, avgSize: 2, winRate: 30 };
    expect(recoveryInsights(base, worse, "dojix").slice(0, 2)).toEqual([
      "Win rate drops by 10pp during recoveries -- may be forcing trades",
      "Lot sizes increase during recovery -- possible revenge trading pattern",
    ]);
    const stDd: PhaseStats = { ...base, sessionBreakdown: [{ session: "REGULAR", count: 5 }] };
    const stRec: PhaseStats = { ...rec, sessionBreakdown: [{ session: "PRE_MARKET", count: 5 }], symbolBreakdown: [{ symbol: "FICT", count: 5 }] };
    expect(recoveryInsights(stDd, stRec, "greenwick")).toEqual([
      "Win rate improves by 20pp during recoveries",
      "Position sizes reduce during recovery — disciplined risk management",
      "Session shift: Regular during drawdowns, Pre-Market during recoveries",
      "Symbol shift: EURUSD during drawdowns, FICT during recoveries",
    ]);
    expect(recoveryInsights(stDd, { ...stDd, avgSize: 2 }, "greenwick")).toEqual(["Position sizes increase during recovery — possible revenge trading pattern"]);
    expect(recoveryInsights(base, { ...base, sessionBreakdown: [{ session: "ODD", count: 1 }] }, "dojix")).toEqual([
      "Session shift: Asian during drawdowns, ODD during recoveries",
    ]);
  });

  it("encodes members the way the harness dumps them (Greenwick names)", () => {
    const st = createEngineContext({ brand: "greenwick", now: 0, compat: "swift" });
    const ps = [...pad(14), "50", "50", "-100", "-50", "50", "100"];
    const trades = ps.map((p, i) => stTrade({ netProfit: p, closeTime: Date.UTC(2026, 8, 1 + i, 18), ticket: String(500 + i) })).reverse();
    const m = drawdownRecoveryParity.compute(st, trades, undefined);
    if (!m) throw new Error("model");
    const enc = (k: string) => drawdownRecoveryParity.members[k]?.(m, st);
    expect((enc("sortedTrades") as string[])[0]).toBe("#500");
    expect((enc("equityCurve") as unknown[])[16]).toEqual({ id: 16, tradeNumber: 17, date: "2026-09-17T18:00:00.000Z", drawdownDollar: -100, drawdownPercent: (-100 / 240) * 100 });
    expect(enc("deepestEvent")).toMatchObject({ startDate: "2026-09-17T18:00:00.000Z", troughDate: "2026-09-18T18:00:00.000Z", endDate: "2026-09-20T18:00:00.000Z", duration: 3 });
    expect(enc("longestEvent")).toEqual(enc("deepestEvent"));
    expect((enc("drawdownEvents") as unknown[])[0]).toEqual(enc("deepestEvent"));
    expect(enc("drawdownPhaseStats")).toMatchObject({ avgShareSize: 100, tradeCount: 2, symbolBreakdown: [{ symbol: "FICT", count: 2 }], sessionBreakdown: [{ session: "REGULAR", count: 2 }] });
    expect(enc("recoveryPhaseStats")).toMatchObject({ tradeCount: 2, winRate: 100 });
    expect(enc("drawdownPhaseTrades")).toEqual(["#516", "#517"]);
    expect(enc("recoveryPhaseTrades")).toEqual(["#518", "#519"]);
    expect(enc("avgRecoveryTrades")).toBe(2);
    expect(enc("isCurrentlyInDrawdown")).toBe(false);
    expect(enc("percentTimeInDrawdown")).toBe(15);
    expect(m.insights[0]).toBe("Win rate improves by 100pp during recoveries");
  });

  it("never throws; no NaN in the statistics for valid input (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1e9, max: 1e9 }), { minLength: 0, maxLength: 40 }), fc.boolean(), (cents, isFixed) => {
        const m = computeDrawdownRecovery(isFixed ? fixed : swift, fxSeries(cents.map((c) => String(c / 100))));
        for (const p of m.equityCurve) expect(Number.isNaN(p.drawdownDollar) || Number.isNaN(p.drawdownPercent)).toBe(false);
        for (const e of m.drawdownEvents) {
          expect(e.depthDollar).toBeGreaterThan(0);
          expect(e.duration).toBeGreaterThanOrEqual(isFixed && !e.isRecovered ? 0 : 1);
        }
        expect(Number.isNaN(m.percentTimeInDrawdown)).toBe(false);
        expect(Number.isNaN(m.avgRecoveryTrades)).toBe(false);
      }),
      { numRuns: 150 },
    );
  });
});
