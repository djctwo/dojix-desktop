// node src/cli.ts [--strict] [--brand dojix|greenwick] [--verbose]
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReferences, runParity, verifyChecksums } from "./check.ts";
import { parseDivergences } from "./divergences.ts";
import { type Brand, engines } from "./engine.ts";

const golden = resolve(dirname(fileURLToPath(import.meta.url)), "../../../golden");

function main(argv: readonly string[]): number {
  const strict = argv.includes("--strict");
  const verbose = argv.includes("--verbose");
  const only = argv.includes("--brand") ? argv[argv.indexOf("--brand") + 1] : undefined;
  const divergences = parseDivergences(readFileSync(join(golden, "divergences.yaml"), "utf8"));
  const manifestPath = join(golden, "fixtures/manifest.json");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { fixtures: { id: string; compare: boolean }[] })
    : { fixtures: [] };
  const excluded = new Set(manifest.fixtures.filter((f) => !f.compare).map((f) => f.id));
  let failed = false;

  for (const brand of ["dojix", "greenwick"] as Brand[]) {
    if (only && only !== brand) continue;
    const dir = join(golden, "reference", brand);
    const checksumErrors = verifyChecksums(golden, brand);
    const { docs, errors } = loadReferences(dir);
    if (docs.length === 0) {
      console.log(`${brand}: no reference files yet (run parity-reference.yml)`);
      if (strict) failed = true;
      continue;
    }
    const r = runParity(docs, engines[brand], divergences, { excluded, strict });
    const allErrors = [...checksumErrors, ...errors, ...r.errors];
    console.log(`${brand}: ${r.files} reference files · ${r.compared} values compared · ${r.notImplemented} not implemented yet · ` +
      `${r.failures.length} failures · ${r.allowed.length} allowed by a DIVERGENCE entry · ${r.warnings.length} warnings`);
    for (const e of allErrors) console.log(`  ERROR ${e}`);
    for (const f of r.failures.slice(0, verbose ? undefined : 20)) {
      console.log(`  FAIL ${f.file} ${f.mismatch.path}: expected ${JSON.stringify(f.mismatch.expected)?.slice(0, 120)}, ` +
        `got ${JSON.stringify(f.mismatch.actual)?.slice(0, 120)} (${f.mismatch.reason})${f.divergence ? ` [${f.divergence}]` : ""}`);
    }
    if (verbose) for (const w of r.warnings) console.log(`  warn ${w}`);
    if (allErrors.length || r.failures.length) failed = true;
    if (strict && r.notImplemented) failed = true;
  }
  return failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
