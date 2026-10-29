// Currency strength for Pulse (Dojix): port of `TwelveDataService.calculateStrength`
// (Dojix `Services/LiveData/TwelveDataService.swift:144-166`).
//
// For each "BASE/QUOTE" quote the daily % change is added to BASE and subtracted from QUOTE;
// scores are divided by the largest absolute score (so they fall in −1…1) and sorted by
// absolute strength, strongest first.
//
// Order of ties: the Mac builds a Dictionary (random order) and sorts it with Swift's
// unstable sort, so equal strengths come out in any order. The desktop keeps the order in which
// currencies first appear and sorts stably (SPEC §3.1 "Order").

import { stableSorted } from "../swiftcompat/collections";

export interface StrengthQuote {
  symbol: string;
  changePercent: number;
}

export interface CurrencyStrength {
  currency: string;
  /** −1 … 1. */
  strength: number;
}

export function currencyStrength(quotes: readonly StrengthQuote[]): CurrencyStrength[] {
  const scores = new Map<string, number>();
  for (const q of quotes) {
    const parts = q.symbol.split("/");
    if (parts.length !== 2) continue;
    const [base, counter] = parts as [string, string];
    // A non-finite change would poison every score; the Mac's REST parser never yields one.
    const change = Number.isFinite(q.changePercent) ? q.changePercent : 0;
    scores.set(base, (scores.get(base) ?? 0) + change);
    scores.set(counter, (scores.get(counter) ?? 0) - change);
  }
  let maxAbs = 0;
  for (const v of scores.values()) maxAbs = Math.max(maxAbs, Math.abs(v));
  // No movement, or sums beyond the double range (hostile input): nothing to show.
  if (scores.size === 0 || !(maxAbs > 0) || !Number.isFinite(maxAbs)) return [];
  const rows = [...scores].map(([currency, score]) => ({ currency, strength: score / maxAbs }));
  return stableSorted(rows, (a, b) => Math.abs(a.strength) > Math.abs(b.strength));
}
