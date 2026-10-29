// The Edge Report's AI request: the user message for each brand (SPEC 8.2).
//
// Ports of `PromptBuilder.edgeAnalysis(from:metrics:)`:
// - Dojix `Services/AI/PromptBuilder.swift:27-139`;
// - Greenwick `Services/AI/PromptBuilder.swift:27-112`.
//
// The text equals the Mac's for the same trades and metrics. It holds **aggregated statistics
// only**: totals, P&L / trade count / win rate per session, hour, day and pair (Dojix: also
// bias and volatility regime) or ticker (Greenwick), and a few averages and counts. Never a
// single trade, ticket, note, tag, emotion, comment or account detail.
//
// The system prompt is fixed in the Rust shell (`net/anthropic.rs`), which also checks that the
// message starts with `PROMPT_PREFIX` and ends with `PROMPT_SUFFIX` and sends exactly the bytes
// the preview showed.
//
// Desktop differences, all logged in PARITY:
// - control characters are removed from group labels (a symbol can't break the line layout or
//   the shell's shape check); labels without them are unchanged;
// - in `fixed` compat (D-18) an average MAE/MFE with no known values reads "n/a" instead of 0.

import {
  asCurrency,
  asPercent,
  asPips,
  asPoints,
  asProfitFactor,
  asRMultiple,
  calculateMetrics,
  edgeByBias,
  edgeByDay,
  edgeByHour,
  edgeByPair,
  edgeBySession,
  edgeBySymbol,
  edgeByVolRegime,
  formatFixed,
  isLoss,
  isWin,
  saturatingAverage,
  seqMax,
  seqMin,
  swiftFormat,
  type DojixTrade,
  type EdgeBreakdown,
  type EngineContext,
  type GreenwickTrade,
  type PortfolioMetrics,
} from "@dojix-desktop/core";

export const PROMPT_PREFIX =
  "Analyze my trading data and give me 3-5 specific recommendations to improve profitability.\n\n## Portfolio Summary\n";
export const PROMPT_SUFFIX = "Give me 3-5 specific, ranked recommendations with dollar impact estimates.";

/** The Mac requires 30 trades before it offers the analysis (`hasEnoughData`). */
export const MINIMUM_TRADES = 30;

type PromptContext = Pick<EngineContext, "brand" | "compat" | "locale">;

/** Group labels without control characters (Unicode Cc), so a symbol can't add lines. */
export function safeLabel(label: string): string {
  return label.replace(/\p{Cc}/gu, "");
}

const money = (x: number, ctx: PromptContext): string => asCurrency(x, ctx.locale);

/** Swift `"\(int)"`: plain digits, with Int.max printed as Swift does. */
const int = (n: number): string => swiftFormat("%d", n);

function summary(m: PortfolioMetrics, ctx: PromptContext, excursion: (x: number) => string): string {
  const ex = (x: number | null) => (x === null ? "n/a" : excursion(x));
  return (
    PROMPT_PREFIX +
    `- Total trades: ${int(m.totalTrades)}\n` +
    `- Win rate: ${asPercent(m.winRate)}\n` +
    `- Profit factor: ${asProfitFactor(m.profitFactor)}\n` +
    `- Total P&L: ${money(m.totalProfit, ctx)}\n` +
    `- Expectancy: ${money(m.expectancy, ctx)}/trade\n` +
    `- Avg win: ${money(m.averageWin, ctx)}, Avg loss: ${money(-m.averageLoss, ctx)}\n` +
    `- Max drawdown: ${money(m.maxDrawdown, ctx)}\n` +
    `- Avg R-multiple: ${asRMultiple(m.averageRMultiple)}\n` +
    `- Avg MAE: ${ex(m.averageMAE)}, Avg MFE: ${ex(m.averageMFE)}\n\n`
  );
}

function breakdown(title: string, rows: readonly EdgeBreakdown[], ctx: PromptContext): string {
  let s = `## ${title}\n`;
  for (const r of rows) {
    s += `- ${safeLabel(r.label)}: ${money(r.profit, ctx)} (${int(r.tradeCount)} trades, ${asPercent(r.winRate)} WR)\n`;
  }
  return `${s}\n`;
}

function hours(rows: readonly EdgeBreakdown[], ctx: PromptContext): string {
  const best = rows.filter((r) => r.profit > 0).slice(0, 5);
  const worst = rows
    .filter((r) => r.profit < 0)
    .slice(-5)
    .reverse();
  const list = (xs: readonly EdgeBreakdown[]) => xs.map((r) => `${safeLabel(r.label)} ${money(r.profit, ctx)}`).join(", ");
  return `## P&L by Hour (Top 5 Best / Worst)\nBest: ${list(best)}\nWorst: ${list(worst)}\n\n`;
}

function rMultiples(trades: readonly (DojixTrade | GreenwickTrade)[]): string {
  const r = trades.map((t) => t.rMultiple);
  const bigWins = r.filter((x) => x >= 2.0).length;
  const smallWins = r.filter((x) => x > 0 && x < 1.0).length;
  const bigLosses = r.filter((x) => x <= -1.0).length;
  return (
    "## R-Multiple Distribution\n" +
    `- 2R+ wins: ${int(bigWins)}, <1R wins: ${int(smallWins)}, -1R+ losses: ${int(bigLosses)}\n` +
    "- This tells you about trade management quality\n\n"
  );
}

function durations(trades: readonly (DojixTrade | GreenwickTrade)[], ctx: PromptContext): string {
  const flavor = ctx.brand === "dojix" ? "dojix" : "greenwick";
  const wins = saturatingAverage(trades.filter(isWin).map((t) => t.durationMin), flavor);
  const losses = saturatingAverage(trades.filter(isLoss).map((t) => t.durationMin), flavor);
  return (
    "## Duration Patterns\n" +
    `- Avg winner duration: ${int(wins)} min\n` +
    `- Avg loser duration: ${int(losses)} min\n` +
    "- If losers last longer, the trader may be holding losers hoping for recovery\n\n"
  );
}

/** Sum in Swift's `reduce(0, +)` order, then divide (NaN for an empty list, as in Swift). */
function mean(xs: readonly number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

/** Dojix `PromptBuilder.edgeAnalysis`. `metrics` defaults to `calculateMetrics(trades)`. */
export function dojixEdgeAnalysisPrompt(
  ctx: PromptContext,
  trades: readonly DojixTrade[],
  metrics: PortfolioMetrics = calculateMetrics(trades, ctx),
): string {
  let p = summary(metrics, ctx, asPips);
  p += breakdown("P&L by Session", edgeBySession(trades), ctx);
  p += hours(edgeByHour(trades), ctx);
  p += breakdown("P&L by Pair", edgeByPair(trades), ctx);
  p += breakdown("P&L by Day", edgeByDay(trades), ctx);
  p += breakdown("Bias Alignment", edgeByBias(trades), ctx);
  p += breakdown("Volatility Regime", edgeByVolRegime(trades), ctx);

  const winners = trades.filter(isWin);
  if (winners.length > 0) {
    const post15 = mean(winners.map((t) => t.postClose15m));
    const post30 = mean(winners.map((t) => t.postClose30m));
    p += "## Post-Close Continuation (Winners)\n";
    p += `- Avg 15m after exit: ${formatFixed(post15, 1)} pips\n`;
    p += `- Avg 30m after exit: ${formatFixed(post30, 1)} pips\n`;
    p += "(Positive = price continued in trade direction after exit = exiting too early)\n\n";
  }

  p += rMultiples(trades);
  p += durations(trades, ctx);

  const lots = trades.map((t) => t.lots);
  const avg = mean(lots);
  const max = seqMax(lots) ?? 0;
  const min = seqMin(lots) ?? 0;
  if (max > avg * 2) {
    p += "## Position Sizing Warning\n";
    p += `- Avg lots: ${formatFixed(avg, 2)}, Max: ${formatFixed(max, 2)}, Min: ${formatFixed(min, 2)}\n`;
    p += "- Max lot size is 2x+ the average — possible revenge trading or over-sizing\n\n";
  }
  return p + PROMPT_SUFFIX;
}

/** Greenwick `PromptBuilder.edgeAnalysis`. `metrics` defaults to `calculateMetrics(trades)`. */
export function greenwickEdgeAnalysisPrompt(
  ctx: PromptContext,
  trades: readonly GreenwickTrade[],
  metrics: PortfolioMetrics = calculateMetrics(trades, ctx),
): string {
  let p = summary(metrics, ctx, asPoints);
  p += breakdown("P&L by Session", edgeBySession(trades), ctx);
  p += hours(edgeByHour(trades), ctx);
  p += breakdown("P&L by Ticker", edgeBySymbol(trades), ctx);
  p += breakdown("P&L by Day", edgeByDay(trades), ctx);
  p += rMultiples(trades);
  p += durations(trades, ctx);

  const shares = trades.map((t) => t.shares);
  const avg = mean(shares);
  const max = seqMax(shares) ?? 0;
  const min = seqMin(shares) ?? 0;
  if (max > avg * 2) {
    p += "## Position Sizing Warning\n";
    p += `- Avg shares: ${formatFixed(avg, 0)}, Max: ${formatFixed(max, 0)}, Min: ${formatFixed(min, 0)}\n`;
    p += "- Max share size is 2x+ the average — possible revenge trading or over-sizing\n\n";
  }
  return p + PROMPT_SUFFIX;
}

/** The brand's prompt (the trades must be the brand's). */
export function edgeAnalysisPrompt(
  ctx: PromptContext,
  trades: readonly (DojixTrade | GreenwickTrade)[],
  metrics?: PortfolioMetrics,
): string {
  if (ctx.brand === "dojix") {
    return dojixEdgeAnalysisPrompt(ctx, trades.filter((t): t is DojixTrade => t.brand === "dojix"), metrics);
  }
  return greenwickEdgeAnalysisPrompt(ctx, trades.filter((t): t is GreenwickTrade => t.brand === "greenwick"), metrics);
}

/** The "## …" section titles a prompt contains, in order (for the preview's outline). */
export function promptSections(prompt: string): string[] {
  return [...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? "");
}
