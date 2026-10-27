// Writers for every file format Greenwick (stocks) reads. Times are US Eastern wall clock,
// which is how the brokers export them and how the Mac parser reads them.
import type { StTrade, Txn } from "./st.ts";
import { row } from "./encode.ts";
import { etOffset, fmt, partsET } from "./time.ts";

const etf = (t: number, pattern: string): string => fmt(partsET(t), pattern);
const neg = (amount: string): string => (amount === "0" || amount === "0.00" ? "0" : `-${amount}`);

/** Gross P&L (before costs) of a stored net trade, as the matched-trade formats report it. */
function gross(t: StTrade): string {
  const c = Math.round(Number(t.netProfit) * 100) + Math.round(Number(t.commission) * 100);
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

export function ibkr(trades: readonly StTrade[]): string {
  const lines = ["TradeID,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Realized P/L,Buy/Sell"];
  for (const t of trades) {
    lines.push(row([t.ticket, t.symbol, etf(t.openTime, "yyyy-MM-dd, HH:mm:ss"),
      String(t.direction === "BUY" ? t.shares : -t.shares), t.openPrice, t.closePrice, "0", neg(t.commission), gross(t),
      t.direction]));
  }
  return lines.join("\n") + "\n";
}

export function tos(trades: readonly StTrade[]): string {
  const lines = ["Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type,P/L,Commission"];
  for (const t of trades) {
    lines.push(row([etf(t.openTime, "MM/dd/yy HH:mm:ss"), "STOCK", t.direction, String(t.shares), "TO OPEN", t.symbol,
      "", "", "STOCK", t.openPrice, t.closePrice, "MKT", gross(t), t.commission]));
  }
  return lines.join("\n") + "\n";
}

/** TradingView "List of trades": Exit and Entry rows per trade, newest first. */
export function tradingView(trades: readonly StTrade[]): string {
  const lines = ["Trade #,Type,Signal,Date/Time,Price,Contracts,Profit,Profit %,Run-up,Drawdown,Cumulative profit"];
  const time = (x: number): string => `${etf(x, "yyyy-MM-dd")}T${etf(x, "HH:mm:ss")}${etOffset(x)}`;
  const rows: string[][] = [];
  let cumulative = 0;
  trades.forEach((t, i) => {
    cumulative += Number(t.netProfit);
    const side = t.direction === "BUY" ? "Long" : "Short";
    rows.push([String(i + 1), `Exit ${side}`, "Close", time(t.closeTime), t.closePrice, String(t.shares), t.netProfit, "0.5",
      String(t.mfePoints), String(-t.maePoints), cumulative.toFixed(2)]);
    rows.push([String(i + 1), `Entry ${side}`, side, time(t.openTime), t.openPrice, String(t.shares), t.netProfit, "0.5",
      String(t.mfePoints), String(-t.maePoints), cumulative.toFixed(2)]);
  });
  for (const r of rows.reverse()) lines.push(row(r));
  return lines.join("\n") + "\n";
}

export function ninjaTrader(trades: readonly StTrade[], extraRows: readonly string[] = []): string {
  const lines = ["Trade #,Instrument,Account,Strategy,Market position,Quantity,Entry price,Exit price,Entry time,Exit time,Profit,Commission,MAE,MFE"];
  trades.forEach((t, i) => {
    lines.push(row([String(i + 1), t.symbol, "Sim101", "Fictional", t.direction === "BUY" ? "Long" : "Short",
      String(t.shares), t.openPrice, t.closePrice, etf(t.openTime, "MM/dd/yyyy HH:mm:ss"),
      etf(t.closeTime, "MM/dd/yyyy HH:mm:ss"), gross(t), t.commission, String(t.maePoints), String(t.mfePoints)]));
  });
  lines.push(...extraRows);
  return lines.join("\n") + "\n";
}

export function webull(trades: readonly StTrade[], withPnl: boolean, extraRows: readonly string[] = []): string {
  const header = ["Name", "Symbol", "Side", "Status", "Filled Qty", "Total Qty", "Price", "Avg Price", "Time-in-Force",
    "Placed Time", "Filled Time"];
  if (withPnl) header.push("Realized P&L", "Commission");
  const lines = [header.join(",")];
  trades.forEach((t, i) => {
    const f = [`Fictional Co ${i + 1}`, t.symbol, t.direction === "BUY" ? "Buy" : "Sell", "Filled", String(t.shares),
      String(t.shares), `@${t.openPrice}`, t.openPrice, "DAY", etf(t.openTime, "MM/dd/yyyy HH:mm:ss"),
      etf(t.openTime, "MM/dd/yyyy HH:mm:ss")];
    if (withPnl) f.push(gross(t), t.commission);
    lines.push(row(f));
  });
  lines.push(...extraRows);
  return lines.join("\n") + "\n";
}

export function genericUnknown(trades: readonly StTrade[]): string {
  const lines = ["Ticker,Side,Shares,Opened,Closed,Entry,Exit,Result"];
  for (const t of trades) {
    lines.push(row([t.symbol, t.direction, String(t.shares), etf(t.openTime, "yyyy-MM-dd HH:mm:ss"),
      etf(t.closeTime, "yyyy-MM-dd HH:mm:ss"), t.openPrice, t.closePrice, t.netProfit]));
  }
  return lines.join("\n") + "\n";
}

// ---- Transaction (FIFO) formats ----

const amount = (x: Txn): number => Number(x.price) * x.shares * (x.side === "BUY" ? -1 : 1);

export function robinhood(txns: readonly Txn[], withFees: boolean): string {
  const header = ["Activity Date", "Process Date", "Settle Date", "Instrument", "Description", "Trans Code", "Quantity",
    "Price", "Amount"];
  if (withFees) header.push("Fees");
  const lines = [header.map((h) => `"${h}"`).join(",")];
  for (const x of txns) {
    const d = etf(x.time, "M/d/yyyy");
    const amt = amount(x);
    const f = [d, d, d, x.symbol, x.description ?? "Fictional Holdings Inc", x.action ?? (x.side === "BUY" ? "Buy" : "Sell"),
      String(x.shares), `$${x.price}`, amt < 0 ? `($${(-amt).toFixed(2)})` : `$${amt.toFixed(2)}`];
    if (withFees) f.push(x.fees);
    lines.push(f.map((v) => `"${v}"`).join(","));
  }
  lines.push("", '"","","","","The data provided is for informational purposes only (fictional).","","","",""');
  return lines.join("\n") + "\n";
}

export interface SchwabOptions {
  /** Metadata line above the header (the usual layout) */
  metadata?: boolean;
  /** "Transactions Total" footer line */
  footer?: boolean;
}

export function schwab(txns: readonly Txn[], opts: SchwabOptions = { metadata: true, footer: true }): string {
  const lines: string[] = [];
  if (opts.metadata) lines.push('"Transactions  for account ...0000 as of 10/01/2026 (fictional)"');
  lines.push('"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount",');
  for (const x of txns) {
    const action = x.action ?? (x.side === "BUY" ? "Buy" : "Sell");
    const fee = Number(x.commission) + Number(x.fees);
    const amt = amount(x) - fee;
    lines.push([etf(x.time, "MM/dd/yyyy"), action, x.symbol, x.description ?? "FICTIONAL HOLDINGS INC", String(x.shares),
      `$${x.price}`, fee ? `$${fee.toFixed(2)}` : "", amt < 0 ? `-$${(-amt).toFixed(2)}` : `$${amt.toFixed(2)}`]
      .map((v) => `"${v}"`).join(",") + ",");
  }
  if (opts.footer) lines.push('"Transactions Total","","","","","","","$0.00",');
  return lines.join("\n") + "\n";
}

export function fidelity(txns: readonly Txn[], withPrice = true): string {
  const lines = ["", "Brokerage", ""];
  const header = ["Run Date", "Action", "Symbol", "Security Description", "Security Type", "Quantity", "Price ($)",
    "Commission ($)", "Fees ($)", "Accrued Interest ($)", "Amount ($)", "Settlement Date"];
  if (!withPrice) header.splice(6, 1);
  lines.push(header.join(","));
  for (const x of txns) {
    const verb = x.action ?? (x.side === "BUY" ? "YOU BOUGHT" : "YOU SOLD");
    const f = [etf(x.time, "MM/dd/yyyy"), `${verb} FICTIONAL HOLDINGS INC (${x.symbol}) (Cash)`, x.symbol,
      "FICTIONAL HOLDINGS INC", "Cash", String(x.side === "BUY" ? x.shares : -x.shares), x.price, x.commission, x.fees, "",
      amount(x).toFixed(2), etf(x.time + 2 * 86400, "MM/dd/yyyy")];
    if (!withPrice) f.splice(6, 1);
    lines.push(row(f));
  }
  lines.push("", "", '"The data and information in this spreadsheet is provided to you solely for your use (fictional)."',
    '"Fidelity footer line (fictional, for the parser test)."');
  return lines.join("\n") + "\n";
}

export function etrade(txns: readonly Txn[]): string {
  const lines = ["TransactionDate,TransactionType,SecurityType,Symbol,Quantity,Amount,Price,Commission,Description"];
  for (const x of txns) {
    lines.push(row([etf(x.time, "MM/dd/yy"), x.action ?? (x.side === "BUY" ? "Bought" : "Sold"), "EQ", x.symbol,
      String(x.side === "BUY" ? x.shares : -x.shares), amount(x).toFixed(2), x.price, x.commission,
      x.description ?? "FICTIONAL HOLDINGS INC"]));
  }
  return lines.join("\n") + "\n";
}

export function tastytrade(txns: readonly Txn[]): string {
  const lines = ["Date,Type,Action,Symbol,Instrument Type,Description,Value,Quantity,Average Price,Commissions,Fees,Multiplier,Root Symbol,Underlying Symbol,Expiration Date,Strike Price,Call or Put,Order #"];
  for (const x of txns) {
    const p = new Date(x.time * 1000);
    const isoZ = `${p.toISOString().slice(0, 19)}+0000`;
    lines.push(row([isoZ, "Trade", x.action ?? (x.side === "BUY" ? "BUY_TO_OPEN" : "SELL_TO_CLOSE"), x.symbol, "Equity",
      x.description ?? `Fictional fill ${x.shares} @ ${x.price}`, amount(x).toFixed(2), String(x.shares), x.price,
      x.commission === "0" ? "0" : `-${x.commission}`, x.fees === "0" ? "0" : `-${x.fees}`, "1", "", x.symbol, "", "", "",
      "0"]));
  }
  return lines.join("\n") + "\n";
}
