// Helpers shared by the Greenwick-only analytics (E4). Each one names the Swift idiom it
// reproduces, so the components can stay line-for-line close to the Mac sources.

import { isWin, profitDouble } from "../../model/accessors";
import type { GreenwickTrade } from "../../model/trade";

/**
 * Swift `String` equality and hashing use canonical equivalence: "Café" written with a
 * precomposed "é" and with "e" + U+0301 is one dictionary key and one `Set` element. JS strings
 * compare code units, so group and dedupe on the NFC form.
 */
export function swiftStringKey(s: string): string {
  return s.normalize("NFC");
}

/**
 * Swift `String <` (what `sorted()` on `[String]` uses): lexicographic order of the Unicode
 * scalars of the NFC forms. JS `<` compares UTF-16 code units, which puts U+E000–U+FFFF after
 * astral characters; Swift puts them before.
 */
export function swiftStringLess(a: string, b: string): boolean {
  const x = swiftStringKey(a);
  const y = swiftStringKey(b);
  if (x === y) return false;
  const xi = x[Symbol.iterator]();
  const yi = y[Symbol.iterator]();
  for (;;) {
    const p = xi.next();
    const q = yi.next();
    if (p.done) return !q.done;
    if (q.done) return false;
    const cp = (p.value as string).codePointAt(0) as number;
    const cq = (q.value as string).codePointAt(0) as number;
    if (cp !== cq) return cp < cq;
  }
}

/**
 * `Dictionary(grouping:by:)` on a String key, in first-appearance order (the Mac's order is
 * random per process; SPEC §3.1 "Order"). Canonically equivalent keys share a group, and the
 * group is labelled with the spelling that appeared first, as Swift keeps the first key.
 */
export function groupByString<T>(items: Iterable<T>, key: (item: T) => string): { label: string; items: T[] }[] {
  const groups = new Map<string, { label: string; items: T[] }>();
  for (const item of items) {
    const label = key(item);
    const k = swiftStringKey(label);
    const g = groups.get(k);
    if (g) g.items.push(item);
    else groups.set(k, { label, items: [item] });
  }
  return [...groups.values()];
}

/** `trades.map(\.profitDouble).reduce(0, +)`: net P&L summed in input order. */
export function sumProfit(trades: readonly GreenwickTrade[]): number {
  let total = 0;
  for (const t of trades) total += profitDouble(t);
  return total;
}

/** `trades.filter(\.isWin).count`. */
export function winCount(trades: readonly GreenwickTrade[]): number {
  let n = 0;
  for (const t of trades) if (isWin(t)) n += 1;
  return n;
}

/** The parity harness writes a trade inside an analytics output as "#<ticket>". */
export function ticketRef(t: Pick<GreenwickTrade, "ticket">): string {
  return `#${t.ticket}`;
}
