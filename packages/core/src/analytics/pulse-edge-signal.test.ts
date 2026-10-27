import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { TradingSession } from "../model/enums";
import type { DojixTrade } from "../model/trade";
import { fxTrade } from "../test-support/trades";
import { computePulseEdgeSignals, EDGE_SIGNAL_SCORE, PULSE_MINIMUM_TRADES, pulseEdgeSignalComponent } from "./pulse-edge-signal";

const at = (hourUTC: number) => createEngineContext({ brand: "dojix", now: Date.UTC(2026, 0, 20, hourUTC, 30) });

function make(n: number, profit: (i: number) => string, session: TradingSession = "LONDON", hour = 13): DojixTrade[] {
  return Array.from({ length: n }, (_, i) =>
    fxTrade({ netProfit: profit(i), session, hour, closeTime: Date.UTC(2026, 0, 10) - i * 60_000 }),
  );
}

describe("Pulse edge signal", () => {
  it("below 30 trades every active session gets the neutral 'need more trades' signal", () => {
    const m = computePulseEdgeSignals(at(13), make(29, () => "10"));
    expect(PULSE_MINIMUM_TRADES).toBe(30);
    expect(m.hasEnoughTrades).toBe(false);
    expect(m.activeSessions).toEqual(["LONDON", "NY"]);
    expect(m.currentHour).toBe(13);
    expect(m.sessionEdgeSignals.map((s) => s.signal.message)).toEqual([
      "Need more trades to generate signals",
      "Need more trades to generate signals",
    ]);
    expect(m.edgeSignal).toEqual({
      level: "neutral",
      message: "Need more trades to generate signals",
      details: "Import at least 30 trades for personalized signals.",
    });
  });

  it("a winning session and hour scores strong; an empty session is neutral", () => {
    const m = computePulseEdgeSignals(at(13), make(30, () => "10"));
    const [london, ny] = m.sessionEdgeSignals;
    expect(london?.score).toBe(3);
    expect(london?.signal).toEqual({
      level: "strong",
      message: "Conditions match your edge",
      details: "100% win rate, inf PF. 13:00 UTC is a strong hour.",
    });
    expect(london?.metrics?.totalTrades).toBe(30);
    expect(ny?.signal).toEqual({ level: "neutral", message: "Average conditions", details: "Insufficient data for this session." });
    expect(m.edgeSignal?.level).toBe("strong");
  });

  it("related sessions: NY Overlap trades count for London and NY", () => {
    const m = computePulseEdgeSignals(at(13), make(30, () => "10", "NY_OVERLAP"));
    expect(m.sessionEdgeSignals.map((s) => s.signal.level)).toEqual(["strong", "strong"]);
    const asian = computePulseEdgeSignals(at(3), make(30, () => "10", "NY_OVERLAP"));
    expect(asian.activeSessions).toEqual(["ASIAN"]);
    expect(asian.sessionEdgeSignals[0]?.metrics?.totalTrades).toBe(0);
  });

  it("losing sessions and hours score avoid; the danger zone subtracts 2", () => {
    const m = computePulseEdgeSignals(at(13), make(30, (i) => (i % 3 === 0 ? "10" : "-10")));
    const london = m.sessionEdgeSignals[0];
    expect(london?.score).toBe(-3);
    expect(london?.signal).toEqual({
      level: "avoid",
      message: "Poor conditions — sit out",
      details: "Historically unprofitable (33% WR). 13:00 UTC has negative P&L.",
    });
    // best active session wins: NY (neutral) beats London (avoid)
    expect(m.edgeSignal?.message).toBe("Average conditions");
    const danger = computePulseEdgeSignals(at(13), make(30, () => "10"), { activeDangerZone: true });
    expect(danger.sessionEdgeSignals[0]?.score).toBe(1);
    expect(danger.sessionEdgeSignals[0]?.signal.details).toBe("100% win rate, inf PF. 13:00 UTC is a strong hour. High-impact news active.");
    expect(danger.sessionEdgeSignals[1]?.signal).toMatchObject({ level: "avoid", details: "High-impact news active." });
  });

  it("middling sessions add nothing; hour needs 3 trades and profit for +1", () => {
    // WR 50, PF 1: neither rule; hour WR 50 with profit 0 → nothing
    const m = computePulseEdgeSignals(at(13), make(30, (i) => (i % 2 === 0 ? "10" : "-10")));
    expect(m.sessionEdgeSignals[0]).toMatchObject({ score: 0, signal: { level: "neutral", details: "Insufficient data for this session." } });
    // other hour: hour metrics empty
    const other = computePulseEdgeSignals(at(14), make(30, () => "10"));
    expect(other.sessionEdgeSignals[0]?.signal.details).toBe("100% win rate, inf PF.");
    expect(other.sessionEdgeSignals[0]?.score).toBe(2);
    // Late session (21–24)
    expect(computePulseEdgeSignals(at(22), make(30, () => "1", "LATE", 22)).sessionEdgeSignals[0]?.session).toBe("LATE");
  });

  it("scores order the levels", () => {
    expect(EDGE_SIGNAL_SCORE).toEqual({ avoid: 0, neutral: 1, strong: 2 });
  });

  it("is registered on Pulse for Dojix only", () => {
    const reg = new AnalyticsRegistry().register(pulseEdgeSignalComponent);
    expect(reg.list("dojix", "pulse").map((c) => c.id)).toEqual(["PulseEdgeSignal"]);
    expect(reg.list("greenwick")).toEqual([]);
    expect(reg.run("PulseEdgeSignal", at(13), [])).toMatchObject({ hasEnoughTrades: false });
  });

  it("properties: no throw; levels follow the score", () => {
    const money = fc.integer({ min: -1_000_000, max: 1_000_000 }).map((c) => (c / 100).toString());
    const session = fc.constantFrom<TradingSession>("ASIAN", "LONDON", "NY_OVERLAP", "NY", "LATE");
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: money, s: session, h: fc.integer({ min: 0, max: 23 }) }), { minLength: 30, maxLength: 45 }),
        fc.integer({ min: 0, max: 23 }),
        fc.boolean(),
        (rows, hour, dz) => {
          const m = computePulseEdgeSignals(at(hour), rows.map((r) => fxTrade({ netProfit: r.p, session: r.s, hour: r.h })), {
            activeDangerZone: dz,
          });
          for (const s of m.sessionEdgeSignals) {
            const score = s.score ?? 0;
            expect(s.signal.level).toBe(score >= 2 ? "strong" : score >= 0 ? "neutral" : "avoid");
            expect(s.signal.details).not.toMatch(/nan/);
          }
          const best = Math.max(...m.sessionEdgeSignals.map((s) => EDGE_SIGNAL_SCORE[s.signal.level]));
          expect(m.edgeSignal && EDGE_SIGNAL_SCORE[m.edgeSignal.level]).toBe(best);
        },
      ),
      { numRuns: 100 },
    );
  });
});
