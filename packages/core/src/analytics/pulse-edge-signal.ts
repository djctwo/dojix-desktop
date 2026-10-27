// Pulse edge signal (SPEC Appendix A, Dojix only): "does now match your edge?"
//
// Port of Dojix `ViewModels/PulseViewModel.swift:196-279` (`generateEdgeSignals`) and the
// `EdgeSignal` model (`PulseViewModel.swift:361-380`); minimum `Configuration.
// minimumTradesForAnalysis` = 30 (`App/Configuration.swift:112`).
//
// - Active sessions and the hour come from "now" in UTC (`Date().activeTradingSessions`,
//   `Date().utcHour`): Asian 0–9, London 7–16, NY 12–21, Late 21–24 (NY Overlap never active).
// - n < 30: every active session (and the primary signal) is the neutral "Need more trades".
// - Per active session, trades whose stored session is in `relatedSessions` (London and NY
//   include NY Overlap), MetricsCalculator on them and on those whose stored `hour` equals the
//   current UTC hour:
//   - session ≥ 5 trades: WR ≥ 60 and PF ≥ 1.5 → +2; else WR < 40 or PF < 0.8 → −2
//     (PF is +∞ without losses, so a lossless session passes the PF test);
//   - hour ≥ 3 trades: WR ≥ 60 and profit > 0 → +1; else profit < 0 → −1;
//   - an active high-impact news window (danger zone) → −2;
//   - score ≥ 2 strong, ≥ 0 neutral, else avoid.
// - The primary signal is the best active session's (stable sort by level score, first).
//
// PARITY D-28: the Mac computes this once, in the Pulse view's `.task` (racing the calendar
// load, so the danger-zone penalty is usually missing). This function is pure in `ctx.now`
// and `activeDangerZone`; the desktop UI calls it again whenever the UTC hour or the active
// sessions change and after the economic calendar loads. Nothing in the engine differs.
//
// The Tier B harness reads only `Components/`, so this has no parity resolver; the Swift
// expectations are ported as unit tests.

import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { calculateMetrics, type PortfolioMetrics } from "../metrics/metrics-calculator";
import { TRADING_SESSION_INFO, type TradingSession } from "../model/enums";
import type { DojixTrade } from "../model/trade";
import { stableSorted } from "../swiftcompat/collections";
import { formatFixed } from "../swiftcompat/format";
import { fxActiveSessions, utcHour } from "../time/fx-sessions";

/** `Configuration.minimumTradesForAnalysis`. */
export const PULSE_MINIMUM_TRADES = 30;

export type EdgeSignalLevel = "avoid" | "neutral" | "strong";

/** `EdgeSignal.Level.score`: avoid 0, neutral 1, strong 2. */
export const EDGE_SIGNAL_SCORE: Readonly<Record<EdgeSignalLevel, number>> = { avoid: 0, neutral: 1, strong: 2 };

export interface EdgeSignal {
  level: EdgeSignalLevel;
  message: string;
  details: string;
}

export interface SessionEdgeSignal {
  session: TradingSession;
  signal: EdgeSignal;
  /** Metrics of the session's related trades (null below the 30-trade minimum). */
  metrics: PortfolioMetrics | null;
  /** The additive score behind the level (null below the minimum). */
  score: number | null;
}

export interface PulseEdgeSignalsModel {
  /** Active sessions at `ctx.now`, in the Mac's order. */
  activeSessions: TradingSession[];
  currentHour: number;
  /** One entry per active session, same order. */
  sessionEdgeSignals: SessionEdgeSignal[];
  /** The primary (best) signal. */
  edgeSignal: EdgeSignal | null;
  hasEnoughTrades: boolean;
}

export interface PulseEdgeSignalOptions {
  /** A high-impact news window is active right now (the Mac's `activeDangerZone != nil`). */
  activeDangerZone?: boolean;
}

const INSUFFICIENT: EdgeSignal = Object.freeze({
  level: "neutral",
  message: "Need more trades to generate signals",
  details: `Import at least ${PULSE_MINIMUM_TRADES} trades for personalized signals.`,
}) as EdgeSignal;

export function computePulseEdgeSignals(
  ctx: EngineContext,
  trades: readonly DojixTrade[],
  options: PulseEdgeSignalOptions = {},
): PulseEdgeSignalsModel {
  const activeSessions = fxActiveSessions(ctx.now);
  const currentHour = utcHour(ctx.now);

  if (trades.length < PULSE_MINIMUM_TRADES) {
    return {
      activeSessions,
      currentHour,
      sessionEdgeSignals: activeSessions.map((session) => ({ session, signal: { ...INSUFFICIENT }, metrics: null, score: null })),
      edgeSignal: { ...INSUFFICIENT },
      hasEnoughTrades: false,
    };
  }

  const sessionEdgeSignals: SessionEdgeSignal[] = [];
  for (const session of activeSessions) {
    const related = TRADING_SESSION_INFO[session].related;
    const relevant = trades.filter((t) => related.includes(t.session));
    const hourTrades = relevant.filter((t) => t.hour === currentHour);
    const metrics = calculateMetrics(relevant, ctx);
    const hourMetrics = calculateMetrics(hourTrades, ctx);

    let score = 0;
    const factors: string[] = [];
    if (metrics.totalTrades >= 5) {
      if (metrics.winRate >= 60 && metrics.profitFactor >= 1.5) {
        score += 2;
        factors.push(`${formatFixed(metrics.winRate, 0)}% win rate, ${formatFixed(metrics.profitFactor, 1)} PF`);
      } else if (metrics.winRate < 40 || metrics.profitFactor < 0.8) {
        score -= 2;
        factors.push(`Historically unprofitable (${formatFixed(metrics.winRate, 0)}% WR)`);
      }
    }
    if (hourMetrics.totalTrades >= 3) {
      if (hourMetrics.winRate >= 60 && hourMetrics.totalProfit > 0) {
        score += 1;
        factors.push(`${currentHour}:00 UTC is a strong hour`);
      } else if (hourMetrics.totalProfit < 0) {
        score -= 1;
        factors.push(`${currentHour}:00 UTC has negative P&L`);
      }
    }
    if (options.activeDangerZone === true) {
      score -= 2;
      factors.push("High-impact news active");
    }

    let level: EdgeSignalLevel;
    let message: string;
    if (score >= 2) {
      level = "strong";
      message = "Conditions match your edge";
    } else if (score >= 0) {
      level = "neutral";
      message = "Average conditions";
    } else {
      level = "avoid";
      message = "Poor conditions — sit out";
    }
    sessionEdgeSignals.push({
      session,
      signal: { level, message, details: factors.length === 0 ? "Insufficient data for this session." : `${factors.join(". ")}.` },
      metrics,
      score,
    });
  }

  const best = stableSorted(
    sessionEdgeSignals.map((s) => s.signal),
    (a, b) => EDGE_SIGNAL_SCORE[a.level] > EDGE_SIGNAL_SCORE[b.level],
  )[0];
  return { activeSessions, currentHour, sessionEdgeSignals, edgeSignal: best ?? null, hasEnoughTrades: true };
}

export const pulseEdgeSignalComponent = defineComponent<"dojix", PulseEdgeSignalsModel>({
  id: "PulseEdgeSignal",
  brands: ["dojix"],
  tab: "pulse",
  minTrades: 0,
  compute: (ctx, trades) => computePulseEdgeSignals(ctx, trades),
});
