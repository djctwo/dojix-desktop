export { compareValues, DOUBLE_TOLERANCE, type Mismatch, normalise, numbersEqual } from "./compare.ts";
export { coveredBy, coveringIds, type Divergence, parseDivergences } from "./divergences.ts";
export {
  type CheckResult, type EngineFn, type EngineMap, HEADLINE_PREFIXES, loadReferences, type ReferenceDoc, runParity,
  verifyChecksums,
} from "./check.ts";
export { type Brand, contextOf, engines, journalOf } from "./engine.ts";
