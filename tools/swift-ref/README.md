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
5. `run.mjs` runs the binary once per fixture × environment (`TZ`, `-AppleLocale`). It runs each one
   **twice**: with `SWIFT_DETERMINISTIC_HASHING=1`, then with Swift's per-process random hashing.
   Every output path that differs between the two runs is listed in `nondeterministic`. That covers
   dictionary order, unseeded randomness and clock reads. When a value crashes or hangs (for example,
   a property the view only shows above a minimum sample), the driver records it under `skipped` and
   runs again without it.

## What each reference file contains

`golden/reference/<brand>/<fixture>[@<tz>_<locale>].json`:

| Key | Content |
|---|---|
| `source_sha`, `xcode`, `swift`, `tz`, `locale`, `firstWeekday`, `minimumDaysInFirstWeek`, `now` | Environment. Inject `now` and the calendar values into the TypeScript engine context |
| `import.detect`, `import.route` | Header detection (platform, column mapping) and the route the Mac's Import screen takes |
| `import.saDirect` | Dojix: the 32-column parser applied directly (the MT5 watcher path) |
| `import.error` | The parser's error, if any |
| `import.parsed` | Every parsed trade, all stored fields, plus: Dojix `contentKey` (the SHA-256 ticket input) and `storageViolations`; Greenwick `storageViolations`, `controlCharacterFields`, `rejected` |
| `import.inserted`, `reimportInserted` | Rows the app's repository inserted, and inserted again on a second import (0 = idempotent) |
| `import.journal` | The stored journal read back (close time descending), after `Trade+Sanitize` (Dojix) or `TradeLimits` (Greenwick) |
| `outputs.Metrics` | `MetricsCalculator.calculate`, plus `edgeBy*`, `allEdgeConditions` (tradingDays = 21) and the confidence table |
| `outputs.TradeGrader.grades` | The grade of every trade |
| `outputs.Trade.derived` | Per trade: every computed `Trade` property, plus session, hour, day and display values of the open and close times (Greenwick adds the ET day key) |
| `outputs.<Component>.<value>` | Every computed value of every analytics component. `<Component>[variant]` marks the extra `@State` instances |
| `skipped`, `nondeterministic` | See above |

Encoding rules (Doubles, ±∞, Decimals, dates, enums, Int64 tickets) are at the top of
`shared/RefSupport.swift`; `tools/parity-check` follows the same rules.

Also in each folder: `sample-trades.json` (invariants of the random sample trades), `f10/` (Mac backup
vectors written by the app's own backup code from F1), `index.json` (one row per run) and
`checksums.json` (a hand-edited reference file fails `parity-check`).

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
