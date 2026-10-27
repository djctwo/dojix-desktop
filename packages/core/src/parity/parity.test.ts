// The parity suite (SPEC §10, golden/README.md "Using the references"). Reads every Tier B
// reference file under golden/reference/** and compares each output the engine computes with
// the Mac's value.
//
// - Input: `golden/fixtures/<brand>/<fixture>.trades.json` = `{ "trades": StoredTrade[] }`, the
//   journal the Mac stored for that reference (one per environment variant).
// - Context: the reference's own "now", zone, locale, first weekday and minimum days in the first
//   week (`referenceContext`), `compat: "swift"`.
// - Equality: SPEC §10.1 (`compareParity`). Paths the reference lists as `nondeterministic`
//   (Swift dictionary order, unseeded randomness, clock reads) are compared as unordered
//   multisets and only warn; values the harness marked `skipped` are not compared.
// - F8 (tie traps, manifest `compare: false`) is never compared with Swift (SPEC §10.3).
// - golden/divergences.yaml: `swift` mode must match the Mac everywhere, including values an
//   approved D-xx changes. The same values are then computed in `fixed` mode (what the app
//   ships): there, a difference from the Mac is allowed only where an entry covers that path.
// - Import keys (`import.parsed`, `import.journal`) and fixtures whose only input is an import
//   file (F9) belong to packages/importers: reported here as "importer parity pending".

import { describe, expect, it } from "vitest";
import { registerE3Parity } from "../analytics/e3";
import { toEngineTrade, type StoredTrade } from "../model/stored";
import type { Trade } from "../model/trade";
import { compareParity, pathWithin, type ParityMismatch } from "./compare";
import { coveredBy, parseDivergences } from "./divergences";
import { parseReferenceFile, referenceContext, resolveParityOutput, type ReferenceFile } from "./reference";
// Component resolvers register themselves on import.
import "../analytics/greenwick/parity";

registerE3Parity();
// Component teams keep their resolvers next to their components ("*.parity.ts").
import.meta.glob("../**/*.parity.ts", { eager: true });

const referenceJson = import.meta.glob<unknown>("../../../../golden/reference/**/*.json", { eager: true, import: "default" });
const fixtureJson = import.meta.glob<{ trades?: StoredTrade[] }>("../../../../golden/fixtures/**/*.trades.json", {
  eager: true,
  import: "default",
});
const manifestJson = import.meta.glob<{ fixtures: { id: string; compare: boolean; kind: string; format: string }[] }>(
  "../../../../golden/fixtures/manifest.json",
  { eager: true, import: "default" },
);
const divergenceText = import.meta.glob<string>("../../../../golden/divergences.yaml", { eager: true, query: "?raw", import: "default" });

const divergences = parseDivergences(Object.values(divergenceText)[0] ?? "");
const manifest = new Map((Object.values(manifestJson)[0]?.fixtures ?? []).map((f) => [f.id, f]));

function fixtureTrades(ref: ReferenceFile): Trade[] | null {
  const entry = Object.entries(fixtureJson).find(([p]) => p.endsWith(`/golden/fixtures/${ref.brand}/${ref.fixture}.trades.json`));
  if (!entry || !Array.isArray(entry[1].trades)) return null;
  // Repository order: close time descending (the order the Mac sums in).
  return entry[1].trades.map((row) => toEngineTrade(row, ref.brand)).sort((a, b) => b.closeTime - a.closeTime);
}

const references = Object.entries(referenceJson)
  .filter(([path]) => !/\/(manifest|index|checksums)\.json$/.test(path))
  .map(([path, json]) => parseReferenceFile(path, json));

function describeMismatches(mm: readonly ParityMismatch[]): string {
  const show = (v: unknown) => JSON.stringify(v)?.slice(0, 160) ?? "undefined";
  return mm
    .slice(0, 12)
    .map((m) => `${m.path}: Mac ${show(m.expected)}, desktop ${show(m.actual)}`)
    .join("\n");
}

function isSkippedValue(v: unknown): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && "$skipped" in v;
}

describe("parity with the Mac apps (golden/reference)", () => {
  it("has reference files and the divergence list", () => {
    expect(references.length).toBeGreaterThan(0);
    expect(divergences.length).toBeGreaterThan(0);
    expect(manifest.size).toBeGreaterThan(0);
  });

  it("every headline divergence is approved (PARITY.md B1)", () => {
    expect(divergences.filter((d) => d.headline && !d.approved).map((d) => d.id)).toEqual([]);
  });

  for (const ref of references) {
    describe(`${ref.brand}/${ref.fixture}`, () => {
      const fixture = manifest.get(ref.fixtureId);
      if (fixture && !fixture.compare) {
        it.skip(`${ref.fixtureId}: tie traps, never compared with Swift (manifest compare: false, SPEC §10.3)`, () => {});
        return;
      }
      if (ref.import.parsed !== undefined || ref.import.journal !== undefined) {
        it.skip(`import.parsed / import.journal: importer parity pending (packages/importers, format ${fixture?.format ?? "?"})`, () => {});
      }
      const trades = fixtureTrades(ref);
      if (trades === null) {
        it.skip(`importer parity pending: ${ref.fixtureId} has no stored journal; its input is the ${fixture?.format ?? "?"} file, read through packages/importers`, () => {});
        return;
      }
      const swiftCtx = referenceContext(ref, "swift");
      const fixedCtx = referenceContext(ref, "fixed");
      const fixedFindings: string[] = [];

      for (const [key, expected] of Object.entries(ref.outputs)) {
        if (key in ref.skipped || isSkippedValue(expected)) continue; // the harness could not compute it
        const root = `outputs.${key}`;
        const nondeterministic = ref.nondeterministic.filter((p) => pathWithin(p, root) || pathWithin(root, p));
        const split = (mm: ParityMismatch[]) => {
          const soft = mm.filter((m) => nondeterministic.some((p) => pathWithin(m.path, p)));
          return { hard: mm.filter((m) => !soft.includes(m)), soft };
        };
        const actual = resolveParityOutput(key, swiftCtx, trades);
        if (actual === undefined) {
          it.skip(`${key}: no resolver yet (owner per FORMULA_INDEX)`, () => {});
          continue;
        }
        const options = { exactIntegers: actual.integer, unordered: nondeterministic };
        it(key, async ({ annotate }) => {
          const { hard, soft } = split(compareParity(expected, actual.value, options, root));
          // Nondeterministic in Swift (dictionary order, randomness): a warning, not a failure.
          if (soft.length > 0) await annotate(`nondeterministic in Swift, differs (warn only):\n${describeMismatches(soft)}`, "warning");
          expect(hard, describeMismatches(hard)).toEqual([]);
        });
        // Fixed mode: differences from the Mac only where golden/divergences.yaml allows them.
        const fixed = resolveParityOutput(key, fixedCtx, trades);
        if (fixed === undefined) continue;
        for (const m of split(compareParity(expected, fixed.value, options, root)).hard) {
          if (!coveredBy(divergences, ref.fixtureId, m.path)) {
            fixedFindings.push(`${m.path}: Mac ${JSON.stringify(m.expected)?.slice(0, 80)}, fixed ${JSON.stringify(m.actual)?.slice(0, 80)}`);
          }
        }
      }
      it("fixed mode differs from the Mac only where golden/divergences.yaml allows it", () => {
        expect(fixedFindings, fixedFindings.join("\n")).toEqual([]);
      });
    });
  }
});
