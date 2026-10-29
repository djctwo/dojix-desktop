// Greenwick imports. Ported from GreenwickTests/{ImportParserTests, ImportSecurityTests}.swift
// (the fictional TestData samples are in test/fixtures/greenwick), plus FIFO details and the
// desktop fixes D-16, D-22, D-23, D-24, D-25, D-26, D-27, D-30, D-32.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SwiftDecimal, TRADING_CALENDAR, decimalToDouble } from "@dojix-desktop/core";
import type { ImportResult } from "../pipeline";
import { ImportError } from "../model";
import { NOW, imp } from "../test-support/helpers";
import { type RawTransaction, pairTransactions } from "./fifo";
import { greenwickCleanSymbol, parseBoundedDouble, parseGreenwickDate, parseGreenwickDecimal, parseShares, sanitizeImportField, stripCurrencyChars } from "./generic";
import { greenwickControlCharacterFields, greenwickStorageViolations, sanitizeGreenwick } from "./limits";

/** A committed parity fixture (golden/fixtures/greenwick/…), fictional data. */
const golden = (path: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../../golden/fixtures/greenwick/${path}`, import.meta.url))));
const sample = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../test/fixtures/greenwick/${name}`, import.meta.url))));

function stats(r: ImportResult) {
  const p = r.trades.map((t) => decimalToDouble(t.netProfit));
  const wins = p.filter((x) => x > 0);
  const losses = p.filter((x) => x < 0);
  const total = p.reduce((a, b) => a + b, 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  return {
    n: p.length,
    total,
    winRate: (wins.length / p.length) * 100,
    pf: grossWin / grossLoss,
    expectancy: total / p.length,
    commissions: r.trades.reduce((a, t) => a + decimalToDouble(t.commission), 0),
  };
}

describe("every bundled sample (ImportParserTests.testEverySampleDetectsAndParses)", () => {
  it.each([
    ["thinkorswim_sample.csv", "tos", 10],
    ["interactive_brokers_sample.csv", "ibkr", 10],
    ["webull_sample.csv", "webull", 8],
    ["tradingview_sample.csv", "tradingview", 7],
    ["ninjatrader_sample.csv", "ninjatrader", 8],
    ["robinhood_sample.csv", "robinhood", 6],
    ["schwab_sample.csv", "schwab", 6],
    ["fidelity_sample.csv", "fidelity", 5],
    ["etrade_sample.csv", "etrade", 5],
    ["tastytrade_sample.csv", "tastytrade", 5],
  ] as const)("%s", (file, format, count) => {
    const r = imp(sample(file), "greenwick", "swift");
    expect(r.format).toBe(format);
    expect(r.trades).toHaveLength(count);
    expect(new Set(r.trades.map((t) => t.ticket)).size).toBe(count);
  });

  it("testGenericSampleFallsBackToManualMapping", () => {
    const r = imp(sample("generic_sample.csv"), "greenwick");
    expect(r.detection).toMatchObject({ format: "generic", needsMapping: true, mapping: null });
    expect(r.trades).toEqual([]);
  });
});

describe("headline stats (ImportParserTests.swift)", () => {
  it("testNinjaTraderHeadlineStats", () => {
    const s = stats(imp(sample("ninjatrader_sample.csv"), "greenwick", "swift"));
    expect(s.n).toBe(8);
    expect(s.total).toBeCloseTo(1814.06, 3);
    expect(s.winRate).toBeCloseTo(87.5, 3);
    expect(s.pf).toBeCloseTo(8.429192, 4);
    expect(s.expectancy).toBeCloseTo(226.7575, 3);
    expect(s.commissions).toBeCloseTo(33.44, 3);
  });
  it("testThinkorswimHeadlineStats", () => {
    const s = stats(imp(sample("thinkorswim_sample.csv"), "greenwick", "swift"));
    expect(s.total).toBeCloseTo(2608.3, 3);
    expect(s.winRate).toBeCloseTo(70, 3);
    expect(s.pf).toBeCloseTo(3.802815, 4);
    expect(s.expectancy).toBeCloseTo(260.83, 3);
  });
  it("testRobinhoodFIFOHeadlineStats", () => {
    const s = stats(imp(sample("robinhood_sample.csv"), "greenwick", "swift"));
    expect(s.total).toBeCloseTo(856, 3);
    expect(s.winRate).toBeCloseTo(66.6667, 3);
    expect(s.pf).toBeCloseTo(2.35873, 4);
    expect(s.expectancy).toBeCloseTo(142.666667, 3);
  });
  it("testSchwabFIFOHeadlineStats", () => {
    const s = stats(imp(sample("schwab_sample.csv"), "greenwick", "swift"));
    expect(s.total).toBeCloseTo(1012.98, 3);
    expect(s.pf).toBeCloseTo(3.411283, 4);
    expect(s.commissions).toBeCloseTo(0.52, 4);
  });
  it("the same numbers in fixed mode (no options, fees or footers in these samples)", () => {
    for (const f of ["robinhood_sample.csv", "schwab_sample.csv", "thinkorswim_sample.csv"]) {
      expect(stats(imp(sample(f), "greenwick", "fixed")).total).toBeCloseTo(stats(imp(sample(f), "greenwick", "swift")).total, 9);
    }
  });
});

const TOS = "Exec Time,Symbol,Side,Qty,Price,Net Price,P/L,Commission";
const RH = "Activity Date,Process Date,Settle Date,Account Type,Instrument,Description,Trans Code,Quantity,Price,Amount,Suppressed";
const SCHWAB = "Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount";

describe("re-import and tickets (ImportParserTests.swift)", () => {
  it("testReimportGivesSameTickets / testReimportLaterGivesSameTickets", () => {
    for (const f of ["thinkorswim_sample.csv", "robinhood_sample.csv", "webull_sample.csv"]) {
      expect(imp(sample(f), "greenwick").trades.map((t) => t.ticket)).toEqual(imp(sample(f), "greenwick").trades.map((t) => t.ticket));
    }
  });
  it("testDifferentFilesWithSameTradeNumbersDoNotCollide", () => {
    const header = "Trade #,Instrument,Market Position,Quantity,Entry Time,Exit Time,Entry Price,Exit Price,Profit";
    const a = imp(`${header}\n1,AAPL,Long,10,03/24/2026 09:35:00,03/24/2026 10:15:00,100,101,10`, "greenwick");
    const b = imp(`${header}\n1,MSFT,Long,10,03/25/2026 09:35:00,03/25/2026 10:15:00,200,201,10`, "greenwick");
    expect(a.trades[0]?.ticket).not.toBe(b.trades[0]?.ticket);
    expect(a.trades[0]?.externalId).toBe("1");
  });
  it("testIdenticalRowsInOneFileAreKept", () => {
    const row = "03/24/26 09:31:15,AAPL,BUY,100,171.25,171.30,25.00,0.65";
    const r = imp([TOS, row, row].join("\n"), "greenwick");
    expect(r.trades).toHaveLength(2);
    expect(new Set(r.trades.map((t) => t.ticket)).size).toBe(2);
  });
  it("testImportedProfitIsNetOfCommission", () => {
    const t = imp(`${TOS}\n03/24/26 09:31:15,AAPL,BUY,100,171.25,171.30,25.00,-1.50`, "greenwick").trades[0]!;
    expect(t).toMatchObject({ netProfit: "23.5", commission: "1.5", session: "REGULAR", hour: 9, dayOfWeek: "Tue", openTime: "2026-03-24 13:31:15.000" });
  });
});

describe("FIFO (ImportParserTests.swift FIFO details)", () => {
  it("testFIFOShortSaleIsLabelledSell", () => {
    const csv = [RH, "3/24/2026,3/24/2026,3/26/2026,Brokerage,XYZ,Example,Sell,10,$50.00,$500.00,", "3/25/2026,3/25/2026,3/27/2026,Brokerage,XYZ,Example,Buy,10,$45.00,($450.00),"].join("\n");
    const t = imp(csv, "greenwick").trades[0]!;
    expect(t).toMatchObject({ direction: "SELL", netProfit: "50", openPrice: "50", closePrice: "45" });
    expect(t.openTime < t.closeTime).toBe(true);
  });
  it("testTitleLineAboveRobinhoodHeaderIsSkipped", () => {
    const text = "Account activity export\n" + new TextDecoder().decode(sample("robinhood_sample.csv"));
    expect(imp(text, "greenwick").trades).toHaveLength(6);
  });
  it("testPartialFillCostsAllocatedPerSide", () => {
    const csv = ['"Transactions for account Example"', SCHWAB, "03/24/2026,Buy,XYZ,Example,100,$10.00,$1.00,-$1000", "03/24/2026,Sell,XYZ,Example,50,$11.00,$0.50,$550", "03/25/2026,Sell,XYZ,Example,50,$12.00,$0.50,$600", "Transactions Total,,,,,,,$150"].join("\n");
    for (const compat of ["swift", "fixed"] as const) {
      const r = imp(csv, "greenwick", compat);
      expect(r.trades).toHaveLength(2);
      expect(r.trades.reduce((a, t) => a + decimalToDouble(t.commission), 0)).toBeCloseTo(2, 9);
      expect(r.trades.map((t) => [t.quantity, t.commission, t.netProfit])).toEqual([[50, "1", "49"], [50, "1", "99"]]);
    }
  });
  it("testOneSellAgainstTwoBuysCountsSellFeesOnce", () => {
    const csv = ['"Transactions for account Example"', SCHWAB, "03/24/2026,Buy,XYZ,Example,50,$10.00,,-$500", "03/24/2026,Buy,XYZ,Example,50,$10.00,,-$500", "03/25/2026,Sell,XYZ,Example,100,$11.00,$1.00,$1099", "Transactions Total,,,,,,,$99"].join("\n");
    const r = imp(csv, "greenwick");
    expect(r.trades).toHaveLength(2);
    expect(r.trades.reduce((a, t) => a + decimalToDouble(t.commission), 0)).toBeCloseTo(1, 9);
    expect(r.trades.reduce((a, t) => a + decimalToDouble(t.netProfit), 0)).toBeCloseTo(99, 9);
    expect(new Set(r.trades.map((t) => t.ticket)).size).toBe(2);
  });

  const txn = (o: Omit<Partial<RawTransaction>, "price"> & { isBuy: boolean; shares: number; price: string; date: number }): RawTransaction => ({
    symbol: "XYZ", commission: SwiftDecimal.zero, fees: SwiftDecimal.zero, line: null, ...o, price: SwiftDecimal.parse(o.price) as SwiftDecimal,
  } as RawTransaction);

  it("prorates costs with Foundation's Decimal(Double) of the share ratio", () => {
    const out = pairTransactions(
      [txn({ isBuy: true, shares: 3, price: "10", date: 1, commission: SwiftDecimal.fromInteger(1) }), txn({ isBuy: false, shares: 1, price: "11", date: 2 }), txn({ isBuy: false, shares: 2, price: "12", date: 3 })],
      "robinhood",
      "fixed",
    );
    // Decimal(1.0/3) = 0.333333333333333248 (×10 in doubles until ≥ 2^64, then truncated).
    expect(out.rows.map((r) => r.trade.commission.toString())).toEqual(["0.333333333333333248", "0.666666666666666496"]);
    expect(out.rows.map((r) => r.trade.netProfit.toString())).toEqual(["0.666666666666666752", "3.333333333333333504"]);
    expect(out.issues).toEqual([]);
  });

  it("skips pairs whose P&L exceeds 1e12, sorts symbols and output by open time", () => {
    const out = pairTransactions(
      [
        txn({ symbol: "BBB", isBuy: true, shares: 1e9, price: "1", date: 5 }),
        txn({ symbol: "BBB", isBuy: false, shares: 1e9, price: "999999", date: 6, line: 9 }),
        txn({ symbol: "AAA", isBuy: true, shares: 1, price: "1", date: 7 }),
        txn({ symbol: "AAA", isBuy: false, shares: 1, price: "2", date: 8 }),
        txn({ symbol: "CCC", isBuy: true, shares: 1, price: "1", date: 1 }),
        txn({ symbol: "CCC", isBuy: false, shares: 1, price: "2", date: 2 }),
      ],
      "schwab",
      "swift",
    );
    expect(out.rows.map((r) => r.trade.symbol)).toEqual(["CCC", "AAA"]);
    expect(out.issues).toEqual([{ line: 9, code: "fifo_out_of_range", reason: "Skipped a BBB pair with an out-of-range P&L" }]);
  });

  it("D-26: a same-timestamp sell before a buy is a short in fixed mode, a long on the Mac", () => {
    const rows = [txn({ isBuy: false, shares: 1, price: "12", date: 10 }), txn({ isBuy: true, shares: 1, price: "10", date: 10 })];
    const mac = pairTransactions(rows, "robinhood", "swift").rows[0]!.trade;
    const fixed = pairTransactions(rows, "robinhood", "fixed").rows[0]!.trade;
    expect([mac.direction, mac.openPrice.toString(), mac.netProfit.toString()]).toEqual(["BUY", "10", "2"]);
    expect([fixed.direction, fixed.openPrice.toString(), fixed.netProfit.toString()]).toEqual(["SELL", "12", "2"]);
    expect(fixed.ticket).toBe(mac.ticket);
  });

  it("D-25: unmatched buys and sells are reported in fixed mode only", () => {
    const rows = [txn({ isBuy: true, shares: 5, price: "10", date: 1, line: 2 }), txn({ isBuy: false, shares: 3, price: "11", date: 2, line: 3 }), txn({ symbol: "Q", isBuy: false, shares: 1, price: "1", date: 3, line: 4 })];
    expect(pairTransactions(rows, "etrade", "swift").issues).toEqual([]);
    expect(pairTransactions(rows, "etrade", "fixed").issues.map((i) => [i.line, i.code])).toEqual([[4, "unmatched_leg"], [2, "unmatched_leg"]]);
  });
});

describe("transaction platforms: fixes", () => {
  it("D-22: Robinhood BTO/STC option rows are skipped and counted", () => {
    const csv = [RH, "3/16/2026,,,,FIXA,Call,BTO,2,$1.25,($2.50),", "3/17/2026,,,,FIXA,Call,STC,2,$1.90,$3.80,", "3/18/2026,,,,FIXA,x,Buy,1,$10,,", "3/19/2026,,,,FIXA,x,Sell,1,$11,,"].join("\n");
    expect(imp(csv, "greenwick", "swift").trades).toHaveLength(2);
    const r = imp(csv, "greenwick", "fixed");
    expect(r.trades).toHaveLength(1);
    expect(r.optionsSkipped).toBe(2);
    expect(r.issues.filter((i) => i.code === "option_row")).toHaveLength(2);
  });
  it("D-22 for Schwab, Fidelity, E*Trade and Tastytrade option rows", () => {
    const schwab = ['"Title"', SCHWAB, "03/24/2026,Buy to Open,XYZ,Call,1,$1.00,,", "03/24/2026,Buy,XYZ,x,1,$1.00,,", "03/25/2026,Sell,XYZ,x,1,$2.00,,"].join("\n");
    expect(imp(schwab, "greenwick", "fixed").optionsSkipped).toBe(1);
    const fid = ["Run Date,Action,Symbol,Security Description,Security Type,Quantity,Price ($),Commission ($),Fees ($)", "03/24/2026,YOU BOUGHT OPENING TRANSACTION CALL,XYZ,x,Cash,1,1,0,0", "03/24/2026,YOU BOUGHT,XYZ,x,Option,1,1,0,0"].join("\n");
    expect(imp(fid, "greenwick", "fixed").optionsSkipped).toBe(2);
    const et = ["TransactionDate,TransactionType,SecurityType,Symbol,Quantity,Amount,Price,Commission", "03/24/26,Bought To Open,EQ,XYZ,1,-1,1,0", "03/24/26,Bought,OPTN,XYZ,1,-1,1,0", "03/24/26,Bought,EQ,XYZ,1,-1,1,0"].join("\n");
    const etr = imp(et, "greenwick", "fixed");
    expect(etr.optionsSkipped).toBe(2);
    expect(etr.issues.map((i) => i.code)).toContain("unmatched_leg");
    const tt = ["Date,Type,Action,Symbol,Instrument Type,Quantity,Average Price,Commissions,Fees,Underlying Symbol", "2026-03-19T14:00:00+0000,Trade,BUY_TO_OPEN,FIXB,Equity Option,1,3.10,-1.00,-0.14,FIXB", "2026-03-19T15:00:00+0000,Trade,BUY_TO_OPEN,FIXB,Equity,1,3.10,-1.00,-0.14,FIXB"].join("\n");
    expect(imp(tt, "greenwick", "fixed").optionsSkipped).toBe(1);
    const ttNoType = ["Date,Action,Symbol,Quantity,Price,Commissions,Root Symbol,Strike Price", "2026-03-19T14:00:00+0000,BUY_TO_OPEN,FIXB,1,3.10,0,FIXB,45", "2026-03-19T14:00:00+0000,BUY_TO_OPEN,FIXB,1,3.10,0,FIXB,"].join("\n");
    expect(imp(ttNoType, "greenwick", "fixed").optionsSkipped).toBe(1);
  });
  it("D-23: Schwab header on line 1 and no footer", () => {
    const rows = ["02/02/2026,Buy,FIXA,x,100,$10.00,$1.05,-$1001.05", "02/03/2026,Sell,FIXA,x,100,$11.00,$0.52,$549.48"];
    const headerFirst = [SCHWAB, ...rows, "Transactions Total,,,,,,,$1"].join("\n");
    expect(imp(headerFirst, "greenwick", "swift").trades).toHaveLength(0);
    expect(imp(headerFirst, "greenwick", "fixed").trades).toHaveLength(1);
    const noFooter = ['"Title line"', SCHWAB, ...rows].join("\n");
    expect(imp(noFooter, "greenwick", "swift").trades).toHaveLength(0); // the last row (the sell) is dropped
    expect(imp(noFooter, "greenwick", "fixed").trades).toHaveLength(1);
    expect(imp(['"x"', SCHWAB].join("\n"), "greenwick", "swift").trades).toEqual([]);
  });
  it("D-24: Fidelity without a price column", () => {
    const csv = ["Brokerage", "Run Date,Action,Symbol,Security Description,Security Type,Quantity,Commission ($),Fees ($)", "03/24/2026,YOU BOUGHT,XYZ,x,Cash,1,0,0", "03/25/2026,YOU SOLD,XYZ,x,Cash,-1,0,0", '"The data and information is fictional."', "Fidelity footer"].join("\n");
    // On the Mac the price falls back to column 0, the date: Decimal(string: "03/24/2026") reads 3.
    expect(imp(csv, "greenwick", "swift").trades[0]).toMatchObject({ openPrice: "3", closePrice: "3" });
    const fixed = imp(csv, "greenwick", "fixed");
    expect(fixed.trades).toEqual([]);
    expect(fixed.issues.map((i) => i.code)).toEqual(["invalid_price", "invalid_price"]);
  });
  it("D-27: Robinhood fees are read when the column exists", () => {
    const csv = ['"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount","Fees"', '"2/2/2026","","","FIXA","x","Buy","100","$10.00","($1000.00)","0.05"', '"2/3/2026","","","FIXA","x","Sell","100","$11.00","$1100.00","(0.02)"'].join("\n");
    expect(imp(csv, "greenwick", "swift").trades[0]).toMatchObject({ commission: "0", netProfit: "100" });
    expect(imp(csv, "greenwick", "fixed").trades[0]).toMatchObject({ commission: "0.07", netProfit: "99.93" });
  });
  it("reports non-trade rows and bad values with reasons", () => {
    const csv = [RH, "3/24/2026,,,,XYZ,x,DIV,1,$1,,", "3/24/2026,,,,,x,Buy,1,$1,,", "3/24/2026,,,,XYZ,x,Buy,0,$1,,", "3/24/2026,,,,XYZ,x,Buy,1,$0,,", "nope,,,,XYZ,x,Buy,1,$1,,", "a,b"].join("\n");
    expect(imp(csv, "greenwick").issues.map((i) => i.code)).toEqual(["not_a_trade", "missing_symbol", "invalid_quantity", "invalid_price", "invalid_date", "too_few_columns"]);
    const missing = ["Activity Date,Instrument,Trans Code,Quantity", "3/24/2026,XYZ,Buy,1"].join("\n");
    expect(imp(missing, "greenwick").issues[0]?.reason).toMatch(/Missing Robinhood/);
    for (const [hdr, row, name] of [
      ["Action,Fees & Comm,Symbol,Quantity", "Buy,1,XYZ,1", "Schwab"],
      ["Run Date,Security Description,Action,Quantity", "03/24/2026,x,Buy,1", "Fidelity"],
      ["TransactionType,SecurityType,Symbol,Quantity", "Bought,EQ,XYZ,1", "E\\*Trade"],
      ["Underlying Symbol,Commissions,Action,Quantity", "XYZ,0,BUY,1", "Tastytrade"],
    ] as const) {
      expect(imp(`${hdr}\n${row}`, "greenwick").issues[0]?.reason, name).toMatch(new RegExp(`Missing ${name}`));
    }
  });
});

describe("matched-row platforms and D-16", () => {
  it("TradingView rows are paired by Trade # in fixed mode", () => {
    const csv = "Trade #,Type,Signal,Date/Time,Price,Contracts,Profit,Run-up,Drawdown\n1,Exit Long,Close,2026-06-25T15:45:48-0400,47.37,200,320.03,1.76,-0.06\n1,Entry Long,Long,2026-06-25T15:14:48-0400,45.77,200,320.03,1.76,-0.06\n2,Entry Short,Short,2026-06-26T10:00:00-0400,10,1,0,0,0";
    expect(imp(csv, "greenwick", "swift").trades).toHaveLength(3);
    const r = imp(csv, "greenwick", "fixed");
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ direction: "BUY", openPrice: "45.77", closePrice: "47.37", netProfit: "320.03", durationMin: 31, quantity: 200, mae: -0.06, mfe: 1.76, symbol: "1" });
    expect(r.issues.map((i) => i.code)).toEqual(["unpaired"]);
    const odd = "Trade #,Type,Signal,Date/Time,Price,Contracts,Profit\n1,Exit Long,Close,bad,1,1,1\n1,Entry Long,Long,2026-06-25T15:14:48-0400,1,1,1\n2,Marker,x,x,x,x,x\na,b";
    expect(imp(odd, "greenwick", "fixed").issues.map((i) => i.code)).toEqual(["invalid_date", "not_a_trade", "too_few_columns"]);
  });

  it("IB falls back to Proceeds, reads C. Price, and keeps the broker id for display", () => {
    const r = imp('TradeID,Symbol,Buy/Sell,Quantity,Date/Time,T. Price,C. Price,Proceeds,Comm/Fee\nIB1,AAPL,BUY,10,"2026-03-24, 09:33:22",171.10,174.35,32.5,-1.05', "greenwick");
    expect(r.trades[0]).toMatchObject({ netProfit: "31.45", commission: "1.05", closePrice: "174.35", externalId: "IB1", openTime: "2026-03-24 13:33:22.000" });
  });

  it("generic mapping with SL computes slDist and R (§3.3 ST generic)", () => {
    const mapping = {
      platform: "generic" as const, ticket: null, symbol: 0, direction: 1, shares: 2, openTime: 3, closeTime: 4, openPrice: 5, closePrice: 6, sl: 9, tp: 10,
      profit: 7, commission: 8, swap: null, maePoints: null, mfePoints: null, volume: 11, dateFormat: "yyyy-MM-dd HH:mm:ss",
    };
    const csv = "Symbol,Direction,Shares,Open Time,Close Time,Open Price,Close Price,Profit,Commission,Stop Loss,Take Profit,Volume\nAAPL,BUY,100,2026-03-24 09:36:00,2026-03-24 10:20:00,171.30,174.10,280.00,1.00,169.50,175.00,-5\nTSLA,SELL,50,bad,x,1,1,1,1,1,1,1";
    const r = imp(csv, "greenwick", "fixed", { mapping });
    expect(r.format).toBe("generic");
    expect(r.trades[0]).toMatchObject({ netProfit: "279", slDist: 1.8, volume: 0, source: "generic", tp: "175", mae: null });
    expect(r.trades[0]?.rMultiple).toBeCloseTo(279 / (1.8 * 100), 12);
    expect(r.issues.map((i) => i.code)).toEqual(["invalid_date"]);
    expect(() => imp("Symbol,Side\n", "greenwick", "fixed", { mapping })).toThrowError(ImportError);
  });
});

describe("hostile input (ImportSecurityTests.swift)", () => {
  it("testNonFiniteAndAbsurdNumbersAreRejected", () => {
    const rows = ["03/24/26 09:31:15,AAPL,BUY,inf,171.25,171.30,25.00,0.65", "03/24/26 09:32:15,AAPL,BUY,nan,171.25,171.30,25.00,0.65", "03/24/26 09:33:15,AAPL,BUY,1e308,171.25,171.30,25.00,0.65", "03/24/26 09:34:15,AAPL,BUY,-0,171.25,171.30,25.00,0.65", "03/24/26 09:35:15,AAPL,BUY,100,171.25,171.30,1e300,0.65", "03/24/26 09:36:15,AAPL,BUY,100,171.25,171.30,25.00,0.65"];
    const r = imp([TOS, ...rows].join("\n"), "greenwick");
    expect(r.trades).toHaveLength(2);
    for (const t of r.trades) {
      expect(t.quantity > 0 && t.quantity <= 1e9).toBe(true);
      expect(Math.abs(decimalToDouble(t.netProfit))).toBeLessThanOrEqual(1e12);
    }
    expect(r.trades[0]?.netProfit).toBe("-0.65"); // the 1e300 P&L reads as 0
  });
  it("testFIFONonFiniteQuantitiesDoNotHang", () => {
    const csv = [RH, "3/24/2026,,,,XYZ,x,Buy,inf,$1.00,$1,", "3/24/2026,,,,XYZ,x,Sell,inf,$2.00,$1,", "3/24/2026,,,,XYZ,x,Buy,10,$NaN,$1,"].join("\n");
    expect(imp(csv, "greenwick").trades).toHaveLength(0);
  });
  it("testMalformedLinesDoNotCrash", () => {
    const rows = ['"unterminated,quote,field', ",,,,,,,", '03/24/26 09:31:15,=HYPERLINK("http://example.invalid"),BUY,1,1,1,1,1', "A".repeat(200_000), "03/24/26 09:31:15,AAPL,SIDEWAYS,100,171.25,171.30,25.00,0.65", "not a date,AAPL,BUY,100,171.25,171.30,25.00,0.65", "\u0000�‮garbage,\u{1F4A9},BUY,1,1,1,1,1"];
    const r = imp([TOS, ...rows].join("\n"), "greenwick");
    for (const t of r.trades) {
      expect(/^[\p{L}\p{N}.]*$/u.test(t.symbol)).toBe(true);
      expect([...t.symbol].length).toBeLessThanOrEqual(10);
    }
  });
  it("testEmptyAndHeaderOnlyFiles", () => {
    expect(() => imp("", "greenwick")).toThrowError(ImportError);
    expect(() => imp(TOS, "greenwick")).toThrowError(ImportError);
  });
  it("storage limits reject what Greenwick never stores", () => {
    const base = imp(`${TOS}\n03/24/26 09:31:15,AAPL,BUY,100,171.25,171.30,25.00,0.65`, "greenwick").mac[0] as Parameters<typeof sanitizeGreenwick>[0];
    expect(sanitizeGreenwick(base, NOW).trade).not.toBeNull();
    const bad = { ...base, shares: 0, ticket: 0n, hour: 24, durationMin: -1, timeToMFEMin: 1e9, volume: -1, avgVolume: 2e12, openTime: Date.UTC(1800, 0, 1), symbol: "X".repeat(33), comment: "c".repeat(201), notes: "n".repeat(100_001), checklistData: "x".repeat(100_001), screenshots: "a.jpg", maePoints: NaN, openPrice: SwiftDecimal.nan };
    expect(greenwickStorageViolations(bad, Date.UTC(2300, 0, 1))).toEqual(["shares", "openPrice", "maePoints", "durationMin", "timeToMFEMin", "hour", "volume", "avgVolume", "ticket", "openTime", "importedAt", "symbol", "comment", "notes", "checklistData", "screenshots"]);
    expect(sanitizeGreenwick(bad, NOW)).toMatchObject({ trade: null });
    expect(greenwickControlCharacterFields({ ...base, symbol: "A\u0001", notes: "x\ny", comment: " " })).toEqual(["symbol", "comment"]);
    expect(greenwickControlCharacterFields({ ...base, notes: "\u0007" })).toEqual(["notes"]);
  });
  it("field helpers behave like the Mac", () => {
    expect(greenwickCleanSymbol(" brk.b$ ")).toBe("BRK.B");
    expect(greenwickCleanSymbol("ABCDEFGHIJKLMNOP")).toBe("ABCDEFGHIJ");
    expect(sanitizeImportField("=BUY")).toBe("BUY");
    expect(sanitizeImportField("=́BUY")).toBe("=́BUY");
    expect(sanitizeImportField("BUY")).toBe("BUY");
    expect(sanitizeImportField("")).toBe("");
    expect(stripCurrencyChars(" ($1,234.50) ")).toBe("-1234.50");
    expect(stripCurrencyChars("()")).toBe("-");
    expect(parseGreenwickDecimal("$(5)")).toBeNull();
    expect(parseGreenwickDecimal(stripCurrencyChars("$(5)"))?.toString()).toBe("-5");
    expect(parseGreenwickDecimal("2e12")).toBeNull();
    expect(parseGreenwickDecimal("nan")).toBeNull();
    expect(parseGreenwickDecimal("")).toBeNull();
    expect(parseGreenwickDecimal(undefined)).toBeNull();
    expect(parseShares("1,000")).toBe(1000);
    expect(parseShares("0.0000001")).toBeNull();
    expect(parseBoundedDouble("1,5")).toBe(15);
    expect(parseBoundedDouble("2e9")).toBeNull();
    expect(parseBoundedDouble(undefined)).toBeNull();
  });
});

// Approved 2026-10-29 (docs/DECISIONS.md #10). `swift` keeps the Mac's behaviour, pinned by the
// Tier B probes and references; `fixed` is what the app ships.
describe("D-30: an ET wall time in the spring-forward gap (fixed mode)", () => {
  const f7 = new TextDecoder().decode(golden("F7/f7-et-boundaries-ninjatrader.csv")).trimEnd();
  // The F7 ET-boundary fixture plus one fictional row that opens inside the 2026 gap (02:00–02:59 ET on 8 March).
  const withGapRow = `${f7}\n14,FIXA,Sim101,Fictional,Long,100,42.00,42.50,03/08/2026 02:30:00,03/08/2026 04:00:00,4.40,0,0.12,0.6\n`;

  it("reads 03/08/2026 02:30 ET as 8 March with the pre-transition offset, not day-first as 3 August", () => {
    const swift = imp(withGapRow, "greenwick", "swift");
    const fixed = imp(withGapRow, "greenwick", "fixed");
    const gapSwift = swift.trades.find((t) => t.netProfit === "4.4");
    const gapFixed = fixed.trades.find((t) => t.netProfit === "4.4");
    // The Mac (golden/README.md probes): MM/dd/yyyy rejects the skipped time, dd/MM/yyyy reads 3 August.
    expect(gapSwift?.openTime).toBe("2026-08-03 06:30:00.000");
    // Fixed: 02:30 EST = 07:30Z (the rule ZonedCalendar and the Mac's Calendar use), close 04:00 EDT = 08:00Z.
    expect(gapFixed).toMatchObject({ openTime: "2026-03-08 07:30:00.000", closeTime: "2026-03-08 08:00:00.000", durationMin: 30 });
    expect(Date.parse(`${gapFixed?.openTime.replace(" ", "T")}Z`)).toBe(TRADING_CALENDAR.instantFromWall(2026, 3, 8, 2, 30));
  });

  it("leaves every row outside the gap exactly as the Mac reads it", () => {
    const times = (compat: "swift" | "fixed") => imp(f7, "greenwick", compat).trades.map((t) => [t.ticket, t.openTime, t.closeTime, t.hour, t.dayOfWeek, t.session]);
    expect(times("fixed")).toEqual(times("swift"));
    expect(times("fixed")).toHaveLength(13);
  });

  it("never lands in another month than the text says, for every gap minute 2007–2040", () => {
    let macOtherMonth = 0;
    for (let year = 2007; year <= 2040; year++) {
      // Second Sunday of March (US rule since 2007).
      const firstDow = new Date(Date.UTC(year, 2, 1)).getUTCDay();
      const day = 1 + ((7 - firstDow) % 7) + 7;
      for (let minute = 0; minute < 60; minute += 7) {
        const text = `03/${String(day).padStart(2, "0")}/${year} 02:${String(minute).padStart(2, "0")}:00`;
        const fixed = parseGreenwickDate(text, "MM/dd/yyyy HH:mm:ss", NOW, "fixed");
        expect(fixed, text).toBe(TRADING_CALENDAR.instantFromWall(year, 3, day, 2, minute));
        const et = TRADING_CALENDAR.fields(fixed as number);
        expect([et.year, et.month, et.day, et.hour], text).toEqual([year, 3, day, 3]);
        const mac = parseGreenwickDate(text, "MM/dd/yyyy HH:mm:ss", NOW, "swift");
        if (mac !== null && TRADING_CALENDAR.fields(mac).month !== 3) macOtherMonth++;
      }
    }
    expect(macOtherMonth).toBeGreaterThan(0); // the Mac bug the fix removes (days 8–12 are read day-first)
  });
});

describe("D-32: Fidelity without a price column never takes the price from the date (fixed mode)", () => {
  it("golden f6-fidelity-no-price: the Mac imports the month as the price; fixed skips every trade row with a reason", () => {
    const bytes = golden("F6/f6-fidelity-no-price.csv");
    const swift = imp(bytes, "greenwick", "swift");
    // golden/reference/greenwick/f6-fidelity-no-price.json: 9 trades priced 2 (February) or 3 (March).
    expect(swift.trades).toHaveLength(9);
    expect(new Set(swift.trades.map((t) => t.openPrice))).toEqual(new Set(["2", "3"]));
    const fixed = imp(bytes, "greenwick", "fixed");
    expect(fixed.trades).toEqual([]);
    expect(fixed.issues).toHaveLength(17); // every buy and sell row
    for (const issue of fixed.issues) expect(issue).toMatchObject({ code: "invalid_price", reason: "The file has no price column" });
  });

  it("golden f6-fidelity: a real Price ($) column is used, in both modes", () => {
    const bytes = golden("F6/f6-fidelity.csv");
    // The fill prices per symbol (D-26 may swap a same-day pair's open and close in fixed mode).
    const prices = (compat: "swift" | "fixed") => imp(bytes, "greenwick", compat).trades.flatMap((t) => [`${t.symbol} ${t.openPrice}`, `${t.symbol} ${t.closePrice}`]).sort();
    expect(prices("fixed").length).toBeGreaterThan(0);
    for (const p of prices("fixed")) expect(Number(p.split(" ")[1])).toBeGreaterThan(3); // never a month number
    expect(prices("fixed")).toEqual(prices("swift"));
  });
});
