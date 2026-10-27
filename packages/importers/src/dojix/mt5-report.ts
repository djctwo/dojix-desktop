// MT5 "Account History" report (ReportHistory-<login>.html, UTF-16LE): the Positions section
// (SPEC §5.2, desktop-only). A linear-time table scanner, no DOM: the input is untrusted.
//
// Each position is one round trip: open time, position id, symbol, type, volume (lots), open
// price, S/L, T/P, close time, close price, commission, swap, profit. Profit excludes costs in
// MT5, so P&L = profit + commission + swap (the rule the Mac applies to MT4 statements).
// Times are server time, read as UTC (SPEC §3.1 broker time).

import { SwiftDecimal } from "@dojix-desktop/core";
import type { DojixMacTrade, ImportContext, ParsedRow, RowIssue } from "../model";
import { ImportError } from "../model";
import { DateParsers } from "../swift/dates";
import { swiftDouble, swiftInt64 } from "../swift/numbers";
import { trimWs } from "../swift/text";
import { dojixSlDistAndR } from "../derive";
import { OccurrenceCounter, dojixContentKey, dojixContentTicket } from "../tickets";
import { dojixCleanSymbol, dojixTimeFields, emptyDojixTrade } from "./generic";

interface Cell {
  text: string;
  isHeader: boolean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return safeCodePoint(parseInt(body.slice(2), 16)) ?? m;
    if (body.startsWith("#")) return safeCodePoint(parseInt(body.slice(1), 10)) ?? m;
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

function safeCodePoint(cp: number): string | null {
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/** Every `<tr>` of the document as its visible cells (cells with class "hidden" are dropped). */
export function htmlTableRows(html: string): Cell[][] {
  const lower = html.toLowerCase();
  const rows: Cell[][] = [];
  const starts: number[] = [];
  for (let i = lower.indexOf("<tr"); i >= 0; i = lower.indexOf("<tr", i + 3)) {
    const next = lower.charCodeAt(i + 3);
    if (next === 62 || next === 32 || next === 9 || next === 10 || next === 13 || next === 47) starts.push(i);
  }
  for (let r = 0; r < starts.length; r++) {
    const start = starts[r] as number;
    const end = r + 1 < starts.length ? (starts[r + 1] as number) : html.length;
    rows.push(cellsOf(html.slice(start, end), lower.slice(start, end)));
  }
  return rows;
}

function cellsOf(row: string, lower: string): Cell[] {
  const cells: Cell[] = [];
  const opens: { at: number; header: boolean }[] = [];
  for (let i = lower.indexOf("<t"); i >= 0; i = lower.indexOf("<t", i + 2)) {
    const kind = lower[i + 2];
    const after = lower.charCodeAt(i + 3);
    if ((kind === "d" || kind === "h") && (after === 62 || after === 32 || after === 9 || after === 10 || after === 13)) {
      opens.push({ at: i, header: kind === "h" });
    }
  }
  for (let c = 0; c < opens.length; c++) {
    const { at, header } = opens[c] as { at: number; header: boolean };
    const tagEnd = lower.indexOf(">", at);
    if (tagEnd < 0) break;
    const attrs = lower.slice(at, tagEnd);
    const limit = c + 1 < opens.length ? (opens[c + 1] as { at: number }).at : row.length;
    let contentEnd = lower.indexOf("</t", tagEnd);
    if (contentEnd < 0 || contentEnd > limit) contentEnd = limit;
    if (/class\s*=\s*["']?[^"'>]*\bhidden\b/.test(attrs)) continue;
    const text = trimWs(decodeEntities(stripTags(row.slice(tagEnd + 1, contentEnd))).replace(/\s+/g, " "));
    cells.push({ text, isHeader: header });
  }
  return cells;
}

/** True when the decoded text looks like an MT5 history report. */
export function looksLikeMt5Report(text: string): boolean {
  const head = text.slice(0, 200_000).toLowerCase();
  return (head.includes("<html") || head.includes("<table")) && head.includes("positions");
}

interface Columns {
  openTime: number;
  position: number;
  symbol: number;
  type: number;
  volume: number;
  openPrice: number;
  sl: number;
  tp: number;
  closeTime: number;
  closePrice: number;
  commission: number;
  swap: number;
  profit: number;
}

function columnsOf(header: readonly Cell[]): Columns | null {
  const names = header.map((c) => c.text.toLowerCase().replace(/\s+/g, " "));
  const all = (name: string) => names.flatMap((n, i) => (n === name ? [i] : []));
  const times = all("time");
  const prices = all("price");
  const one = (name: string) => names.indexOf(name);
  const cols = {
    openTime: times[0] ?? -1,
    position: one("position"),
    symbol: one("symbol"),
    type: one("type"),
    volume: one("volume"),
    openPrice: prices[0] ?? -1,
    sl: one("s / l"),
    tp: one("t / p"),
    closeTime: times[1] ?? -1,
    closePrice: prices[1] ?? -1,
    commission: one("commission"),
    swap: one("swap"),
    profit: one("profit"),
  };
  const required = [cols.openTime, cols.symbol, cols.type, cols.volume, cols.openPrice, cols.closeTime, cols.closePrice, cols.profit];
  return required.every((i) => i >= 0) ? cols : null;
}

function money(s: string | undefined): SwiftDecimal | null {
  if (s === undefined) return null;
  const cleaned = s.replace(/[\s\u00a0]/g, "");
  if (cleaned === "") return null;
  return SwiftDecimal.parse(cleaned, { matchEntireString: true });
}

/** Parses the Positions section of an MT5 report into Dojix trades. */
export function parseMt5Report(html: string, ctx: ImportContext): { rows: ParsedRow<DojixMacTrade>[]; issues: RowIssue[] } {
  const rows = htmlTableRows(html);
  const sectionIndex = rows.findIndex((r) => r.length >= 1 && r.length <= 2 && r.some((c) => c.text.toLowerCase() === "positions"));
  if (sectionIndex < 0) throw new ImportError("no_trade_section", "No Positions section found in the MT5 report");
  const header = rows[sectionIndex + 1];
  const cols = header ? columnsOf(header) : null;
  if (!cols) throw new ImportError("no_trade_section", "The Positions section has no column header");
  const dates = new DateParsers(["yyyy.MM.dd HH:mm:ss", "yyyy.MM.dd HH:mm"], "UTC", ctx.now, 64);
  const occurrences = new OccurrenceCounter();
  const out: ParsedRow<DojixMacTrade>[] = [];
  const issues: RowIssue[] = [];
  for (let r = sectionIndex + 2; r < rows.length; r++) {
    const cells = rows[r] as Cell[];
    if (cells.length === 0) continue;
    if (cells.some((c) => c.isHeader) || cells.length < 8) break; // next section
    const get = (i: number) => (i >= 0 ? cells[i]?.text : undefined);
    const rowNo = r + 1;
    const symbol = dojixCleanSymbol(get(cols.symbol) ?? "");
    const type = (get(cols.type) ?? "").toUpperCase();
    const direction = type.startsWith("BUY") ? "BUY" : type.startsWith("SELL") ? "SELL" : null;
    const openTime = dates.parse(get(cols.openTime) ?? "", trimWs);
    const closeTime = dates.parse(get(cols.closeTime) ?? "", trimWs);
    const lots = swiftDouble((get(cols.volume) ?? "").split("/")[0]?.replace(/[\s\u00a0]/g, "") ?? "");
    const openPrice = money(get(cols.openPrice));
    const closePrice = money(get(cols.closePrice));
    const profit = money(get(cols.profit));
    if (symbol === "") issues.push({ line: rowNo, code: "missing_symbol", reason: "No symbol" });
    else if (direction === null) issues.push({ line: rowNo, code: "invalid_direction", reason: `Type "${type.slice(0, 20)}" is not buy or sell` });
    else if (openTime === null || closeTime === null) issues.push({ line: rowNo, code: "invalid_date", reason: "Cannot read the open or close time" });
    else if (lots === null || !Number.isFinite(lots)) issues.push({ line: rowNo, code: "invalid_quantity", reason: "Cannot read the volume" });
    else if (openPrice === null || closePrice === null || profit === null) issues.push({ line: rowNo, code: "invalid_price", reason: "Cannot read a price or the profit" });
    else {
      const commission = money(get(cols.commission)) ?? SwiftDecimal.zero;
      const swap = money(get(cols.swap)) ?? SwiftDecimal.zero;
      const netProfit = profit.add(commission).add(swap);
      const sl = money(get(cols.sl)) ?? SwiftDecimal.zero;
      const tp = money(get(cols.tp)) ?? SwiftDecimal.zero;
      const trade: DojixMacTrade = {
        ...emptyDojixTrade(),
        symbol,
        direction,
        lots: Math.abs(lots),
        openTime,
        closeTime,
        ...dojixTimeFields(openTime, closeTime),
        openPrice,
        closePrice,
        sl,
        tp,
        netProfit,
      };
      const r2 = dojixSlDistAndR(symbol, openPrice, sl, netProfit, trade.lots, ctx.compat);
      trade.slDistPips = r2.slDistPips;
      trade.rMultiple = r2.rMultiple;
      const positionText = get(cols.position) ?? "";
      const ticket = swiftInt64(positionText);
      if (ticket !== null && ticket !== 0n) trade.ticket = ticket;
      else {
        const key = dojixContentKey(trade);
        trade.ticket = dojixContentTicket(key, occurrences.next(key));
      }
      out.push({
        trade,
        meta: {
          source: "mt5_report",
          line: rowNo,
          externalId: positionText === "" ? null : positionText.slice(0, 64),
          maeKnown: false,
          mfeKnown: false,
          strategyKnown: false,
          timeBasis: "utc",
        },
      });
    }
  }
  return { rows: out, issues };
}
