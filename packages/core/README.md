# @dojix-desktop/core

The pure TypeScript engine shared by Dojix (forex) and Greenwick (stocks): the trade model,
Swift-compatibility helpers, calendars and sessions, MetricsCalculator, and the models the
analytics registry runs. No DOM, IPC or Tauri imports; every function is testable headless.

The numbers must match the Mac apps (SPEC §10). Where JavaScript and Swift disagree, the code
here reproduces Swift and says which Swift line it matches.

## Layout

| Folder | What lives there |
|---|---|
| `model/` | `DojixTrade`, `GreenwickTrade` (Mac field names), enums, per-trade accessors (`profitDouble`, `isWin`, `quantity`, `maeOf`, `exitEfficiency`, …), `toEngineTrade` (journal row → engine trade) |
| `swiftcompat/` | Swift behaviour JS lacks: `idiv`, `intSaturating`, `saturatingSum`, `swiftRounded`, `formatFixed` / `swiftFormat` (printf), `asCurrency` and the other `Double+Formatting` helpers, `maxBy` / `minBy`, `swiftMax` / `swiftMin`, `stableSorted`, `groupByFirstAppearance`, `SwiftDecimal` (Foundation `Decimal`), grapheme-aware string helpers |
| `time/` | `ZonedCalendar` (Foundation/ICU calendar in any IANA zone), forex sessions, the Greenwick `Market` / `TradingCalendar`, NYSE holidays + the desktop session clock, GRDB time text, date filters |
| `engine/` | `EngineContext`, `CompatMode`, seeded `Rng`, `AnalyticsRegistry` |
| `metrics/` | `calculateMetrics`, `edgeBy*`, `allEdgeConditions`, `confidenceLevel`, `tradingDayCount` |
| `parity/` | The §10.1 equality rule, reference-file parsing, output resolvers |
| `formulas.ts` | `FORMULA_INDEX`: every formula of SPEC §3.3 and Appendix A, its owner team, status, module and divergences |

## Writing an analytics component

1. Take an `EngineContext` and the trades in **repository order** (close time descending).
   Sum in that order; sort with `sortedByCloseAscending` (stable) where the Mac sorts.
2. Read money only through the accessors (`profitDouble`, `commissionDouble`, …). They use
   Foundation's Decimal → Double conversion, which differs from `Number(text)` in the last bit
   ("0.07" → 0.06999999999999999).
3. Use the brand calendar for days, weeks and months: `ctx.calendar` (Dojix: the display zone;
   Greenwick: ET). Use `ctx.localCalendar` only where the Mac uses `Calendar.current` in
   Greenwick (PeriodComparison, GrowthProjection, EventImpactProfiler day span). Use `ctx.now`,
   never `Date.now()`, and `ctx.rng`, never `Math.random()`.
4. For brand-shared components use the neutral accessors (`quantity`, `maeOf`, `mfeOf`,
   `slDist`, `slippage`, `sessionLabel`, `dayLabel`).
5. Unknown MAE/MFE: `maeOf(t, ctx.compat)` returns 0 in `swift` compat (the Mac) and `null` in
   `fixed` (D-18); skip nulls.
6. Every intentional fix branches on `ctx.compat === "fixed"` and cites its PARITY id.
7. Register it with `defineComponent` in an `AnalyticsRegistry`, add a parity resolver
   (`registerParityResolver("<Component>.", …)`) and flip its `FORMULA_INDEX` entry to
   `implemented` with the module and exports (the index test checks they exist).

## Swift parity traps (reproduced here)

| Trap | Swift | JS default | Helper |
|---|---|---|---|
| Integer division | truncates toward zero | `Math.floor` floors | `idiv`, `irem` |
| `Int(saturating:)` | NaN → 0, ±∞ → Int.max/min; Dojix saturates from 2^63 − 1024 (its literal rounds), Greenwick from 2^63 | — | `intSaturating(x, flavor)` |
| Int.max | 9223372036854775807 | not representable | `INT_MAX` = 2^63, printed as Swift's digits by `swiftFormat` |
| `saturatingSum` | on overflow the running total *becomes* Int.max/min and keeps adding | — | `saturatingSum` |
| `String(format: "%.2f")` | exact binary value, ties to even, "-0.00", "nan"/"inf" | `toFixed` ties up, "0.00", exponent at 1e21 | `formatFixed`, `swiftFormat` |
| Currency formatter | ICU: shortest digits, then half-even (2.675 → "2.68") | — | `asCurrency` |
| `.rounded()` | half away from zero | `Math.round` half up (−2.5 → −2) | `swiftRounded` |
| `max(by:)` / `min(by:)` | max returns the **last** tie, min the **first** | — | `maxBy`, `minBy` |
| `max(x, y)` / `[Double].max()` with NaN | NaN handled asymmetrically | `Math.max` returns NaN | `swiftMax`, `seqMax` |
| Sort | stable | stable (ES2019), but needs a 3-way comparator | `stableSorted(items, less)` |
| Dictionary order | random per process | — | `groupByFirstAppearance` (desktop tie-break) |
| Decimal → Double | 16-bit words, then ÷10 per place | `Number(text)` is correctly rounded | `SwiftDecimal`, `decimalToDouble` |
| Decimal parse | prefix match, "e5" = 0, "0e1000" = nil, 128-bit significand with banker's rounding | — | `SwiftDecimal.parse` |
| Win/loss | compared in Decimal | — | `isWin`, `isLoss` |
| Session `Comparable` | compares raw value strings | — | `compareRawValue` |
| String length/prefix | grapheme clusters | UTF-16 units | `swiftCount`, `swiftPrefix`, `swiftSuffix` |
| `.whitespaces` trim | spaces, tabs and Zs only (keeps newlines) | `trim()` strips newlines too | `trimSwiftWhitespaces`, `macTagList` |
| Week numbers | ICU rules with `firstWeekday` / `minimumDaysInFirstWeek` (Greenwick: week 0 of a Friday-start month) | — | `ZonedCalendar.weekOfYear`, `weekOfMonth` |
| DST | days of 23/25 h; skipped wall times read with the earlier offset; repeated ones resolve to the first | — | `ZonedCalendar` |
| Greenwick day | ET date of the **close**; session/hour/weekday from the ET **open** | — | `tradingDay`, `etSession` |

**Open check for the parity team.** The Decimal → Double algorithm is the one in
swift-foundation (`Decimal+Math.swift`, `doubleValue`). If the Tier B harness shows that
`NSDecimalNumber.doubleValue` on macOS 15 is correctly rounded instead, switch the default mode
in `swiftcompat/decimal.ts` to `"nearest"`; both are implemented and the difference is at most a
few ulps, well inside the 1e-9 tolerance.

## Tests

`pnpm --filter @dojix-desktop/core test` runs Vitest with v8 coverage (thresholds: 90 % lines,
statements and functions, 85 % branches). Swift unit tests that cover the same behaviour are
ported and cite their file. `properties.test.ts` runs fast-check over hostile input.
`parity/parity.test.ts` compares every `golden/reference/**` value it can resolve; it skips
with a reason until Phase 0 commits reference files and fixture inputs
(`golden/fixtures/<brand>/<fixture>.trades.json` = `{ "trades": StoredTrade[] }`).
