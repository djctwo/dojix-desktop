// OANDA v20 API → trades, as pure functions (the HTTP client lives in the Rust `net` module).
// Dojix `Services/Import/OANDAService.swift`: ORDER_FILL transactions are paired by trade id
// (an opening fill's `tradeOpened` with a later fill's `tradesClosed`), units ÷ 100,000 = lots.

import { SwiftDecimal, fxSessionAt, intSaturating, utcHour, utcShortDayName } from "@dojix-desktop/core";
import type { DojixMacTrade, ImportContext, ParsedRow, RowIssue } from "../model";
import { parseIso8601 } from "../swift/dates";
import { swiftDouble, swiftInt64 } from "../swift/numbers";
import { trimWs } from "../swift/text";
import { emptyDojixTrade } from "./generic";

/** `OANDAService.OANDATransaction` (OANDAService.swift:248-257). */
export interface OandaTransaction {
  id?: string;
  type?: string;
  time?: string;
  instrument?: string;
  units?: string;
  price?: string;
  tradeOpened?: { tradeID: string };
  tradesClosed?: { tradeID: string; realizedPL?: string }[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Decodes one page's `transactions` array the way `JSONDecoder` does for `OANDATransaction`:
 * wrong-typed optional fields fail the whole page on the Mac; here they make the page invalid
 * too (null), so a malformed response imports nothing rather than something partial.
 */
export function decodeOandaPage(json: unknown): OandaTransaction[] | null {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { transactions?: unknown }).transactions)) return null;
  const out: OandaTransaction[] = [];
  for (const raw of (json as { transactions: unknown[] }).transactions) {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const tx: OandaTransaction = {};
    for (const key of ["id", "type", "time", "instrument", "units", "price"] as const) {
      const v = r[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") return null;
      tx[key] = v;
    }
    if (r.tradeOpened !== undefined && r.tradeOpened !== null) {
      const id = str((r.tradeOpened as Record<string, unknown>).tradeID);
      if (id === undefined) return null;
      tx.tradeOpened = { tradeID: id };
    }
    if (r.tradesClosed !== undefined && r.tradesClosed !== null) {
      if (!Array.isArray(r.tradesClosed)) return null;
      const closed: { tradeID: string; realizedPL?: string }[] = [];
      for (const c of r.tradesClosed) {
        if (typeof c !== "object" || c === null) return null;
        const id = str((c as Record<string, unknown>).tradeID);
        const pl = (c as Record<string, unknown>).realizedPL;
        if (id === undefined || (pl !== undefined && pl !== null && typeof pl !== "string")) return null;
        closed.push(typeof pl === "string" ? { tradeID: id, realizedPL: pl } : { tradeID: id });
      }
      tx.tradesClosed = closed;
    }
    out.push(tx);
  }
  return out;
}

/** `OANDAService.isTrustedOANDAURL` (OANDAService.swift:93-97): only HTTPS on oanda.com may get the token. */
export function isTrustedOandaUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && (host === "oanda.com" || host.endsWith(".oanda.com"));
}

/** `OANDAService.isValidAccountID` (OANDAService.swift:100-102). */
export function isValidOandaAccountId(id: string): boolean {
  return id !== "" && [...id].length <= 64 && /^[A-Za-z0-9-]+$/.test(id);
}

/** `cleanSymbol` of the OANDA service (OANDAService.swift:220-225): no space removal, unlike the CSV path. */
function cleanSymbol(raw: string): string {
  return trimWs(raw.toUpperCase().replaceAll("/", "").replaceAll("_", ""));
}

/** `parseOANDADate` (OANDAService.swift:227-234). */
function parseOandaDate(s: string | undefined): number | null {
  if (s === undefined) return null;
  return parseIso8601(s, true) ?? parseIso8601(s, false);
}

/**
 * `mapTransactionsToTrades` (OANDAService.swift:140-218). Rows the Mac would build from a missing
 * time get "now" there; the desktop reports them instead (a trade dated at import time is wrong).
 */
export function mapOandaTransactions(transactions: readonly OandaTransaction[], ctx: ImportContext): { rows: ParsedRow<DojixMacTrade>[]; issues: RowIssue[] } {
  const open = new Map<string, OandaTransaction>();
  const rows: ParsedRow<DojixMacTrade>[] = [];
  const issues: RowIssue[] = [];
  for (const tx of transactions) {
    if (tx.tradeOpened) open.set(tx.tradeOpened.tradeID, tx);
    for (const closed of tx.tradesClosed ?? []) {
      const openTx = open.get(closed.tradeID);
      if (!openTx) continue;
      open.delete(closed.tradeID);
      const symbol = cleanSymbol(tx.instrument ?? openTx.instrument ?? "");
      const signedUnits = swiftDouble(openTx.units ?? "0") ?? 0;
      const lots = Math.abs(signedUnits) / 100_000;
      const openTimeParsed = parseOandaDate(openTx.time);
      const closeTimeParsed = parseOandaDate(tx.time);
      if (ctx.compat === "fixed" && (openTimeParsed === null || closeTimeParsed === null)) {
        issues.push({ line: null, code: "invalid_date", reason: `OANDA trade ${closed.tradeID.slice(0, 32)} has no readable time` });
        continue;
      }
      const openTime = openTimeParsed ?? ctx.now;
      const closeTime = closeTimeParsed ?? ctx.now;
      const duration = intSaturating((closeTime - openTime) / 60_000, "dojix");
      const ticket = swiftInt64(closed.tradeID) ?? BigInt(intSaturating(ctx.now / 1000, "dojix"));
      const trade: DojixMacTrade = {
        ...emptyDojixTrade(),
        ticket,
        symbol,
        direction: signedUnits > 0 ? "BUY" : "SELL",
        lots,
        openTime,
        closeTime,
        durationMin: Math.max(0, duration),
        openPrice: SwiftDecimal.parse(openTx.price ?? "0") ?? SwiftDecimal.zero,
        closePrice: SwiftDecimal.parse(tx.price ?? "0") ?? SwiftDecimal.zero,
        netProfit: SwiftDecimal.parse(closed.realizedPL ?? "0") ?? SwiftDecimal.zero,
        session: fxSessionAt(openTime),
        dayOfWeek: utcShortDayName(openTime),
        hour: utcHour(openTime),
        comment: "OANDA",
      };
      rows.push({
        trade,
        meta: { source: "oanda_api", line: null, externalId: closed.tradeID.slice(0, 64), maeKnown: false, mfeKnown: false, strategyKnown: false, timeBasis: "utc" },
      });
    }
  }
  return { rows, issues };
}
