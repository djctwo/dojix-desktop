// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INT_MAX, calculateMetrics, toEngineTrade, type DojixTrade, type GreenwickTrade, type StoredTrade } from "@dojix-desktop/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DATA_SENT, MAC_DATA_SENT, aiOffText, consentText } from "./data-sent";
import {
  PROMPT_PREFIX,
  PROMPT_SUFFIX,
  dojixEdgeAnalysisPrompt,
  edgeAnalysisPrompt,
  greenwickEdgeAnalysisPrompt,
  promptSections,
  safeLabel,
} from "./edge-analysis";
import { fxTrade, stTrade } from "./test-support/trades";

const FX = { brand: "dojix", compat: "swift", locale: "en_US" } as const;
const ST = { brand: "greenwick", compat: "swift", locale: "en_US" } as const;

/** Three fictional trades, newest first (repository order). */
function fxTiny(): DojixTrade[] {
  const t1 = fxTrade({
    netProfit: "100", session: "LONDON", hour: 9, dayOfWeek: "Mon", symbol: "EURUSD", biasAtEntry: "WITH", volRegime: "MED",
    rMultiple: 2.5, durationMin: 30, lots: 0.1, postClose15m: 5, postClose30m: 10, maePips: 5, mfePips: 10, closeTime: Date.UTC(2026, 0, 15, 10),
  });
  const t2 = fxTrade({
    netProfit: "-50", session: "NY", hour: 14, dayOfWeek: "Tue", symbol: "GBPUSD", biasAtEntry: "AGAINST", volRegime: "HIGH",
    rMultiple: -1, durationMin: 90, lots: 0.1, postClose15m: 0, postClose30m: 0, maePips: 8, mfePips: 4, closeTime: Date.UTC(2026, 0, 16, 15),
  });
  const t3 = fxTrade({
    netProfit: "25", session: "LONDON", hour: 9, dayOfWeek: "Mon", symbol: "EURUSD", biasAtEntry: "WITH", volRegime: "MED",
    rMultiple: 0.5, durationMin: 20, lots: 0.5, postClose15m: 2, postClose30m: -1, maePips: 3, mfePips: 6, closeTime: Date.UTC(2026, 0, 17, 10),
  });
  return [t3, t2, t1];
}

describe("Dojix PromptBuilder.edgeAnalysis", () => {
  it("matches the Mac text line for line", () => {
    expect(dojixEdgeAnalysisPrompt(FX, fxTiny())).toBe(
      [
        "Analyze my trading data and give me 3-5 specific recommendations to improve profitability.",
        "",
        "## Portfolio Summary",
        "- Total trades: 3",
        "- Win rate: 66.7%",
        "- Profit factor: 2.50",
        "- Total P&L: $75.00",
        "- Expectancy: $25.00/trade",
        "- Avg win: $62.50, Avg loss: -$50.00",
        "- Max drawdown: $50.00",
        "- Avg R-multiple: 0.67R",
        "- Avg MAE: 5.3 pips, Avg MFE: 6.7 pips",
        "",
        "## P&L by Session",
        "- London: $125.00 (2 trades, 100.0% WR)",
        "- New York: -$50.00 (1 trades, 0.0% WR)",
        "",
        "## P&L by Hour (Top 5 Best / Worst)",
        "Best: 9:00 $125.00",
        "Worst: 14:00 -$50.00",
        "",
        "## P&L by Pair",
        "- EURUSD: $125.00 (2 trades, 100.0% WR)",
        "- GBPUSD: -$50.00 (1 trades, 0.0% WR)",
        "",
        "## P&L by Day",
        "- Mon: $125.00 (2 trades, 100.0% WR)",
        "- Tue: -$50.00 (1 trades, 0.0% WR)",
        "",
        "## Bias Alignment",
        "- WITH: $125.00 (2 trades, 100.0% WR)",
        "- AGAINST: -$50.00 (1 trades, 0.0% WR)",
        "",
        "## Volatility Regime",
        "- MED: $125.00 (2 trades, 100.0% WR)",
        "- HIGH: -$50.00 (1 trades, 0.0% WR)",
        "",
        "## Post-Close Continuation (Winners)",
        "- Avg 15m after exit: 3.5 pips",
        "- Avg 30m after exit: 4.5 pips",
        "(Positive = price continued in trade direction after exit = exiting too early)",
        "",
        "## R-Multiple Distribution",
        "- 2R+ wins: 1, <1R wins: 1, -1R+ losses: 1",
        "- This tells you about trade management quality",
        "",
        "## Duration Patterns",
        "- Avg winner duration: 25 min",
        "- Avg loser duration: 90 min",
        "- If losers last longer, the trader may be holding losers hoping for recovery",
        "",
        "## Position Sizing Warning",
        "- Avg lots: 0.23, Max: 0.50, Min: 0.10",
        "- Max lot size is 2x+ the average — possible revenge trading or over-sizing",
        "",
        "Give me 3-5 specific, ranked recommendations with dollar impact estimates.",
      ].join("\n"),
    );
  });

  it("keeps the Mac's top-5 hour lists and leaves out empty sections", () => {
    const trades = Array.from({ length: 14 }, (_, h) => fxTrade({ hour: h, netProfit: String((h - 7) * 10), lots: 0.1, closeTime: Date.UTC(2026, 0, 1, h) }));
    const p = dojixEdgeAnalysisPrompt(FX, trades);
    expect(p).toContain("Best: 13:00 $60.00, 12:00 $50.00, 11:00 $40.00, 10:00 $30.00, 9:00 $20.00\n");
    expect(p).toContain("Worst: 0:00 -$70.00, 1:00 -$60.00, 2:00 -$50.00, 3:00 -$40.00, 4:00 -$30.00\n");
    expect(p).not.toContain("Position Sizing Warning");
    const losers = [fxTrade({ netProfit: "-5" }), fxTrade({ netProfit: "-7" })];
    const q = dojixEdgeAnalysisPrompt(FX, losers);
    expect(q).not.toContain("Post-Close Continuation");
    expect(q).toContain("Best: \nWorst: ");
    expect(q).toContain("- Avg winner duration: 0 min");
  });

  it("prints Int.max durations as Swift does and never traps", () => {
    const huge = [fxTrade({ netProfit: "10", durationMin: INT_MAX }), fxTrade({ netProfit: "-5", durationMin: INT_MAX })];
    const p = dojixEdgeAnalysisPrompt(FX, huge);
    expect(p).toContain("- Avg winner duration: 9223372036854775807 min");
  });

  it("formats money in the user's locale, like the Mac's NumberFormatter", () => {
    const p = dojixEdgeAnalysisPrompt({ ...FX, locale: "en_GB" }, fxTiny());
    expect(p).toContain("- Total P&L: US$75.00\n");
  });

  it("shows unknown excursions as n/a in fixed compat (D-18)", () => {
    const unknown = fxTiny().map((t) => ({ ...t, maePips: null, mfePips: null }));
    expect(dojixEdgeAnalysisPrompt({ ...FX, compat: "fixed" }, unknown)).toContain("- Avg MAE: n/a, Avg MFE: n/a\n");
    expect(dojixEdgeAnalysisPrompt(FX, unknown)).toContain("- Avg MAE: 0.0 pips, Avg MFE: 0.0 pips\n");
  });
});

describe("Greenwick PromptBuilder.edgeAnalysis", () => {
  it("has tickers, no bias/volatility/post-close, points and share sizing", () => {
    const trades = [
      stTrade({ symbol: "FICT", netProfit: "120", shares: 900, rMultiple: 2, durationMin: 15, maePoints: 1, mfePoints: 3, hour: 10, closeTime: Date.UTC(2026, 9, 23, 15) }),
      stTrade({ symbol: "MADE", netProfit: "-40", shares: 100, rMultiple: -1, durationMin: 45, maePoints: 2, mfePoints: 1, hour: 11, closeTime: Date.UTC(2026, 9, 22, 15) }),
      stTrade({ symbol: "MADE", netProfit: "10", shares: 100, rMultiple: 0.4, durationMin: 5, maePoints: 3, mfePoints: 2, hour: 10, closeTime: Date.UTC(2026, 9, 21, 15) }),
    ];
    const p = greenwickEdgeAnalysisPrompt(ST, trades);
    expect(p.startsWith(PROMPT_PREFIX)).toBe(true);
    expect(p.endsWith(PROMPT_SUFFIX)).toBe(true);
    expect(promptSections(p)).toEqual([
      "Portfolio Summary",
      "P&L by Session",
      "P&L by Hour (Top 5 Best / Worst)",
      "P&L by Ticker",
      "P&L by Day",
      "R-Multiple Distribution",
      "Duration Patterns",
      "Position Sizing Warning",
    ]);
    expect(p).toContain("- Avg MAE: 2.0 pts, Avg MFE: 2.0 pts\n");
    expect(p).toContain("- FICT: $120.00 (1 trades, 100.0% WR)\n- MADE: -$30.00 (2 trades, 50.0% WR)\n");
    expect(p).toContain("- Avg shares: 367, Max: 900, Min: 100\n");
    expect(p).toContain("- Max share size is 2x+ the average — possible revenge trading or over-sizing\n");
    expect(p).toContain("## P&L by Session\n- Regular: $90.00 (3 trades, 66.7% WR)\n");
  });

  it("an empty journal still gives a well-formed message (the UI asks for 30 trades first)", () => {
    for (const p of [dojixEdgeAnalysisPrompt(FX, []), greenwickEdgeAnalysisPrompt(ST, [])]) {
      expect(p.startsWith(PROMPT_PREFIX) && p.endsWith(PROMPT_SUFFIX)).toBe(true);
      expect(p).toContain("- Total trades: 0\n");
      expect(p).not.toContain("Position Sizing Warning");
    }
    const even = [stTrade({ netProfit: "5", shares: 10 }), stTrade({ netProfit: "-5", shares: 10 })];
    expect(greenwickEdgeAnalysisPrompt(ST, even)).not.toContain("Position Sizing Warning");
  });

  it("uses the metrics it is given", () => {
    const trades = fxTiny();
    const p = dojixEdgeAnalysisPrompt(FX, trades, { ...calculateMetrics(trades, FX), totalTrades: 999 });
    expect(p).toContain("- Total trades: 999\n");
    const q = greenwickEdgeAnalysisPrompt(ST, [], { ...calculateMetrics([], ST), winRate: 50 });
    expect(q).toContain("- Win rate: 50.0%\n");
  });

  it("dispatches by brand", () => {
    const fx = fxTiny();
    expect(edgeAnalysisPrompt(FX, fx)).toBe(dojixEdgeAnalysisPrompt(FX, fx));
    const st = [stTrade({ netProfit: "5" })];
    expect(edgeAnalysisPrompt(ST, st)).toBe(greenwickEdgeAnalysisPrompt(ST, st));
    expect(edgeAnalysisPrompt(ST, [...fx, ...st])).toBe(greenwickEdgeAnalysisPrompt(ST, st));
  });
});

// ---------------------------------------------------------------------------------------------
// Data minimisation: only aggregates leave the computer
// ---------------------------------------------------------------------------------------------

function fixture(brand: "dojix" | "greenwick", name: string): StoredTrade[] {
  const path = fileURLToPath(new URL(`../../../golden/fixtures/${brand}/${name}.trades.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { trades: StoredTrade[] }).trades;
}

const MARKERS = ["MARKER-NOTE-4711", "MARKER-TAG-4711", "MARKER-COMMENT-4711", "MARKER-EMOTION-4711", "MARKER-CHECK-4711"];

function marked(rows: StoredTrade[]): StoredTrade[] {
  return rows.map((r, i) => ({
    ...r,
    ticket: 900_000_000 + i,
    notes: `${MARKERS[0]} private journal text`,
    tags: JSON.stringify([MARKERS[1]]),
    comment: MARKERS[2] as string,
    emotion: MARKERS[3] as string,
    checklist: JSON.stringify({ [MARKERS[4] as string]: true }),
    magic: 424_242,
  }));
}

describe("what is sent", () => {
  for (const [brand, name, ctx] of [
    ["dojix", "f2-forex-year", FX],
    ["greenwick", "f2-stocks-year-journal", ST],
  ] as const) {
    it(`${brand}: no notes, tags, comments, emotions, checklists, tickets or single trades`, () => {
      const rows = marked(fixture(brand, name));
      const trades = rows.map((r) => toEngineTrade(r, brand)).sort((a, b) => b.closeTime - a.closeTime);
      const p = edgeAnalysisPrompt(ctx, trades);
      for (const m of MARKERS) expect(p).not.toContain(m);
      expect(p).not.toContain("900000");
      expect(p).not.toContain("424242");
      expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates
      expect(p.length).toBeLessThan(64 * 1024);
      // Every line is a heading, a statistic or fixed text: no per-trade rows.
      const lines = p.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeLessThan(trades.length);
      expect(promptSections(p).length).toBeGreaterThanOrEqual(brand === "dojix" ? 10 : 7);
    });
  }

  it("the desktop text names every section a prompt can contain; the Mac texts are kept", () => {
    expect(DATA_SENT.dojix).toContain("bias alignment and volatility regime");
    expect(DATA_SENT.dojix).toContain("lot sizes");
    expect(DATA_SENT.greenwick).toContain("share counts");
    expect(MAC_DATA_SENT.greenwick).not.toContain("share");
    for (const brand of ["dojix", "greenwick"] as const) {
      expect(DATA_SENT[brand]).toContain("not sent");
      expect(consentText(brand)).toContain(DATA_SENT[brand]);
      expect(aiOffText(brand)).toContain("off by default");
    }
    expect(consentText("greenwick")).toContain("Greenwick keeps");
    expect(aiOffText("dojix")).toContain("Dojix never sends");
  });
});

describe("hostile input", () => {
  it("labels can't add lines or control characters", () => {
    expect(safeLabel("EUR\nUSD\u0000\u0007\u0085")).toBe("EURUSD");
    expect(safeLabel("Ünïcode ✓")).toBe("Ünïcode ✓");
    const p = dojixEdgeAnalysisPrompt(FX, [fxTrade({ symbol: "EVIL\n## Notes\nsecret", netProfit: "5" })]);
    expect(promptSections(p)).not.toContain("Notes");
  });

  it("always has the shape the shell accepts and never prints NaN or infinity (property)", () => {
    const fxArb = fc.record({
      // Stored money is canonical decimal text (validated on every write path).
      netProfit: fc.oneof(fc.integer({ min: -1e9, max: 1e9 }).map(String), fc.constantFrom("0", "-0", "0.01", "-0.07", "99999999.99")),
      symbol: fc.string({ maxLength: 12 }),
      hour: fc.integer({ min: 0, max: 23 }),
      rMultiple: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      durationMin: fc.oneof(fc.integer({ min: 0, max: 1e7 }), fc.constant(INT_MAX)),
      lots: fc.double({ min: 0.01, max: 1e4, noNaN: true }),
      postClose15m: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      postClose30m: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      maePips: fc.option(fc.double({ min: 0, max: 1e6, noNaN: true }), { nil: null }),
      mfePips: fc.option(fc.double({ min: 0, max: 1e6, noNaN: true }), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(fxArb, { minLength: 1, maxLength: 40 }), fc.constantFrom("swift", "fixed"), (rows, compat) => {
        const trades = rows.map((r, i) => fxTrade({ ...r, closeTime: Date.UTC(2026, 0, 1) + i * 60_000 }));
        const p = dojixEdgeAnalysisPrompt({ ...FX, compat }, trades);
        expect(p.startsWith(PROMPT_PREFIX) && p.endsWith(PROMPT_SUFFIX)).toBe(true);
        expect(/\p{Cc}/u.test(p.replace(/\n/g, ""))).toBe(false);
        expect(p).not.toMatch(/NaN|nan\b|Infinity|\binf\b|∞/);
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS ?? 300) },
    );
    const stArb = fc.record({
      netProfit: fc.integer({ min: -1e9, max: 1e9 }).map(String),
      symbol: fc.string({ maxLength: 8 }),
      shares: fc.double({ min: 1, max: 1e9, noNaN: true }),
      durationMin: fc.integer({ min: 0, max: 1e7 }),
    });
    fc.assert(
      fc.property(fc.array(stArb, { minLength: 1, maxLength: 30 }), (rows) => {
        const trades: GreenwickTrade[] = rows.map((r, i) => stTrade({ ...r, closeTime: Date.UTC(2026, 9, 1) + i * 3_600_000 }));
        const p = greenwickEdgeAnalysisPrompt(ST, trades);
        expect(p.endsWith(PROMPT_SUFFIX)).toBe(true);
        expect(p).not.toMatch(/NaN|Infinity|∞/);
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS ?? 300) },
    );
  });
});
