// Tickets computed exactly as each Mac app does (SPEC §5.1 step 6), so a Mac backup restored on
// the desktop plus a re-import of the same broker file never creates duplicates.

import { formatFixed } from "@dojix-desktop/core";
import type { DojixMacTrade } from "./model";
import { fnv1a64, sha256 } from "./hash";
import { decimalDescription, doubleDescription } from "./swift/numbers";

const utf8 = new TextEncoder();

/** Dojix: placeholder meaning "no usable broker ticket" (GenericCSVParser.swift:148). */
export const NO_TICKET = 0n;
/** Dojix content tickets live in [8e18, 9e18) (GenericCSVParser.swift:152). */
export const CONTENT_TICKET_BASE = 8_000_000_000_000_000_000n;

/** Swift `Date.timeIntervalSince1970` of an instant parsed into a `Date` (stored relative to 2001). */
export function timeIntervalSince1970(ms: number): number {
  return ms / 1000 - 978_307_200 + 978_307_200;
}

/** `GenericCSVParser.contentKey(for:)` (Dojix GenericCSVParser.swift:155-161). */
export function dojixContentKey(t: Pick<DojixMacTrade, "symbol" | "direction" | "lots" | "openTime" | "closeTime" | "openPrice" | "closePrice" | "netProfit">): string {
  return [
    t.symbol,
    t.direction,
    formatFixed(t.lots, 8),
    doubleDescription(timeIntervalSince1970(t.openTime)),
    doubleDescription(timeIntervalSince1970(t.closeTime)),
    decimalDescription(t.openPrice),
    decimalDescription(t.closePrice),
    decimalDescription(t.netProfit),
  ].join("|");
}

/** `GenericCSVParser.contentTicket(key:occurrence:)` (Dojix GenericCSVParser.swift:164-168). */
export function dojixContentTicket(key: string, occurrence: number): bigint {
  const digest = sha256(utf8.encode(`${key}#${occurrence}`));
  let value = 0n;
  for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(digest[i] as number);
  return CONTENT_TICKET_BASE + (value % 1_000_000_000_000_000_000n);
}

/** Counts identical keys inside one file, so genuine twins get distinct tickets. */
export class OccurrenceCounter {
  private readonly seen = new Map<string, number>();

  /** The occurrence index of `key` (0 for the first), then counts it. */
  next(key: string): number {
    const n = this.seen.get(key) ?? 0;
    this.seen.set(key, n + 1);
    return n;
  }
}

/** Greenwick `TicketKeyCounter.hash` (GenericCSVParser.swift:1053-1061): FNV-1a 64 masked to 63 bits, 0 → 1. */
export function greenwickHash(s: string): bigint {
  const positive = fnv1a64(utf8.encode(s)) & 0x7fff_ffff_ffff_ffffn;
  return positive === 0n ? 1n : positive;
}

/** Greenwick `TicketKeyCounter` (GenericCSVParser.swift:1044-1051). */
export class GreenwickTicketCounter {
  private readonly counter = new OccurrenceCounter();

  ticket(key: string): bigint {
    return greenwickHash(`${key}#${this.counter.next(key)}`);
  }
}
