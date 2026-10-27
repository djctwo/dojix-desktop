// PostCloseAnalysis (SPEC Appendix A, Dojix only): how far price kept moving after the exit.
//
// Port of Dojix `Components/PostCloseAnalysis.swift:8-57` (+ the insight in `body`, lines
// 119-138). Averages of postClose15m / postClose30m over all trades; early exits = wins with
// postClose30m > 10, as a share of wins; continuation bars for winners and losers (each pair
// only when that side has trades). Insight: "Consider trailing stops" when the early-exit share
// is above 40 %, else "Good exit timing" when the 30-minute average is below 0. Empty state: no
// trades (line 64).

import { defineComponent } from "../engine/registry";
import { isLoss, isWin } from "../model/accessors";
import type { DojixTrade } from "../model/trade";
import { swiftFormat } from "../swiftcompat/format";
import type { ComponentParity } from "./support";

/** `PostCloseAnalysis.ContinuationData` (stored: label, timeframe, avgPips; the UUID id is omitted). */
export interface ContinuationData {
  label: "Winners" | "Losers";
  timeframe: "15m" | "30m";
  avgPips: number;
}

export interface PostCloseAnalysisModel {
  avgPostClose15m: number;
  avgPostClose30m: number;
  earlyExitCount: number;
  /** Percent of wins. */
  earlyExitPercent: number;
  winContinuation: ContinuationData[];
  lossContinuation: ContinuationData[];
  /** View insight (null when neither condition holds). */
  insight: { kind: "trailingStops" | "goodTiming"; text: string } | null;
}

function averages(group: readonly DojixTrade[]): [number, number] {
  let s15 = 0;
  let s30 = 0;
  for (const t of group) s15 += t.postClose15m;
  for (const t of group) s30 += t.postClose30m;
  return [s15 / group.length, s30 / group.length];
}

function continuation(group: readonly DojixTrade[], label: ContinuationData["label"]): ContinuationData[] {
  if (group.length === 0) return [];
  const [a15, a30] = averages(group);
  return [
    { label, timeframe: "15m", avgPips: a15 },
    { label, timeframe: "30m", avgPips: a30 },
  ];
}

export function computePostCloseAnalysis(trades: readonly DojixTrade[]): PostCloseAnalysisModel {
  const [avg15, avg30] = trades.length === 0 ? [0, 0] : averages(trades);
  const wins = trades.filter(isWin);
  const losses = trades.filter(isLoss);
  let earlyExitCount = 0;
  for (const t of trades) if (t.postClose30m > 10 && isWin(t)) earlyExitCount += 1;
  let early = 0;
  for (const t of wins) if (t.postClose30m > 10) early += 1;
  const earlyExitPercent = wins.length === 0 ? 0 : (early / wins.length) * 100;

  let insight: PostCloseAnalysisModel["insight"] = null;
  if (earlyExitPercent > 40) {
    insight = {
      kind: "trailingStops",
      text: `Consider trailing stops — ${swiftFormat("%.0f", earlyExitPercent)}% of wins had 10+ pips continuation`,
    };
  } else if (avg30 < 0) {
    insight = { kind: "goodTiming", text: "Good exit timing — price reverses after your exits on average" };
  }

  return {
    avgPostClose15m: avg15,
    avgPostClose30m: avg30,
    earlyExitCount,
    earlyExitPercent,
    winContinuation: continuation(wins, "Winners"),
    lossContinuation: continuation(losses, "Losers"),
    insight,
  };
}

export const postCloseAnalysisComponent = defineComponent<"dojix", PostCloseAnalysisModel>({
  id: "PostCloseAnalysis",
  brands: ["dojix"],
  tab: "edgeReport",
  minTrades: 1,
  compute: (_ctx, trades) => computePostCloseAnalysis(trades),
});

export const postCloseAnalysisParity: ComponentParity<PostCloseAnalysisModel> = {
  component: "PostCloseAnalysis",
  brands: ["dojix"],
  compute: (_ctx, trades) => computePostCloseAnalysis(trades as readonly DojixTrade[]),
  members: {
    avgPostClose15m: (m) => m.avgPostClose15m,
    avgPostClose30m: (m) => m.avgPostClose30m,
    earlyExitCount: (m) => m.earlyExitCount,
    earlyExitPercent: (m) => m.earlyExitPercent,
    winContinuation: (m) => m.winContinuation.map((c) => ({ ...c })),
    lossContinuation: (m) => m.lossContinuation.map((c) => ({ ...c })),
  },
  integerMembers: ["earlyExitCount"],
};
