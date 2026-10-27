// SessionIntelligence (Sessions tab, both brands). SPEC Appendix A "SessionIntelligence".
//
// Dojix `Components/SessionIntelligence.swift:17-86,157-158` over `TradingSession.allCases`;
// Greenwick over `MarketSession.allCases` (identical math).
//
// Per non-empty session, in enum order: profit (input order), WR%, average R, profit factor
// (+∞ with wins and no losses, 0 with neither) and a recommendation:
// FOCUS (avgR ≥ .5, WR ≥ 50, n ≥ 5) · OK (avgR ≥ 0, WR ≥ 40) · AVOID (avgR < 0, n ≥ 5) ·
// otherwise REDUCE.

import type { EngineContext } from "../engine/context";
import { profitFactorOf } from "../metrics/metrics-calculator";
import { isLoss, isWin, profitDouble } from "../model/accessors";
import { MARKET_SESSIONS, MARKET_SESSION_INFO, TRADING_SESSIONS, TRADING_SESSION_INFO } from "../model/enums";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance } from "../swiftcompat/collections";
import { meanR, percentOf } from "./shared";
import { sumProfit } from "./support";

export type SessionRecommendation = "focus" | "neutral" | "reduce" | "avoid";

/** `Recommendation.label` (SessionIntelligence.swift:20-27). */
export const SESSION_RECOMMENDATION_LABEL: Readonly<Record<SessionRecommendation, string>> = {
  focus: "FOCUS",
  neutral: "OK",
  reduce: "REDUCE",
  avoid: "AVOID",
};

/** `Recommendation.icon` (SF Symbol names; the UI maps them to its own icons). */
export const SESSION_RECOMMENDATION_ICON: Readonly<Record<SessionRecommendation, string>> = {
  focus: "star.fill",
  neutral: "minus.circle",
  reduce: "arrow.down.circle",
  avoid: "xmark.circle.fill",
};

export interface SessionData {
  /** Raw session value ("LONDON", "REGULAR", …). */
  id: string;
  displayName: string;
  profit: number;
  tradeCount: number;
  wins: number;
  losses: number;
  /** Percent. */
  winRate: number;
  avgR: number;
  /** +∞ when there are wins and no losses (shown as "99.99"). */
  profitFactor: number;
  recommendation: SessionRecommendation;
}

export interface SessionIntelligenceModel {
  sessionData: SessionData[];
  /** Display names of the FOCUS sessions ("Focus on: …"). */
  focus: string[];
  /** Display names of the AVOID sessions ("Avoid: …"). */
  avoid: string[];
}

export function sessionRecommendation(avgR: number, winRate: number, count: number): SessionRecommendation {
  if (avgR >= 0.5 && winRate >= 50 && count >= 5) return "focus";
  if (avgR >= 0 && winRate >= 40) return "neutral";
  if (avgR < 0 && count >= 5) return "avoid";
  return "reduce";
}

/** Sessions in `allCases` order with their display names, per brand. */
export function sessionCases(ctx: EngineContext): readonly { id: string; displayName: string }[] {
  return ctx.brand === "dojix"
    ? TRADING_SESSIONS.map((s) => ({ id: s, displayName: TRADING_SESSION_INFO[s].displayName }))
    : MARKET_SESSIONS.map((s) => ({ id: s, displayName: MARKET_SESSION_INFO[s].displayName }));
}

export function sessionIntelligence(ctx: EngineContext, trades: readonly Trade[]): SessionIntelligenceModel {
  const grouped = groupByFirstAppearance(trades, (t) => t.session as string);
  const sessionData: SessionData[] = [];
  for (const { id, displayName } of sessionCases(ctx)) {
    const sessionTrades = grouped.get(id) ?? [];
    if (sessionTrades.length === 0) continue;
    const winners = sessionTrades.filter(isWin);
    const losers = sessionTrades.filter(isLoss);
    const winRate = percentOf(winners.length, sessionTrades.length);
    const avgR = meanR(sessionTrades);
    let grossWin = 0;
    for (const t of winners) grossWin += profitDouble(t);
    let lossSum = 0;
    for (const t of losers) lossSum += profitDouble(t);
    sessionData.push({
      id,
      displayName,
      profit: sumProfit(sessionTrades),
      tradeCount: sessionTrades.length,
      wins: winners.length,
      losses: losers.length,
      winRate,
      avgR,
      profitFactor: profitFactorOf(grossWin, Math.abs(lossSum)),
      recommendation: sessionRecommendation(avgR, winRate, sessionTrades.length),
    });
  }
  return {
    sessionData,
    focus: sessionData.filter((s) => s.recommendation === "focus").map((s) => s.displayName),
    avoid: sessionData.filter((s) => s.recommendation === "avoid").map((s) => s.displayName),
  };
}
