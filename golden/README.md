# Golden numbers (parity with the Mac apps)

The desktop engine has to produce the same numbers as the Mac apps for the same input
(SPEC §10, PARITY.md). This folder holds the evidence. **All input data is fictional.**

| Folder | What | Produced by |
|---|---|---|
| `fixtures/` | Fictional input files F1–F9, one per import format and edge case ([README](fixtures/README.md)) | `tools/fixture-gen` (seeded, deterministic; CI checks the committed bytes) |
| `swift-tests/` | **Tier A.** The Mac apps' own unit-test expectations for math, imports, tickets, calendars, grading and validation, as JSON with source file and line | Ported by hand from djctwo/dojix `614bd6a` and djctwo/greenwick `64495e2` |
| `reference/` | **Tier B (authoritative).** The value of every metric and analytics component for each fixture, computed by the Mac apps' real Swift code | `.github/workflows/parity-reference.yml` only (macOS 15, Xcode 16.4); never run locally |
| `divergences.yaml` | The intentional differences (PARITY.md B1), each with the reference paths it may change | Maintained by hand; headline entries need the maintainer's approval |

## Reference run

<!-- reference-run -->
Not generated yet.
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
