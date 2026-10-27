// PlaybookCatalog (SPEC Appendix A): each tag is a "setup" with its own metrics and a
// KEEP / REVIEW / DROP call.
//
// Port of Dojix `Components/PlaybookCatalog.swift:49-110` and Greenwick
// `Components/PlaybookCatalog.swift:49-110` (identical apart from the session type). Per tag:
// count, WR%, avgR, total P&L, PF (grossLoss > 0 ? gw/gl : gw > 0 ? ∞ : 0, shown and classified
// as 99.99 when infinite), best / worst session by summed P&L, the last 10 P&Ls by close time.
// KEEP when PF ≥ 1 and n ≥ 5; DROP when PF < 0.8 and n ≥ 5; else REVIEW. Sorted by |total|
// descending.
//
// Determinism: tags and sessions are grouped with `Dictionary`, so ties (equal |total|, equal
// session P&L) resolve in random order on the Mac. The desktop orders groups by first appearance
// in the input; best = the last maximum, worst = the first minimum in that order (max/min(by:)).

import type { BrandId } from "../brand";
import { defineComponent } from "../engine/registry";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { isLoss, isWin, profitDouble } from "../model/accessors";
import type { MarketSession, TradingSession } from "../model/enums";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, maxBy, minBy, stableSorted } from "../swiftcompat/collections";
import type { ComponentParity } from "./support";
import { tradesByTag } from "./tag-analytics";

export type PlaybookClassification = "KEEP" | "REVIEW" | "DROP";

/** `Classification.icon` (PlaybookCatalog.swift:38-44), part of the encoded enum. */
export const PLAYBOOK_CLASSIFICATION_ICON: Readonly<Record<PlaybookClassification, string>> = {
  KEEP: "checkmark.seal.fill",
  REVIEW: "exclamationmark.triangle.fill",
  DROP: "xmark.seal.fill",
};

/** `PlaybookCatalog.SetupData`. */
export interface PlaybookSetup<T extends Trade = Trade> {
  id: string;
  name: string;
  trades: T[];
  tradeCount: number;
  /** Percent. */
  winRate: number;
  avgR: number;
  /** 99.99 in place of +∞. */
  profitFactor: number;
  totalPnL: number;
  bestSession: TradingSession | MarketSession | null;
  worstSession: TradingSession | MarketSession | null;
  /** The last 10 P&Ls by close time (ascending). */
  recentPnL: number[];
  classification: PlaybookClassification;
}

export interface PlaybookCatalogModel<T extends Trade = Trade> {
  setups: PlaybookSetup<T>[];
  keepSetups: PlaybookSetup<T>[];
  reviewSetups: PlaybookSetup<T>[];
  dropSetups: PlaybookSetup<T>[];
}

function setupOf<T extends Trade>(tag: string, tagged: T[]): PlaybookSetup<T> {
  const count = tagged.length;
  let wins = 0;
  let rSum = 0;
  let totalPnL = 0;
  let grossWin = 0;
  let lossSum = 0;
  for (const t of tagged) {
    if (isWin(t)) wins += 1;
    rSum += t.rMultiple;
    totalPnL += profitDouble(t);
  }
  for (const t of tagged) if (isWin(t)) grossWin += profitDouble(t);
  for (const t of tagged) if (isLoss(t)) lossSum += profitDouble(t);
  const grossLoss = Math.abs(lossSum);
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  const sessionPnL: { session: TradingSession | MarketSession; pnl: number }[] = [];
  for (const [session, group] of groupByFirstAppearance(tagged, (t) => t.session)) {
    let s = 0;
    for (const t of group) s += profitDouble(t);
    sessionPnL.push({ session, pnl: s });
  }
  const less = (a: { pnl: number }, b: { pnl: number }) => a.pnl < b.pnl;
  const best = maxBy(sessionPnL, less);
  const worst = minBy(sessionPnL, less);

  const effectivePF = pf === Infinity || pf === -Infinity ? 99.99 : pf;
  let classification: PlaybookClassification;
  if (effectivePF >= 1.0 && count >= 5) classification = "KEEP";
  else if (effectivePF < 0.8 && count >= 5) classification = "DROP";
  else classification = "REVIEW";

  return {
    id: tag,
    name: tag,
    trades: tagged,
    tradeCount: count,
    winRate: (wins / count) * 100,
    avgR: rSum / count,
    profitFactor: effectivePF,
    totalPnL,
    bestSession: best?.session ?? null,
    worstSession: worst?.session ?? null,
    recentPnL: sortedByCloseAscending(tagged).slice(-10).map(profitDouble),
    classification,
  };
}

export function computePlaybookCatalog<T extends Trade>(trades: readonly T[]): PlaybookCatalogModel<T> {
  const rows = [...tradesByTag(trades)].map(([tag, tagged]) => setupOf(tag, tagged));
  const setups = stableSorted(rows, (a, b) => Math.abs(a.totalPnL) > Math.abs(b.totalPnL));
  return {
    setups,
    keepSetups: setups.filter((s) => s.classification === "KEEP"),
    reviewSetups: setups.filter((s) => s.classification === "REVIEW"),
    dropSetups: setups.filter((s) => s.classification === "DROP"),
  };
}

export const playbookCatalogComponent = defineComponent<BrandId, PlaybookCatalogModel>({
  id: "PlaybookCatalog",
  brands: ["dojix", "greenwick"],
  tab: "behavioral",
  minTrades: 0,
  compute: (_ctx, trades) => {
    const m = computePlaybookCatalog(trades);
    return m.setups.length === 0 ? null : m;
  },
});

const CASE: Readonly<Record<PlaybookClassification, string>> = { KEEP: "keep", REVIEW: "review", DROP: "drop" };

/** A setup as the harness encodes `SetupData` (Classification is RefDumpable: $case, $raw, icon). */
export function playbookSetupRef(s: PlaybookSetup): unknown {
  return {
    id: s.id,
    name: s.name,
    trades: s.trades.map((t) => `#${t.ticket}`),
    tradeCount: s.tradeCount,
    winRate: s.winRate,
    avgR: s.avgR,
    profitFactor: s.profitFactor,
    totalPnL: s.totalPnL,
    bestSession: s.bestSession,
    worstSession: s.worstSession,
    recentPnL: [...s.recentPnL],
    classification: { $case: CASE[s.classification], $raw: s.classification, icon: PLAYBOOK_CLASSIFICATION_ICON[s.classification] },
  };
}

export const playbookCatalogParity: ComponentParity<PlaybookCatalogModel> = {
  component: "PlaybookCatalog",
  brands: ["dojix", "greenwick"],
  compute: (_ctx, trades) => computePlaybookCatalog(trades),
  members: {
    setups: (m) => m.setups.map(playbookSetupRef),
    keepSetups: (m) => m.keepSetups.map(playbookSetupRef),
    reviewSetups: (m) => m.reviewSetups.map(playbookSetupRef),
    dropSetups: (m) => m.dropSetups.map(playbookSetupRef),
  },
};
