# Golden numbers (parity with the Mac apps)

The desktop engine has to produce the same numbers as the Mac apps for the same input
(SPEC §10, PARITY.md). This folder holds the evidence. **All input data is fictional.**

| Folder | What | Produced by |
|---|---|---|
| `fixtures/` | Fictional input files F1–F9, one per import format and edge case ([README](fixtures/README.md)) | `tools/fixture-gen` (seeded, deterministic; CI checks the committed bytes) |
| `swift-tests/` | **Tier A.** The Mac apps' own unit-test expectations for math, imports, tickets, calendars, grading and validation, as JSON with source file and line | Ported by hand from djctwo/dojix `614bd6a` and djctwo/greenwick `64495e2` |
| `reference/` | **Tier B (authoritative).** The value of every metric and analytics component for each fixture, computed by the Mac apps' real Swift code. One file per fixture and environment, and nothing else | `.github/workflows/parity-reference.yml` only (macOS 15, Xcode 16.4); never run locally |
| `reference-meta/` | Per brand: run index, checksums, platform probes, sample-trade invariants | Same workflow |
| `fixtures/<brand>/<fixture>.trades.json` | **Engine input**: `{ "trades": StoredTrade[] }`, the journal the Mac stored for each reference | Same workflow (`tools/swift-ref/export-trades.mjs`) |
| `fixtures/<brand>/F10/` | Mac backup vectors (plain, current and older encrypted formats) | Same workflow, written by the apps' own backup code |
| `divergences.yaml` | The intentional differences (PARITY.md B1), each with the reference paths it may change | Maintained by hand; headline entries need the maintainer's approval |

## Reference run

<!-- reference-run -->
**Run [40586319588](https://github.com/djctwo/dojix-desktop/actions/runs/40586319588)**: success,
2026-10-27. Built from commit `6be8319` of this repository, against djctwo/dojix `614bd6a` and
djctwo/greenwick `64495e2`. Toolchain: Xcode 16.4, macOS 15.7.9 (24G830).

- Dojix: 52 reference files. That is every Dojix fixture, the four extra F7 environments for each
  of its two F7 fixtures, and the F9 scale sets.
- Greenwick: 54 reference files, made up the same way.
- `reference-meta/<brand>/index.json` lists each run.
- No value crashed or hung, so `skipped` is empty everywhere.
- The F9 scale sets record metrics only.

Everything under `reference/`, `reference-meta/`, `fixtures/*/F10/` and `fixtures/*/*.trades.json` was
copied unchanged from that run's artifacts (`gh run download 40586319588`).
<!-- /reference-run -->

### Platform probes (`reference-meta/<brand>/probes.json`)

The core team asked for two checks on macos-15. The results:

- **Decimal → Double is not correctly rounded.** `NSDecimalNumber(decimal:).doubleValue` (which
  `profitDouble` uses) gives `"0.07"` → **0.06999999999999999** (bits `3fb1eb851eb851eb`; the
  correctly rounded value is `…ec`). It agrees with the correctly rounded value for 0.1, 0.3, 1.1,
  2.675, 1.0842, 33.1 and 123.45. It differs by 1 ulp for 0.07, −0.07, 151.42 and 0.000001, by 2 for
  1e-7, and by 1 for 1.0000000000000002. `Double(truncating:)` gives the same results. This matches the
  default mode in `packages/core/src/swiftcompat/decimal.ts`, so that mode should stay.
- **DST through `Calendar` (`date(from:)`, `startOfDay`).**
  - A skipped wall time resolves with the **pre-transition offset**. New York 2026-03-08 02:30 →
    07:30Z (= 02:30 EST). Berlin 2026-03-29 02:30 → 01:30Z (= 02:30 CET).
  - A repeated wall time resolves to its **first occurrence**. New York 2026-11-01 01:30 → 05:30Z
    (EDT). Berlin 2026-10-25 02:30 → 00:30Z (CEST).
  - Day lengths are 23 h and 25 h.

  This confirms the `ZonedCalendar` assumption.
- **DST through `DateFormatter` is different. This is what the importers use.**
  - A skipped wall time **does not parse** (`nil`).
  - A repeated wall time resolves to the **second occurrence**: New York 01:30 → 06:30Z (EST), Berlin
    02:30 → 01:30Z (CET).
  - Greenwick's `parseDateTime` then tries its other formats. `"03/08/2026 02:30:00"` in ET comes back
    as **3 August 2026**, through `dd/MM/yyyy HH:mm:ss`.
  - Dojix's generic parser reads every time as UTC, so DST never applies there.

  The importers (packages/importers) must reproduce the DateFormatter behaviour, not the Calendar one.

## Engine input format

The core team proposed `golden/fixtures/<brand>/<fixture>.trades.json` = `{ "trades": [journal
rows] }` in the `StoredTrade` shape of `packages/core/src/model/stored.ts`. That format is used
unchanged.

- There is one file per reference file, named after it, so each F7 environment variant
  (`f7-…@Europe-Berlin_en_GB`) has its own copy of the same trades.
- The trades are the Mac's **stored** journal after import and storage validation (`import.journal`),
  so they work for import-format fixtures too. Unknown MAE/MFE is 0, as the Mac stores it.
- `ticket` is a string. Times are GRDB text, and tags are a JSON array.
- `source` comes from the fixture format. Journal fixtures use `mac_backup`.
- Variant files carry their own `tz`, `locale`, `firstWeekday` and `minimumDaysInFirstWeek`. The
  engine context for Dojix calendar outputs must be built from those, not only from `now`. With TZ=UTC,
  Foundation reports the zone as `GMT`.
<!-- /reference-run -->

The reference files are copied unchanged from the workflow's artifact (`gh run download`). Each
brand folder has a `checksums.json`, and `tools/parity-check` fails if a file no longer matches it.
To regenerate after moving a pin or changing a fixture, run the workflow, download the artifact into
`golden/reference/`, and commit it with the run link updated above.

## Tier A files (`swift-tests/`)

Each file mirrors one Swift test file: `cases[]` with the test's `func` line, the API under test,
self-contained inputs, and `expect[]` with the assert line and literal. Values marked
`"derived": true` follow directly from the formulas but aren't asserted by the Swift test. Cases that
pin a Mac behaviour the desktop fixes on purpose carry `"parity": "D-xx"`. `_index.json` lists the
ported files, counts, and the security/UI test files that were not ported (with a reason). Ticker
symbols in these files are copied verbatim from the public Mac test suites.

### Reproducibility

A second run of the workflow (40588172520, same commit) produced identical reference files,
apart from `now` and `MonteCarloSimulation.result`. Those are the unseeded shuffle (D-05), and every
file already lists them as `nondeterministic`.

### Notes for the engine teams

- **Formatted text uses `en_US_POSIX`**, as SPEC §10.2 pins it. Currency strings inside insight and
  summary text read `$ 4755.36`, not `$4,755.36`. Compare formatted text with POSIX formatting, or
  exclude it here and test it with the en-US vectors (SPEC §10.1).
- **Honour `nondeterministic`.** Swift's dictionary order and its random choice among ties make
  those paths differ from run to run. For example, the order of `CommissionAnalytics.symbolCosts` on
  tied totals, and `EdgeDecayMonitor`'s dominant regime on a tie. Compare them unordered (as
  `tools/parity-check` does) or skip them.
- **Variant files** (`@<zone>_<locale>`) need the engine context built from their own `tz`,
  `firstWeekday` and `minimumDaysInFirstWeek`.

## Using the references (Phase 2)

`tools/parity-check` compares the engine with every reference value. Register an engine function
per reference key in `tools/parity-check/src/engine.ts`. Inputs come from the reference itself:
`import.journal` holds the stored trades, and `now`, `tz`, `locale` and `firstWeekday` hold the
context.

- Doubles must agree within 1e-9 relative.
- Integers, labels, decimal text and ±∞ must be exact.
- Paths listed in a file's `nondeterministic` (Swift dictionary order, unseeded randomness, clock
  reads) are compared unordered and only warn.
- A difference fails unless `divergences.yaml` covers that path for that fixture. A headline
  (Dashboard) number also needs an approved headline entry.

```sh
node tools/parity-check/src/cli.ts            # summary; fails on unexplained differences
node tools/parity-check/src/cli.ts --strict   # Phase 2 gate: every key implemented, every divergence tested
```
