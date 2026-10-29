// "What is sent" (SPEC 8.2): the disclosure shown next to Run Analysis and in the consent
// dialog, and the Mac's wording for reference.
//
// The Mac texts (Dojix `Views/EdgeReportView.swift:171-173`, Greenwick
// `App/Configuration.swift:23-27`) name the per-group statistics but not every section of the
// prompt. The desktop text lists everything the prompt builders in `edge-analysis.ts` can add
// (PARITY "AI disclosure"), and the preview shows the exact request.

import type { BrandId } from "@dojix-desktop/core";

export const MAC_DATA_SENT: Readonly<Record<BrandId, string>> = {
  dojix:
    "Optional. Clicking Run Analysis sends a summary of your trades (totals, and P&L and win rate by session, hour, day, pair, bias and volatility) to Anthropic using your own API key, billed to your Anthropic account. Individual trades, tickets and notes are not sent. Nothing is sent unless you click.",
  greenwick:
    "When you click Run Analysis, Greenwick sends summary statistics (overall totals, and P&L by session, hour, ticker and weekday) to Anthropic's API, billed to your own API key. Individual trades, notes, tags, screenshots and account details are not sent.",
};

export const DATA_SENT: Readonly<Record<BrandId, string>> = {
  dojix:
    "When you click Run Analysis, Dojix sends summary statistics to Anthropic's API, using your own API key and billed to your Anthropic account: overall totals (trade count, win rate, profit factor, P&L, expectancy, average win and loss, maximum drawdown, average R-multiple, MAE and MFE); P&L, trade count and win rate by session, hour, pair, weekday, bias alignment and volatility regime; how far price moved on average after winning exits; how many trades reached 2R or more, under 1R, or lost 1R or more; the average duration of winners and losers; and, when your largest position is more than twice the average, the average, largest and smallest lot sizes. Individual trades, tickets, notes, tags, emotions, screenshots and account details are not sent. Nothing is sent unless you click, and you can see the exact request first.",
  greenwick:
    "When you click Run Analysis, Greenwick sends summary statistics to Anthropic's API, using your own API key and billed to your Anthropic account: overall totals (trade count, win rate, profit factor, P&L, expectancy, average win and loss, maximum drawdown, average R-multiple, MAE and MFE); P&L, trade count and win rate by session, hour, ticker and weekday; how many trades reached 2R or more, under 1R, or lost 1R or more; the average duration of winners and losers; and, when your largest position is more than twice the average, the average, largest and smallest share counts. Individual trades, notes, tags, emotions, screenshots and account details are not sent. Nothing is sent unless you click, and you can see the exact request first.",
};

/** Shown before the first run (SPEC 8.2 "The first run needs consent"). */
export function consentText(brand: BrandId): string {
  const product = brand === "dojix" ? "Dojix" : "Greenwick";
  return `${DATA_SENT[brand]}\n\nAnthropic processes the request under its own terms. ${product} keeps the answer in your encrypted journal.`;
}

/** Shown when AI analysis is off or no key is saved. */
export function aiOffText(brand: BrandId): string {
  const product = brand === "dojix" ? "Dojix" : "Greenwick";
  return `Optional and off by default. To use it, add your own Anthropic API key and switch on AI analysis in Settings › AI. ${product} never sends anything to an AI service without your key, the switch and a click on Run Analysis. Everything else on this page works without it.`;
}
