// Dojix `GenericCSVParser.swift`: platform detection, the per-platform column mappings and the
// row mapper, plus the desktop's fixes (D-06 pip value, D-15 units, D-16 TradingView pairing,
// D-18 unknown MAE/MFE).

import { SwiftDecimal, fxSessionAt, utcHour, utcShortDayName, intSaturating } from "@dojix-desktop/core";
import type { DojixMacTrade, ImportContext, ImportSource, ParsedRow, RowIssue } from "../model";
import { type CsvDialect, splitFields } from "../csv/dialect";
import { DateParsers } from "../swift/dates";
import { swiftDouble, swiftInt64 } from "../swift/numbers";
import { trimWs } from "../swift/text";
import { dojixSlDistAndR } from "../derive";
import { NO_TICKET, OccurrenceCounter, dojixContentKey, dojixContentTicket } from "../tickets";

export type DojixPlatform = "mt4" | "cTrader" | "tradingView" | "oanda" | "interactiveBrokers" | "thinkorswim" | "ninjaTrader" | "generic";

/** `GenericCSVParser.ColumnMapping` (Dojix GenericCSVParser.swift:173-196): column indexes. */
export interface DojixColumnMapping {
  platform: DojixPlatform;
  ticket: number | null;
  symbol: number;
  direction: number;
  lots: number;
  openTime: number;
  closeTime: number | null;
  openPrice: number;
  closePrice: number | null;
  sl: number | null;
  tp: number | null;
  profit: number;
  commission: number | null;
  swap: number | null;
  maePips: number | null;
  mfePips: number | null;
  pips: number | null;
  dateFormat: string;
}

export const DOJIX_PLATFORM_SOURCE: Readonly<Record<DojixPlatform, ImportSource>> = {
  mt4: "mt4",
  cTrader: "ctrader",
  tradingView: "tradingview",
  oanda: "oanda_csv",
  interactiveBrokers: "ibkr",
  thinkorswim: "tos",
  ninjaTrader: "ninjatrader",
  generic: "generic",
};

const lowerTrim = (h: readonly string[]): string[] => h.map((x) => trimWs(x.toLowerCase()));
function idx(h: readonly string[], ...names: string[]): number | null {
  for (const n of names) {
    const i = h.indexOf(n);
    if (i >= 0) return i;
  }
  return null;
}
const or0 = (v: number | null): number => v ?? 0;

/** GenericCSVParser.swift:341-363. */
function mt4Mapping(headers: readonly string[]): DojixColumnMapping {
  const h = lowerTrim(headers);
  const firstPrice = h.indexOf("price");
  let lastOtherPrice: number | null = null;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i] === "price" && i !== (firstPrice >= 0 ? firstPrice : -1)) {
      lastOtherPrice = i;
      break;
    }
  }
  return {
    platform: "mt4",
    ticket: idx(h, "ticket"),
    symbol: or0(idx(h, "item", "symbol")),
    direction: or0(idx(h, "type")),
    lots: or0(idx(h, "size", "volume")),
    openTime: or0(idx(h, "open time", "time")),
    closeTime: idx(h, "close time"),
    openPrice: or0(idx(h, "price", "open price")),
    closePrice: lastOtherPrice ?? idx(h, "close price"),
    sl: idx(h, "s/l", "sl"),
    tp: idx(h, "t/p", "tp"),
    profit: or0(idx(h, "profit")),
    commission: idx(h, "commission"),
    swap: idx(h, "swap", "taxes"),
    maePips: null,
    mfePips: null,
    pips: idx(h, "pips"),
    dateFormat: "yyyy.MM.dd HH:mm:ss",
  };
}

/** GenericCSVParser.swift:365-387. */
function cTraderMapping(headers: readonly string[]): DojixColumnMapping {
  const h = lowerTrim(headers);
  return {
    platform: "cTrader",
    ticket: idx(h, "position id", "positionid"),
    symbol: or0(idx(h, "symbol")),
    direction: or0(idx(h, "direction", "type")),
    lots: or0(idx(h, "volume", "quantity")),
    openTime: or0(idx(h, "entry time", "opening time")),
    closeTime: idx(h, "close time", "closing time"),
    openPrice: or0(idx(h, "entry price", "opening price")),
    closePrice: idx(h, "close price", "closing price"),
    sl: idx(h, "stop loss", "sl"),
    tp: idx(h, "take profit", "tp"),
    profit: or0(idx(h, "net profit", "profit", "net p&l")),
    commission: idx(h, "commission"),
    swap: idx(h, "swap"),
    maePips: null,
    mfePips: null,
    pips: idx(h, "pips"),
    dateFormat: "yyyy-MM-dd HH:mm:ss",
  };
}

/** GenericCSVParser.swift:389-411. */
function tradingViewMapping(headers: readonly string[]): DojixColumnMapping {
  const h = lowerTrim(headers);
  return {
    platform: "tradingView",
    ticket: null,
    symbol: or0(idx(h, "symbol")),
    direction: or0(idx(h, "type", "side")),
    lots: or0(idx(h, "contracts", "qty")),
    openTime: or0(idx(h, "date/time", "date")),
    closeTime: null,
    openPrice: or0(idx(h, "price")),
    closePrice: null,
    sl: null,
    tp: null,
    profit: or0(idx(h, "profit", "cumulative profit")),
    commission: null,
    swap: null,
    maePips: idx(h, "drawdown"),
    mfePips: idx(h, "run-up"),
    pips: null,
    dateFormat: "yyyy-MM-dd'T'HH:mm:ssZ",
  };
}

/** GenericCSVParser.swift:413-435. */
function oandaMapping(headers: readonly string[]): DojixColumnMapping {
  const h = lowerTrim(headers);
  return {
    platform: "oanda",
    ticket: idx(h, "transaction id", "id"),
    symbol: or0(idx(h, "instrument")),
    direction: or0(idx(h, "type", "side")),
    lots: or0(idx(h, "units")),
    openTime: or0(idx(h, "open time", "time")),
    closeTime: idx(h, "close time"),
    openPrice: or0(idx(h, "open price", "price")),
    closePrice: idx(h, "close price"),
    sl: idx(h, "s/l", "stop loss"),
    tp: idx(h, "t/p", "take profit"),
    profit: or0(idx(h, "p/l", "profit", "realized p/l")),
    commission: idx(h, "commission"),
    swap: idx(h, "financing", "interest"),
    maePips: null,
    mfePips: null,
    pips: null,
    dateFormat: "yyyy-MM-dd'T'HH:mm:ss",
  };
}

/** GenericCSVParser.swift:437-459. */
function ibMapping(headers: readonly string[]): DojixColumnMapping {
  const h = lowerTrim(headers);
  return {
    platform: "interactiveBrokers",
    ticket: idx(h, "tradeid"),
    symbol: or0(idx(h, "symbol")),
    direction: or0(idx(h, "side", "buy/sell")),
    lots: or0(idx(h, "quantity", "shares")),
    openTime: or0(idx(h, "date/time", "tradetime")),
    closeTime: null,
    openPrice: or0(idx(h, "t. price", "tradeprice")),
    closePrice: idx(h, "c. price", "closeprice"),
    sl: null,
    tp: null,
    profit: or0(idx(h, "realized p/l", "mtm p/l", "proceeds")),
    commission: idx(h, "comm/fee", "commission"),
    swap: null,
    maePips: null,
    mfePips: null,
    pips: null,
    dateFormat: "yyyy-MM-dd, HH:mm:ss",
  };
}

/** GenericCSVParser.swift:461-483. */
function tosMapping(headers: readonly string[]): DojixColumnMapping {
  const h = lowerTrim(headers);
  return {
    platform: "thinkorswim",
    ticket: null,
    symbol: or0(idx(h, "symbol")),
    direction: or0(idx(h, "side")),
    lots: or0(idx(h, "qty", "amount")),
    openTime: or0(idx(h, "exec time", "date")),
    closeTime: null,
    openPrice: or0(idx(h, "price", "net price")),
    closePrice: null,
    sl: null,
    tp: null,
    profit: or0(idx(h, "p/l", "net cash")),
    commission: idx(h, "commission", "commissions"),
    swap: null,
    maePips: null,
    mfePips: null,
    pips: null,
    dateFormat: "MM/dd/yy HH:mm:ss",
  };
}

/** GenericCSVParser.swift:485-507. */
function ninjaTraderMapping(headers: readonly string[]): DojixColumnMapping {
  const h = lowerTrim(headers);
  return {
    platform: "ninjaTrader",
    ticket: null,
    symbol: or0(idx(h, "instrument")),
    direction: or0(idx(h, "market position")),
    lots: or0(idx(h, "quantity", "qty")),
    openTime: or0(idx(h, "entry time")),
    closeTime: idx(h, "exit time"),
    openPrice: or0(idx(h, "entry price")),
    closePrice: idx(h, "exit price"),
    sl: null,
    tp: null,
    profit: or0(idx(h, "profit", "net profit")),
    commission: idx(h, "commission"),
    swap: null,
    maePips: idx(h, "mae"),
    mfePips: idx(h, "mfe"),
    pips: null,
    dateFormat: "MM/dd/yyyy HH:mm:ss",
  };
}

export type DojixDetection =
  | { kind: "mt5_32col" }
  | { kind: "mapped"; mapping: DojixColumnMapping }
  | { kind: "generic" };

/** `GenericCSVParser.detect` header rules (GenericCSVParser.swift:44-100), on the header fields. */
export function detectDojixHeaders(headers: readonly string[]): DojixDetection {
  const set = new Set(lowerTrim(headers));
  const has = (...names: string[]) => names.every((n) => set.has(n));
  if (has("ticket", "rmultiple")) return { kind: "mt5_32col" };
  if (has("ticket", "type", "item", "profit")) return { kind: "mapped", mapping: mt4Mapping(headers) };
  if (has("position id", "direction", "entry price") || has("positionid", "direction", "entryprice")) {
    return { kind: "mapped", mapping: cTraderMapping(headers) };
  }
  if (has("trade #", "signal", "contracts")) return { kind: "mapped", mapping: tradingViewMapping(headers) };
  if (has("transaction id", "instrument", "units")) return { kind: "mapped", mapping: oandaMapping(headers) };
  if (has("tradeid", "symbol", "quantity", "t. price")) return { kind: "mapped", mapping: ibMapping(headers) };
  if (has("exec time", "side", "qty", "symbol")) return { kind: "mapped", mapping: tosMapping(headers) };
  if (has("trade #", "instrument", "market position", "entry price")) return { kind: "mapped", mapping: ninjaTraderMapping(headers) };
  return { kind: "generic" };
}

/** `cleanSymbol` (GenericCSVParser.swift:555-561). */
export function dojixCleanSymbol(raw: string): string {
  return trimWs(raw.toUpperCase().replaceAll("/", "").replaceAll("_", "").replaceAll(" ", ""));
}

const BUY_VALUES = ["BUY", "LONG", "BOT", "B"];
const SELL_VALUES = ["SELL", "SHORT", "SLD", "S"];

/** The direction rule of `mapToTrade` (GenericCSVParser.swift:215-228), shared by both apps. */
export function directionOf(dirStr: string): "BUY" | "SELL" | null {
  if (BUY_VALUES.includes(dirStr) || dirStr.includes("BUY") || dirStr.includes("LONG") || dirStr.includes("BOT")) return "BUY";
  if (SELL_VALUES.includes(dirStr) || dirStr.includes("SELL") || dirStr.includes("SHORT") || dirStr.includes("SLD")) return "SELL";
  const qty = swiftDouble(dirStr);
  if (qty !== null && qty < 0) return "SELL";
  return null;
}

const decimal = (s: string): SwiftDecimal | null => SwiftDecimal.parse(s);
const at = (fields: readonly string[], i: number | null): string | undefined => (i === null || i < 0 ? undefined : fields[i]);

/** The Mac's generic date formats after the platform's own (GenericCSVParser.swift:571-588). */
export function dojixDateParsers(primary: string, now: number): DateParsers {
  return new DateParsers(
    [primary, "yyyy-MM-dd HH:mm:ss", "yyyy.MM.dd HH:mm:ss", "MM/dd/yyyy HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd'T'HH:mm:ss",
      "yyyy-MM-dd, HH:mm:ss", "MM/dd/yy HH:mm:ss", "dd/MM/yyyy HH:mm:ss", "yyyy-MM-dd"],
    "UTC",
    now,
    64,
  );
}

export function emptyDojixTrade(): DojixMacTrade {
  return {
    brand: "dojix",
    ticket: 0n,
    symbol: "",
    direction: "BUY",
    lots: 0,
    openTime: 0,
    closeTime: 0,
    durationMin: 0,
    openPrice: SwiftDecimal.zero,
    closePrice: SwiftDecimal.zero,
    sl: SwiftDecimal.zero,
    tp: SwiftDecimal.zero,
    netProfit: SwiftDecimal.zero,
    maePips: 0,
    mfePips: 0,
    rMultiple: 0,
    session: "LATE",
    dayOfWeek: "",
    hour: 0,
    rangeSize: 0,
    sweepDepth: 0,
    usedFVG: false,
    volRegime: "MED",
    hitBreakeven: false,
    scaledIn: false,
    magic: 0,
    comment: "",
    timeToMFEMin: 0,
    slDistPips: 0,
    slippagePips: 0,
    postClose15m: 0,
    postClose30m: 0,
    biasAtEntry: "NEUTRAL",
    notes: "",
    tags: "",
    emotion: "",
    screenshots: "",
    checklistData: "",
    commission: SwiftDecimal.zero,
    swap: SwiftDecimal.zero,
  };
}

/** Derived time fields of a generic row (GenericCSVParser.swift:284-287). */
export function dojixTimeFields(openTime: number, closeTime: number): Pick<DojixMacTrade, "durationMin" | "session" | "dayOfWeek" | "hour"> {
  const duration = intSaturating((closeTime - openTime) / 60_000, "dojix");
  return { durationMin: Math.max(0, duration), session: fxSessionAt(openTime), dayOfWeek: utcShortDayName(openTime), hour: utcHour(openTime) };
}

interface MappedRow {
  trade: DojixMacTrade;
  maeKnown: boolean;
  mfeKnown: boolean;
}

class RowError extends Error {
  constructor(readonly issue: Omit<RowIssue, "line">) {
    super(issue.reason);
  }
}

/** `mapToTrade` (GenericCSVParser.swift:200-337), in Mac (`swift`) form. */
function mapToTrade(fields: readonly string[], mapping: DojixColumnMapping, dates: DateParsers): MappedRow {
  const symbol = dojixCleanSymbol(at(fields, mapping.symbol) ?? "");
  if (symbol === "") throw new RowError({ code: "missing_symbol", reason: "No symbol" });
  const dirStr = trimWs((at(fields, mapping.direction) ?? "").toUpperCase());
  const direction = directionOf(dirStr);
  if (direction === null) throw new RowError({ code: "invalid_direction", reason: `Cannot tell buy or sell from "${dirStr.slice(0, 40)}"` });
  const lotsStr = at(fields, mapping.lots) ?? "0";
  const lots = Math.abs(swiftDouble(lotsStr.replaceAll(",", "")) ?? 0);
  const openStr = at(fields, mapping.openTime) ?? "";
  const openTime = dates.parse(openStr, trimWs);
  if (openTime === null) throw new RowError({ code: "invalid_date", reason: `Cannot read the date "${openStr.slice(0, 40)}"` });
  const closeStr = at(fields, mapping.closeTime);
  const parsedClose = closeStr === undefined ? null : dates.parse(closeStr, trimWs);
  const closeTime = parsedClose ?? openTime;
  const openPrice = decimal((at(fields, mapping.openPrice) ?? "0").replaceAll(",", "")) ?? SwiftDecimal.zero;
  const cpStr = at(fields, mapping.closePrice);
  const closePrice = cpStr !== undefined ? (decimal(cpStr.replaceAll(",", "")) ?? SwiftDecimal.zero) : openPrice;
  let profit = decimal((at(fields, mapping.profit) ?? "0").replaceAll(",", "")) ?? SwiftDecimal.zero;
  const comm = at(fields, mapping.commission);
  if (comm !== undefined) profit = profit.add(decimal(comm.replaceAll(",", "")) ?? SwiftDecimal.zero);
  const swap = at(fields, mapping.swap);
  if (swap !== undefined) profit = profit.add(decimal(swap.replaceAll(",", "")) ?? SwiftDecimal.zero);
  const slStr = at(fields, mapping.sl);
  const tpStr = at(fields, mapping.tp);
  const sl = (slStr !== undefined ? decimal(slStr) : null) ?? SwiftDecimal.zero;
  const tp = (tpStr !== undefined ? decimal(tpStr) : null) ?? SwiftDecimal.zero;
  const maeStr = at(fields, mapping.maePips);
  const mfeStr = at(fields, mapping.mfePips);
  const mae = maeStr !== undefined ? swiftDouble(maeStr) : null;
  const mfe = mfeStr !== undefined ? swiftDouble(mfeStr) : null;
  const ticketText = at(fields, mapping.ticket);
  const parsedTicket = ticketText !== undefined ? swiftInt64(ticketText) : null;
  const ticket = parsedTicket !== null && parsedTicket !== NO_TICKET ? parsedTicket : NO_TICKET;
  const { slDistPips, rMultiple } = dojixSlDistAndR(symbol, openPrice, sl, profit, lots, "swift");
  return {
    trade: {
      ...emptyDojixTrade(),
      ticket,
      symbol,
      direction,
      lots,
      openTime,
      closeTime,
      ...dojixTimeFields(openTime, closeTime),
      openPrice,
      closePrice,
      sl,
      tp,
      netProfit: profit,
      maePips: mae ?? 0,
      mfePips: mfe ?? 0,
      rMultiple,
      slDistPips,
    },
    maeKnown: mae !== null,
    mfeKnown: mfe !== null,
  };
}

export interface DojixParseOutput {
  rows: ParsedRow<DojixMacTrade>[];
  issues: RowIssue[];
}

/** Units → lots for cTrader and OANDA CSV in `fixed` mode (PARITY D-15). */
const UNITS_PLATFORMS: ReadonlySet<DojixPlatform> = new Set(["cTrader", "oanda"]);

/**
 * `GenericCSVParser.parse(fileAt:mapping:)` (GenericCSVParser.swift:105-143) over decoded lines
 * (`lines[0]` is the header). In `fixed` mode TradingView exports are paired by Trade # (D-16).
 */
export function parseDojixMapped(
  lines: readonly { text: string; line: number }[],
  mapping: DojixColumnMapping,
  dialect: CsvDialect,
  ctx: ImportContext,
): DojixParseOutput {
  if (ctx.compat === "fixed" && mapping.platform === "tradingView") {
    return parseTradingViewPaired(lines, mapping, dialect, ctx);
  }
  const dates = dojixDateParsers(mapping.dateFormat, ctx.now);
  const occurrences = new OccurrenceCounter();
  const rows: ParsedRow<DojixMacTrade>[] = [];
  const issues: RowIssue[] = [];
  const source = DOJIX_PLATFORM_SOURCE[mapping.platform];
  for (let i = 1; i < lines.length; i++) {
    const { text, line } = lines[i] as { text: string; line: number };
    const trimmed = trimWs(text);
    if (trimmed === "") continue;
    const fields = splitFields(trimmed, dialect);
    if (fields.length < 4) {
      issues.push({ line, code: "too_few_columns", reason: `Only ${fields.length} column(s)` });
      continue;
    }
    let mapped: MappedRow;
    try {
      mapped = mapToTrade(fields, mapping, dates);
    } catch (e) {
      /* c8 ignore next */
      if (!(e instanceof RowError)) throw e;
      issues.push({ line, ...e.issue });
      continue;
    }
    const trade = mapped.trade;
    if (trade.ticket === NO_TICKET) {
      const key = dojixContentKey(trade);
      trade.ticket = dojixContentTicket(key, occurrences.next(key));
    }
    const externalText = at(fields, mapping.ticket);
    if (ctx.compat === "fixed") applyDojixFixes(trade, mapping.platform);
    rows.push({
      trade,
      meta: {
        source,
        line,
        externalId: externalText !== undefined && externalText !== "" ? externalText.slice(0, 64) : null,
        maeKnown: mapped.maeKnown,
        mfeKnown: mapped.mfeKnown,
        strategyKnown: false,
        timeBasis: "utc",
      },
    });
  }
  return { rows, issues };
}

/** The `fixed`-mode corrections applied after the Mac mapping (tickets already set from the Mac values). */
function applyDojixFixes(trade: DojixMacTrade, platform: DojixPlatform): void {
  if (UNITS_PLATFORMS.has(platform)) trade.lots = trade.lots / 100_000; // D-15
  const { slDistPips, rMultiple } = dojixSlDistAndR(trade.symbol, trade.openPrice, trade.sl, trade.netProfit, trade.lots, "fixed"); // D-06
  trade.slDistPips = slDistPips;
  trade.rMultiple = rMultiple;
}

/**
 * PARITY D-16: a TradingView "List of trades" export has an Entry and an Exit row per trade;
 * they are paired by Trade # into one round trip (open = entry row, close = exit row).
 * The ticket is the content ticket of the paired trade (the Mac has no equivalent trade).
 */
function parseTradingViewPaired(
  lines: readonly { text: string; line: number }[],
  mapping: DojixColumnMapping,
  dialect: CsvDialect,
  ctx: ImportContext,
): DojixParseOutput {
  const header = lowerTrim(splitFields(lines[0]?.text ?? "", dialect));
  const tradeNoIdx = header.indexOf("trade #");
  const typeIdx = mapping.direction;
  const dates = dojixDateParsers(mapping.dateFormat, ctx.now);
  const issues: RowIssue[] = [];
  const groups = new Map<string, { entry?: { fields: string[]; line: number }; exit?: { fields: string[]; line: number }; order: number }>();
  let order = 0;
  for (let i = 1; i < lines.length; i++) {
    const { text, line } = lines[i] as { text: string; line: number };
    const trimmed = trimWs(text);
    if (trimmed === "") continue;
    const fields = splitFields(trimmed, dialect);
    if (fields.length < 4) {
      issues.push({ line, code: "too_few_columns", reason: `Only ${fields.length} column(s)` });
      continue;
    }
    const no = fields[tradeNoIdx] ?? "";
    const type = (fields[typeIdx] ?? "").toUpperCase();
    const isEntry = type.includes("ENTRY");
    if (!isEntry && !type.includes("EXIT")) {
      issues.push({ line, code: "not_a_trade", reason: `Type "${type.slice(0, 40)}" is neither an entry nor an exit` });
      continue;
    }
    const group = groups.get(no) ?? { order: order++ };
    groups.set(no, group);
    if (isEntry) group.entry = { fields, line };
    else group.exit = { fields, line };
  }
  const occurrences = new OccurrenceCounter();
  const rows: ParsedRow<DojixMacTrade>[] = [];
  for (const [no, g] of [...groups.entries()].sort((a, b) => a[1].order - b[1].order)) {
    if (!g.entry || !g.exit) {
      const line = (g.entry ?? g.exit)?.line ?? null;
      issues.push({ line, code: "unpaired", reason: `Trade #${no.slice(0, 20)} has no ${g.entry ? "exit" : "entry"} row (still open?)` });
      continue;
    }
    let entry: MappedRow;
    let exit: MappedRow;
    try {
      entry = mapToTrade(g.entry.fields, mapping, dates);
      exit = mapToTrade(g.exit.fields, mapping, dates);
    } catch (e) {
      /* c8 ignore next */
      if (!(e instanceof RowError)) throw e;
      issues.push({ line: g.entry.line, ...e.issue });
      continue;
    }
    const t = entry.trade;
    t.closeTime = exit.trade.openTime;
    t.closePrice = exit.trade.openPrice;
    t.netProfit = exit.trade.netProfit;
    Object.assign(t, dojixTimeFields(t.openTime, t.closeTime));
    t.maePips = exit.trade.maePips;
    t.mfePips = exit.trade.mfePips;
    const { slDistPips, rMultiple } = dojixSlDistAndR(t.symbol, t.openPrice, t.sl, t.netProfit, t.lots, "fixed");
    t.slDistPips = slDistPips;
    t.rMultiple = rMultiple;
    const key = dojixContentKey(t);
    t.ticket = dojixContentTicket(key, occurrences.next(key));
    rows.push({
      trade: t,
      meta: {
        source: "tradingview",
        line: g.entry.line,
        externalId: no === "" ? null : no.slice(0, 64),
        maeKnown: exit.maeKnown,
        mfeKnown: exit.mfeKnown,
        strategyKnown: false,
        timeBasis: "utc",
      },
    });
  }
  return { rows, issues };
}
