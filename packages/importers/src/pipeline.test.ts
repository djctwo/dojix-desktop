import { describe, expect, it } from "vitest";
import { ImportError, MAX_IMPORT_BYTES } from "./model";
import { detectFormat, headerSignature, importTradeFile } from "./pipeline";
import { normaliseDecimalComma, splitFields } from "./csv/dialect";
import { NOW, imp, utf16 } from "./test-support/helpers";
import { dojixRow, storeRow } from "./rows";
import { isValidDojixScreenshotName, isValidGreenwickScreenshotName } from "./screenshots";

describe("pipeline", () => {
  it("refuses files over 50 MB before decoding", () => {
    const big = new Uint8Array(MAX_IMPORT_BYTES + 1);
    expect(() => importTradeFile(big, { brand: "dojix", now: NOW })).toThrowError(expect.objectContaining({ code: "too_large" }));
  });

  it("decodes UTF-16BE, CP1252 and UTF-8 BOM files the Macs can't (superset)", () => {
    const tos = "Exec Time,Symbol,Side,Qty,Price,Net Price,P/L,Commission\n03/24/26 09:31:15,AAPL,BUY,100,171.25,171.30,25.00,0.65\n";
    expect(imp(utf16(tos, false), "greenwick").trades).toHaveLength(1);
    const cp1252 = new Uint8Array([...new TextEncoder().encode(tos.replace("AAPL", "AAPL")), 0x80]);
    expect(imp(cp1252, "greenwick").encoding).toBe("windows-1252");
    expect(imp(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(tos)]), "greenwick").trades).toHaveLength(1);
  });

  it("detects Greenwick headers on line 2 and Dojix only on line 1", () => {
    const fid = "Brokerage\nRun Date,Action,Symbol,Security Description,Security Type,Quantity,Price ($)\n03/24/2026,YOU BOUGHT,XYZ,x,Cash,1,1";
    expect(detectFormat(fid, "greenwick")).toMatchObject({ format: "fidelity", headers: expect.arrayContaining(["Run Date"]) });
    expect(detectFormat("only one line", "greenwick")).toMatchObject({ format: "generic", needsMapping: true });
    expect(() => detectFormat("  \n\n", "dojix")).toThrowError(ImportError);
  });

  it("decimal commas are rewritten only in semicolon files", () => {
    expect(splitFields("1,5;2,5", { delimiter: ";", decimalComma: true })).toEqual(["1.5", "2.5"]);
    expect(["1.234,56", "-1,5", "($1.234,50)", "1,08500", "2024-01-15", "abc,1"].map(normaliseDecimalComma)).toEqual(["1234.56", "-1.5", "($1234.50)", "1.08500", "2024-01-15", "abc,1"]);
  });

  it("issues are sorted by line and duplicates counted", () => {
    const r = imp("Ticket,Open Time,Type,Item,Price,Profit\n1,2024.01.15 08:30:00,BUY,EURUSD,1,1\n1,2024.01.15 08:30:00,BUY,EURUSD,1,1\nx,y\n", "dojix");
    expect(r.issues.map((i) => i.line)).toEqual([3, 4]);
    expect(r.duplicatesInFile).toBe(1);
  });

  it("reports rows whose dates the journal text can't hold", () => {
    const r = imp("Ticket,Open Time,Type,Item,Price,Profit\n1,99999.01.15 08:30:00,BUY,EURUSD,1,1\n", "dojix");
    expect(r.trades).toEqual([]);
    expect(r.issues[0]?.code).toBe("storage_rejected");
    const g = imp("Exec Time,Symbol,Side,Qty,Price,Net Price,P/L,Commission\n03/24/26 09:31:15,AAPL,BUY,100,171.25,171.30,25.00,0.65", "greenwick");
    const row = { trade: { ...g.mac[0]!, openTime: Date.UTC(1850, 0, 1) }, meta: { source: "tos" as const, line: 2, externalId: null, maeKnown: false, mfeKnown: false, strategyKnown: false, timeBasis: "utc" as const } };
    expect(storeRow(row, "fixed", NOW)).toMatchObject({ issue: { code: "storage_rejected" } });
  });

  it("maps tags and checklist JSON the way the Mac reads them", () => {
    const d = imp("Ticket,Open Time,Type,Item,Price,Profit\n1,2024.01.15 08:30:00,BUY,EURUSD,1,1\n", "dojix");
    const t = d.mac[0]!;
    const meta = { source: "mt4" as const, line: 1, externalId: null, maeKnown: true, mfeKnown: true, strategyKnown: true, timeBasis: "utc" as const };
    const row = (o: object) => dojixRow({ ...t, ...o } as typeof t & { brand: "dojix" }, { trade: t, meta }, "fixed", NOW);
    expect(row({ tags: " a, ,b ", emotion: "CALM", checklistData: '{"x":true,"y":false}' })).toMatchObject({ tags: '["a","b"]', emotion: "CALM", checklist: '{"x":true,"y":false}' });
    for (const bad of ["[1]", "null", '{"x":1}', "{", ""]) expect(row({ checklistData: bad }).checklist).toBe("{}");
  });

  it("header signatures ignore case and spacing", () => {
    expect(headerSignature([" Symbol", "QTY "])).toBe(headerSignature(["symbol", "qty"]));
    expect(headerSignature(["a"])).not.toBe(headerSignature(["b"]));
  });

  it("screenshot names follow each Mac's rule", () => {
    const id = "0F8FAD5B-D9CB-469F-A165-70867728950E";
    expect(isValidDojixScreenshotName(`${id}.jpg`)).toBe(true);
    expect(isValidDojixScreenshotName(`${id}.JPG`)).toBe(false);
    expect(isValidGreenwickScreenshotName(`${id}.JPG`)).toBe(true);
    expect(isValidGreenwickScreenshotName("../../etc/passwd.jpg")).toBe(false);
    expect(isValidDojixScreenshotName(`${id.replace("F", "Z")}.jpg`)).toBe(false);
  });
});

describe("swift compat reproduces the Mac's routing and decoding (Swift reference run)", () => {
  const sa = "Ticket,Symbol,Direction,Lots,OpenTime,CloseTime,DurationMin,OpenPrice,ClosePrice,SL,TP,NetProfit,MAE_Pips,MFE_Pips,RMultiple,Session,DayOfWeek,Hour,RangeSize,SweepDepth,UsedFVG,VolRegime,HitBreakeven,ScaledIn,Magic,Comment";
  const row = "1,EURUSD,BUY,0.1,2026.01.15 08:30:00,2026.01.15 09:30:00,60,1,1,0,0,5,1,1,1,LONDON,Thu,8,1,1,NO,MED,NO,NO,1,x";
  const multi = `== Summary ==\nTotal,1\n\n${sa}\n${row}\n`;

  it("a multi-section file is read by name on the Mac, by content on the desktop", () => {
    expect(imp(multi, "dojix", "swift").detection).toMatchObject({ format: "generic", needsMapping: true });
    expect(imp(multi, "dojix", "swift", { fileName: "StrategyAnalytics_x.csv" }).trades).toHaveLength(1);
    expect(imp(multi, "dojix", "swift", { fileName: "SA_Results.csv" }).trades).toHaveLength(1);
    expect(imp(multi, "dojix", "fixed").trades).toHaveLength(1);
    expect(imp(`${sa}\n${row}`, "dojix", "swift").trades).toHaveLength(1); // ticket + rmultiple on line 1
  });

  it("a UTF-8 BOM hides the 32-column header on the Mac; UTF-16 imports nowhere on the Mac", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(`${sa}\n${row}\n`)]);
    expect(() => imp(bom, "dojix", "swift", { fileName: "StrategyAnalytics_bom.csv" })).toThrowError(ImportError);
    expect(imp(bom, "dojix", "swift").trades).toEqual([]);
    expect(imp(bom, "dojix", "fixed").trades).toHaveLength(1);
    expect(imp(utf16(`${sa}\r\n${row}\r\n`, true), "dojix", "swift").trades).toEqual([]);
    expect(imp(utf16(`${sa}\r\n${row}\r\n`, true), "dojix", "fixed").trades).toHaveLength(1);
    const tos = "Exec Time,Symbol,Side,Qty,Price,Net Price,P/L,Commission\n03/24/26 09:31:15,AAPL,BUY,100,171.25,171.30,25.00,0.65\n";
    expect(imp(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(tos)]), "greenwick", "swift").trades).toHaveLength(1); // Greenwick strips it
    expect(imp(new Uint8Array([...new TextEncoder().encode(tos), 0x80]), "greenwick", "swift").encoding).toBe("windows-1252");
  });

  it("DateFormatter in New York: skipped times rejected, repeated times take the second occurrence", () => {
    const tos = (t: string) => `Exec Time,Symbol,Side,Qty,Price,Net Price,P/L,Commission\n${t},AAPL,BUY,100,1,1,1,0`;
    // 2026-03-08 02:30 ET does not exist: MM/dd/yyyy fails and the day-first fallback reads 3 August.
    expect(imp("Trade #,Instrument,Market Position,Quantity,Entry Time,Exit Time,Entry Price,Exit Price,Profit\n1,AAPL,Long,1,03/08/2026 02:30:00,03/08/2026 03:30:00,1,1,1", "greenwick", "swift").trades[0]).toMatchObject({ openTime: "2026-08-03 06:30:00.000" });
    // 2026-11-01 01:30 ET happens twice: the second (EST, 06:30 UTC).
    expect(imp(tos("11/01/26 01:30:00"), "greenwick").trades[0]?.openTime).toBe("2026-11-01 06:30:00.000");
    expect(imp(tos("11/01/26 00:30:00"), "greenwick").trades[0]?.openTime).toBe("2026-11-01 04:30:00.000");
  });

  it("the Mac reads a DojixExport file as a plain 32-column file", () => {
    const header = `${sa},TimeBasis`;
    expect(imp(`${header}\n${row},SERVER`, "dojix", "swift", { fileName: "StrategyAnalytics.csv" }).trades[0]).toMatchObject({ source: "mt5_32col" });
    expect(imp(`${header}\n${row},UTC`, "dojix", "fixed").trades[0]).toMatchObject({ source: "dojix_export" });
  });

  it("swift-mode detection handles empty and title-only files", () => {
    expect(() => detectFormat("\n \n", "greenwick", { compat: "swift" })).toThrowError(ImportError);
    expect(detectFormat("x", "dojix", { compat: "swift" }).format).toBe("generic");
    expect(detectFormat("Exec Time,Side,Qty,Symbol\n1,2,3,4", "dojix", { compat: "swift" }).format).toBe("tos");
  });
});

describe("OANDA API import", () => {
  it("decodes, pairs and stores pages; a malformed page fails the import", async () => {
    const { importOandaPages } = await import("./pipeline");
    const open = { time: "2025-03-15T10:30:00.000000000Z", instrument: "EUR_USD", units: "inf", price: "1.08542", tradeOpened: { tradeID: "7" } };
    const close = { time: "2025-03-15T12:00:00Z", price: "1.08650", tradesClosed: [{ tradeID: "7", realizedPL: "nan" }] };
    const r = importOandaPages([{ transactions: [open] }, { transactions: [close] }], { now: NOW });
    expect(r?.trades[0]).toMatchObject({ ticket: "7", quantity: 0, direction: "BUY", netProfit: "0", source: "oanda_api", mae: null }); // ∞ lots → 0 (Trade+Sanitize)
    expect(importOandaPages([{ transactions: [{ id: 1 }] }], { now: NOW })).toBeNull();
  });
});
