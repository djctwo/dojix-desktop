// The parity gate (SPEC §10.4). Loads the Swift reference files, runs each engine function the
// desktop has registered for a reference key, and compares the two under the SPEC's rules.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareValues, type Mismatch } from "./compare.ts";
import { coveredBy, isProposal, unapprovedHeadlineFixes, type Divergence } from "./divergences.ts";

/** One golden/reference/<brand>/<fixture>[@variant].json file, as tools/swift-ref writes it. */
export interface ReferenceDoc {
  schema: number;
  brand: "dojix" | "greenwick";
  fixture: string;
  source_sha: string;
  tz: string;
  locale: string;
  firstWeekday: number;
  minimumDaysInFirstWeek: number;
  /** The harness clock (ISO); inject it as `now` in the engine context */
  now: string;
  import: Record<string, unknown> & { journal?: Record<string, unknown>[]; parsed?: Record<string, unknown>[] };
  outputs: Record<string, unknown>;
  skipped: Record<string, string>;
  nondeterministic: string[];
  environment?: { tz: string; locale: string };
  error?: string;
}

/**
 * Engine functions keyed by reference path: "outputs.Metrics", "outputs.RiskOfRuin.riskOfRuin",
 * "import.parsed", … Each receives the reference document (its `import.journal` is the input the
 * Swift side used; `now`, `tz`, `locale` and `firstWeekday` give the engine context).
 */
export type EngineFn = (doc: ReferenceDoc) => unknown;
export type EngineMap = Readonly<Record<string, EngineFn>>;

/** Reference paths that are Dashboard header numbers. */
export const HEADLINE_PREFIXES = ["outputs.Metrics"];

export interface Finding {
  fixture: string;
  file: string;
  key: string;
  mismatch: Mismatch;
  divergence?: string;
}

export interface CheckResult {
  files: number;
  /** reference values that have an engine function */
  compared: number;
  /** reference keys without an engine function yet */
  notImplemented: number;
  failures: Finding[];
  allowed: Finding[];
  warnings: string[];
  errors: string[];
}

export function loadReferences(dir: string): { docs: { file: string; doc: ReferenceDoc }[]; errors: string[] } {
  const docs: { file: string; doc: ReferenceDoc }[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { docs, errors };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || ["index.json", "checksums.json", "sample-trades.json"].includes(name)) continue;
    try {
      const doc = JSON.parse(readFileSync(join(dir, name), "utf8")) as ReferenceDoc;
      if (doc.schema !== 1) errors.push(`${name}: unknown schema ${String(doc.schema)}`);
      docs.push({ file: name, doc });
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { docs, errors };
}

/**
 * Reference files are produced only by CI; a hand edit breaks the checksum manifest
 * (golden/reference-meta/<brand>/checksums.json, paths relative to golden/).
 */
export function verifyChecksums(golden: string, brand: string): string[] {
  const manifest = join(golden, "reference-meta", brand, "checksums.json");
  const refDir = join(golden, "reference", brand);
  if (!existsSync(manifest)) return existsSync(refDir) ? [`${brand}: reference-meta/${brand}/checksums.json missing`] : [];
  const sums = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, string>;
  const errors: string[] = [];
  for (const [file, sum] of Object.entries(sums)) {
    const p = join(golden, file);
    if (!existsSync(p)) errors.push(`${file}: listed in checksums.json but missing`);
    else if (createHash("sha256").update(readFileSync(p)).digest("hex") !== sum) {
      errors.push(`${file}: edited by hand (checksum differs from the CI run)`);
    }
  }
  for (const name of existsSync(refDir) ? readdirSync(refDir) : []) {
    if (!(`reference/${brand}/${name}` in sums)) errors.push(`reference/${brand}/${name}: not produced by the CI run`);
  }
  return errors;
}

function get(doc: ReferenceDoc, key: string): unknown {
  const [head, ...rest] = key.split(".");
  if (head === "outputs") return doc.outputs[rest.join(".")];
  if (head === "import") return doc.import[rest.join(".")];
  return undefined;
}

export interface RunOptions {
  /** Fixture ids never compared with Swift (F8) */
  excluded?: ReadonlySet<string>;
  /** Phase 2+: every divergence needs a test */
  strict?: boolean;
}

export function runParity(docs: readonly { file: string; doc: ReferenceDoc }[], engine: EngineMap,
  divergences: readonly Divergence[], opts: RunOptions = {}): CheckResult {
  const result: CheckResult = { files: docs.length, compared: 0, notImplemented: 0, failures: [], allowed: [], warnings: [], errors: [] };

  for (const id of unapprovedHeadlineFixes(divergences)) result.errors.push(`${id}: changes a headline number but is not approved`);
  for (const d of divergences) {
    if (opts.strict && d.approved && !d.test) result.errors.push(`${d.id}: no red→green test`);
    if (isProposal(d)) result.warnings.push(`${d.id}: proposed, waiting for the maintainer (covers nothing yet)`);
  }

  for (const { file, doc } of docs) {
    if (doc.error) {
      result.warnings.push(`${file}: the Swift harness failed (${doc.error})`);
      continue;
    }
    if (opts.excluded?.has(doc.fixture)) continue;
    const keys = [...Object.keys(doc.outputs).map((k) => `outputs.${k}`), "import.parsed", "import.journal"];
    for (const key of keys) {
      const expected = get(doc, key);
      if (expected === undefined) continue;
      if (expected && typeof expected === "object" && "$skipped" in (expected as object)) continue;
      const fn = engine[key];
      if (!fn) {
        result.notImplemented++;
        continue;
      }
      result.compared++;
      const nondet = doc.nondeterministic.filter((p) => p.startsWith(key));
      const mismatches = compareValues(expected, fn(doc), key, { unordered: nondet });
      for (const m of mismatches) {
        const finding: Finding = { fixture: doc.fixture, file, key, mismatch: m };
        if (nondet.some((p) => m.path.startsWith(p))) {
          result.warnings.push(`${file}: ${m.path} differs but is nondeterministic in Swift (${m.reason})`);
          continue;
        }
        const div = coveredBy(divergences, doc.fixture, m.path);
        if (div && HEADLINE_PREFIXES.some((h) => m.path.startsWith(h)) && !div.headline) {
          result.failures.push({ ...finding, divergence: `${div.id} (not marked headline)` });
        } else if (div) {
          result.allowed.push({ ...finding, divergence: div.id });
        } else {
          result.failures.push(finding);
        }
      }
    }
  }
  return result;
}
