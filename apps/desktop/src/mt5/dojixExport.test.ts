// @vitest-environment node
// The free MT5 exporter (mql5/DojixExport.mq5) can't be compiled in CI (no MetaEditor), so this
// pins its output format instead: the header the script writes, the number of fields its row
// builder produces, and a hand-written sample in exactly that format, which the importer must
// read as a DojixExport file. The sample's outcome is also the fixture the Rust commit test uses.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SA32_HEADER, importTradeFile } from "@dojix-desktop/importers";
import { mt5OutcomeFor } from "./autoImport";

const repo = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const SCRIPT = readFileSync(repo("mql5/DojixExport.mq5"), "utf8");
const SAMPLE_NAME = "DojixExport_10000001_20261028.csv";
const SAMPLE = readFileSync(repo(`mql5/samples/${SAMPLE_NAME}`));
const FIXTURE = repo("apps/desktop/src-tauri/tests/fixtures/mt5_outcome_dojix_export.json");
/** 2026-10-28 12:00:00 UTC: the fixture's "importedAt". */
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const EXTRA = ["Account", "Commission", "Swap", "TimeBasis", "ServerUTCOffset"];

function scriptHeader(): string {
  const m = /const string DJX_HEADER = "([^"]+)";/.exec(SCRIPT);
  if (!m) throw new Error("DJX_HEADER not found in DojixExport.mq5");
  return m[1] as string;
}

/** The commas in the string literals of the script's row expression. */
function rowSeparators(): number {
  const m = /\n {3}row = ([\s\S]*?);\n/.exec(SCRIPT);
  if (!m) throw new Error("the row expression was not found in DojixExport.mq5");
  const literals = [...(m[1] as string).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1] as string);
  return literals.reduce((n, l) => n + l.split(",").length - 1, 0);
}

describe("DojixExport.mq5 output format", () => {
  it("writes the 32-column header plus the five DojixExport columns", () => {
    expect(scriptHeader()).toBe([SA32_HEADER, ...EXTRA].join(","));
  });

  it("builds every row with as many fields as the header", () => {
    expect(rowSeparators() + 1).toBe(scriptHeader().split(",").length);
  });

  it("names files DojixExport_<login>_<YYYYMMDD>.csv in Common\\Files, via a temporary file", () => {
    expect(SCRIPT).toContain('StringFormat("DojixExport_%I64d_%04d%02d%02d.csv"');
    expect(SCRIPT).toContain("FILE_WRITE | FILE_BIN | FILE_COMMON");
    expect(SCRIPT).toContain("FILE_COMMON | FILE_REWRITE");
    expect(SCRIPT).toContain("CP_UTF8");
    expect(SCRIPT).toContain('"\\r\\n"');
  });

  it("is GPL-3.0 and never trades", () => {
    expect(SCRIPT).toContain("Copyright (C) 2026 Douglas Cleary");
    expect(SCRIPT).toContain("GNU General Public License");
    for (const call of ["OrderSend", "OrderSendAsync", "PositionClose", "CTrade"]) {
      expect(SCRIPT).not.toContain(call);
    }
  });
});

describe("the sample file (the script's exact output format)", () => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(SAMPLE);
  const lines = text.split("\r\n");

  it("is UTF-8 without a BOM, CRLF, header first, one field per header column", () => {
    expect(SAMPLE[0]).not.toBe(0xef);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(lines[0]).toBe(scriptHeader());
    const rows = lines.slice(1, -1);
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.split(",").length).toBe(37);
  });

  it("imports as a DojixExport file: UTC times, net profit, strategy fields unknown", () => {
    const r = importTradeFile(SAMPLE, { brand: "dojix", now: NOW, fileName: SAMPLE_NAME });
    expect(r.format).toBe("dojix_export");
    expect(r.issues).toEqual([]);
    expect(r.trades.map((t) => t.ticket)).toEqual(["500001", "500002", "500003"]);
    const [eur, gbp, jpy] = r.trades;
    expect(eur).toMatchObject({
      source: "dojix_export",
      symbol: "EURUSD",
      direction: "BUY",
      quantity: 0.1,
      openTime: "2026-10-26 08:15:00.000",
      closeTime: "2026-10-26 10:45:30.000",
      timeBasis: "utc",
      durationMin: 150,
      openPrice: "1.0825",
      netProfit: "15.3",
      mae: 3.2,
      mfe: 18.5,
      rMultiple: 1.07,
      session: "LONDON",
      dayOfWeek: "Mon",
      hour: 8,
      slDist: 15,
      comment: "Fictional sample",
      rangeSize: null,
      sweepDepth: null,
      usedFvg: null,
      volRegime: null,
      biasAtEntry: null,
    });
    expect(gbp).toMatchObject({ direction: "SELL", netProfit: "-31.4", magic: 20261027, session: "NY_OVERLAP" });
    expect(jpy).toMatchObject({ session: "LATE", hitBreakeven: true, scaledIn: true, closeTime: "2026-10-28 02:10:00.000" });
  });

  it("is a compatible superset: without the five extra columns it is a plain 32-column file", () => {
    const plain = lines
      .filter((l) => l !== "")
      .map((l) => l.split(",").slice(0, 32).join(","))
      .join("\r\n");
    const bytes = new TextEncoder().encode(`${plain}\r\n`);
    const asExport = importTradeFile(SAMPLE, { brand: "dojix", now: NOW });
    const as32 = importTradeFile(bytes, { brand: "dojix", now: NOW });
    expect(as32.format).toBe("mt5_32col");
    expect(as32.trades.map((t) => [t.ticket, t.openTime, t.netProfit])).toEqual(
      asExport.trades.map((t) => [t.ticket, t.openTime, t.netProfit]),
    );
  });

  it("produces the outcome the Rust commit test reads (fixture)", () => {
    const outcome = mt5OutcomeFor(SAMPLE, SAMPLE_NAME, NOW);
    expect(outcome.kind).toBe("trades");
    const json = `${JSON.stringify(outcome, null, 2)}\n`;
    if (process.env["UPDATE_MT5_FIXTURE"] === "1") writeFileSync(FIXTURE, json);
    expect(readFileSync(FIXTURE, "utf8")).toBe(json);
  });
});
