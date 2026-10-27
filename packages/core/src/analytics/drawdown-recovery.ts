// DrawdownRecovery (SPEC Appendix A): time underwater, drawdown events, recovery statistics
// and a drawdown-phase vs recovery-phase comparison.
//
// Port of Dojix `Components/DrawdownRecovery.swift:11-235,616-658` and Greenwick
// `Components/DrawdownRecovery.swift:11-235,608-650`. Brand differences: Greenwick's phase
// stats say `avgShareSize` / `symbolBreakdown` (Dojix `avgLotSize` / `pairBreakdown`), the
// session type is MarketSession, and the insight copy says "Position sizes" / "Symbol shift".
// - Everything walks the trades ASC by close time; equity curve and events need n ≥ 20.
// - Equity curve: cumulative and peak from 0; dd$ = cum − peak; dd% = dd$/peak × 100 (0 when
//   peak ≤ 0).
// - Events: a drawdown starts at the first trade below the peak and closes at the first trade
//   back at or above it (`cumulative >= peak`, so a return to the exact high closes it). The
//   trough is the first index with the largest depth. Recovered: duration = idx − start,
//   recoveryTrades = idx − trough. Unrecovered (still open at the end): duration =
//   last − start **+ 1** and recoveryTrades 0.
//   **D-20:** `fixed` uses last − start for the open event too, the same rule as recovered ones.
// - deepest / longest = `max(by:)` on depth / duration (the **last** of ties).
// - Phase trades: start…trough of every event (drawdown phase) and trough+1…end of every
//   recovered event (recovery phase), concatenated in event order.
// - Phase stats: average size, WR%, count, and counts per symbol / session sorted by count
//   descending. The Mac sorts a Dictionary, so equal counts come out in random order; the
//   desktop breaks ties by first appearance in the phase (ASC) order.
// - The view's events table shows the top 10 by depth (stable sort, descending).

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { isWin, profitDouble, quantity, sessionRaw } from "../model/accessors";
import { MARKET_SESSION_INFO, TRADING_SESSION_INFO } from "../model/enums";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, maxBy, stableSorted, swiftMax, swiftMin } from "../swiftcompat/collections";
import { swiftFormat } from "../swiftcompat/format";
import { refDate, toRef, type ComponentParity } from "./support";

export interface EquityPoint {
  /** Trade index (0-based). */
  id: number;
  tradeNumber: number;
  date: number;
  /** ≤ 0. */
  drawdownDollar: number;
  /** ≤ 0, percent of the peak. */
  drawdownPercent: number;
}

export interface DrawdownEvent {
  startIndex: number;
  endIndex: number;
  troughIndex: number;
  /** Positive. */
  depthDollar: number;
  depthPercent: number;
  peakAtStart: number;
  duration: number;
  recoveryTrades: number;
  startDate: number;
  endDate: number;
  troughDate: number;
  isRecovered: boolean;
}

/** Brand-neutral `PhaseStats`; the parity encoder renames the fields per brand. */
export interface PhaseStats {
  /** Average lots (Dojix) / shares (Greenwick). */
  avgSize: number;
  /** Percent. */
  winRate: number;
  tradeCount: number;
  /** Pairs (Dojix) / symbols (Greenwick) by count, descending. */
  symbolBreakdown: { symbol: string; count: number }[];
  /** Session raw values by count, descending. */
  sessionBreakdown: { session: string; count: number }[];
}

export interface DrawdownRecoveryModel<T extends Trade = Trade> {
  sortedTrades: T[];
  equityCurve: EquityPoint[];
  drawdownEvents: DrawdownEvent[];
  avgRecoveryTrades: number;
  deepestEvent: DrawdownEvent | null;
  longestEvent: DrawdownEvent | null;
  isCurrentlyInDrawdown: boolean;
  percentTimeInDrawdown: number;
  drawdownPhaseStats: PhaseStats;
  recoveryPhaseStats: PhaseStats;
  drawdownPhaseTrades: T[];
  recoveryPhaseTrades: T[];
  /** UI: the events table (top 10 by depth, stable). */
  topEvents: DrawdownEvent[];
  /** UI: "+N more events". */
  moreEventsCount: number;
  /** UI: "What changed during recoveries?" (shown when both phases have trades). */
  insights: string[];
}

function equityCurveOf(sorted: readonly Trade[]): EquityPoint[] {
  if (sorted.length < 20) return [];
  let cumulative = 0;
  let peak = 0;
  return sorted.map((t, idx) => {
    cumulative += profitDouble(t);
    peak = swiftMax(peak, cumulative);
    const dd = cumulative - peak;
    return { id: idx, tradeNumber: idx + 1, date: t.closeTime, drawdownDollar: dd, drawdownPercent: peak > 0 ? (dd / peak) * 100 : 0 };
  });
}

function eventsOf(sorted: readonly Trade[], ctx: EngineContext): DrawdownEvent[] {
  if (sorted.length < 20) return [];
  const at = (i: number) => (sorted[i] as Trade).closeTime;
  let cumulative = 0;
  let peak = 0;
  const events: DrawdownEvent[] = [];
  let inDrawdown = false;
  let start = 0;
  let trough = 0;
  let depth = 0;
  let peakAtStart = 0;
  const pct = () => (peakAtStart > 0 ? (depth / peakAtStart) * 100 : 0);
  sorted.forEach((t, idx) => {
    cumulative += profitDouble(t);
    if (cumulative >= peak) {
      if (inDrawdown) {
        events.push({
          startIndex: start,
          endIndex: idx,
          troughIndex: trough,
          depthDollar: depth,
          depthPercent: pct(),
          peakAtStart,
          duration: idx - start,
          recoveryTrades: idx - trough,
          startDate: at(start),
          endDate: at(idx),
          troughDate: at(trough),
          isRecovered: true,
        });
        inDrawdown = false;
      }
      peak = cumulative;
    } else {
      const current = peak - cumulative;
      if (!inDrawdown) {
        inDrawdown = true;
        start = idx;
        trough = idx;
        depth = current;
        peakAtStart = peak;
      }
      if (current > depth) {
        depth = current;
        trough = idx;
      }
    }
  });
  if (inDrawdown) {
    const last = sorted.length - 1;
    events.push({
      startIndex: start,
      endIndex: last,
      troughIndex: trough,
      depthDollar: depth,
      depthPercent: pct(),
      peakAtStart,
      // D-20: the Mac adds 1 for the open event only.
      duration: ctx.compat === "fixed" ? last - start : last - start + 1,
      recoveryTrades: 0,
      startDate: at(start),
      endDate: at(last),
      troughDate: at(trough),
      isRecovered: false,
    });
  }
  return events;
}

function countsDescending(keys: readonly string[]): { key: string; count: number }[] {
  const groups = groupByFirstAppearance(keys, (k) => k);
  const rows = [...groups].map(([key, g]) => ({ key, count: g.length }));
  return stableSorted(rows, (a, b) => a.count > b.count);
}

/** `computePhaseStats(for:)` (DrawdownRecovery.swift:216-235). */
export function phaseStatsOf(phase: readonly Trade[]): PhaseStats {
  if (phase.length === 0) return { avgSize: 0, winRate: 0, tradeCount: 0, symbolBreakdown: [], sessionBreakdown: [] };
  let size = 0;
  let wins = 0;
  for (const t of phase) {
    size += quantity(t);
    if (isWin(t)) wins += 1;
  }
  return {
    avgSize: size / phase.length,
    winRate: (wins / phase.length) * 100,
    tradeCount: phase.length,
    symbolBreakdown: countsDescending(phase.map((t) => t.symbol)).map((r) => ({ symbol: r.key, count: r.count })),
    sessionBreakdown: countsDescending(phase.map(sessionRaw)).map((r) => ({ session: r.key, count: r.count })),
  };
}

function sessionName(raw: string): string {
  return (TRADING_SESSION_INFO as Record<string, { displayName: string }>)[raw]?.displayName ??
    (MARKET_SESSION_INFO as Record<string, { displayName: string }>)[raw]?.displayName ??
    raw;
}

/** `buildInsights(ddStats:recStats:)` (Dojix :616-658, Greenwick :608-650). */
export function recoveryInsights(dd: PhaseStats, rec: PhaseStats, brand: BrandId): string[] {
  const out: string[] = [];
  const wrDiff = rec.winRate - dd.winRate;
  if (Math.abs(wrDiff) > 5) {
    out.push(
      wrDiff > 0
        ? `Win rate improves by ${swiftFormat("%.0f", wrDiff)}pp during recoveries`
        : `Win rate drops by ${swiftFormat("%.0f", Math.abs(wrDiff))}pp during recoveries -- may be forcing trades`,
    );
  }
  if (dd.avgSize > 0 && rec.avgSize > 0) {
    const ratio = rec.avgSize / dd.avgSize;
    if (brand === "dojix") {
      if (ratio < 0.8) out.push("Lot sizes reduce during recovery -- disciplined risk management");
      else if (ratio > 1.3) out.push("Lot sizes increase during recovery -- possible revenge trading pattern");
    } else {
      if (ratio < 0.8) out.push("Position sizes reduce during recovery — disciplined risk management");
      else if (ratio > 1.3) out.push("Position sizes increase during recovery — possible revenge trading pattern");
    }
  }
  const ddSession = dd.sessionBreakdown[0];
  const recSession = rec.sessionBreakdown[0];
  if (ddSession && recSession && ddSession.session !== recSession.session) {
    out.push(`Session shift: ${sessionName(ddSession.session)} during drawdowns, ${sessionName(recSession.session)} during recoveries`);
  }
  const ddTop = dd.symbolBreakdown[0];
  const recTop = rec.symbolBreakdown[0];
  if (ddTop && recTop && ddTop.symbol !== recTop.symbol) {
    const word = brand === "dojix" ? "Pair" : "Symbol";
    out.push(`${word} shift: ${ddTop.symbol} during drawdowns, ${recTop.symbol} during recoveries`);
  }
  if (out.length === 0) out.push("Behavior is consistent between drawdown and recovery phases");
  return out;
}

export function computeDrawdownRecovery<T extends Trade>(ctx: EngineContext, trades: readonly T[]): DrawdownRecoveryModel<T> {
  const sorted = sortedByCloseAscending(trades);
  const equityCurve = equityCurveOf(sorted);
  const drawdownEvents = eventsOf(sorted, ctx);

  const recovered = drawdownEvents.filter((e) => e.isRecovered);
  let recSum = 0;
  for (const e of recovered) recSum += e.recoveryTrades;
  const avgRecoveryTrades = recovered.length === 0 ? 0 : recSum / recovered.length;

  const lastEvent = drawdownEvents[drawdownEvents.length - 1];
  let underwater = 0;
  for (const p of equityCurve) if (p.drawdownDollar < 0) underwater += 1;

  const drawdownPhaseTrades: T[] = [];
  for (const e of drawdownEvents) {
    const end = swiftMin(e.troughIndex, sorted.length - 1);
    if (e.startIndex <= end) drawdownPhaseTrades.push(...sorted.slice(e.startIndex, end + 1));
  }
  const recoveryPhaseTrades: T[] = [];
  for (const e of recovered) {
    const start = e.troughIndex + 1;
    const end = e.endIndex;
    if (start <= end && start < sorted.length && end < sorted.length) recoveryPhaseTrades.push(...sorted.slice(start, end + 1));
  }
  const drawdownPhaseStats = phaseStatsOf(drawdownPhaseTrades);
  const recoveryPhaseStats = phaseStatsOf(recoveryPhaseTrades);

  return {
    sortedTrades: sorted,
    equityCurve,
    drawdownEvents,
    avgRecoveryTrades,
    deepestEvent: maxBy(drawdownEvents, (a, b) => a.depthDollar < b.depthDollar) ?? null,
    longestEvent: maxBy(drawdownEvents, (a, b) => a.duration < b.duration) ?? null,
    isCurrentlyInDrawdown: lastEvent ? !lastEvent.isRecovered : false,
    percentTimeInDrawdown: equityCurve.length === 0 ? 0 : (underwater / equityCurve.length) * 100,
    drawdownPhaseStats,
    recoveryPhaseStats,
    drawdownPhaseTrades,
    recoveryPhaseTrades,
    topEvents: stableSorted(drawdownEvents, (a, b) => a.depthDollar > b.depthDollar).slice(0, 10),
    moreEventsCount: Math.max(0, drawdownEvents.length - 10),
    insights: recoveryInsights(drawdownPhaseStats, recoveryPhaseStats, ctx.brand),
  };
}

export const drawdownRecoveryComponent = defineComponent<BrandId, DrawdownRecoveryModel>({
  id: "DrawdownRecovery",
  brands: ["dojix", "greenwick"],
  tab: "risk",
  minTrades: 20,
  // With no events the view shows "No drawdowns detected" (not an empty state), so the model
  // is returned and the UI checks `drawdownEvents.length`.
  compute: (ctx, trades) => computeDrawdownRecovery(ctx, trades),
});

const EVENT_DATES = ["startDate", "endDate", "troughDate"];

function refEvent(e: DrawdownEvent | null): unknown {
  return toRef(e, { dates: EVENT_DATES });
}

/** `PhaseStats` as the harness dumps it (stored properties, brand field names). */
export function refPhaseStats(s: PhaseStats, brand: BrandId): unknown {
  return brand === "dojix"
    ? {
        avgLotSize: s.avgSize,
        winRate: s.winRate,
        tradeCount: s.tradeCount,
        pairBreakdown: s.symbolBreakdown.map((r) => ({ pair: r.symbol, count: r.count })),
        sessionBreakdown: s.sessionBreakdown,
      }
    : {
        avgShareSize: s.avgSize,
        winRate: s.winRate,
        tradeCount: s.tradeCount,
        symbolBreakdown: s.symbolBreakdown,
        sessionBreakdown: s.sessionBreakdown,
      };
}

export const drawdownRecoveryParity: ComponentParity<DrawdownRecoveryModel> = {
  component: "DrawdownRecovery",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeDrawdownRecovery(ctx, trades),
  members: {
    sortedTrades: (m) => toRef(m.sortedTrades),
    equityCurve: (m) => m.equityCurve.map((p) => ({ ...p, date: refDate(p.date) })),
    drawdownEvents: (m) => m.drawdownEvents.map(refEvent),
    avgRecoveryTrades: (m) => m.avgRecoveryTrades,
    deepestEvent: (m) => refEvent(m.deepestEvent),
    longestEvent: (m) => refEvent(m.longestEvent),
    isCurrentlyInDrawdown: (m) => m.isCurrentlyInDrawdown,
    percentTimeInDrawdown: (m) => m.percentTimeInDrawdown,
    drawdownPhaseStats: (m, ctx) => refPhaseStats(m.drawdownPhaseStats, ctx.brand),
    recoveryPhaseStats: (m, ctx) => refPhaseStats(m.recoveryPhaseStats, ctx.brand),
    drawdownPhaseTrades: (m) => toRef(m.drawdownPhaseTrades),
    recoveryPhaseTrades: (m) => toRef(m.recoveryPhaseTrades),
  },
};
