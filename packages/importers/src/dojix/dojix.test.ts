// Dojix imports. Swift unit tests ported from DojixTests/{CSVParserTests, GenericCSVParserTests,
// ImportHardeningTests, ReimportDedupeTests, SampleFileCrossCheckTests, HostileInputRegressionTests}.swift
// (each `it` names its source), plus the desktop fixes D-06, D-15, D-16, D-18, D-21.

import { describe, expect, it } from "vitest";
import { SwiftDecimal } from "@dojix-desktop/core";
import { ImportError } from "../model";
import { detectFormat, importTradeText } from "../pipeline";
import { NOW, imp, totalProfit, utf16 } from "../test-support/helpers";
import { dojixContentKey, dojixContentTicket } from "../tickets";
import { SA32_HEADER } from "./sa32";
import { type DojixColumnMapping, directionOf } from "./generic";
import { dojixLotSize, dojixStorageViolations, sanitizeDojix, sanitizeDojixForRestore } from "./sanitize";

const ROW1 =
  "100001,GBPUSD,BUY,0.10,2026.01.15 08:30:00,2026.01.15 09:45:00,75,1.25000,1.25250,1.24800,1.25500,25.00,8.5,30.2,1.25,LONDON,Wed,8,45.0,12.3,YES,MED,NO,NO,12345,test comment,35,20.0,0.5,15.0,22.0,WITH";

describe("32-column MT5 CSV (CSVParserTests.swift)", () => {
  it("testParseSimpleCSVLine", () => {
    const r = imp(`${SA32_HEADER}\n${ROW1}`, "dojix");
    expect(r.format).toBe("mt5_32col");
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t).toMatchObject({
      ticket: "100001", symbol: "GBPUSD", direction: "BUY", quantity: 0.1, durationMin: 75, netProfit: "25", mae: 8.5, mfe: 30.2,
      rMultiple: 1.25, session: "LONDON", dayOfWeek: "Wed", hour: 8, usedFvg: true, volRegime: "MED", hitBreakeven: false,
      scaledIn: false, magic: 12345, comment: "test comment", timeToMfeMin: 35, slDist: 20, slippage: 0.5, postClose15m: 15,
      postClose30m: 22, biasAtEntry: "WITH", source: "mt5_32col", openTime: "2026-01-15 08:30:00.000", closeTime: "2026-01-15 09:45:00.000",
      rangeSize: 45, sweepDepth: 12.3, openPrice: "1.25", sl: "1.248", tp: "1.255", timeBasis: "utc",
    });
    expect(r.mac[0]?.brand).toBe("dojix");
  });

  it("testParseMultipleTrades / testParseSellDirection", () => {
    const csv = `${SA32_HEADER}
100001,GBPUSD,BUY,0.10,2026.01.15 08:30:00,2026.01.15 09:45:00,75,1.25000,1.25250,1.24800,1.25500,25.00,8.5,30.2,1.25,LONDON,Wed,8,45.0,12.3,YES,MED,NO,NO,12345,,35,20.0,0.5,15.0,22.0,WITH
100002,EURUSD,SELL,0.20,2026.01.15 14:00:00,2026.01.15 15:30:00,90,1.08500,1.08200,1.08800,1.08000,60.00,5.0,35.0,2.00,NY_OVERLAP,Wed,14,38.0,8.0,NO,HIGH,YES,YES,12345,,40,30.0,1.0,20.0,28.0,AGAINST
100003,USDJPY,BUY,0.05,2026.01.16 03:00:00,2026.01.16 04:15:00,75,150.500,150.200,150.800,150.000,-15.00,12.0,8.0,-0.50,ASIAN,Thu,3,55.0,15.0,YES,LOW,NO,NO,12345,,20,30.0,0.2,5.0,8.0,NEUTRAL`;
    const r = imp(csv, "dojix");
    expect(r.trades.map((t) => t.symbol)).toEqual(["GBPUSD", "EURUSD", "USDJPY"]);
    expect(r.trades[1]).toMatchObject({ direction: "SELL", scaledIn: true, volRegime: "HIGH", hitBreakeven: true });
    expect(r.trades[2]?.biasAtEntry).toBe("NEUTRAL");
  });

  it("testParseNoTradeSection", () => {
    expect(() => imp("Some random content\nwith no trade headers\n", "dojix")).not.toThrow();
    expect(imp("Some random content\nwith no trade headers\n", "dojix").detection.needsMapping).toBe(true);
    expect(() => imp("Ticket,Foo,RMultiple\n1,2,3\n", "dojix")).toThrowError(ImportError);
  });

  it("testParseOlderCSVFormat26Columns: short rows are padded (column 31 NEUTRAL, the rest 0)", () => {
    const header = SA32_HEADER.split(",").slice(0, 26).join(",");
    const r = imp(`${header}\n300001,GBPJPY,BUY,0.10,2025.12.01 10:00:00,2025.12.01 11:00:00,60,185.500,186.000,185.000,186.500,50.00,10.0,55.0,1.00,LONDON,Mon,10,60.0,20.0,YES,MED,NO,NO,11111,old format`, "dojix");
    expect(r.trades[0]).toMatchObject({ ticket: "300001", timeToMfeMin: 0, slDist: 0, biasAtEntry: "NEUTRAL" });
  });

  it("testParseWithMultiSectionCSV: stops at an empty line or a non-numeric line", () => {
    const csv = `== Section 1: Summary ==\nTotal Trades,12\n\n${SA32_HEADER}\n${ROW1.replace("100001", "400001")}\n\n== Section 4 ==\nSomething`;
    const r = imp(csv, "dojix");
    expect(r.trades.map((t) => t.ticket)).toEqual(["400001"]);
    const noBlank = `${SA32_HEADER}\n${ROW1}\nTotals,1\n${ROW1.replace("100001", "5")}`;
    const r2 = imp(noBlank, "dojix");
    expect(r2.trades).toHaveLength(1);
    expect(r2.issues.map((i) => i.code)).toEqual(["section_end"]);
  });

  it("reads UTF-16LE (with BOM) and semicolon files too (desktop superset)", () => {
    expect(imp(utf16(`${SA32_HEADER}\r\n${ROW1}\r\n`, true), "dojix").trades).toHaveLength(1);
    const semi = `${SA32_HEADER.replaceAll(",", ";")}\n${ROW1.replaceAll(",", ";").replace("0.10;", "0,10;").replace("25.00", "25,00")}`;
    const r = imp(semi, "dojix");
    expect(r.trades[0]).toMatchObject({ quantity: 0.1, netProfit: "25" });
  });

  it("ImportHardeningTests.testHostileSARowsAreSanitizedBeforeStorage", () => {
    const long = "X".repeat(10_000);
    const rows = [
      "1,EURUSD,BUY,nan,2026.01.05 09:00:00,2026.01.05 10:00:00,-50,1.1,1.2,0,0,inf,nan,inf,-inf,LONDON,Funday,99,nan,inf,NO,MED,NO,NO,1,c,-9,nan,inf,nan,-inf,WITH",
      `2,${long}\u0007,SELL,1e308,2026.01.05 09:00:00,2026.01.04 10:00:00,999999999,1e300,0,0,0,1e300,1e300,1e300,1e300,ASIAN,Mon,-3,1,1,NO,LOW,NO,NO,1,"=HYPERLINK(""x"")",1,1,1,1,1,AGAINST`,
      '3,"GBPUSD,BUY,0.1',
      "abc,GBPUSD,BUY,0.1,2026.01.05 09:00:00,2026.01.05 10:00:00,60,1,1,0,0,10,1,1,1,LONDON,Mon,9,1,1,NO,MED,NO,NO,1,,1,1,1,1,1,WITH",
      "99999999999999999999999,GBPUSD,BUY,0.1,2026.01.05 09:00:00,2026.01.05 10:00:00,60,1,1,0,0,10,1,1,1,LONDON,Mon,9,1,1,NO,MED,NO,NO,1,,1,1,1,1,1,WITH",
    ];
    const r = imp(`${SA32_HEADER}\n${rows.join("\n")}\n`, "dojix");
    expect(r.parsed).toBe(2);
    expect(r.trades).toHaveLength(2);
    for (const t of r.trades) {
      for (const v of [t.quantity, t.mae, t.mfe, t.rMultiple, t.rangeSize, t.sweepDepth, t.slDist, t.slippage, t.postClose15m, t.postClose30m]) {
        expect(Number.isFinite(v as number)).toBe(true);
      }
      expect(t.netProfit).not.toBe("NaN");
      expect(t.hour >= 0 && t.hour <= 23).toBe(true);
      expect(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]).toContain(t.dayOfWeek);
      expect(t.durationMin).toBeGreaterThanOrEqual(0);
      expect([...t.symbol].length).toBeLessThanOrEqual(32);
      expect(t.closeTime >= t.openTime).toBe(true);
    }
    expect(r.trades[0]).toMatchObject({ netProfit: "0", hour: 9, dayOfWeek: "Mon", quantity: 0, durationMin: 0, timeToMfeMin: 0 });
    // "1e300" is not a Decimal (exponent past 127) → 0; huge Doubles clamp to ±1e9; lots to 1e6.
    expect(r.trades[1]).toMatchObject({ quantity: 1_000_000, netProfit: "0", openPrice: "0", mae: 1e9, rMultiple: 1e9, hour: 9, durationMin: 5_270_400, symbol: "X".repeat(32) });
    expect(r.trades[1]?.comment).toBe("=HYPERLINK(x)");
    expect(r.issues.map((i) => i.code)).toEqual(["too_few_columns", "section_end"]);
  });

  it("D-21: unquoted commas inside Comment are re-joined (fixed) or shift columns (swift)", () => {
    const row = ROW1.replace("test comment", "a, b, c");
    const fixed = imp(`${SA32_HEADER}\n${row}`, "dojix", "fixed").trades[0]!;
    expect(fixed).toMatchObject({ comment: "a,b,c", timeToMfeMin: 35, biasAtEntry: "WITH" });
    const swift = imp(`${SA32_HEADER}\n${row}`, "dojix", "swift").trades[0]!;
    expect(swift.comment).toBe("a");
    expect(swift.timeToMfeMin).toBe(0); // "b" is not an Int
  });

  it("rejects bad tickets, directions and dates with reasons", () => {
    const bad = [
      ROW1.replace("BUY", "HOLD"),
      ROW1.replace("2026.01.15 08:30:00", "2026-01-15 08:30:00"),
      ROW1.replace("2026.01.15 09:45:00", "nope"),
      ROW1.replace("100001", "1.5"),
    ];
    const r = imp(`${SA32_HEADER}\n${bad.join("\n")}`, "dojix");
    expect(r.issues.map((i) => i.code)).toEqual(["invalid_direction", "invalid_date", "invalid_date", "invalid_ticket"]);
  });
});

const NOW_MS = NOW;

describe("DojixExport CSV (SPEC §5.3)", () => {
  const header = `${SA32_HEADER},Account,Commission,Swap,TimeBasis,ServerUTCOffset`;
  const row = "51000114,AUDUSD,BUY,1.5,2026.06.01 20:34:50,2026.06.01 21:48:37,73,0.66242,0.66377,0.66075,0.66576,203.09,1.3,16.2,0.81,NY,Mon,20,,,,,NO,NO,7001,fictional,72,16.7,0.7,5.8,7.9,,00000000,10.50,0,UTC,7200";
  it("reads the account, keeps strategy fields NULL and NetProfit as written", () => {
    const r = imp(`${header}\r\n${row}\r\n`, "dojix");
    expect(r.format).toBe("dojix_export");
    expect(r.trades[0]).toMatchObject({ source: "dojix_export", netProfit: "203.09", rangeSize: null, sweepDepth: null, usedFvg: null, volRegime: null, biasAtEntry: null, commission: "0", timeBasis: "utc" });
  });
  it("converts server-time rows to UTC with the offset, or marks them broker time", () => {
    const server = imp(`${header}\n${row.replace("UTC,7200", "SERVER,7200")}`, "dojix").trades[0]!;
    expect(server.openTime).toBe("2026-06-01 18:34:50.000");
    const broker = imp(`${header}\n${row.replace("UTC,7200", "SERVER,")}`, "dojix").trades[0]!;
    expect(broker).toMatchObject({ openTime: "2026-06-01 20:34:50.000", timeBasis: "broker" });
  });
});

const MT4_SAMPLE = `Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Close Price,Profit,Commission,Swap
5001,2026.03.02 08:15:00,2026.03.02 09:40:00,BUY,0.10,EURUSD,1.08000,1.07800,1.08500,1.08500,50.00,-2.00,0.00
5002,2026.03.03 13:05:00,2026.03.03 14:10:00,SELL,0.20,GBPUSD,1.27000,1.27200,1.26500,1.27150,-30.00,-2.00,0.00
5003,2026.03.04 02:30:00,2026.03.04 05:00:00,BUY,0.10,USDJPY,150.000,149.700,150.800,150.800,80.00,-3.00,-1.00
5004,2026.03.05 15:45:00,2026.03.05 16:20:00,SELL,0.10,AUDUSD,0.66000,0.66200,0.65500,0.66200,-20.00,-1.00,0.00
5005,2026.03.06 09:00:00,2026.03.06 10:30:00,BUY,0.05,EURUSD,1.08200,1.08000,1.08800,1.08700,25.00,-1.00,0.00`;

describe("Dojix platform detection (GenericCSVParserTests.swift)", () => {
  it.each([
    ["testDetectMT4Format", "Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Profit,Commission,Swap\n12345,2024.01.15 08:30:00,2024.01.15 09:45:00,BUY,0.10,GBPUSD,1.25000,1.24800,1.25500,25.00,-2.00,0.00\n", "mt4"],
    ["testDetectCTraderFormat", "Position ID,Symbol,Direction,Volume,Entry Time,Close Time,Entry Price,Close Price,Stop Loss,Take Profit,Net Profit,Commission,Swap,Pips\n100001,EURUSD,BUY,10000,2024-01-15 08:30:00,2024-01-15 09:45:00,1.08500,1.08700,1.08200,1.09000,20.00,-1.50,0.00,20.0\n", "ctrader"],
    ["compact cTrader", "PositionId,Symbol,Direction,EntryPrice\n1,EURUSD,BUY,1.1\n", "ctrader"],
    ["testDetectOANDAFormat", "Transaction ID,Instrument,Type,Units,Open Time,Close Time,Open Price,Close Price,S/L,T/P,P/L,Financing\n5001,EUR_USD,BUY,10000,2024-01-15T08:30:00,2024-01-15T09:45:00,1.08500,1.08700,1.08200,1.09000,20.00,-0.50\n", "oanda_csv"],
    ["testDetectTradingViewFormat", "Trade #,Date/Time,Type,Signal,Symbol,Contracts,Price,Profit,Cumulative Profit,Run-up,Drawdown\n1,2024-01-15T08:30:00Z,Entry Long,BUY,EURUSD,1,1.08500,0.00,0.00,0.0,0.0\n", "tradingview"],
    ["testDetectNinjaTraderFormat", "Trade #,Instrument,Market Position,Quantity,Entry Time,Entry Price,Exit Time,Exit Price,Profit,Commission,MAE,MFE\n1,ES 03-24,Long,1,01/15/2024 08:30:00,4800.00,01/15/2024 09:45:00,4810.00,500.00,-4.00,100.00,600.00\n", "ninjatrader"],
    ["IB", "TradeID,Symbol,Quantity,T. Price,Date/Time\n1,EUR.USD,1,1,x\n", "ibkr"],
    ["thinkorswim", "Exec Time,Side,Qty,Symbol\n1,2,3,4\n", "tos"],
    ["testDetectSAFormatWithRMultiple (by header line)", `${SA32_HEADER}\n${ROW1}`, "mt5_32col"],
  ])("%s", (_name, csv, format) => {
    expect(detectFormat(csv, "dojix").format).toBe(format);
  });

  it("testDetectUnknownFormatReturnsGeneric / testDetectionReturnsSampleRows", () => {
    const d = detectFormat("Column A,Column B,Column C,Column D\nfoo,bar,baz,qux\n", "dojix");
    expect(d).toMatchObject({ format: "generic", needsMapping: true, mapping: null, headers: ["Column A", "Column B", "Column C", "Column D"] });
    const s = detectFormat("Ticket,Open Time,Type,Size,Item,Price,Profit\n1,2024.01.15 08:30:00,BUY,0.10,GBPUSD,1.25000,25.00\n2,2024.01.15 09:00:00,SELL,0.20,EURUSD,1.08500,30.00", "dojix");
    expect(s.headers).toHaveLength(7);
    expect(s.sampleRows.map((r) => r[0])).toEqual(["1", "2"]);
  });

  it("testDetectEmptyFileThrows / testParseHeaderOnlyFileThrows", () => {
    expect(() => imp("", "dojix")).toThrowError(ImportError);
    expect(() => imp("Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Profit\n", "dojix")).toThrowError(/no rows/);
  });

  it("detects a semicolon or tab dialect only when the header has no comma", () => {
    expect(detectFormat("Ticket;Open Time;Type;Item;Profit\n1;2;3;4;5", "dojix")).toMatchObject({ format: "mt4", dialect: { delimiter: ";", decimalComma: true } });
    expect(detectFormat("Ticket\tOpen Time\tType\tItem\tProfit\n1\t2\t3\t4\t5", "dojix").dialect.delimiter).toBe("\t");
  });
});

describe("Dojix generic parsing", () => {
  it("testParseMT4CSVCreatesTradesCorrectly: profit + commission + swap, broker tickets", () => {
    const csv = `Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Close Price,Profit,Commission,Swap
12345,2024.01.15 08:30:00,2024.01.15 09:45:00,BUY,0.10,GBPUSD,1.25000,1.24800,1.25500,1.25250,25.00,-2.00,-0.50
12346,2024.01.15 14:00:00,2024.01.15 15:30:00,SELL,0.20,EURUSD,1.08500,1.08800,1.08000,1.08200,60.00,-4.00,0.00
12347,2024.01.16 03:00:00,2024.01.16 04:15:00,BUY,0.05,USDJPY,150.500,150.000,151.000,150.200,-15.00,-1.00,0.00`;
    const r = imp(csv, "dojix");
    expect(r.trades.map((t) => [t.symbol, t.direction, t.quantity, t.netProfit, t.ticket])).toEqual([
      ["GBPUSD", "BUY", 0.1, "22.5", "12345"],
      ["EURUSD", "SELL", 0.2, "56", "12346"],
      ["USDJPY", "BUY", 0.05, "-16", "12347"],
    ]);
    expect(r.trades[0]).toMatchObject({ closePrice: "1.2525", session: "LONDON", hour: 8, dayOfWeek: "Mon", durationMin: 75, mae: null, mfe: null });
  });

  it("MT4 with two Price columns: the second is the close price", () => {
    const csv = "Ticket,Open Time,Type,Size,Item,Price,S/L,T/P,Close Time,Price,Commission,Taxes,Swap,Profit\n7,2026.06.01 10:00:00,buy,0.1,eurusd,1.1,0,0,2026.06.01 11:00:00,1.2,-1,0,-0.5,10";
    expect(imp(csv, "dojix").trades[0]).toMatchObject({ openPrice: "1.1", closePrice: "1.2", netProfit: "8.5", symbol: "EURUSD" });
  });

  it("testMultipleDateFormatsParseCorrectly", () => {
    expect(imp("Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Profit,Commission\n1,2024.03.15 10:30:00,2024.03.15 11:00:00,BUY,0.10,EURUSD,1.08500,1.08200,1.09000,15.00,0.00", "dojix").trades).toHaveLength(1);
    expect(imp("Position ID,Symbol,Direction,Volume,Entry Time,Close Time,Entry Price,Close Price,Net Profit\n200,GBPUSD,BUY,10000,2024-03-15 10:30:00,2024-03-15 11:00:00,1.27500,1.27700,20.00", "dojix").trades).toHaveLength(1);
    expect(imp("Trade #,Instrument,Market Position,Quantity,Entry Time,Entry Price,Exit Time,Exit Price,Profit\n1,ES 03-24,Long,1,01/15/2024 08:30:00,4800.00,01/15/2024 09:45:00,4810.00,500.00", "dojix").trades).toHaveLength(1);
  });

  it("SampleFileCrossCheckTests: the MT4 sample's headline numbers", () => {
    const r = imp(MT4_SAMPLE, "dojix");
    expect(r.format).toBe("mt4");
    expect(r.trades).toHaveLength(5);
    expect(totalProfit(r)).toBeCloseTo(95, 9);
    expect(r.trades.filter((t) => Number(t.netProfit) > 0)).toHaveLength(3);
  });

  it("ImportHardeningTests.testGenericZeroLotsWithStopLossDoesNotStoreInfiniteR", () => {
    const r = imp("Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Profit,Commission,Swap\n500,2024.01.15 08:30:00,2024.01.15 09:45:00,BUY,0,GBPUSD,1.25000,1.24800,1.25500,25.00,0,0\n", "dojix");
    expect(r.trades[0]?.rMultiple).toBe(0);
    expect(r.mac[0]?.rMultiple).toBe(Infinity); // Mac value before Trade+Sanitize
  });

  it("D-06: generic R uses a pip value of 10 for every pair in fixed mode, the Mac's 100 for JPY in swift", () => {
    const csv = "Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Profit\n1,2024.01.15 08:30:00,2024.01.15 09:45:00,BUY,1,USDJPY,150.000,149.500,151.000,500";
    expect(imp(csv, "dojix", "swift").trades[0]).toMatchObject({ slDist: 50, rMultiple: 0.1 });
    expect(imp(csv, "dojix", "fixed").trades[0]).toMatchObject({ slDist: 50, rMultiple: 1 });
    const eur = "Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Profit\n1,2024.01.15 08:30:00,2024.01.15 09:45:00,BUY,1,EURUSD,1.1000,1.0950,1.11,500";
    expect(imp(eur, "dojix", "swift").trades[0]?.rMultiple).toBeCloseTo(1, 9);
    expect(imp(eur, "dojix", "fixed").trades[0]?.rMultiple).toBeCloseTo(1, 9);
  });

  it("D-15: cTrader and OANDA CSV units are lots ÷ 100,000 in fixed mode; tickets stay the Mac's", () => {
    const ct = "Position ID,Symbol,Direction,Volume,Entry Time,Close Time,Entry Price,Close Price,Stop Loss,Net Profit,Commission,Swap\n0,EUR/USD,Buy,10000,2024-01-15 08:30:00,2024-01-15 09:45:00,1.08500,1.08700,1.08300,20.00,-1.50,0";
    const swift = imp(ct, "dojix", "swift").trades[0]!;
    const fixed = imp(ct, "dojix", "fixed").trades[0]!;
    expect(swift.quantity).toBe(10_000);
    expect(fixed.quantity).toBeCloseTo(0.1, 12);
    expect(fixed.ticket).toBe(swift.ticket); // content ticket computed from the Mac's values
    expect(BigInt(fixed.ticket) >= 8_000_000_000_000_000_000n).toBe(true);
    expect(fixed.rMultiple).toBeCloseTo(18.5 / (20 * 0.1 * 10), 9);
    const oanda = "Transaction ID,Instrument,Type,Units,Open Time,Close Time,Open Price,Close Price,P/L,Financing\n5001,EUR_USD,Sell Market,-25000,2024-01-15T08:30:00,2024-01-15T09:45:00,1.08500,1.08700,-50.00,-0.50";
    expect(imp(oanda, "dojix", "fixed").trades[0]).toMatchObject({ quantity: 0.25, direction: "SELL", netProfit: "-50.5", ticket: "5001", source: "oanda_csv" });
  });

  it("D-16: TradingView Entry/Exit rows paired by Trade # (fixed); one trade per row on the Mac", () => {
    const tv = `Trade #,Type,Signal,Date/Time,Price,Contracts,Profit,Run-up,Drawdown,Symbol
2,Exit Short,Close,2024-01-16T12:00:00+0000,1.0800,1,30,40,-5,EURUSD
2,Entry Short,Short,2024-01-16T10:00:00+0000,1.0830,1,30,40,-5,EURUSD
1,Exit Long,Close,2024-01-15T12:00:00+0000,1.0900,1,-20,5,-25,EURUSD
1,Entry Long,Long,2024-01-15T09:30:00+0000,1.0920,1,-20,5,-25,EURUSD
3,Entry Long,Long,2024-01-17T09:30:00+0000,1.0920,1,0,0,0,EURUSD
4,Marker,,2024-01-17T09:30:00+0000,1.0920,1,0,0,0,EURUSD`;
    const swift = imp(tv, "dojix", "swift");
    expect(swift.trades).toHaveLength(5); // "Marker" has no direction
    const fixed = imp(tv, "dojix", "fixed");
    expect(fixed.trades.map((t) => [t.direction, t.openTime, t.closeTime, t.openPrice, t.closePrice, t.netProfit, t.durationMin, t.externalId])).toEqual([
      ["SELL", "2024-01-16 10:00:00.000", "2024-01-16 12:00:00.000", "1.083", "1.08", "30", 120, "2"],
      ["BUY", "2024-01-15 09:30:00.000", "2024-01-15 12:00:00.000", "1.092", "1.09", "-20", 150, "1"],
    ]);
    expect(fixed.issues.map((i) => i.code).sort()).toEqual(["not_a_trade", "unpaired"]);
    expect(fixed.trades[0]).toMatchObject({ mae: -5, mfe: 40 });
    expect(new Set(fixed.trades.map((t) => t.ticket)).size).toBe(2);
    // Re-import gives the same tickets.
    expect(imp(tv, "dojix", "fixed").trades.map((t) => t.ticket)).toEqual(fixed.trades.map((t) => t.ticket));
  });

  it("D-18: unknown MAE/MFE are NULL in fixed mode, 0 on the Mac; known columns are kept", () => {
    const nt = "Trade #,Instrument,Market Position,Quantity,Entry Time,Entry Price,Exit Time,Exit Price,Profit,MAE,MFE\n1,EURUSD,Long,1,01/15/2024 08:30:00,1.1,01/15/2024 09:45:00,1.2,500,12,x";
    expect(imp(nt, "dojix", "fixed").trades[0]).toMatchObject({ mae: 12, mfe: null });
    expect(imp(nt, "dojix", "swift").trades[0]).toMatchObject({ mae: 12, mfe: 0 });
  });

  it("row-level problems are reported, never dropped silently", () => {
    const csv = `Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Profit
1,2024.01.15 08:30:00,,HOLD,0.1,EURUSD,1,0,0,1
2,not a date,,BUY,0.1,EURUSD,1,0,0,1
3,2024.01.15 08:30:00,,BUY,0.1,,1,0,0,1
a,b
4,2024.01.15 08:30:00,,-1,0.1,EURUSD,1,0,0,1`;
    const r = imp(csv, "dojix");
    expect(r.issues.map((i) => [i.line, i.code])).toEqual([[2, "invalid_direction"], [3, "invalid_date"], [4, "missing_symbol"], [5, "too_few_columns"]]);
    expect(r.trades[0]).toMatchObject({ direction: "SELL", closeTime: r.trades[0]?.openTime });
  });
});

describe("Re-import idempotence (ReimportDedupeTests.swift)", () => {
  const mapping: DojixColumnMapping = {
    platform: "generic", ticket: null, symbol: 0, direction: 1, lots: 2, openTime: 3, closeTime: 4, openPrice: 5, closePrice: 6, sl: null, tp: null,
    profit: 7, commission: null, swap: null, maePips: null, mfePips: null, pips: null, dateFormat: "yyyy-MM-dd HH:mm:ss",
  };
  const csv = `Symbol,Side,Qty,Open,Close,OpenPrice,ClosePrice,Profit
EURUSD,BUY,0.10,2026-02-02 09:00:00,2026-02-02 10:00:00,1.08000,1.08200,20.00
GBPUSD,SELL,0.20,2026-02-03 13:00:00,2026-02-03 14:30:00,1.27000,1.27100,-20.00
GBPUSD,SELL,0.20,2026-02-03 13:00:00,2026-02-03 14:30:00,1.27000,1.27100,-20.00`;

  it("testReimportingTicketlessFileAddsNothing: identical rows stay two trades; the same file gives the same tickets", () => {
    const first = imp(csv, "dojix", "fixed", { mapping });
    expect(first.format).toBe("generic");
    expect(first.trades).toHaveLength(3);
    expect(new Set(first.trades.map((t) => t.ticket)).size).toBe(3);
    const again = imp(csv, "dojix", "fixed", { mapping });
    expect(again.trades.map((t) => t.ticket)).toEqual(first.trades.map((t) => t.ticket));
    const key = "EURUSD|BUY|0.10000000|1770022800.0|1770026400.0|1.08|1.082|20";
    expect(first.trades[0]?.ticket).toBe(dojixContentTicket(key, 0).toString());
    expect(dojixContentKey(first.mac[0] as never)).toBe(key);
  });

  it("testPerExportTradeNumbersDoNotHideNewTrades", () => {
    const header = "Trade #,Instrument,Market position,Quantity,Entry price,Exit price,Entry time,Exit time,Profit,Commission\n";
    const a = imp(header + "1,EURUSD,Long,1,1.0800,1.0820,02/02/2026 09:00:00,02/02/2026 10:00:00,200,0\n", "dojix");
    const b = imp(header + "1,GBPUSD,Short,1,1.2700,1.2690,02/09/2026 09:00:00,02/09/2026 10:00:00,100,0\n", "dojix");
    expect(a.trades[0]?.ticket).not.toBe(b.trades[0]?.ticket);
    expect(a.trades[0]?.externalId).toBeNull();
  });

  it("duplicate broker tickets inside one file keep the first (as the Mac's insert does)", () => {
    const r = imp(MT4_SAMPLE + "\n5001,2026.03.02 08:15:00,2026.03.02 09:40:00,BUY,0.10,EURUSD,1.08000,1.07800,1.08500,1.08500,50.00,-2.00,0.00", "dojix");
    expect(r.trades).toHaveLength(5);
    expect(r.duplicatesInFile).toBe(1);
  });

  it("a user mapping of the wrong brand is refused", () => {
    expect(() => importTradeText("a,b,c,d\n1,2,3,4", "utf-8", { brand: "greenwick", now: NOW_MS, mapping })).toThrowError(TypeError);
  });
});

describe("Trade+Sanitize (HostileInputRegressionTests.swift F5)", () => {
  it("testSanitizerEnforcesMinimumLotSize", () => {
    expect(dojixLotSize(1e-15)).toBe(0.00001);
    expect(dojixLotSize(-1e-9)).toBe(0.00001);
    expect(dojixLotSize(0)).toBe(0);
    expect(dojixLotSize(0.01)).toBe(0.01);
    expect(dojixLotSize(5e9)).toBe(1_000_000);
    expect(dojixLotSize(NaN)).toBe(0);
  });

  it("storageViolations names every out-of-range field; restore strips controls and bad screenshot names", () => {
    const base = imp(MT4_SAMPLE, "dojix", "swift").mac[0] as Parameters<typeof sanitizeDojix>[0];
    expect(dojixStorageViolations(sanitizeDojix(base))).toEqual([]);
    const bad = {
      ...base,
      symbol: "",
      lots: -1,
      netProfit: SwiftDecimal.nan,
      openPrice: SwiftDecimal.parse("2e12") as SwiftDecimal,
      maePips: Infinity,
      durationMin: -1,
      timeToMFEMin: 99_999_999,
      hour: 24,
      dayOfWeek: "Funday",
      screenshots: "../x.jpg",
    };
    expect(dojixStorageViolations(bad)).toEqual(["symbol", "lots", "openPrice", "netProfit", "maePips", "durationMin", "timeToMFEMin", "hour", "dayOfWeek", "screenshots"]);
    const clamped = sanitizeDojix({ ...bad, openPrice: SwiftDecimal.parse("-2e12") as SwiftDecimal, closeTime: base.openTime - 1 });
    expect(clamped.openPrice.toString()).toBe("-1000000000000");
    expect(clamped.closeTime).toBe(base.openTime);
    const good = "0F8FAD5B-D9CB-469F-A165-70867728950E.jpg";
    const restored = sanitizeDojixForRestore({ ...base, notes: "a\u0000b\nc\td", tags: "x\u0007,y", emotion: "CALM​", checklistData: '{"a":true}\u0001', screenshots: `${good}, bad.jpg` });
    expect(restored).toMatchObject({ notes: "ab\nc\td", tags: "x,y", emotion: "CALM", checklistData: '{"a":true}', screenshots: good });
  });

  it("directionOf: values, substrings and IB negative quantities", () => {
    expect(["B", "BOT", "LONG", "BUY TO OPEN"].map(directionOf)).toEqual(["BUY", "BUY", "BUY", "BUY"]);
    expect(["S", "SLD", "SHORT", "-3"].map(directionOf)).toEqual(["SELL", "SELL", "SELL", "SELL"]);
    expect(directionOf("3")).toBeNull();
  });
});
