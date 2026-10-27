// golden/divergences.yaml reader: one implementation, shared with the core parity suite
// (packages/core/src/parity/divergences.ts has no imports and only erasable TypeScript, so
// plain Node loads it).
export { coveredBy, coveringIds, parseDivergences, type Divergence } from "../../../packages/core/src/parity/divergences.ts";
