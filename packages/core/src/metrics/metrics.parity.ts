// Parity resolvers for the MetricsCalculator helpers the Tier B harness records next to the
// portfolio metrics (tools/swift-ref/*/RefPipeline.swift `refBrandOutputs`):
// - "Metrics.edgeBy<Dimension>": `MetricsCalculator.edgeBy…(from:)`, {category, label, profit,
//   tradeCount, winRate} per group, sorted by profit;
// - "Metrics.allEdgeConditions[tradingDays=21]": `allEdgeConditions(from:tradingDays: 21)`;
// - "Metrics.confidence": `confidenceLevel` / `isActionable` for n = 0, 1, 9, 10, 29, 30, 31, 100;
// - Greenwick "TradingCalendar.*": `tradingDayCount`, `dailyPnL` (by day key, ascending) and
//   `groupedByWeekday` (tickets per ET weekday of the close).
// The portfolio fields themselves ("Metrics.<field>") resolve in parity/reference.ts.

import type { EngineContext } from "../engine/context";
import type { GreenwickTrade, Trade } from "../model/trade";
import { registerParityResolver } from "../parity/reference";
import { stableSorted } from "../swiftcompat/collections";
import { dailyPnL, etTradingDayCount, groupedByTradingWeekday, TRADING_CALENDAR } from "../time/us-market";
import {
  allEdgeConditions,
  CONFIDENCE_LEVEL_INFO,
  confidenceLevel,
  edgeByBias,
  edgeByDay,
  edgeByHour,
  edgeByPair,
  edgeBySector,
  edgeBySession,
  edgeBySymbol,
  edgeByVolRegime,
  isActionable,
  type EdgeBreakdown,
} from "./edges";
import type { DojixTrade } from "../model/trade";

type Edge = (ctx: EngineContext, trades: readonly Trade[]) => EdgeBreakdown[] | undefined;

const fx = (f: (t: readonly DojixTrade[]) => EdgeBreakdown[]): Edge => (ctx, trades) =>
  ctx.brand === "dojix" ? f(trades as readonly DojixTrade[]) : undefined;
const st = (f: (t: readonly GreenwickTrade[]) => EdgeBreakdown[]): Edge => (ctx, trades) =>
  ctx.brand === "greenwick" ? f(trades as readonly GreenwickTrade[]) : undefined;

const EDGES: Readonly<Record<string, Edge>> = {
  "Metrics.edgeByHour": (_ctx, trades) => edgeByHour(trades),
  "Metrics.edgeBySession": (_ctx, trades) => edgeBySession(trades),
  "Metrics.edgeByDay": (_ctx, trades) => edgeByDay(trades),
  "Metrics.edgeByPair": fx(edgeByPair),
  "Metrics.edgeByBias": fx(edgeByBias),
  "Metrics.edgeByVolRegime": fx(edgeByVolRegime),
  "Metrics.edgeBySymbol": st(edgeBySymbol),
  "Metrics.edgeBySector": st(edgeBySector),
};

/** The sample sizes the harness probes (RefPipeline.swift `Metrics.confidence`). */
export const CONFIDENCE_PROBES = [0, 1, 9, 10, 29, 30, 31, 100] as const;

registerParityResolver("Metrics.edgeBy", (key, ctx, trades) => {
  const value = EDGES[key]?.(ctx, trades);
  return value === undefined ? undefined : { value };
});

const CONDITIONS = /^Metrics\.allEdgeConditions\[tradingDays=(\d+)\]$/;

registerParityResolver("Metrics.allEdgeConditions", (key, ctx, trades) => {
  const m = CONDITIONS.exec(key);
  return m ? { value: allEdgeConditions(trades, Number(m[1]), ctx.brand) } : undefined;
});

registerParityResolver("Metrics.confidence", (key) =>
  key === "Metrics.confidence"
    ? {
        value: CONFIDENCE_PROBES.map((n) => {
          const level = confidenceLevel(n);
          return { n, level: { $case: level, ...CONFIDENCE_LEVEL_INFO[level] }, actionable: isActionable(n) };
        }),
      }
    : undefined,
);

registerParityResolver(
  "TradingCalendar.",
  (key, ctx, trades) => {
    if (ctx.brand !== "greenwick") return undefined;
    const st = trades as readonly GreenwickTrade[];
    switch (key) {
      case "TradingCalendar.tradingDayCount":
        return { value: etTradingDayCount(st) };
      case "TradingCalendar.dailyPnL": {
        const rows = [...dailyPnL(st)].map(([day, pnl]) => ({ day: TRADING_CALENDAR.dayKey(day), pnl }));
        return { value: stableSorted(rows, (a, b) => a.day < b.day) };
      }
      case "TradingCalendar.groupedByWeekday":
        return { value: Object.fromEntries([...groupedByTradingWeekday(st)].map(([day, ts]) => [day, ts.map((t) => t.ticket)])) };
      default:
        return undefined;
    }
  },
  ["TradingCalendar.tradingDayCount"],
);
