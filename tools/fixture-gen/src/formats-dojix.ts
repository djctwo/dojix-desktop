// Writers for every file format Dojix (forex) reads, plus the two desktop-only formats.
// Column layouts follow the Mac parser's header signatures (GenericCSVParser / CSVParser).
import { type FxTrade, isJpy } from "./fx.ts";
import { row } from "./encode.ts";
import { fmt, iso, partsUTC } from "./time.ts";

export const SA32_HEADER =
  "Ticket,Symbol,Direction,Lots,OpenTime,CloseTime,DurationMin,OpenPrice,ClosePrice,SL,TP,NetProfit,MAE_Pips,MFE_Pips,RMultiple,Session,DayOfWeek,Hour,RangeSize,SweepDepth,UsedFVG,VolRegime,HitBreakeven,ScaledIn,Magic,Comment,TimeToMFE_Min,SLDist_Pips,Slippage_Pips,PostClose15m,PostClose30m,BiasAtEntry";

const yn = (b: boolean): string => (b ? "YES" : "NO");
const saTime = (t: number): string => fmt(partsUTC(t), "yyyy.MM.dd HH:mm:ss");

/** The 32 fields of one trade, as strings, in file order. */
export function sa32Fields(t: FxTrade): string[] {
  return [
    t.ticket, t.symbol, t.direction, String(t.lots), saTime(t.openTime), saTime(t.closeTime),
    String(t.durationMin), t.openPrice, t.closePrice, t.sl, t.tp, t.netProfit, String(t.maePips),
    String(t.mfePips), String(t.rMultiple), t.session, t.dayOfWeek, String(t.hour), String(t.rangeSize),
    String(t.sweepDepth), yn(t.usedFVG), t.volRegime, yn(t.hitBreakeven), yn(t.scaledIn), String(t.magic),
    t.comment, String(t.timeToMFEMin), String(t.slDistPips), String(t.slippagePips), String(t.postClose15m),
    String(t.postClose30m), t.biasAtEntry,
  ];
}

export interface Sa32Options {
  /** Lines written before the trade header (multi-section exports) */
  preamble?: readonly string[];
  /** Lines written after a blank line following the trades */
  postamble?: readonly string[];
  /** Raw lines to append inside the trade section (hand-made edge rows) */
  extraRows?: readonly string[];
  /** Keep only the first N columns of every trade row (26–31 = older layouts) */
  columns?: number;
}

/** 32-column MT5 analysis export, trade-detail section (times are broker time read as UTC). */
export function sa32(trades: readonly FxTrade[], opts: Sa32Options = {}): string {
  const lines: string[] = [];
  if (opts.preamble) lines.push(...opts.preamble);
  lines.push(SA32_HEADER);
  // The Mac reads trades in file order; the exporter writes newest last.
  for (const t of trades) {
    const f = sa32Fields(t);
    lines.push(row(opts.columns ? f.slice(0, opts.columns) : f));
  }
  if (opts.extraRows) lines.push(...opts.extraRows);
  if (opts.postamble) lines.push("", ...opts.postamble);
  return lines.join("\n") + "\n";
}

/** DojixExport.mq5 output (SPEC §5.3): the 32 columns + Account, Commission, Swap, TimeBasis, ServerUTCOffset. */
export function dojixExport(trades: readonly FxTrade[], account = "00000000"): string {
  const lines = [`${SA32_HEADER},Account,Commission,Swap,TimeBasis,ServerUTCOffset`];
  for (const t of trades) {
    const f = sa32Fields(t);
    // Strategy-specific fields are left empty (→ NULL on the desktop).
    for (const i of [18, 19, 20, 21, 31]) f[i] = "";
    lines.push(row([...f, account, t.commission, t.swap, "UTC", "7200"]));
  }
  return lines.join("\r\n") + "\r\n";
}

/** MetaTrader 4 detailed statement (ticket,type,item,profit signature). */
export function mt4(trades: readonly FxTrade[], extraRows: readonly string[] = []): string {
  const lines = ["Ticket,Open Time,Type,Size,Item,Price,S/L,T/P,Close Time,Price,Commission,Taxes,Swap,Profit"];
  for (const t of trades) {
    const p = (x: number): string => fmt(partsUTC(x), "yyyy.MM.dd HH:mm:ss");
    // MT4's Profit excludes commission and swap; the Mac adds them back in.
    lines.push(row([t.ticket, p(t.openTime), t.direction.toLowerCase(), t.lots, t.symbol.toLowerCase(), t.openPrice,
      t.sl, t.tp, p(t.closeTime), t.closePrice, t.commission === "0" ? "0.00" : `-${t.commission}`, "0.00",
      t.swap, t.netProfit]));
  }
  lines.push(...extraRows);
  return lines.join("\n") + "\n";
}

/** cTrader history (volume in units, as cTrader exports it). */
export function ctrader(trades: readonly FxTrade[], variant: "spaced" | "compact" = "spaced"): string {
  const header = variant === "spaced"
    ? "Position ID,Symbol,Direction,Volume,Entry Time,Entry Price,Close Time,Close Price,Stop Loss,Take Profit,Commission,Swap,Net Profit"
    : "PositionId,Symbol,Direction,Volume,EntryTime,EntryPrice,CloseTime,ClosePrice,StopLoss,TakeProfit,Commission,Swap,NetProfit";
  const lines = [header];
  const time = (x: number): string => fmt(partsUTC(x), "yyyy-MM-dd HH:mm:ss");
  for (const t of trades) {
    lines.push(row([t.ticket, `${t.symbol.slice(0, 3)}/${t.symbol.slice(3)}`, t.direction === "BUY" ? "Buy" : "Sell",
      String(Math.round(t.lots * 100000)), time(t.openTime), t.openPrice, time(t.closeTime), t.closePrice, t.sl, t.tp,
      t.commission === "0" ? "0" : `-${t.commission}`, t.swap, t.netProfit]));
  }
  return lines.join("\n") + "\n";
}

/** TradingView strategy "List of trades": an Exit row and an Entry row per trade, newest first. */
export function tradingView(trades: readonly FxTrade[], symbolColumn = true): string {
  const header = ["Trade #", "Type", "Signal", "Date/Time", "Price", "Contracts", "Profit", "Profit %",
    "Run-up", "Drawdown", "Cumulative profit"];
  if (symbolColumn) header.splice(1, 0, "Symbol");
  const lines = [header.join(",")];
  let cumulative = 0;
  const tvTime = (x: number): string => `${fmt(partsUTC(x), "yyyy-MM-dd")}T${fmt(partsUTC(x), "HH:mm:ss")}+0000`;
  const rows: string[][] = [];
  trades.forEach((t, i) => {
    cumulative += Number(t.netProfit);
    const side = t.direction === "BUY" ? "Long" : "Short";
    const common = (type: string, time: number, price: string): string[] => {
      const f = [String(i + 1), `${type} ${side}`, type === "Entry" ? side : "Close", tvTime(time), price, String(t.lots),
        t.netProfit, "0.12", String(t.mfePips), String(-t.maePips), cumulative.toFixed(2)];
      if (symbolColumn) f.splice(1, 0, t.symbol);
      return f;
    };
    rows.push(common("Exit", t.closeTime, t.closePrice));
    rows.push(common("Entry", t.openTime, t.openPrice));
  });
  for (const r of rows.reverse()) lines.push(row(r));
  return lines.join("\n") + "\n";
}

/** OANDA account statement (units, ISO times without zone). */
export function oanda(trades: readonly FxTrade[]): string {
  const lines = ["Transaction ID,Type,Instrument,Units,Open Time,Close Time,Open Price,Close Price,P/L,Commission,Financing"];
  const time = (x: number): string => `${fmt(partsUTC(x), "yyyy-MM-dd")}T${fmt(partsUTC(x), "HH:mm:ss")}`;
  for (const t of trades) {
    const units = Math.round(t.lots * 100000) * (t.direction === "BUY" ? 1 : -1);
    lines.push(row([t.ticket, t.direction === "BUY" ? "Buy Market" : "Sell Market",
      `${t.symbol.slice(0, 3)}_${t.symbol.slice(3)}`, String(units), time(t.openTime), time(t.closeTime), t.openPrice,
      t.closePrice, t.netProfit, "0", t.swap]));
  }
  return lines.join("\n") + "\n";
}

/** Interactive Brokers trade report (one row per closed trade; "Date/Time" holds a comma). */
export function ibkr(trades: readonly FxTrade[]): string {
  const lines = ["TradeID,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Realized P/L,Buy/Sell"];
  for (const t of trades) {
    const time = fmt(partsUTC(t.openTime), "yyyy-MM-dd, HH:mm:ss");
    lines.push(row([t.ticket, `${t.symbol.slice(0, 3)}.${t.symbol.slice(3)}`, time, String(Math.round(t.lots * 100000)),
      t.openPrice, t.closePrice, "0", t.commission === "0" ? "0" : `-${t.commission}`, t.netProfit,
      t.direction === "BUY" ? "BUY" : "SELL"]));
  }
  return lines.join("\n") + "\n";
}

/** thinkorswim account statement trade history. */
export function tos(trades: readonly FxTrade[]): string {
  const lines = ["Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Price,Net Price,Order Type,P/L,Commission"];
  for (const t of trades) {
    lines.push(row([fmt(partsUTC(t.openTime), "MM/dd/yy HH:mm:ss"), "FOREX", t.direction, String(Math.round(t.lots * 100000)),
      "TO CLOSE", `/${t.symbol}`, t.openPrice, t.closePrice, "MKT", t.netProfit, t.commission]));
  }
  return lines.join("\n") + "\n";
}

/** NinjaTrader trade performance export ("Trade #" restarts at 1). */
export function ninjaTrader(trades: readonly FxTrade[]): string {
  const lines = ["Trade #,Instrument,Account,Strategy,Market pos.,Market position,Quantity,Entry price,Exit price,Entry time,Exit time,Profit,Commission,MAE,MFE"];
  const time = (x: number): string => fmt(partsUTC(x), "MM/dd/yyyy HH:mm:ss");
  trades.forEach((t, i) => {
    lines.push(row([String(i + 1), `6${t.symbol.slice(0, 1)} 12-26`, "Sim101", "Fictional", "", t.direction === "BUY" ? "Long" : "Short",
      String(t.lots), t.openPrice, t.closePrice, time(t.openTime), time(t.closeTime), t.netProfit, t.commission,
      String(t.maePips), String(t.mfePips)]));
  });
  return lines.join("\n") + "\n";
}

/** A CSV the Mac does not recognise (it shows the column-mapping sheet). */
export function genericUnknown(trades: readonly FxTrade[]): string {
  const lines = ["Pair,Side,Size,Opened,Closed,Entry,Exit,Result"];
  for (const t of trades) {
    lines.push(row([t.symbol, t.direction, String(t.lots), iso(t.openTime), iso(t.closeTime), t.openPrice,
      t.closePrice, t.netProfit]));
  }
  return lines.join("\n") + "\n";
}

/**
 * MT5 "Account History" report (ReportHistory-<login>.html), Positions section only, in the
 * layout the terminal writes. Encoded UTF-16LE by the caller. Times are server time.
 */
export function mt5ReportHtml(trades: readonly FxTrade[], login = "00000000"): string {
  const time = (x: number): string => fmt(partsUTC(x), "yyyy.MM.dd HH:mm:ss");
  const cell = (s: string, extra = ""): string => `<td${extra}>${s}</td>`;
  const rows = trades.map((t, i) => {
    const bg = i % 2 ? ' bgcolor="#F7F7F7"' : ' bgcolor="#FFFFFF"';
    return `<tr${bg} align="right">${cell(time(t.openTime))}${cell(t.ticket)}${cell(t.symbol)}${cell(t.direction.toLowerCase())}` +
      `${cell(t.lots.toFixed(2))}${cell(t.openPrice)}${cell(t.sl)}${cell(t.tp)}${cell(time(t.closeTime))}${cell(t.closePrice)}` +
      `${cell(t.commission === "0" ? "0.00" : `-${t.commission}`)}${cell(t.swap === "0" ? "0.00" : t.swap)}${cell(t.netProfit, ' colspan="2"')}</tr>`;
  });
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head><title>Trade History Report (fictional)</title><meta charset=\"utf-16\"></head>",
    "<body>",
    '<table cellspacing="1" cellpadding="3" border="0">',
    `<tr align="left"><th colspan="14"><div style="font: 14pt Tahoma"><b>Trade History Report</b></div></th></tr>`,
    `<tr align="left"><th colspan="4">Name:</th><th colspan="10"><b>Fictional Demo</b></th></tr>`,
    `<tr align="left"><th colspan="4">Account:</th><th colspan="10"><b>${login} (USD, Fictional-Demo, demo, Hedge)</b></th></tr>`,
    `<tr align="left"><th colspan="4">Broker:</th><th colspan="10"><b>Fictional Broker Ltd.</b></th></tr>`,
    '<tr><th colspan="14" style="height: 25px"><div style="font: 10pt Tahoma"><b>Positions</b></div></th></tr>',
    '<tr bgcolor="#E5F0FC" align="center"><td>Time</td><td>Position</td><td>Symbol</td><td>Type</td><td>Volume</td><td>Price</td><td>S / L</td><td>T / P</td><td>Time</td><td>Price</td><td>Commission</td><td>Swap</td><td colspan="2">Profit</td></tr>',
    ...rows,
    '<tr><th colspan="14" style="height: 25px"><div style="font: 10pt Tahoma"><b>Orders</b></div></th></tr>',
    "</table>",
    "</body>",
    "</html>",
  ].join("\r\n") + "\r\n";
}

export { isJpy };
