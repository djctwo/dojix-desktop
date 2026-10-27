// Parity resolvers for the E2 components (SPEC §10.2 Tier B).
//
// The Swift harness (tools/swift-ref/prepare.mjs) reads every computed member of every
// component and writes it under "<Component>.<member>" (or "<Component>[<instance>].<member>"
// for the extra instances it builds: PeriodComparison[week|quarter], TradeCalendar
// [lastTradeMonth]). Values are encoded by reflection (tools/swift-ref/shared/RefSupport.swift):
// structs as objects of their stored properties (UUID ids dropped) plus the computed ones of
// component-file types, labelled tuples as objects, trades as "#<ticket>", dates as ISO-8601
// UTC text with milliseconds, raw-value enums as their raw value, and Dictionary keys as text.
// The functions below rebuild those shapes from the desktop models, so `compareParity` can
// compare them field by field.

import type { EngineContext } from "../engine/context";
import type { EdgeCondition } from "../metrics/edges";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import type { Trade } from "../model/trade";
import type { ZonedCalendar } from "../time/zoned-calendar";
import { registerParityResolver } from "../parity/reference";
import { dayOfWeekChart } from "./day-of-week";
import { directionalEdge } from "./directional-edge";
import { durationAnalysis } from "./duration-analysis";
import { hourlyPnL } from "./hourly-pnl";
import { killZoneOptimizer, type TimeWindow } from "./kill-zone";
import { MAE_MFE_INSIGHT_TEXT, maeMfeChart } from "./mae-mfe";
import { performanceSummary } from "./performance-summary";
import { periodComparison, type ComparisonPeriod } from "./period-comparison";
import { rMultipleChart } from "./r-multiple";
import { sequenceAnalysis } from "./sequence-analysis";
import { sessionHeatmap } from "./session-heatmap";
import { SESSION_RECOMMENDATION_ICON, SESSION_RECOMMENDATION_LABEL, sessionIntelligence } from "./session-intelligence";
import { sessionRanking } from "./session-ranking";
import { sizeAnalysis } from "./size-analysis";
import { slippageAnalysis } from "./slippage";
import { streakCard } from "./streak-card";
import { streakTimeline } from "./streak-timeline";
import { symbolAnalytics } from "./symbol-analytics";
import { tradeCalendar, tradeCalendarGrid } from "./trade-calendar";
import { tradeTimeHeatmap } from "./trade-time-heatmap";
import { weeklyHeatmap } from "./weekly-heatmap";
import { whatToCut } from "./what-to-cut";
import { winLossDistribution } from "./win-loss-distribution";

/** A trade inside an analytics output ("#<ticket>"). */
export function refTrade(t: Pick<Trade, "ticket">): string {
  return `#${t.ticket}`;
}

/**
 * A Foundation `Calendar` as the harness writes it: its settings (RefSupport.swift
 * `refCalendar`). Foundation names the UTC zone "GMT".
 */
export function refCalendar(cal: ZonedCalendar, locale: string): Record<string, unknown> {
  return {
    firstWeekday: cal.weekStart,
    identifier: "gregorian",
    locale,
    minimumDaysInFirstWeek: cal.minDaysInFirstWeek,
    timeZone: cal.tz === "UTC" ? "GMT" : cal.tz,
  };
}

/** A date as the harness writes it ("2026-01-15T10:00:00.000Z"). */
export function refDate(t: number): string {
  return new Date(t).toISOString();
}

function refEdgeCondition(c: EdgeCondition): Record<string, unknown> {
  return {
    dimension: c.dimension,
    expectancy: c.expectancy,
    id: c.id,
    label: c.label,
    monthlyImpact: c.monthlyImpact,
    profitFactor: c.profitFactor,
    tradeCount: c.tradeCount,
    winRate: c.winRate,
    profit: c.profit,
  };
}

function refWindow(w: TimeWindow): Record<string, unknown> {
  return {
    count: w.count,
    endHour: w.endHour,
    label: w.label,
    monthlyImpact: w.monthlyImpact,
    pnl: w.pnl,
    startHour: w.startHour,
    winRate: w.winRate,
  };
}

type Member = (ctx: EngineContext, trades: readonly Trade[], instance: string | null) => unknown;

interface ComponentSpec {
  /** Swift type names (both brands' names where they differ). */
  names: readonly string[];
  members: Readonly<Record<string, Member>>;
  /** Members whose value is a Swift Int (compared exactly). */
  ints?: readonly string[];
  /** Instance suffixes the harness adds (besides the default instance). */
  instances?: readonly string[];
}

const cache = new WeakMap<readonly Trade[], Map<string, unknown>>();

/** One model per (trades, ctx brand/compat, component, instance), computed once. */
function memo<M>(trades: readonly Trade[], key: string, f: () => M): M {
  let m = cache.get(trades);
  if (!m) {
    m = new Map();
    cache.set(trades, m);
  }
  if (!m.has(key)) m.set(key, f());
  return m.get(key) as M;
}

function model<M>(name: string, f: (ctx: EngineContext, trades: readonly Trade[]) => M) {
  return (ctx: EngineContext, trades: readonly Trade[]): M => memo(trades, `${name}|${ctx.brand}|${ctx.compat}|${ctx.now}`, () => f(ctx, trades));
}

const hourly = model("hourly", hourlyPnL);
const duration = model("duration", durationAnalysis);
const days = model("days", dayOfWeekChart);
const timeHeat = model("timeHeat", tradeTimeHeatmap);
const weekly = model("weekly", weeklyHeatmap);
const rmult = model("rmult", rMultipleChart);
const perf = model("perf", performanceSummary);
const timeline = model("timeline", streakTimeline);
const sessHeat = model("sessHeat", sessionHeatmap);
const intel = model("intel", sessionIntelligence);
const seq = model("seq", sequenceAnalysis);
const cut = model("cut", whatToCut);
const kill = model("kill", killZoneOptimizer);
const size = model("size", sizeAnalysis);
const dist = model("dist", winLossDistribution);
const slip = model("slip", slippageAnalysis);
const maemfe = model("maemfe", maeMfeChart);
const symbols = model("symbols", symbolAnalytics);
const direction = model("direction", directionalEdge);
const ranking = model("ranking", sessionRanking);
const streak = model("streak", streakCard);

function calendarModel(ctx: EngineContext, trades: readonly Trade[], instance: string | null) {
  return memo(trades, `calendar|${ctx.brand}|${ctx.now}|${instance ?? ""}`, () => {
    // The default instance shows the month of `Date()`; [lastTradeMonth] the month of the latest close.
    let month = ctx.now;
    if (instance === "lastTradeMonth") {
      month = 0;
      for (const t of trades) if (t.closeTime > month || month === 0) month = t.closeTime;
    }
    return tradeCalendar(ctx, trades, month);
  });
}

function comparisonModel(ctx: EngineContext, trades: readonly Trade[], instance: string | null) {
  const period: ComparisonPeriod = instance === "week" ? "week" : instance === "quarter" ? "quarter" : "month";
  return memo(trades, `comparison|${ctx.brand}|${ctx.compat}|${ctx.now}|${period}`, () => periodComparison(ctx, trades, period));
}

const SPECS: readonly ComponentSpec[] = [
  {
    names: ["HourlyPnLChart"],
    members: { hourlyData: (c, t) => hourly(c, t).hourlyData.map((r) => ({ count: r.count, hour: r.hour, pnl: r.pnl })) },
  },
  {
    names: ["DurationAnalysis"],
    members: { buckets: (c, t) => duration(c, t).buckets.map((b) => ({ ...b })) },
  },
  {
    names: ["DayOfWeekChart"],
    members: { data: (c, t) => days(c, t).data.map((d) => ({ ...d })) },
  },
  {
    names: ["TradeTimeHeatmap"],
    members: {
      cells: (c, t) => timeHeat(c, t).cells.map((x) => ({ ...x })),
      maxAbsPnL: (c, t) => timeHeat(c, t).maxAbsPnL,
    },
  },
  {
    names: ["TradeCalendar"],
    instances: ["lastTradeMonth"],
    members: {
      dailyPnL: (c, t, i) => {
        const out: Record<string, number> = {};
        for (const [day, pnl] of calendarModel(c, t, i).dailyPnL) out[refDate(day)] = pnl;
        return out;
      },
      daysInMonth: (c, t, i) => calendarModel(c, t, i).days.map((d) => refDate(d.date)),
      firstWeekdayOffset: (c, t, i) => calendarModel(c, t, i).leadingBlankCount,
      // Dojix: Calendar.current; Greenwick: gridCalendar() = the ET trading calendar with the
      // computer's first weekday and Locale.current (TradeCalendar.swift:9 / :12, :143-148).
      calendar: (c) => refCalendar(tradeCalendarGrid(c), c.locale),
    },
    ints: ["firstWeekdayOffset"],
  },
  {
    names: ["WeeklyHeatmap"],
    members: {
      weeklyData: (c, t) =>
        weekly(c, t).weeklyData.map((w) => ({ id: w.id, profit: w.profit, tradeCount: w.tradeCount, weekStart: refDate(w.weekStart), winRate: w.winRate })),
      maxAbsProfit: (c, t) => weekly(c, t).maxAbsProfit,
      calculateStreak: (c, t) => weekly(c, t).currentStreak,
    },
    ints: ["calculateStreak"],
  },
  {
    names: ["RMultipleChart"],
    members: {
      buckets: (c, t) => rmult(c, t).buckets.map((b) => ({ ...b })),
      avgR: (c, t) => rmult(c, t).avgR,
      medianR: (c, t) => rmult(c, t).medianR,
      bestR: (c, t) => rmult(c, t).bestR,
      worstR: (c, t) => rmult(c, t).worstR,
    },
  },
  {
    names: ["PerformanceSummary"],
    members: {
      thisWeekTrades: (c, t) => perf(c, t).thisWeek.trades.map(refTrade),
      thisMonthTrades: (c, t) => perf(c, t).thisMonth.trades.map(refTrade),
      lastMonthTrades: (c, t) => perf(c, t).lastMonth.trades.map(refTrade),
      // Dojix: Calendar.current; Greenwick: TradingCalendar.calendar, pinned to en_US_POSIX
      // (PerformanceSummary.swift:7-8, TradingCalendar.swift:72-79).
      calendar: (c) => refCalendar(c.calendar, c.brand === "greenwick" ? "en_US_POSIX" : c.locale),
    },
  },
  {
    names: ["StreakTimeline"],
    members: { segments: (c, t) => timeline(c, t).segments.map((s) => ({ ...s })) },
  },
  {
    names: ["SessionHeatmap"],
    members: {
      dateRangeLabel: (c, t) => sessHeat(c, t).dateRangeLabel,
      heatmapData: (c, t) => sessHeat(c, t).heatmapData.map((x) => ({ ...x })),
      sortedActiveHours: (c, t) => sessHeat(c, t).sortedActiveHours,
      maxAbsProfit: (c, t) => sessHeat(c, t).maxAbsProfit,
    },
  },
  {
    names: ["SessionIntelligence"],
    members: {
      sessionData: (c, t) =>
        intel(c, t).sessionData.map((s) => ({
          avgR: s.avgR,
          id: s.id,
          profit: s.profit,
          profitFactor: s.profitFactor,
          recommendation: {
            $case: s.recommendation,
            icon: SESSION_RECOMMENDATION_ICON[s.recommendation],
            label: SESSION_RECOMMENDATION_LABEL[s.recommendation],
          },
          session: s.id,
          tradeCount: s.tradeCount,
          winRate: s.winRate,
        })),
    },
  },
  {
    names: ["SequenceAnalysis"],
    members: {
      sortedTrades: (c, t) => sortedByCloseAscending(t).map(refTrade),
      stats: (c, t) => {
        const s = seq(c, t).stats;
        return s === null
          ? null
          : {
              avgPnLAfterLoss: s.avgPnLAfterLoss,
              avgPnLAfterWin: s.avgPnLAfterWin,
              lossAfterLoss: s.lossAfterLoss,
              lossAfterWin: s.lossAfterWin,
              pattern: s.pattern,
              winAfterLoss: s.winAfterLoss,
              winAfterWin: s.winAfterWin,
            };
      },
    },
  },
  {
    names: ["WhatToCutAdvisor"],
    members: {
      tradingDays: (c, t) => cut(c, t).tradingDays,
      negativeConditions: (c, t) => cut(c, t).negativeConditions.map(refEdgeCondition),
      totalPotentialSavings: (c, t) => cut(c, t).totalPotentialSavings,
      worstCondition: (c, t) => {
        const w = cut(c, t).worstCondition;
        return w === null ? null : refEdgeCondition(w);
      },
      hasEnoughData: (c, t) => cut(c, t).hasEnoughData,
    },
    ints: ["tradingDays"],
  },
  {
    names: ["KillZoneOptimizer"],
    members: {
      tradingDays: (c, t) => kill(c, t).tradingDays,
      hourlyStats: (c, t) => kill(c, t).hourlyStats.map((h) => ({ ...h })),
      recommendWindows: (c, t) => kill(c, t).recommendWindows.map(refWindow),
      avoidWindows: (c, t) => kill(c, t).avoidWindows.map(refWindow),
      topWindowMonthlyPnL: (c, t) => kill(c, t).topWindowMonthlyPnL,
    },
    ints: ["tradingDays"],
  },
  {
    names: ["PeriodComparison"],
    instances: ["week", "quarter"],
    members: {
      currentPeriodTrades: (c, t, i) => comparisonModel(c, t, i).currentPeriodTrades.map(refTrade),
      previousPeriodTrades: (c, t, i) => comparisonModel(c, t, i).previousPeriodTrades.map(refTrade),
      comparisons: (c, t, i) =>
        comparisonModel(c, t, i).comparisons.map((m) => ({
          change: m.change,
          current: m.current,
          id: m.id,
          isPositiveGood: m.isPositiveGood,
          label: m.label,
          previous: m.previous,
        })),
    },
  },
  {
    names: ["LotSizeAnalysis", "ShareSizeAnalysis"],
    members: {
      avgLotsWins: (c, t) => size(c, t).avgWinSize,
      avgLotsLosses: (c, t) => size(c, t).avgLossSize,
      avgSharesWins: (c, t) => size(c, t).avgWinSize,
      avgSharesLosses: (c, t) => size(c, t).avgLossSize,
    },
  },
  {
    names: ["WinLossDistribution"],
    members: { buckets: (c, t) => dist(c, t).buckets.map((b) => ({ count: b.count, isProfit: b.isProfit, range: b.range })) },
  },
  {
    names: ["SlippageAnalysis"],
    members: {
      tradesWithSlippage: (c, t) => slip(c, t).tradesWithSlippage.map(refTrade),
      avgSlippage: (c, t) => slip(c, t).avgSlippage,
      totalSlippageCost: (c, t) => slip(c, t).totalSlippageCost,
      highSlippageTrades: (c, t) => slip(c, t).highSlippageTrades,
      buckets: (c, t) => slip(c, t).buckets.map((b) => ({ ...b })),
    },
    ints: ["highSlippageTrades"],
  },
  {
    names: ["MAEMFEChart"],
    members: {
      captureRatio: (c, t) => maemfe(c, t).captureRatio,
      avgMAE: (c, t) => maemfe(c, t).avgMAE,
      avgMFE: (c, t) => maemfe(c, t).avgMFE,
      mfeToMaeRatio: (c, t) => maemfe(c, t).mfeToMaeRatio,
      insightText: (c, t) => MAE_MFE_INSIGHT_TEXT[maemfe(c, t).rating],
      insightIcon: (c, t) => (maemfe(c, t).mfeToMaeRatio >= 2 ? "checkmark.circle" : "exclamationmark.circle"),
    },
  },
  {
    names: ["PairAnalytics", "SymbolAnalytics"],
    members: {
      pairGroups: (c, t) => symbols(c, t).cards.map((g) => ({ symbol: g.symbol, trades: g.trades.map(refTrade) })),
      symbolGroups: (c, t) => symbols(c, t).cards.map((g) => ({ symbol: g.symbol, trades: g.trades.map(refTrade) })),
    },
  },
  {
    names: ["DirectionalEdge"],
    members: {
      buyTrades: (c, t) => t.filter((x) => x.direction === "BUY").map(refTrade),
      sellTrades: (c, t) => t.filter((x) => x.direction === "SELL").map(refTrade),
      buyStats: (c, t) => ({ ...direction(c, t).buyStats }),
      sellStats: (c, t) => ({ ...direction(c, t).sellStats }),
    },
  },
  {
    names: ["SessionRankingCard"],
    members: {
      sessions: (c, t) => ranking(c, t).sessions.map((s) => ({ name: s.name, pnl: s.pnl, rank: s.rank, trades: s.trades, winRate: s.winRate })),
    },
  },
  {
    names: ["StreakCard"],
    members: {
      sortedTrades: (c, t) => sortedByCloseAscending(t).map(refTrade),
      currentStreak: (c, t) => streak(c, t).currentStreak,
      bestWinStreak: (c, t) => streak(c, t).bestWinStreak,
      bestLossStreak: (c, t) => streak(c, t).bestLossStreak,
      recentResults: (c, t) => streak(c, t).recentResults,
      isNearPersonalBest: (c, t) => streak(c, t).isNearPersonalBest ?? undefined,
    },
    ints: ["currentStreak", "bestWinStreak", "bestLossStreak"],
  },
];

const KEY_RE = /^([A-Za-z]+)(?:\[([A-Za-z0-9_]+)\])?\.([A-Za-z]+)$/;

/** The desktop value of an E2 reference key, or undefined when it isn't one this file covers. */
export function resolveE2Output(key: string, ctx: EngineContext, trades: readonly Trade[]): { value: unknown } | undefined {
  const m = KEY_RE.exec(key);
  if (!m) return undefined;
  const [, name, instance, member] = m as unknown as [string, string, string | undefined, string];
  const spec = SPECS.find((s) => s.names.includes(name));
  if (!spec) return undefined;
  if (instance !== undefined && !(spec.instances ?? []).includes(instance)) return undefined;
  const f = Object.hasOwn(spec.members, member) ? spec.members[member] : undefined;
  if (!f) return undefined;
  const value = f(ctx, trades, instance ?? null);
  return value === undefined ? undefined : { value };
}

/** Every "<Component>.<member>" key the E2 resolvers answer with a Swift Int (exact compare). */
export const E2_INTEGER_KEYS: readonly string[] = SPECS.flatMap((s) =>
  s.names.flatMap((n) => [null, ...(s.instances ?? [])].flatMap((i) => (s.ints ?? []).map((m) => `${n}${i === null ? "" : `[${i}]`}.${m}`))),
);

/** The component names covered here (one resolver prefix each). */
export const E2_PARITY_COMPONENTS: readonly string[] = SPECS.flatMap((s) => s.names);

for (const name of E2_PARITY_COMPONENTS) {
  // "<Name>." and "<Name>[" share one resolver per component name.
  for (const prefix of [`${name}.`, `${name}[`]) {
    registerParityResolver(prefix, resolveE2Output, E2_INTEGER_KEYS);
  }
}
