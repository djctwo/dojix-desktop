// Greenwick transaction exports (Robinhood, Schwab, Fidelity, E*Trade, Tastytrade):
// `parseTransactions` and the per-broker row parsers (GenericCSVParser.swift:317-607), then FIFO.
//
// Desktop fixes in `fixed` mode (PARITY.md B1):
// - D-22 option rows are skipped and counted (the Mac imports them as shares, without ×100);
// - D-23 Schwab: the header is found on line 1 or 2 and only a real "Transactions Total" footer
//   is dropped (the Mac always drops the last line and assumes a title line);
// - D-24 / D-32 Fidelity: no price column means the row is skipped and reported (the Mac reads
//   column 0, the Run Date, so "02/03/2026" becomes price 2 and the row is imported);
// - D-27 Robinhood: a Fees column is read when present (the Mac never reads fees);
// - D-30 dates: an ET time in the spring-forward gap keeps its date (parseGreenwickDate).

import { SwiftDecimal } from "@dojix-desktop/core";
import type { ImportContext, RowIssue } from "../model";
import { type CsvDialect, splitFields } from "../csv/dialect";
import { trimWs } from "../swift/text";
import {
  type GreenwickParseOutput,
  type GreenwickPlatform,
  detectGreenwickHeaders,
  greenwickCleanSymbol,
  parseGreenwickDate,
  parseGreenwickDecimal,
  parseShares,
  stripCurrencyChars,
} from "./generic";
import { type RawTransaction, pairTransactions } from "./fifo";

export interface NumberedLine {
  text: string;
  line: number;
}

/** `preprocessLines` (GenericCSVParser.swift:351-394). */
function preprocess(lines: readonly NumberedLine[], platform: GreenwickPlatform, dialect: CsvDialect, ctx: ImportContext): { header: NumberedLine | null; data: NumberedLine[] } {
  const isHeaderFor = (l: NumberedLine) => detectGreenwickHeaders(splitFields(l.text, dialect))?.platform === platform;
  switch (platform) {
    case "schwab": {
      if (ctx.compat === "fixed") {
        const headerIdx = lines.slice(0, 2).findIndex(isHeaderFor);
        const h = headerIdx < 0 ? 0 : headerIdx;
        const data = lines.slice(h + 1).filter((l) => {
          const t = trimWs(l.text);
          return t !== "" && !t.startsWith("Transactions Total") && !t.startsWith('"Transactions Total');
        });
        return { header: lines[h] ?? null, data };
      }
      if (lines.length < 3) return { header: lines[0] ?? null, data: [] };
      const data = lines.slice(1, -1).filter((l) => {
        const t = trimWs(l.text);
        return !t.startsWith("Transactions Total") && t !== "";
      });
      return { header: lines[1] ?? null, data: data.slice(1) };
    }
    case "fidelity": {
      let headerIdx = 0;
      for (let i = 0; i < lines.length; i++) {
        const lower = trimWs((lines[i] as NumberedLine).text.toLowerCase());
        if (lower.includes("run date") && lower.includes("action") && lower.includes("symbol")) {
          headerIdx = i;
          break;
        }
      }
      const data = lines.slice(headerIdx + 1).filter((l) => {
        const t = trimWs(l.text);
        return t !== "" && !t.startsWith("The data and information") && !t.startsWith("Fidelity") && !t.startsWith('"The data') && !t.startsWith('"Fidelity');
      });
      return { header: lines[headerIdx] ?? null, data };
    }
    default: {
      const found = lines.slice(0, 10).findIndex(isHeaderFor);
      const headerIdx = found < 0 ? 0 : found;
      return { header: lines[headerIdx] ?? null, data: lines.slice(headerIdx + 1) };
    }
  }
}

type RowResult = { txn: Omit<RawTransaction, "line"> } | { skip: Omit<RowIssue, "line"> } | { option: true };

const notTrade = (what: string): RowResult => ({ skip: { code: "not_a_trade", reason: `${what} is not a buy or sell` } });
const bad = (code: RowIssue["code"], reason: string): RowResult => ({ skip: { code, reason } });

function first(h: readonly string[], ...names: string[]): number | null {
  for (const n of names) {
    const i = h.indexOf(n);
    if (i >= 0) return i;
  }
  return null;
}
const at = (f: readonly string[], i: number | null): string | undefined => (i === null || i < 0 ? undefined : f[i]);
const absDec = (d: SwiftDecimal): SwiftDecimal => (d.sign() < 0 ? d.negate() : d);
/** `parseDecimal(stripCurrencyChars(field ?? "0")) ?? 0`: the transaction parsers strip twice, as on the Mac. */
const money = (f: readonly string[], i: number | null): SwiftDecimal => parseGreenwickDecimal(stripCurrencyChars(at(f, i) ?? "0")) ?? SwiftDecimal.zero;

function common(
  f: readonly string[],
  symbolIdx: number,
  qtyIdx: number,
  priceIdx: number,
  dateIdx: number,
  format: string,
  ctx: ImportContext,
  stripQtyCommas: boolean,
): { symbol: string; shares: number; price: SwiftDecimal; date: number } | RowResult {
  const symbol = greenwickCleanSymbol(f[symbolIdx] ?? "");
  if (symbol === "") return bad("missing_symbol", "No symbol");
  const qty = f[qtyIdx] ?? (stripQtyCommas ? "0" : "");
  const shares = parseShares(stripQtyCommas ? qty.replaceAll(",", "") : qty);
  if (shares === null) return bad("invalid_quantity", "Quantity must be a number above 0");
  const price = parseGreenwickDecimal(stripCurrencyChars(f[priceIdx] ?? "0"));
  if (price === null || price.sign() <= 0) return bad("invalid_price", "Price must be above 0");
  const date = parseGreenwickDate(f[dateIdx] ?? "", format, ctx.now, ctx.compat); // D-30 in fixed mode
  if (date === null) return bad("invalid_date", `Cannot read the date "${(f[dateIdx] ?? "").slice(0, 40)}"`);
  return { symbol, shares, price, date };
}

function isRowResult(x: object): x is RowResult {
  return "skip" in x || "option" in x || "txn" in x;
}

/** Robinhood (GenericCSVParser.swift:416-444). BTO/STC are option codes (D-22); fees per D-27. */
function robinhood(f: readonly string[], h: readonly string[], ctx: ImportContext): RowResult {
  const tc = h.indexOf("trans code");
  const sym = h.indexOf("instrument");
  const qty = h.indexOf("quantity");
  const price = h.indexOf("price");
  const date = h.indexOf("activity date");
  if (tc < 0 || sym < 0 || qty < 0 || price < 0 || date < 0) return bad("not_a_trade", "Missing Robinhood columns");
  const code = trimWs((f[tc] ?? "").toUpperCase());
  const isBuy = code === "BUY" || code === "BTO";
  if (!isBuy && code !== "SELL" && code !== "STC") return notTrade(`Trans code "${code.slice(0, 20)}"`);
  if (ctx.compat === "fixed" && (code === "BTO" || code === "STC")) return { option: true };
  const c = common(f, sym, qty, price, date, "M/d/yyyy", ctx, false);
  if (isRowResult(c)) return c;
  let fees = SwiftDecimal.zero;
  if (ctx.compat === "fixed") {
    const feesIdx = first(h, "fees", "fee", "regulatory fee");
    if (feesIdx !== null) fees = absDec(money(f, feesIdx)); // D-27
  }
  return { txn: { ...c, isBuy, commission: SwiftDecimal.zero, fees } };
}

/** Schwab (GenericCSVParser.swift:448-481). "Buy to Open" / "Sell to Close" are option actions (D-22). */
function schwab(f: readonly string[], h: readonly string[], ctx: ImportContext): RowResult {
  const act = h.indexOf("action");
  const sym = h.indexOf("symbol");
  const qty = h.indexOf("quantity");
  const price = h.indexOf("price");
  const date = h.indexOf("date");
  if (act < 0 || sym < 0 || qty < 0 || price < 0 || date < 0) return bad("not_a_trade", "Missing Schwab columns");
  const action = trimWs((f[act] ?? "").toUpperCase());
  const buys = ["BUY", "BUY TO OPEN", "BUY TO COVER"];
  const sells = ["SELL", "SELL TO CLOSE", "SELL SHORT"];
  if (!buys.includes(action) && !sells.includes(action)) return notTrade(`Action "${action.slice(0, 30)}"`);
  if (ctx.compat === "fixed" && (action === "BUY TO OPEN" || action === "SELL TO CLOSE")) return { option: true };
  const c = common(f, sym, qty, price, date, "MM/dd/yyyy", ctx, true);
  if (isRowResult(c)) return c;
  const fees = money(f, first(h, "fees & comm"));
  return { txn: { ...c, isBuy: buys.includes(action), commission: absDec(fees), fees: SwiftDecimal.zero } };
}

/** Fidelity (GenericCSVParser.swift:485-520). Opening/closing-transaction actions are options (D-22). */
function fidelity(f: readonly string[], h: readonly string[], ctx: ImportContext): RowResult {
  const act = h.indexOf("action");
  const sym = h.indexOf("symbol");
  const qty = h.indexOf("quantity");
  const date = h.indexOf("run date");
  if (act < 0 || sym < 0 || qty < 0 || date < 0) return bad("not_a_trade", "Missing Fidelity columns");
  const action = trimWs((f[act] ?? "").toUpperCase());
  const isBuy = action.includes("BOUGHT") || action.includes("BUY");
  const isSell = action.includes("SOLD") || action.includes("SELL");
  if (!isBuy && !isSell) return notTrade(`Action "${action.slice(0, 30)}"`);
  if (ctx.compat === "fixed") {
    const typeIdx = first(h, "security type");
    const secType = (at(f, typeIdx) ?? "").toUpperCase();
    if (action.includes("OPENING TRANSACTION") || action.includes("CLOSING TRANSACTION") || secType.includes("OPTION")) return { option: true };
  }
  let priceIdx = h.findIndex((x) => x.includes("price")); // GenericCSVParser.swift:503
  if (priceIdx < 0) {
    if (ctx.compat === "fixed") return bad("invalid_price", "The file has no price column"); // D-24, D-32
    priceIdx = 0;
  }
  const c = common(f, sym, qty, priceIdx, date, "MM/dd/yyyy", ctx, true);
  if (isRowResult(c)) return c;
  const commIdx = h.findIndex((x) => x.includes("commission"));
  const feesIdx = h.findIndex((x) => x.includes("fees") && !x.includes("commission"));
  return { txn: { ...c, isBuy, commission: absDec(money(f, commIdx)), fees: absDec(money(f, feesIdx)) } };
}

/** E*Trade (GenericCSVParser.swift:524-564). "… to open/close" actions and OPTN securities are options (D-22). */
function etrade(f: readonly string[], h: readonly string[], ctx: ImportContext): RowResult {
  const date = first(h, "transactiondate", "transaction date", "date", "execution date");
  const type = first(h, "transactiontype", "transaction type", "action", "side");
  const sym = first(h, "symbol");
  const qty = first(h, "quantity", "qty");
  const price = first(h, "price", "execution price");
  if (date === null || type === null || sym === null || qty === null || price === null) return bad("not_a_trade", "Missing E*Trade columns");
  const action = trimWs((f[type] ?? "").toUpperCase());
  const buys = ["BOUGHT", "BUY", "BOUGHT TO OPEN", "BUY TO OPEN", "BUY TO COVER"];
  const sells = ["SOLD", "SELL", "SOLD TO CLOSE", "SELL TO CLOSE", "SELL SHORT"];
  const isBuy = buys.includes(action);
  if (!isBuy && !sells.includes(action)) return notTrade(`Transaction type "${action.slice(0, 30)}"`);
  if (ctx.compat === "fixed") {
    const secType = (at(f, first(h, "securitytype", "security type")) ?? "").toUpperCase();
    if (/TO (OPEN|CLOSE)$/.test(action)) return { option: true };
    if (secType === "OPTN" || secType.includes("OPTION")) return { option: true };
  }
  const c = common(f, sym, qty, price, date, "MM/dd/yy", ctx, true);
  if (isRowResult(c)) return c;
  const comm = money(f, first(h, "commission", "comm"));
  return { txn: { ...c, isBuy, commission: absDec(comm), fees: SwiftDecimal.zero } };
}

/** Tastytrade (GenericCSVParser.swift:568-607). Rows whose instrument type is an option are skipped (D-22). */
function tastytrade(f: readonly string[], h: readonly string[], ctx: ImportContext): RowResult {
  const date = first(h, "date", "executed at", "exec date");
  const act = first(h, "action", "type");
  const sym = first(h, "symbol", "underlying symbol");
  const qty = first(h, "quantity", "qty");
  const price = first(h, "price", "average price");
  if (date === null || act === null || sym === null || qty === null || price === null) return bad("not_a_trade", "Missing Tastytrade columns");
  const action = trimWs((f[act] ?? "").toUpperCase());
  const buys = ["BUY_TO_OPEN", "BUY", "BTO", "BUY_TO_CLOSE"];
  const sells = ["SELL_TO_CLOSE", "SELL", "STC", "SELL_TO_OPEN"];
  const isBuy = buys.includes(action);
  if (!isBuy && !sells.includes(action)) return notTrade(`Action "${action.slice(0, 30)}"`);
  if (ctx.compat === "fixed") {
    const instIdx = first(h, "instrument type");
    const inst = (at(f, instIdx) ?? "").toUpperCase();
    const optionFields = [first(h, "expiration date"), first(h, "strike price"), first(h, "call or put")].some((i) => trimWs(at(f, i) ?? "") !== "");
    if (inst.includes("OPTION") || (instIdx === null && optionFields)) return { option: true };
  }
  const c = common(f, sym, qty, price, date, "yyyy-MM-dd'T'HH:mm:ssZ", ctx, true);
  if (isRowResult(c)) return c;
  const comm = money(f, first(h, "commissions", "commission"));
  const fees = money(f, first(h, "fees", "clearing fees"));
  return { txn: { ...c, isBuy, commission: absDec(comm), fees: absDec(fees) } };
}

const PARSERS: Partial<Record<GreenwickPlatform, (f: readonly string[], h: readonly string[], ctx: ImportContext) => RowResult>> = {
  robinhood,
  schwab,
  fidelity,
  etrade,
  tastytrade,
};

/** `parseTransactions(fileAt:platform:)` (GenericCSVParser.swift:317-348) on the file's non-blank lines. */
export function parseGreenwickTransactions(
  lines: readonly NumberedLine[],
  platform: GreenwickPlatform,
  dialect: CsvDialect,
  ctx: ImportContext,
): GreenwickParseOutput {
  const parse = PARSERS[platform];
  /* c8 ignore next */
  if (!parse) throw new RangeError(`${platform} is not a transaction platform`);
  const { header, data } = preprocess(lines, platform, dialect, ctx);
  const h = splitFields(header?.text ?? "", dialect).map((x) => trimWs(x.toLowerCase()));
  const txns: RawTransaction[] = [];
  const issues: RowIssue[] = [];
  let optionsSkipped = 0;
  for (const { text, line } of data) {
    const fields = splitFields(text, dialect);
    if (fields.length < 4) {
      issues.push({ line, code: "too_few_columns", reason: `Only ${fields.length} column(s)` });
      continue;
    }
    const r = parse(fields, h, ctx);
    if ("txn" in r) txns.push({ ...r.txn, line });
    else if ("option" in r) {
      optionsSkipped++;
      issues.push({ line, code: "option_row", reason: "Options aren't supported yet" });
    } else issues.push({ line, ...r.skip });
  }
  const paired = pairTransactions(txns, platform, ctx.compat);
  return { rows: paired.rows, issues: [...issues, ...paired.issues], optionsSkipped };
}
