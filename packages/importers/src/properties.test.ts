// Property tests over hostile input (SPEC §10 H1): every parser, fed rows built from hostile
// values, never throws anything but ImportError, never hangs, and never lets NaN/∞ or
// non-decimal money reach a journal row. PROPERTY_RUNS=100000 (`pnpm test:props`) is the
// nightly depth; CI runs fewer cases per parser.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { BrandId } from "@dojix-desktop/core";
import { ImportError, type CompatMode } from "./model";
import { importOandaPages, importTradeFile } from "./pipeline";
import { decodeTradeFile } from "./encoding";
import { macCsvFields } from "./swift/text";
import { swiftDouble, doubleDescription, decimalFromDouble } from "./swift/numbers";
import { DateParsers } from "./swift/dates";
import { parseMt5Report } from "./dojix/mt5-report";
import { SA32_HEADER } from "./dojix/sa32";
import type { DojixColumnMapping } from "./dojix/generic";
import type { GreenwickColumnMapping } from "./greenwick/generic";

const RUNS = Number(process.env.PROPERTY_RUNS ?? 250);
const NOW = Date.UTC(2026, 9, 27);
const MONEY = /^-?\d+(\.\d+)?$/;

const hostileValue = fc.oneof(
  fc.constantFrom("", "0", "-0", "1", "-1", "0.1", "1e308", "-1e308", "1e300", "nan", "NaN", "inf", "-inf", "Infinity", "0x1p1023", "99999999999999999999999",
    "9223372036854775807", "-9223372036854775808", "1,000.50", "($1,234.56)", "$-0.00", "1e-400", "=HYPERLINK(\"x\")", "@SUM(1)", "+1", "\t-1", "BUY", "SELL", "Long",
    "Short", "Entry Long", "Exit Long", "BTO", "STC", "Buy to Open", "SELL_TO_OPEN", "YOU BOUGHT", "Bought", "balance", "2026.01.15 08:30:00", "2026-01-15 08:30:00",
    "01/15/2026 08:30:00", "1/5/26", "2026-01-15T08:30:00Z", "2026-01-15T08:30:00.123+05:30", "2024-02-30", "24:00:00", "LONDON", "Mon", "Funday", "YES", "\u0000",
    "\u202e", "\u{1F4A9}", "e\u0301", "\uFFFD", '"', '""', "a,b", "\r", "EUR/USD", "brk.b", "X".repeat(300)),
  fc.double().map(String),
  fc.integer().map(String),
  fc.string({ maxLength: 20 }),
  fc.string({ unit: "grapheme", maxLength: 12 }),
);

const row = fc.array(fc.tuple(hostileValue, fc.boolean()), { maxLength: 40 }).map((cells) =>
  cells.map(([v, quote]) => (quote ? `"${v.replaceAll('"', '""')}"` : v)).join(","),
);

const HEADERS: Record<BrandId, Record<string, string>> = {
  dojix: {
    sa32: SA32_HEADER,
    dojixExport: `${SA32_HEADER},Account,Commission,Swap,TimeBasis,ServerUTCOffset`,
    mt4: "Ticket,Open Time,Type,Size,Item,Price,S/L,T/P,Close Time,Price,Commission,Taxes,Swap,Profit",
    ctrader: "Position ID,Symbol,Direction,Volume,Entry Time,Entry Price,Close Time,Close Price,Stop Loss,Take Profit,Commission,Swap,Net Profit",
    oanda: "Transaction ID,Type,Instrument,Units,Open Time,Close Time,Open Price,Close Price,P/L,Commission,Financing",
    ibkr: "TradeID,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Realized P/L,Buy/Sell",
    tos: "Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Price,Net Price,Order Type,P/L,Commission",
    ninjatrader: "Trade #,Instrument,Market position,Quantity,Entry price,Exit price,Entry time,Exit time,Profit,Commission,MAE,MFE",
    tradingview: "Trade #,Symbol,Type,Signal,Date/Time,Price,Contracts,Profit,Profit %,Run-up,Drawdown,Cumulative profit",
  },
  greenwick: {
    ibkr: "TradeID,Symbol,Buy/Sell,Quantity,Date/Time,T. Price,C. Price,Realized P/L,Comm/Fee",
    tos: "Exec Time,Symbol,Side,Qty,Price,Net Price,P/L,Commission",
    tradingview: "Trade #,Type,Signal,Contracts,Date/Time,Price,Profit,Drawdown,Run-up,Symbol",
    ninjatrader: "Trade #,Instrument,Market Position,Quantity,Entry Time,Exit Time,Entry Price,Exit Price,Profit,MAE,MFE,Commission",
    webull: "Symbol,Side,Filled Qty,Filled Time,Avg Price,Realized P&L,Commission,Order Number",
    robinhood: "Activity Date,Process Date,Settle Date,Account Type,Instrument,Description,Trans Code,Quantity,Price,Amount,Fees",
    schwab: '"Transactions for account (fictional)"\nDate,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount',
    fidelity: "Brokerage\nRun Date,Action,Symbol,Security Description,Security Type,Quantity,Price ($),Commission ($),Fees ($),Amount ($)",
    etrade: "TransactionDate,TransactionType,SecurityType,Symbol,Quantity,Amount,Price,Commission",
    tastytrade: "Date,Type,Action,Symbol,Instrument Type,Description,Value,Quantity,Average Price,Commissions,Fees,Root Symbol,Underlying Symbol,Expiration Date,Strike Price,Call or Put",
  },
};

const DOJIX_MAPPING: DojixColumnMapping = {
  platform: "generic", ticket: 0, symbol: 1, direction: 2, lots: 3, openTime: 4, closeTime: 5, openPrice: 6, closePrice: 7, sl: 8, tp: 9, profit: 10,
  commission: 11, swap: 12, maePips: 13, mfePips: 14, pips: null, dateFormat: "dd.MM.yyyy HH:mm",
};
const GREENWICK_MAPPING: GreenwickColumnMapping = {
  platform: "generic", ticket: 0, symbol: 1, direction: 2, shares: 3, openTime: 4, closeTime: 5, openPrice: 6, closePrice: 7, sl: 8, tp: 9, profit: 10,
  commission: 11, swap: 12, maePoints: 13, mfePoints: 14, volume: 15, dateFormat: "MM/dd/yyyy hh:mm a",
};

function check(text: string, brand: BrandId, compat: CompatMode, mapping?: DojixColumnMapping | GreenwickColumnMapping): void {
  let r;
  try {
    r = importTradeFile(new TextEncoder().encode(text), { brand, compat, now: NOW, ...(mapping ? { mapping } : {}) });
  } catch (e) {
    if (e instanceof ImportError) return;
    throw e;
  }
  for (const t of r.trades) {
    for (const v of [t.quantity, t.rMultiple, t.durationMin, t.hour, t.slDist, t.slippage, t.mae, t.mfe, t.rangeSize, t.sweepDepth, t.postClose15m, t.postClose30m, t.volume]) {
      if (v !== null) expect(Number.isFinite(v), `${brand} ${String(v)}`).toBe(true);
    }
    for (const m of [t.netProfit, t.openPrice, t.closePrice, t.sl, t.tp, t.commission, t.swap]) expect(m).toMatch(MONEY);
    expect(t.ticket).toMatch(/^-?\d+$/);
    expect(t.hour >= 0 && t.hour <= 23).toBe(true);
    expect(t.closeTime >= t.openTime || brand === "greenwick").toBe(true);
    expect(t.openTime).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
  }
  expect(new Set(r.trades.map((t) => t.ticket)).size).toBe(r.trades.length);
}

describe("hostile rows never crash a parser", () => {
  for (const brand of ["dojix", "greenwick"] as const) {
    for (const [name, header] of Object.entries(HEADERS[brand])) {
      it(`${brand} ${name}`, () => {
        fc.assert(
          fc.property(fc.array(row, { maxLength: 6 }), fc.constantFrom<CompatMode>("swift", "fixed"), (rows, compat) => {
            check([header, ...rows].join("\n"), brand, compat);
          }),
          { numRuns: RUNS },
        );
      });
    }
    it(`${brand} generic mapping`, () => {
      fc.assert(
        fc.property(fc.array(row, { minLength: 1, maxLength: 6 }), fc.constantFrom<CompatMode>("swift", "fixed"), (rows, compat) => {
          check(["A,B,C,D", ...rows].join("\n"), brand, compat, brand === "dojix" ? DOJIX_MAPPING : GREENWICK_MAPPING);
        }),
        { numRuns: RUNS },
      );
    });
  }

  it("arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), fc.constantFrom<BrandId>("dojix", "greenwick"), (bytes, brand) => {
        try {
          importTradeFile(bytes, { brand, now: NOW });
        } catch (e) {
          if (!(e instanceof ImportError)) throw e;
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("MT5 report HTML", () => {
    const cell = fc.oneof(hostileValue, fc.constantFrom("<b>", "</td>", "<td", "&amp;", "&#x110000;", "<tr>", "Positions"));
    fc.assert(
      fc.property(fc.array(fc.array(cell, { maxLength: 16 }), { maxLength: 8 }), (rows) => {
        const html = `<html><table><tr><th>Positions</th></tr><tr><td>Time</td><td>Position</td><td>Symbol</td><td>Type</td><td>Volume</td><td>Price</td><td>S / L</td><td>T / P</td><td>Time</td><td>Price</td><td>Commission</td><td>Swap</td><td>Profit</td></tr>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</table></html>`;
        check(html, "dojix", "fixed");
        try {
          parseMt5Report(html, { brand: "dojix", compat: "swift", now: NOW });
        } catch (e) {
          if (!(e instanceof ImportError)) throw e;
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("OANDA API pages", () => {
    const str = fc.oneof(hostileValue, fc.constant(undefined));
    const tx = fc.record({
      id: str, type: str, time: str, instrument: str, units: str, price: str,
      tradeOpened: fc.option(fc.record({ tradeID: fc.constantFrom("1", "2", "x", "99999999999999999999") }), { nil: undefined }),
      tradesClosed: fc.option(fc.array(fc.record({ tradeID: fc.constantFrom("1", "2", "x"), realizedPL: str })), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(tx, { maxLength: 8 }), fc.constantFrom<CompatMode>("swift", "fixed"), (txs, compat) => {
        const out = importOandaPages([JSON.parse(JSON.stringify({ transactions: txs }))], { compat, now: NOW });
        for (const t of out?.trades ?? []) {
          expect(Number.isFinite(t.quantity)).toBe(true);
          expect(t.netProfit).toMatch(MONEY);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("primitives on arbitrary input", () => {
  it("decode, tokenize, numbers and dates never throw", () => {
    const dates = new DateParsers(["yyyy.MM.dd HH:mm:ss", "MM/dd/yy hh:mm a", "yyyy-MM-dd'T'HH:mm:ssZ"], "America/New_York", NOW);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), fc.string({ unit: "binary", maxLength: 200 }), fc.double(), (bytes, s, d) => {
        decodeTradeFile(bytes);
        macCsvFields(s);
        swiftDouble(s);
        dates.parse(s, (x) => x);
        expect(typeof doubleDescription(d)).toBe("string");
        if (Number.isFinite(d)) expect(decimalFromDouble(d)?.isNaN).toBe(false);
      }),
      { numRuns: RUNS * 4 },
    );
  });
});
