// SessionRankingCard (Overview, both brands). SPEC Appendix A "SessionRankingCard".
//
// Dojix `Components/SessionRankingCard.swift:16-37` over `TradingSession.allCases`; Greenwick
// over `MarketSession.allCases` (identical math).
// Non-empty sessions in enum order, stable-sorted by P&L descending (so equal P&Ls keep enum
// order), rank = index + 1; per session P&L (input order), trade count and WR%.

import type { EngineContext } from "../engine/context";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, stableSorted } from "../swiftcompat/collections";
import { sessionCases } from "./session-intelligence";
import { percentOf, sumProfit, winCount } from "./shared";

export interface SessionRank {
  rank: number;
  /** Raw session value. */
  session: string;
  name: string;
  pnl: number;
  trades: number;
  /** Percent. */
  winRate: number;
}

export interface SessionRankingModel {
  sessions: SessionRank[];
}

export function sessionRanking(ctx: EngineContext, trades: readonly Trade[]): SessionRankingModel {
  const grouped = groupByFirstAppearance(trades, (t) => t.session as string);
  const ranked: Omit<SessionRank, "rank">[] = [];
  for (const { id, displayName } of sessionCases(ctx)) {
    const sessionTrades = grouped.get(id) ?? [];
    if (sessionTrades.length === 0) continue;
    ranked.push({
      session: id,
      name: displayName,
      pnl: sumProfit(sessionTrades),
      trades: sessionTrades.length,
      winRate: percentOf(winCount(sessionTrades), sessionTrades.length),
    });
  }
  return {
    sessions: stableSorted(ranked, (a, b) => a.pnl > b.pnl).map((s, index) => ({ rank: index + 1, ...s })),
  };
}
