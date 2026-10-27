// MT5 History Report (desktop format) and the OANDA v20 mapping (OANDAServiceTests.swift).
import { describe, expect, it } from "vitest";
import { ImportError } from "../model";
import { NOW, imp, utf16 } from "../test-support/helpers";
import { htmlTableRows, looksLikeMt5Report, parseMt5Report } from "./mt5-report";
import { decodeOandaPage, isTrustedOandaUrl, isValidOandaAccountId, mapOandaTransactions } from "./oanda-api";

const ctx = { brand: "dojix" as const, compat: "fixed" as const, now: NOW };

const HEAD = `<!DOCTYPE html><html><head><title>Trade History Report (fictional)</title></head><body><table>
<tr><th colspan="14"><div><b>Trade History Report</b></div></th></tr>
<tr><th colspan="14"><div><b>Positions</b></div></th></tr>
<tr bgcolor="#E5F0FC" align="center"><td>Time</td><td>Position</td><td>Symbol</td><td>Type</td><td class="hidden" colspan="8"></td><td>Volume</td><td>Price</td><td>S / L</td><td>T / P</td><td>Time</td><td>Price</td><td>Commission</td><td>Swap</td><td colspan="2">Profit</td></tr>`;
const row = (cells: string[]) => `<tr bgcolor="#FFFFFF" align="right">${cells.map((c, i) => (i === 4 ? `<td class="hidden" colspan="8">${c}</td>` : `<td>${c}</td>`)).join("")}</tr>`;
const TAIL = `<tr><th colspan="14"><div><b>Orders</b></div></th></tr><tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td><td>9</td></tr></table></body></html>`;

describe("MT5 History Report", () => {
  const html =
    HEAD +
    row(["2026.06.01 20:34:50", "51000114", "AUDUSD", "buy", "x", "1.50", "0.66242", "0.66075", "0.66576", "2026.06.01 21:48:37", "0.66377", "-10.50", "0.00", "203.09"]) +
    row(["2026.06.02 15:19:39", "", "USDJPY", "sell", "", "0.01", "152.100", "152.400", "", "2026.06.02 15:50:43", "151.800", "-0.07", "0.10", "1&nbsp;234.50"]) +
    row(["2026.06.02 15:19:39", "7", "EURUSD", "balance", "", "0.01", "1", "", "", "2026.06.02 15:50:43", "1", "0", "0", "1"]) +
    row(["bad", "8", "EURUSD", "buy", "", "0.01", "1", "", "", "2026.06.02 15:50:43", "1", "0", "0", "1"]) +
    row(["2026.06.02 15:19:39", "9", "", "buy", "", "0.01", "1", "", "", "2026.06.02 15:50:43", "1", "0", "0", "1"]) +
    row(["2026.06.02 15:19:39", "10", "EURUSD", "buy", "", "abc", "1", "", "", "2026.06.02 15:50:43", "1", "0", "0", "1"]) +
    row(["2026.06.02 15:19:39", "11", "EURUSD", "buy", "", "0.01", "x", "", "", "2026.06.02 15:50:43", "1", "0", "0", "1"]) +
    TAIL;

  it("reads positions: P&L = profit + commission + swap, server time as UTC, position id as ticket", () => {
    expect(looksLikeMt5Report(html)).toBe(true);
    const r = imp(utf16(html, true), "dojix");
    expect(r.format).toBe("mt5_report");
    expect(r.trades[0]).toMatchObject({
      ticket: "51000114", externalId: "51000114", symbol: "AUDUSD", direction: "BUY", quantity: 1.5, openPrice: "0.66242", sl: "0.66075", tp: "0.66576",
      closePrice: "0.66377", netProfit: "192.59", commission: "0", openTime: "2026-06-01 20:34:50.000", closeTime: "2026-06-01 21:48:37.000",
      session: "NY", hour: 20, dayOfWeek: "Mon", durationMin: 73, mae: null, mfe: null, source: "mt5_report", slDist: 16.7,
    });
    expect(r.trades[1]).toMatchObject({ direction: "SELL", netProfit: "1234.53", symbol: "USDJPY", slDist: 30, externalId: null });
    expect(BigInt(r.trades[1]!.ticket) >= 8_000_000_000_000_000_000n).toBe(true);
    expect(r.issues.map((i) => i.code)).toEqual(["invalid_direction", "invalid_date", "missing_symbol", "invalid_quantity", "invalid_price"]);
  });

  it("refuses a report without a Positions table", () => {
    expect(() => parseMt5Report("<html><table><tr><td>x</td></tr></table></html>", ctx)).toThrowError(ImportError);
    expect(() => parseMt5Report("<html><table><tr><th>Positions</th></tr><tr><td>Nope</td></tr></table></html>", ctx)).toThrowError(/column header/);
  });

  it("scans tables linearly and decodes entities", () => {
    expect(htmlTableRows("<TR><TD>a &amp; b &#65;&#x42; &bogus; &#0;</TD><td>x<tr><td>y")).toEqual([
      [{ text: "a & b AB &bogus; &#0;", isHeader: false }, { text: "x", isHeader: false }],
      [{ text: "y", isHeader: false }],
    ]);
    expect(htmlTableRows("<tr><td")).toEqual([[]]);
    expect(htmlTableRows("<track><trx>")).toEqual([]);
  });
});

describe("OANDA v20 mapping (OANDAService.swift)", () => {
  const open = { id: "12345", type: "ORDER_FILL", time: "2025-03-15T10:30:00.000000000Z", instrument: "EUR_USD", units: "100000", price: "1.08542", tradeOpened: { tradeID: "12345" } };
  const close = { id: "12350", type: "ORDER_FILL", time: "2025-03-15T12:00:00.000000000Z", instrument: "EUR_USD", units: "-100000", price: "1.08650", tradesClosed: [{ tradeID: "12345", realizedPL: "108.00" }] };

  it("testTransactionDecode*: decodes pages the way JSONDecoder does", () => {
    const page = decodeOandaPage({ transactions: [open, close, {}] });
    expect(page?.[0]).toMatchObject({ id: "12345", tradeOpened: { tradeID: "12345" } });
    expect(page?.[1]?.tradesClosed).toEqual([{ tradeID: "12345", realizedPL: "108.00" }]);
    expect(page?.[2]).toEqual({});
    expect(decodeOandaPage({ transactions: [{ id: 5 }] })).toBeNull();
    expect(decodeOandaPage({ transactions: [{ tradeOpened: {} }] })).toBeNull();
    expect(decodeOandaPage({ transactions: [{ tradesClosed: {} }] })).toBeNull();
    expect(decodeOandaPage({ transactions: [{ tradesClosed: [{ tradeID: "1", realizedPL: 3 }] }] })).toBeNull();
    expect(decodeOandaPage({ transactions: [{ tradesClosed: [null] }] })).toBeNull();
    expect(decodeOandaPage({ transactions: [3] })).toBeNull();
    expect(decodeOandaPage({})).toBeNull();
    expect(decodeOandaPage(null)).toBeNull();
    expect(decodeOandaPage({ transactions: [{ tradesClosed: [{ tradeID: "556", realizedPL: null }], tradeOpened: null }] })?.[0]).toEqual({ tradesClosed: [{ tradeID: "556" }] });
  });

  it("pairs opening and closing fills into trades", () => {
    const { rows, issues } = mapOandaTransactions(decodeOandaPage({ transactions: [open, close] }) ?? [], ctx);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(1);
    const t = rows[0]!.trade;
    expect(t).toMatchObject({ ticket: 12345n, symbol: "EURUSD", direction: "BUY", lots: 1, durationMin: 90, comment: "OANDA", session: "LONDON", hour: 10, dayOfWeek: "Sat" });
    expect(t.netProfit.toString()).toBe("108");
    expect(rows[0]?.meta.source).toBe("oanda_api");
  });

  it("closes unknown trades with nothing, and handles missing times per mode", () => {
    expect(mapOandaTransactions([close], ctx).rows).toEqual([]);
    const noTime = [{ ...open, time: undefined }, close].map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)));
    expect(mapOandaTransactions(noTime, ctx).issues[0]?.code).toBe("invalid_date");
    const swift = mapOandaTransactions(noTime, { ...ctx, compat: "swift" }).rows[0]!.trade;
    expect(swift.openTime).toBe(NOW);
    const oddId = [{ ...open, tradeOpened: { tradeID: "x" } }, { ...close, tradesClosed: [{ tradeID: "x" }] }];
    const fallback = mapOandaTransactions(oddId, ctx).rows[0]!.trade;
    expect(fallback.ticket).toBe(BigInt(Math.trunc(NOW / 1000)));
    expect(fallback.netProfit.toString()).toBe("0");
    const sell = [{ ...open, units: "-5000" }, { ...close, instrument: undefined }].map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)));
    expect(mapOandaTransactions(sell, ctx).rows[0]!.trade).toMatchObject({ direction: "SELL", lots: 0.05, symbol: "EURUSD" });
    const bare = [{ tradeOpened: { tradeID: "1" }, time: open.time }, { tradesClosed: [{ tradeID: "1" }], time: close.time }];
    expect(mapOandaTransactions(bare, ctx).rows[0]!.trade).toMatchObject({ symbol: "", lots: 0, direction: "SELL" });
  });

  it("testOnlyHTTPSOandaHostsAreTrusted / testAccountIDValidation", () => {
    expect(isTrustedOandaUrl("https://api-fxpractice.oanda.com/v3/accounts/1/transactions")).toBe(true);
    expect(isTrustedOandaUrl("https://oanda.com/x")).toBe(true);
    for (const u of ["https://evil-oanda.com/x", "https://eviloanda.com/x", "https://oanda.com.evil.net/x", "http://api-fxpractice.oanda.com/x", "not a url"]) {
      expect(isTrustedOandaUrl(u), u).toBe(false);
    }
    expect(isValidOandaAccountId("101-004-1234567-001")).toBe(true);
    for (const id of ["", "../../v3/users", "1?x=y", "1/summary#", "a".repeat(65)]) expect(isValidOandaAccountId(id), id).toBe(false);
  });
});
