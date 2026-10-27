// Greenwick FIFO pairing (`GenericCSVParser.pairTransactions`, GenericCSVParser.swift:203-312).
//
// Per symbol (symbols in ascending order), transactions sorted by date (stable), buys and sells
// queued; each match takes min(remaining) shares. Costs are prorated by each side's own size:
//   commission = (buy.comm + buy.fees) × Decimal(matched / buy.shares)
//              + (sell.comm + sell.fees) × Decimal(matched / sell.shares)
//   net P&L    = (sell.price − buy.price) × Decimal(matched) − commission
// A sell dated before its buy is a short (opens with the sale). Pairs whose P&L or costs exceed
// 1e12 are skipped. Output is sorted by open time (stable).
//
// Desktop fixes in `fixed` mode: unmatched legs are reported (D-25); a sell and a buy with the
// same timestamp (date-only exports) are ordered by file position to detect shorts (D-26).

import type { CompatMode, SwiftDecimal } from "@dojix-desktop/core";
import type { GreenwickMacTrade, ParsedRow, RowIssue } from "../model";
import { decimalDescription, decimalFromDouble, doubleDescription } from "../swift/numbers";
import { GreenwickTicketCounter, timeIntervalSince1970 } from "../tickets";
import { TRADE_LIMITS } from "./limits";
import { emptyGreenwickTrade, greenwickTimeFields, GREENWICK_PLATFORM_NAME, GREENWICK_PLATFORM_SOURCE, type GreenwickPlatform } from "./generic";

/** `RawTransaction` (GenericCSVParser.swift:191-199) plus its position in the file. */
export interface RawTransaction {
  symbol: string;
  isBuy: boolean;
  shares: number;
  price: SwiftDecimal;
  /** Epoch ms. */
  date: number;
  commission: SwiftDecimal;
  fees: SwiftDecimal;
  /** 1-based line in the file (desktop only). */
  line: number | null;
}

interface QueueItem {
  txn: RawTransaction;
  remaining: number;
}

/** Swift `String <` for symbols: Unicode scalar order after canonical (NFC) normalisation. */
function compareSymbols(a: string, b: string): number {
  const x = [...a.normalize("NFC")].map((c) => c.codePointAt(0) as number);
  const y = [...b.normalize("NFC")].map((c) => c.codePointAt(0) as number);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
}

function abs(d: SwiftDecimal): SwiftDecimal {
  return d.sign() < 0 ? d.negate() : d;
}

function outOfRange(d: SwiftDecimal): boolean {
  return d.isNaN || abs(d).compare(TRADE_LIMITS.maxAbsAmount) > 0;
}

/** Decimal(x) for a share ratio; shares are finite and bounded, so the Swift trap never fires. */
function dec(x: number): SwiftDecimal {
  return decimalFromDouble(x) as SwiftDecimal;
}

export interface FifoOutput {
  rows: ParsedRow<GreenwickMacTrade>[];
  issues: RowIssue[];
}

export function pairTransactions(transactions: readonly RawTransaction[], platform: GreenwickPlatform, compat: CompatMode): FifoOutput {
  const bySymbol = new Map<string, { txn: RawTransaction; order: number }[]>();
  transactions.forEach((txn, order) => {
    const list = bySymbol.get(txn.symbol) ?? [];
    list.push({ txn, order });
    bySymbol.set(txn.symbol, list);
  });
  const name = GREENWICK_PLATFORM_NAME[platform];
  const tickets = new GreenwickTicketCounter();
  const rows: ParsedRow<GreenwickMacTrade>[] = [];
  const issues: RowIssue[] = [];
  const symbols = [...bySymbol.keys()].sort(compareSymbols);
  for (const symbol of symbols) {
    const sorted = [...(bySymbol.get(symbol) ?? [])].sort((a, b) => a.txn.date - b.txn.date || a.order - b.order);
    const orderOf = new Map(sorted.map((s) => [s.txn, s.order]));
    const buys: QueueItem[] = [];
    const sells: QueueItem[] = [];
    for (const { txn } of sorted) {
      (txn.isBuy ? buys : sells).push({ txn, remaining: txn.shares });
      while (buys.length > 0 && sells.length > 0) {
        const b = buys[0] as QueueItem;
        const s = sells[0] as QueueItem;
        const match = Math.min(b.remaining, s.remaining);
        if (!(match > 0)) break;
        const buy = b.txn;
        const sell = s.txn;
        const pnl = sell.price.subtract(buy.price).multiply(dec(match));
        const commPortion = buy.commission
          .add(buy.fees)
          .multiply(dec(match / buy.shares))
          .add(sell.commission.add(sell.fees).multiply(dec(match / sell.shares)));
        const net = pnl.subtract(commPortion);
        const consume = () => {
          b.remaining -= match;
          s.remaining -= match;
          if (b.remaining <= 0.0001) buys.shift();
          if (s.remaining <= 0.0001) sells.shift();
        };
        if (outOfRange(net) || outOfRange(commPortion)) {
          issues.push({ line: sell.line, code: "fifo_out_of_range", reason: `Skipped a ${symbol} pair with an out-of-range P&L` });
          consume();
          continue;
        }
        const ticket = tickets.ticket(
          [
            name,
            symbol,
            doubleDescription(timeIntervalSince1970(buy.date)),
            decimalDescription(buy.price),
            doubleDescription(buy.shares),
            doubleDescription(timeIntervalSince1970(sell.date)),
            decimalDescription(sell.price),
            doubleDescription(sell.shares),
            doubleDescription(match),
          ].join("|"),
        );
        let isShort = sell.date < buy.date;
        if (compat === "fixed" && sell.date === buy.date) {
          isShort = (orderOf.get(sell) ?? 0) < (orderOf.get(buy) ?? 0); // D-26
        }
        const openTime = isShort ? sell.date : buy.date;
        const closeTime = isShort ? buy.date : sell.date;
        rows.push({
          trade: {
            ...emptyGreenwickTrade(),
            ticket,
            symbol,
            direction: isShort ? "SELL" : "BUY",
            shares: match,
            openTime,
            closeTime,
            ...greenwickTimeFields(openTime, closeTime),
            openPrice: isShort ? sell.price : buy.price,
            closePrice: isShort ? buy.price : sell.price,
            netProfit: net,
            commission: commPortion,
          },
          meta: {
            source: GREENWICK_PLATFORM_SOURCE[platform],
            line: (isShort ? sell : buy).line,
            externalId: null,
            maeKnown: false,
            mfeKnown: false,
            strategyKnown: false,
            timeBasis: "utc",
          },
        });
        consume();
      }
    }
    if (compat === "fixed") {
      // D-25: unmatched legs are reported, not logged (buys) or dropped (sells).
      for (const q of buys) issues.push({ line: q.txn.line, code: "unmatched_leg", reason: `${symbol}: ${doubleDescription(q.remaining)} share(s) bought and not sold yet (open position)` });
      for (const q of sells) issues.push({ line: q.txn.line, code: "unmatched_leg", reason: `${symbol}: ${doubleDescription(q.remaining)} share(s) sold without a matching buy in this file` });
    }
  }
  const ordered = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.trade.openTime - b.r.trade.openTime || a.i - b.i);
  return { rows: ordered.map((x) => x.r), issues };
}
