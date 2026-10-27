import { describe, expect, it } from "vitest";
import { fxTrade, stTrade } from "../test-support/trades";
import {
  baseCurrency,
  commissionDouble,
  exitEfficiency,
  grossProfitBeforeCostsDouble,
  isBreakeven,
  isLoss,
  isWin,
  maeOf,
  mfeOf,
  moneyLeftOnTable,
  netProfitAfterCostsDouble,
  pairDisplay,
  profitDouble,
  quantity,
  quoteCurrency,
  sessionRaw,
  slDist,
  slippage,
  swapDouble,
  totalCosts,
  tradeEmotion,
} from "./accessors";
import {
  compareRawValue,
  isBiasAlignment,
  isMarketSession,
  isTradingSession,
  isVolatilityRegime,
  MARKET_SESSION_INFO,
  parseTradeEmotion,
  TRADE_EMOTIONS,
  TRADING_SESSION_INFO,
  TRADING_SESSIONS,
} from "./enums";
import { toEngineTrade, type StoredTrade } from "./stored";
import { isDojixTrade, isGreenwickTrade } from "./trade";

describe("enums", () => {
  it("keeps the Mac raw values, display names and windows", () => {
    expect(TRADING_SESSIONS).toEqual(["ASIAN", "LONDON", "NY_OVERLAP", "NY", "LATE"]);
    expect(TRADING_SESSION_INFO.NY.displayName).toBe("New York");
    expect(TRADING_SESSION_INFO.LONDON.related).toEqual(["LONDON", "NY_OVERLAP"]);
    expect(TRADING_SESSION_INFO.NY.startHourUTC).toBe(12);
    expect(MARKET_SESSION_INFO.AFTER_HOURS.displayName).toBe("After Hours");
    expect(MARKET_SESSION_INFO.EXTENDED.related).toEqual(["EXTENDED", "PRE_MARKET", "AFTER_HOURS"]);
    expect(TRADE_EMOTIONS.FOMO).toBe("FOMO");
  });

  it("sorts sessions by raw value, as Swift's Comparable does", () => {
    expect([...TRADING_SESSIONS].sort(compareRawValue)).toEqual(["ASIAN", "LATE", "LONDON", "NY", "NY_OVERLAP"]);
    expect(compareRawValue("A", "A")).toBe(0);
  });

  it("guards", () => {
    expect(isTradingSession("NY")).toBe(true);
    expect(isTradingSession("ny")).toBe(false);
    expect(isMarketSession("REGULAR")).toBe(true);
    expect(isMarketSession(3)).toBe(false);
    expect(isVolatilityRegime("HIGH")).toBe(true);
    expect(isBiasAlignment("WITH")).toBe(true);
    expect(parseTradeEmotion("CALM")).toBe("CALM");
    expect(parseTradeEmotion("toString")).toBeNull();
    expect(parseTradeEmotion("")).toBeNull();
    expect(parseTradeEmotion(null)).toBeNull();
  });
});

describe("accessors", () => {
  it("classifies wins, losses and breakevens in Decimal", () => {
    expect(isWin(fxTrade({ netProfit: "0.01" }))).toBe(true);
    expect(isLoss(fxTrade({ netProfit: "-0.01" }))).toBe(true);
    expect(isBreakeven(fxTrade({ netProfit: "-0.00" }))).toBe(true);
    expect(isWin(fxTrade({ netProfit: "garbage" }))).toBe(false);
    expect(profitDouble(fxTrade({ netProfit: "garbage" }))).toBeNaN();
  });

  it("caches per trade object", () => {
    const t = fxTrade({ netProfit: "12.5" });
    expect(profitDouble(t)).toBe(12.5);
    expect(profitDouble(t)).toBe(12.5);
  });

  it("costs per brand", () => {
    const fx = fxTrade({ netProfit: "100", commission: "7", swap: "-0.07" });
    expect(commissionDouble(fx)).toBe(7);
    expect(swapDouble(fx)).toBe(-0.06999999999999999);
    expect(totalCosts(fx)).toBe(7 + -0.06999999999999999);
    // Decimal 93.07 exactly, then Foundation's 9307 / 10 / 10 — not the nearest double 93.07.
    expect(netProfitAfterCostsDouble(fx)).toBe(93.07000000000001);
    expect(netProfitAfterCostsDouble(fxTrade({ swap: "x" }))).toBeNaN();
    const st = stTrade({ netProfit: "95", commission: "5", swap: "0" });
    expect(grossProfitBeforeCostsDouble(st)).toBe(100);
    expect(grossProfitBeforeCostsDouble(stTrade({ commission: "x" }))).toBeNaN();
  });

  it("brand-neutral fields", () => {
    const fx = fxTrade({ lots: 0.5, slDistPips: 20, slippagePips: 1.5 });
    const st = stTrade({ shares: 200, slDistPoints: 0.4, slippagePoints: 0.02 });
    expect([quantity(fx), quantity(st)]).toEqual([0.5, 200]);
    expect([slDist(fx), slDist(st)]).toEqual([20, 0.4]);
    expect([slippage(fx), slippage(st)]).toEqual([1.5, 0.02]);
    expect([sessionRaw(fx), sessionRaw(st)]).toEqual(["LONDON", "REGULAR"]);
    expect(isDojixTrade(fx) && isGreenwickTrade(st)).toBe(true);
    expect(isDojixTrade(st)).toBe(false);
  });

  it("reads unknown MAE/MFE as 0 only in swift compat (D-18)", () => {
    const t = fxTrade({ maePips: null, mfePips: null });
    expect(maeOf(t, "swift")).toBe(0);
    expect(mfeOf(t, "swift")).toBe(0);
    expect(maeOf(t, "fixed")).toBeNull();
    expect(mfeOf(stTrade({ mfePoints: 3 }), "fixed")).toBe(3);
  });

  it("exit efficiency and money left (Trade.swift:302-313)", () => {
    const win = fxTrade({ netProfit: "10", rMultiple: 1, slDistPips: 20, mfePips: 40 });
    expect(exitEfficiency(win, "fixed")).toBe(50);
    expect(moneyLeftOnTable(win, "fixed")).toBe(20);
    const loser = fxTrade({ netProfit: "-10", rMultiple: -1, slDistPips: 20, mfePips: 40 });
    expect(exitEfficiency(loser, "fixed")).toBe(0); // clamped
    expect(moneyLeftOnTable(loser, "fixed")).toBeNull(); // wins only
    const over = fxTrade({ netProfit: "10", rMultiple: 5, slDistPips: 20, mfePips: 40 });
    expect(exitEfficiency(over, "fixed")).toBe(100);
    expect(moneyLeftOnTable(over, "fixed")).toBe(0);
    expect(exitEfficiency(fxTrade({ mfePips: null }), "swift")).toBeNull();
    expect(exitEfficiency(fxTrade({ slDistPips: 0 }), "swift")).toBeNull();
    expect(moneyLeftOnTable(fxTrade({ netProfit: "5", mfePips: null }), "fixed")).toBeNull();
  });

  it("currency pair parts and emotion", () => {
    const t = fxTrade({ symbol: "EURJPY", emotion: "REVENGE" });
    expect([baseCurrency(t), quoteCurrency(t), pairDisplay(t)]).toEqual(["EUR", "JPY", "EUR/JPY"]);
    expect(tradeEmotion(t)).toBe("REVENGE");
    expect(tradeEmotion(fxTrade({ emotion: "HAPPY" }))).toBeNull();
  });
});

const row = (over: Partial<StoredTrade> = {}): StoredTrade => ({
  id: 7,
  ticket: "8123456789012345678",
  source: "sample",
  externalId: null,
  isSample: 1,
  accountId: 1,
  importBatchId: null,
  symbol: "EURUSD",
  direction: "SELL",
  quantity: 0.3,
  openTime: "2026-01-15 09:00:00.000",
  closeTime: "2026-01-15 10:30:00.000",
  timeBasis: "utc",
  durationMin: 90,
  openPrice: "1.1",
  closePrice: "1.09",
  sl: "0",
  tp: "0",
  netProfit: "30",
  commission: "0",
  swap: "0",
  mae: null,
  mfe: 12,
  rMultiple: null,
  session: "LONDON",
  dayOfWeek: "Thu",
  hour: 9,
  timeToMfeMin: null,
  slDist: null,
  slippage: null,
  rangeSize: null,
  hitBreakeven: null,
  scaledIn: 1,
  sweepDepth: null,
  usedFvg: true,
  volRegime: null,
  magic: null,
  postClose15m: null,
  postClose30m: null,
  biasAtEntry: null,
  sector: null,
  industry: null,
  volume: null,
  avgVolume: null,
  comment: "Sample (fictional)",
  notes: "",
  tags: '["breakout"]',
  emotion: null,
  checklist: '{"Waited for close": true}',
  importedAt: "2026-01-16 00:00:00.000",
  updatedAt: "2026-01-16 00:00:00.000",
  ...over,
});

describe("toEngineTrade", () => {
  it("maps a Dojix row with the Mac defaults", () => {
    const t = toEngineTrade(row(), "dojix");
    expect(t).toMatchObject({
      brand: "dojix",
      ticket: "8123456789012345678",
      lots: 0.3,
      maePips: null,
      mfePips: 12,
      rMultiple: 0,
      volRegime: "MED",
      biasAtEntry: "NEUTRAL",
      usedFVG: true,
      scaledIn: true,
      hitBreakeven: false,
      isSample: true,
      tags: ["breakout"],
      emotion: "",
      closeTime: Date.UTC(2026, 0, 15, 10, 30),
    });
    expect(t.checklist["Waited for close"]).toBe(true);
    expect(Object.getPrototypeOf(t.checklist)).toBeNull();
  });

  it("maps a Greenwick row", () => {
    const t = toEngineTrade(
      row({ session: "PRE_MARKET", symbol: "FICT", quantity: 50, sector: "Energy", volume: 1000, ticket: 900001, isSample: false }),
      "greenwick",
    );
    expect(t).toMatchObject({ brand: "greenwick", shares: 50, sector: "Energy", volume: 1000, avgVolume: 0, industry: "", ticket: "900001" });
    expect(t.isSample).toBe(false);
  });

  it("refuses rows that never passed storage validation", () => {
    expect(() => toEngineTrade(row({ session: "PRE_MARKET" }), "dojix")).toThrow(/session/);
    expect(() => toEngineTrade(row(), "greenwick")).toThrow(/session/);
    expect(() => toEngineTrade(row({ volRegime: "WILD" }), "dojix")).toThrow(/volRegime/);
    expect(() => toEngineTrade(row({ biasAtEntry: "MAYBE" }), "dojix")).toThrow(/biasAtEntry/);
    expect(() => toEngineTrade(row({ direction: "LONG" as "BUY" }), "dojix")).toThrow(/direction/);
    expect(() => toEngineTrade(row({ closeTime: "yesterday" }), "dojix")).toThrow(/closeTime/);
    expect(() => toEngineTrade(row({ tags: "a,b" }), "dojix")).toThrow(/tags is not JSON/);
    expect(() => toEngineTrade(row({ tags: "[1]" }), "dojix")).toThrow(/string array/);
    expect(() => toEngineTrade(row({ checklist: "{" }), "dojix")).toThrow(/checklist is not JSON/);
    expect(() => toEngineTrade(row({ checklist: "[]" }), "dojix")).toThrow(/not an object/);
    expect(() => toEngineTrade(row({ checklist: '{"a": 1}' }), "dojix")).toThrow(/boolean/);
  });
});
