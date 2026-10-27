# Swift reference harness (Tier B)

This is a command-line build of the Mac apps' own model, import, analytics and backup code. It
computes the reference numbers the desktop engine has to match (SPEC §10.2). It is built and run
**only** by `.github/workflows/parity-reference.yml` on a throwaway `macos-15` runner with Xcode 16.4.
Never run it on a maintainer's Mac.

## How it is put together

1. The workflow checks out **djctwo/dojix** and **djctwo/greenwick** at the pinned commits (PARITY.md).
2. `prepare.mjs --brand <b> --src <checkout>` copies **every** Swift file of the app into
   `<b>/Sources/<B>Ref/App/` (git-ignored). It makes two changes to the copies:
   - It removes the `@main` attribute, because the harness has its own `main.swift`.
   - In the computational folders (`Components`, `Services/Analytics`, `Services/Import`, `Models`,
     `Extensions`) and the backup-format files, it changes member-level `private`/`fileprivate` to
     internal. This lets the harness read each component's computed values. No logic is changed.

   The real sources are linked, not copied by hand: SwiftUI views compile as they are and are never
   rendered. Nothing had to be extracted or rewritten.
3. `prepare.mjs` scans the component files and writes `RefGenerated.swift`, which has:
   - one accessor per computed value of each analytics component, a `View` built from the journal's
     trades, metrics and a checkpoint. The components whose numbers depend on a `@State` setting
     (period, month, balance, risk, prop-firm limits) get extra instances;
   - `RefDumpable` conformances that expose the computed properties of the components' result types;
   - every computed property of `Trade` and of the app's `Date` extensions, per trade.

   `generated-report.json` (uploaded with the artifact) lists what was read and what was left out.
4. `swift build -c release`, against the same GRDB commit the apps pin.
5. `run.mjs` runs the binary per fixture × environment (`TZ`, `-AppleLocale`): once with
   `SWIFT_DETERMINISTIC_HASHING=1` (the recorded values), then `RANDOM_RUNS` (12) times with Swift's
   per-process random hashing (once for the metrics-only scale sets). Every output path that differs
   from the first run in any of them is listed in `nondeterministic`. One random run is not enough: it
   reproduces a two-key dictionary's order half the time (run 40586319588 missed
   `GapAnalysis.gapTrades` and `CommissionAnalytics.symbolCosts` on some F6 files that way). That covers
   dictionary order, unseeded randomness and clock reads. When a value crashes or hangs (for example,
   a property the view only shows above a minimum sample), the driver records it under `skipped` and
   runs again without it.

## What each reference file contains

`golden/reference/<brand>/<fixture>[@<tz>_<locale>].json`, one per fixture and environment.
Nothing else goes in that folder, so `packages/core` can read every file there as a reference:

| Key | Content |
|---|---|
| `source_sha`, `xcode`, `swift`, `tz`, `locale`, `firstWeekday`, `minimumDaysInFirstWeek`, `now` | The environment. `tz` is Foundation's name for the zone (TZ=UTC reads back as `GMT`); `environment.tz` is the zone that was requested. Inject `now` and the calendar values into the engine context |
| `import.detect`, `import.route` | Header detection (platform, column mapping) and the route the Mac's Import screen takes |
| `import.saDirect` | Dojix only: the 32-column parser applied directly (the MT5 watcher path) |
| `import.error` | The parser's error, if any |
| `import.parsed` | File fixtures only. Every parsed trade with all stored fields. Dojix adds `contentKey` (the SHA-256 ticket input) and `storageViolations`. Greenwick adds `storageViolations`, `controlCharacterFields` and `rejected` |
| `import.inserted`, `import.reimportInserted` | Rows the app's repository inserted, and rows inserted again on a second import (0 = idempotent) |
| `import.journal` | The stored journal read back in close-time-descending order, after `Trade+Sanitize` (Dojix) or `TradeLimits` (Greenwick). The scale sets record counts only |
| `outputs["Metrics.<field>"]` | `MetricsCalculator.calculate` |
| `outputs["Metrics.edgeBy…"]`, `outputs["Metrics.allEdgeConditions[tradingDays=21]"]`, `outputs["Metrics.confidence"]` | Edge breakdowns, edge conditions with tradingDays = 21, and the confidence table |
| `outputs["TradeGrader.grades"]` | The grade of every trade |
| `outputs["Trade.derived"]` | Per trade: every computed `Trade` property, plus the session, hour, day and display values of the open and close times. Greenwick adds the ET day key |
| `outputs["<Component>.<value>"]` | Every computed value of every analytics component. `<Component>[variant]` marks the extra `@State` instances |
| `skipped`, `nondeterministic` | See above |

Encoding rules for Doubles, ±∞, Decimals, dates, enums and Int64 tickets are at the top of
`shared/RefSupport.swift`. `tools/parity-check` follows the same rules.

Other outputs of the same run:

| Path | Content |
|---|---|
| `golden/reference-meta/<brand>/index.json` | One row per run: status, seconds, skipped and nondeterministic counts |
| `golden/reference-meta/<brand>/checksums.json` | SHA-256 of every reference and F10 file, paths relative to `golden/`. A hand-edited file fails `parity-check` |
| `golden/reference-meta/<brand>/probes.json` | How Foundation converts Decimal to Double, how it resolves skipped and repeated DST wall times, and how each brand's parser reads times |
| `golden/reference-meta/<brand>/sample-trades.json` | Invariants of the random sample trades |
| `golden/fixtures/<brand>/F10/` | Mac backup vectors written by the app's own backup code from F1, plus `backups.json` |
| `golden/fixtures/<brand>/<name>.trades.json` | `export-trades.mjs`: each reference's `import.journal`, mapped to the `StoredTrade` row of `packages/core`. This is the engine input |

## Not covered (gaps)

- **Pulse edge signal (Dojix)** lives in a view model fed by live prices. D-28 changes it anyway.
- **Formatted strings** (`Double+Formatting`, labels drawn in `body`). The SPEC tests these separately
  with en-US vectors; Tier A covers `FormattingTests`.
- **Values computed only inside `body`, or by functions that take arguments** (for example
  `stats(for:)`). The generator reads zero-argument computed properties and functions. Most components
  expose their numbers that way, and StrategyCheckpoints' `metrics(for:)` is called by hand.
- **Computed properties of result types declared outside the component files** are not exposed.
  Their stored fields are.
- **Prop-firm settings stored in the journal**: the components read their `@State` defaults (and one
  custom instance).
