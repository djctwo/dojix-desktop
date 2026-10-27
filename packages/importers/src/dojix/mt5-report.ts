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

/** Scanner limits: anything beyond them is not an MT5 report the terminal writes. */
export const REPORT_LIMITS = Object.freeze({ maxRows: 2_000_000, maxCellsPerRow: 64, maxCellLength: 4096, maxAttributeLength: 4096 });

/** True when the attribute text of a tag has `class` containing the token "hidden" (no regex). */
function hasHiddenClass(attrs: string): boolean {
  const lower = attrs.slice(0, REPORT_LIMITS.maxAttributeLength).toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf("class", from);
    if (at < 0) return false;
    from = at + 5;
    let i = from;
    while (i < lower.length && lower.charCodeAt(i) <= 32) i++;
    if (lower[i] !== "=") continue;
    i++;
    while (i < lower.length && lower.charCodeAt(i) <= 32) i++;
    const quote = lower[i] === '"' || lower[i] === "'" ? lower[i] : null;
    if (quote) i++;
    let end = i;
    while (end < lower.length && (quote ? lower[end] !== quote : lower.charCodeAt(end) > 32)) end++;
    if (lower.slice(i, end).split(/\s+/).includes("hidden")) return true;
  }
}

interface OpenCell {
  parts: string[];
  length: number;
  header: boolean;
  hidden: boolean;
}

/**
 * Every `<tr>` of the document as its visible cells (cells with class "hidden" are dropped).
 * One forward pass: each tag's end (`>`) is found once, and when a `<` has no `>` after it the
 * rest of the input cannot contain a tag, so the scan stops. Text outside cells is ignored;
 * rows, cells per row and cell text are capped (`REPORT_LIMITS`). Linear in the input size.
 */
export function htmlTableRows(html: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] | null = null;
  let cell: OpenCell | null = null;
  const closeCell = () => {
    if (cell && row && !cell.hidden && row.length < REPORT_LIMITS.maxCellsPerRow) {
      const text = trimWs(decodeEntities(cell.parts.join("")).replace(/\s+/g, " "));
      row.push({ text, isHeader: cell.header });
    }
    cell = null;
  };
  const closeRow = () => {
    closeCell();
    if (row && rows.length < REPORT_LIMITS.maxRows) rows.push(row);
    row = null;
  };
  const appendText = (from: number, to: number) => {
    if (!cell || to <= from) return;
    const room = REPORT_LIMITS.maxCellLength - cell.length;
    if (room <= 0) return;
    const piece = html.slice(from, Math.min(to, from + room));
    cell.parts.push(piece);
    cell.length += piece.length;
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      appendText(i, n);
      break;
    }
    appendText(i, lt);
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break; // no tag can follow: stop
    let j = lt + 1;
    const closing = html[j] === "/";
    if (closing) j++;
    let nameEnd = j;
    while (nameEnd < gt && nameEnd - j < 8 && /[A-Za-z0-9]/.test(html[nameEnd] as string)) nameEnd++;
    const name = html.slice(j, nameEnd).toLowerCase();
    const boundary = html.charCodeAt(nameEnd);
    const isName = nameEnd === gt || boundary <= 32 || boundary === 47; // ">" / whitespace / "/"
    if (isName && name === "tr") {
      if (closing) closeRow();
      else {
        closeRow();
        row = [];
      }
    } else if (isName && (name === "td" || name === "th")) {
      closeCell();
      if (!closing && row) cell = { parts: [], length: 0, header: name === "th", hidden: hasHiddenClass(html.slice(nameEnd, gt)) };
    }
    i = gt + 1;
  }
  closeRow();
  return rows;
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
