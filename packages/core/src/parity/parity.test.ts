// Parity scaffold (SPEC §10.4). Reads every Tier B reference file under golden/reference/**
// and compares each output the engine can already compute with the desktop's value
// (`compat: "swift"`). Until Phase 0 commits reference files, or while a fixture has no
// engine-shaped input, the cases are skipped with the reason.
//
// Fixture input: `golden/fixtures/<brand>/<fixture>.trades.json` = `{ "trades": StoredTrade[] }`
// (journal rows, as the importers will produce them). Import-format fixtures (CSV, HTML) get
// loaders once packages/importers can parse them.

import { describe, expect, it } from "vitest";
import { parityContext } from "../engine/context";
import { toEngineTrade, type StoredTrade } from "../model/stored";
import type { Trade } from "../model/trade";
import { compareParity } from "./compare";
import { parseReferenceFile, resolveParityOutput, type ReferenceFile } from "./reference";

const referenceJson = import.meta.glob<unknown>("../../../../golden/reference/**/*.json", { eager: true, import: "default" });
const fixtureJson = import.meta.glob<{ trades?: StoredTrade[] }>("../../../../golden/fixtures/**/*.trades.json", {
  eager: true,
  import: "default",
});

function fixtureTrades(ref: ReferenceFile): Trade[] | null {
  const entry = Object.entries(fixtureJson).find(([p]) => p.endsWith(`/golden/fixtures/${ref.brand}/${ref.fixture}.trades.json`));
  if (!entry || !Array.isArray(entry[1].trades)) return null;
  // Repository order: close time descending (the order the Mac sums in).
  return entry[1].trades
    .map((row) => toEngineTrade(row, ref.brand))
    .sort((a, b) => b.closeTime - a.closeTime);
}

const references = Object.entries(referenceJson)
  .filter(([path]) => !path.endsWith("manifest.json"))
  .map(([path, json]) => parseReferenceFile(path, json));

describe("parity with the Mac apps (golden/reference)", () => {
  if (references.length === 0) {
    it.skip("golden/reference/** is not committed yet (Phase 0, parity team): nothing to compare", () => {});
    return;
  }
  for (const ref of references) {
    const trades = fixtureTrades(ref);
    describe(`${ref.brand}/${ref.fixture}`, () => {
      if (trades === null) {
        it.skip(`no engine input for ${ref.fixture} yet (needs golden/fixtures/${ref.brand}/${ref.fixture}.trades.json or an importer loader)`, () => {});
        return;
      }
      const ctx = parityContext(ref.brand, ref.now);
      for (const [key, expected] of Object.entries(ref.outputs)) {
        const actual = resolveParityOutput(key, ctx, trades);
        if (actual === undefined) {
          it.skip(`${key}: no resolver yet (owner per FORMULA_INDEX)`, () => {});
          continue;
        }
        it(key, () => {
          expect(compareParity(expected, actual.value, { exactIntegers: actual.integer })).toEqual([]);
        });
      }
    });
  }
});
