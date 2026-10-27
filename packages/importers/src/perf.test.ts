// Worst-case sizes and hostile shapes must finish in bounded time (SPEC §10: a 50 MB worst-case
// file parses in < 5 s). The bounds are wall-clock on a developer machine; CI runners are
// slower and shared, so CI gets a larger allowance (the measured times are printed).

import { describe, expect, it } from "vitest";
import { ImportError, MAX_IMPORT_BYTES } from "./model";
import { importTradeFile } from "./pipeline";
import { htmlTableRows, parseMt5Report } from "./dojix/mt5-report";
import { macCsvFields, trimWs } from "./swift/text";
import { swiftDouble } from "./swift/numbers";
import { normaliseDecimalComma } from "./csv/dialect";

// The full 50 MB run is `pnpm test:perf` (no coverage instrumentation, which slows code 2-3×).
// The default run uses 5 MB files with a proportional bound, which still catches any
// super-linear behaviour.
const FULL = process.env.PERF_FULL === "1";
const CI = process.env.CI !== undefined;
const SLACK = (CI ? 4 : 1) * (FULL ? 1 : 3);
const NOW = Date.UTC(2026, 9, 27);
const enc = new TextEncoder();

function timed<T>(label: string, limitMs: number, fn: () => T): T {
  const start = performance.now();
  const out = fn();
  const ms = performance.now() - start;
  process.stdout.write(`${label}: ${ms.toFixed(0)} ms\n`);
  expect(ms, label).toBeLessThan(limitMs * SLACK);
  return out;
}

function fill(line: string, bytes: number, header: string): Uint8Array {
  const count = Math.floor((bytes - enc.encode(header).length - 1) / (enc.encode(line).length + 1));
  return enc.encode(header + "\n" + `${line}\n`.repeat(count));
}

function tryImport(bytes: Uint8Array, brand: "dojix" | "greenwick"): number {
  try {
    return importTradeFile(bytes, { brand, now: NOW }).trades.length;
  } catch (e) {
    if (e instanceof ImportError) return -1;
    throw e;
  }
}

describe(FULL ? "50 MB worst cases" : "5 MB worst cases (PERF_FULL=1 for 50 MB)", () => {
  const SIZE = FULL ? MAX_IMPORT_BYTES - 1024 : Math.floor(MAX_IMPORT_BYTES / 10);
  const LIMIT = FULL ? 5000 : 500;

  it("valid MT4 rows (every row parsed, ticketed and stored)", () => {
    const n = timed("MT4", LIMIT, () =>
      tryImport(fill("12345,2024.01.15 08:30:00,2024.01.15 09:45:00,BUY,0.10,GBPUSD,1.25000,1.24800,1.25500,25.00,-2.00,0.00", SIZE, "Ticket,Open Time,Close Time,Type,Size,Item,Price,S/L,T/P,Profit,Commission,Swap"), "dojix"),
    );
    expect(n).toBe(1); // one broker ticket repeated: the rest are in-file duplicates
  });

  it("ticketless rows (content tickets, SHA-256 per row)", () => {
    const n = timed("ticketless NinjaTrader", LIMIT, () =>
      tryImport(fill("1,ES 03-24,Long,1,01/15/2024 08:30:00,4800.00,01/15/2024 09:45:00,4810.00,500.00,-4.00,100.00,600.00", SIZE, "Trade #,Instrument,Market Position,Quantity,Entry Time,Entry Price,Exit Time,Exit Price,Profit,Commission,MAE,MFE"), "dojix"),
    );
    expect(n).toBeGreaterThan(FULL ? 400_000 : 40_000);
  });

  it("Greenwick FIFO transactions", () => {
    const n = timed("Robinhood FIFO", LIMIT, () =>
      tryImport(fill("3/24/2026,3/24/2026,3/26/2026,Brokerage,AAPL,x,Buy,100,$171.50,($17150.00),", SIZE, "Activity Date,Process Date,Settle Date,Account Type,Instrument,Description,Trans Code,Quantity,Price,Amount,Suppressed"), "greenwick"),
    );
    expect(n).toBe(0); // buys only: nothing to pair
  });

  it("non-ASCII rows (grapheme tokenizer path)", () => {
    const n = timed("non-ASCII", LIMIT, () =>
      tryImport(fill("1,2024.01.15 08:30:00,BUY,0.10,ÉURUSD,1.25,1é,25,ü,ö,ä,ß", SIZE, "Ticket,Open Time,Type,Size,Item,Price,S/L,Profit,a,b,c,d"), "dojix"),
    );
    expect(n).toBe(1); // parsed (one ticket repeated)
  });

  it("one 50 MB line of commas, spaces or quotes", () => {
    for (const ch of [",", " ", '"', "<"]) {
      const line = "1" + ch.repeat(SIZE - 400);
      timed(`one line of ${JSON.stringify(ch)}`, LIMIT, () => tryImport(enc.encode(`Ticket,Symbol,Direction,Lots,OpenTime,CloseTime,DurationMin,OpenPrice,ClosePrice,SL,TP,NetProfit,MAE_Pips,MFE_Pips,RMultiple\n${line}\n`), "dojix"));
    }
  });
});

describe("hostile shapes stay linear", () => {
  const MB5 = 5 * 1024 * 1024;

  it("HTML: unclosed <td openers, < without >, long attributes, many rows", () => {
    timed("5 MB of <td", 1000, () => htmlTableRows("<tr>" + "<td".repeat(MB5 / 3)));
    timed("5 MB of <td + >", 1000, () => htmlTableRows("<tr>" + "<td".repeat(MB5 / 3) + ">"));
    timed("5 MB of <", 1000, () => htmlTableRows("<".repeat(MB5)));
    timed("5 MB of <a", 1000, () => htmlTableRows("<a ".repeat(MB5 / 3) + ">x"));
    timed("5 MB attribute", 1000, () => htmlTableRows(`<tr><td class="${"a ".repeat(MB5 / 2)}hidden">x</td></tr>`));
    timed("5 MB of class=", 1000, () => htmlTableRows(`<tr><td ${"class=".repeat(MB5 / 6)}>x</td></tr>`));
    const many = timed("5 MB of cells", 1000, () => htmlTableRows("<tr>" + "<td>1</td>".repeat(MB5 / 10)));
    expect(many[0]?.length).toBe(64);
    const long = timed("5 MB cell", 1000, () => htmlTableRows(`<tr><td>${"x &amp; ".repeat(MB5 / 8)}</td></tr>`));
    expect(long[0]?.[0]?.text.length).toBeLessThanOrEqual(4096);
    timed("5 MB of rows", 1000, () => htmlTableRows("<tr><td>x</td></tr>".repeat(MB5 / 20)));
    expect(() => parseMt5Report(`<table><tr><th>Positions</th></tr>${"<td".repeat(MB5 / 3)}`, { brand: "dojix", compat: "fixed", now: NOW })).toThrowError(ImportError);
  });

  it("CSV and number primitives on long runs", () => {
    timed("trim 5 MB of inner spaces", 200, () => trimWs("a" + " ".repeat(MB5) + "b"));
    timed("tokenize 5 MB of quotes and commas", 1000, () => macCsvFields('",'.repeat(MB5 / 2)));
    timed("Double of 5 MB of digits + x", 200, () => expect(swiftDouble("1".repeat(MB5) + "x")).toBeNull());
    timed("Double of 5 MB of hex digits + x", 500, () => expect(swiftDouble("0x" + "f".repeat(MB5) + "z")).toBeNull());
    timed("Double of 5 MB hex exponent + z", 500, () => expect(swiftDouble("0x1p" + "1".repeat(MB5) + "z")).toBeNull());
    timed("decimal comma on 5 MB", 50, () => normaliseDecimalComma("1".repeat(MB5) + ","));
  });
});
