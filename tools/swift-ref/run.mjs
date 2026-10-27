// Runs the built Swift reference harness over every fixture of one brand (CI only, macOS).
//
//   node tools/swift-ref/run.mjs --brand dojix --bin <DojixRef binary> --out golden/reference/dojix \
//        --source-sha <sha> --xcode <version> [--scale-dir <dir with F9 files>] [--only <substring>]
//
// For each fixture × environment variant it runs the harness twice — once with
// SWIFT_DETERMINISTIC_HASHING=1 and once with Swift's random per-process hashing — and records
// every output path that differs between the two runs as `nondeterministic` (dictionary order,
// unseeded randomness, clock reads). A value that crashes or hangs is skipped and named in
// `skipped`; the run is repeated without it.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

function arg(argv, key, fallback) {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : fallback;
}

export function variantSuffix(v) {
  if (v.tz === "UTC" && v.locale === "en_US_POSIX") return "";
  return `@${v.tz.replace(/\//g, "-")}_${v.locale}`;
}

/** Paths (depth-limited) whose values differ between two JSON documents. */
export function diffPaths(a, b, path = "", depth = 0, out = new Set(), maxDepth = 4) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const bothObjects = a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
  if (depth >= maxDepth || !bothObjects) {
    out.add(path || "$");
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffPaths(a[k], b[k], path ? `${path}.${k}` : k, depth + 1, out, maxDepth);
  }
  return out;
}

function runOnce(bin, args, env, timeoutMs) {
  const r = spawnSync(bin, args, { env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const marks = (r.stderr ?? "").split("\n").filter((l) => l.startsWith("@@ "));
  const last = marks.length ? marks[marks.length - 1].slice(3) : null;
  return { status: r.status, signal: r.signal, timedOut: r.error?.code === "ETIMEDOUT", last, stderr: r.stderr ?? "" };
}

/** Runs until the harness completes, skipping values that crash or hang. */
function runFixture(bin, baseArgs, env, timeoutMs, workDir) {
  const skip = {};
  const skipFile = join(workDir, "skip.json");
  for (let attempt = 0; attempt < 300; attempt++) {
    writeFileSync(skipFile, JSON.stringify(skip));
    const r = runOnce(bin, [...baseArgs, "--skip", skipFile], env, timeoutMs);
    if (r.status === 0) return { ok: true, skip };
    const reason = r.timedOut ? "timeout" : r.signal ? `crash (${r.signal})` : `exit ${r.status}`;
    if (!r.last || r.last.startsWith("$") || skip[r.last]) {
      return { ok: false, skip, error: `${reason} during ${r.last ?? "startup"}`, stderr: r.stderr.slice(-4000) };
    }
    skip[r.last] = reason;
  }
  return { ok: false, skip, error: "too many skipped values" };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main(argv) {
  const brand = arg(argv, "--brand");
  const bin = resolve(arg(argv, "--bin", ""));
  const outDir = resolve(arg(argv, "--out", join(repo, "golden/reference", brand ?? "")));
  const scaleDir = arg(argv, "--scale-dir");
  const only = arg(argv, "--only");
  const sourceSha = arg(argv, "--source-sha", "");
  const xcode = arg(argv, "--xcode", "");
  if (!brand || !existsSync(bin)) {
    console.error("usage: run.mjs --brand dojix|greenwick --bin <harness> [--out dir] [--scale-dir dir]");
    return 2;
  }
  const manifest = JSON.parse(readFileSync(join(repo, "golden/fixtures/manifest.json"), "utf8"));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "swift-ref-"));
  const baseEnv = {
    ...process.env,
    HOME: work,
    DOJIX_DATA_DIR: join(work, "data"),
    GREENWICK_DATA_DIR: join(work, "data"),
  };
  const index = [];
  let failures = 0;

  for (const f of manifest.fixtures.filter((x) => x.brand === brand)) {
    if (only && !f.id.includes(only)) continue;
    const fixturePath = f.committed ? join(repo, "golden/fixtures", f.path) : scaleDir ? join(scaleDir, f.path) : null;
    if (!fixturePath || !existsSync(fixturePath)) {
      index.push({ fixture: f.id, status: "not run (fixture not available)" });
      continue;
    }
    for (const v of f.variants) {
      const name = `${basename(f.id)}${variantSuffix(v)}.json`;
      const outA = join(outDir, name);
      const outB = join(work, `b-${name}`);
      const base = ["--fixture", fixturePath, "--kind", f.kind, "--id", f.id, "--source-sha", sourceSha, "--xcode", xcode,
        "--components", f.components ? "true" : "false", "-AppleLocale", v.locale, "-AppleLanguages", "(en)"];
      const env = { ...baseEnv, TZ: v.tz };
      const timeout = f.components ? 300_000 : 1_200_000;
      const started = Date.now();
      const a = runFixture(bin, [...base, "--out", outA], { ...env, SWIFT_DETERMINISTIC_HASHING: "1" }, timeout, work);
      if (!a.ok) {
        failures++;
        writeFileSync(outA, JSON.stringify({ schema: 1, brand, fixture: f.id, error: a.error, stderr: a.stderr }, null, 1) + "\n");
        index.push({ fixture: f.id, variant: v, file: name, status: "failed", error: a.error });
        console.error(`FAIL ${name}: ${a.error}`);
        continue;
      }
      // Second run with random hashing: anything that differs is order- or time-dependent.
      const skipB = join(work, "skip-b.json");
      writeFileSync(skipB, JSON.stringify(a.skip));
      const b = runOnce(bin, [...base, "--out", outB, "--skip", skipB], env, timeout);
      const docA = JSON.parse(readFileSync(outA, "utf8"));
      let nondeterministic;
      if (b.status === 0) {
        const docB = JSON.parse(readFileSync(outB, "utf8"));
        delete docB.now;
        const nowA = docA.now;
        delete docA.now;
        nondeterministic = [...diffPaths(docA, docB)].sort();
        docA.now = nowA;
      } else {
        nondeterministic = ["$second-run-failed"];
      }
      docA.environment = { tz: v.tz, locale: v.locale, deterministicHashing: true };
      docA.nondeterministic = nondeterministic;
      writeFileSync(outA, JSON.stringify(docA, null, 1) + "\n");
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      index.push({ fixture: f.id, set: f.set, compare: f.compare, variant: v, file: name, status: "ok",
        skipped: Object.keys(a.skip), nondeterministic: nondeterministic.length, seconds });
      console.log(`ok   ${name} (${seconds}s, ${Object.keys(a.skip).length} skipped, ${nondeterministic.length} nondeterministic)`);
    }
  }

  // Sample-trade invariants and F10 backup vectors.
  const samples = runOnce(bin, ["--samples", join(outDir, "sample-trades.json")], baseEnv, 120_000);
  if (samples.status !== 0) { failures++; console.error(`FAIL samples: ${samples.stderr.slice(-2000)}`); }
  const f1 = manifest.fixtures.find((x) => x.brand === brand && x.id === `${brand}/f1-tiny-journal`);
  if (f1) {
    const r = runOnce(bin, ["--backups", join(outDir, "f10"), "--fixture", join(repo, "golden/fixtures", f1.path)], baseEnv, 300_000);
    if (r.status !== 0) { failures++; console.error(`FAIL backups: ${r.stderr.slice(-2000)}`); }
  }

  writeFileSync(join(outDir, "index.json"), JSON.stringify({
    brand, source_sha: sourceSha, xcode, fixtures: index,
  }, null, 1) + "\n");
  // Checksums: parity-check refuses reference files that were edited by hand.
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name !== "checksums.json") files.push(p);
    }
  };
  walk(outDir);
  const sums = Object.fromEntries(files.sort().map((p) => [relative(outDir, p), sha256(p)]));
  writeFileSync(join(outDir, "checksums.json"), JSON.stringify(sums, null, 1) + "\n");
  rmSync(work, { recursive: true, force: true });
  console.log(`${brand}: ${index.filter((x) => x.status === "ok").length} reference files, ${failures} failure(s)`);
  return failures ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
