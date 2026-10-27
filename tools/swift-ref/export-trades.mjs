// Engine input for the parity suite in packages/core: for every reference file
// golden/reference/<brand>/<name>.json, writes golden/fixtures/<brand>/<name>.trades.json =
// { "trades": StoredTrade[] } — the journal the Mac app stored for that fixture (the
// reference's `import.journal`), mapped to the desktop journal-row shape of
// packages/core/src/model/stored.ts. Pure Node; run by parity-reference.yml after the harness.
//
//   node tools/swift-ref/export-trades.mjs [--golden <dir>]
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Manifest format → the SPEC §4.1 `source` value. */
const SOURCE = {
  sa32: "mt5_32col", dojix_export: "dojix_export", mt5_report: "mt5_report", mt4: "mt4", ctrader: "ctrader",
  tradingview: "tradingview", oanda: "oanda_csv", ibkr: "ibkr", tos: "tos", ninjatrader: "ninjatrader",
  webull: "webull", robinhood: "robinhood", schwab: "schwab", fidelity: "fidelity", etrade: "etrade",
  tastytrade: "tastytrade", generic: "generic", journal: "mac_backup",
};

/** ISO-8601 UTC → GRDB text "YYYY-MM-DD HH:MM:SS.SSS". */
export function grdb(iso) {
  return String(iso).replace("T", " ").replace(/Z$/, "");
}

/** The Mac's comma-separated tags → JSON array text (Trade.tagList: split, trim spaces/tabs, drop empty). */
export function tagsJson(list) {
  const tags = String(list ?? "").split(",").map((t) => t.replace(/^[\t \p{Zs}]+|[\t \p{Zs}]+$/gu, "")).filter((t) => t);
  return JSON.stringify(tags);
}

export function toStoredTrade(t, brand, source) {
  const fx = brand === "dojix";
  const isSample = fx ? t.comment === "Sample (fictional)" && Number(t.ticket) >= 9e12 : t.isSample === true;
  return {
    id: t.id,
    ticket: String(t.ticket),
    source,
    externalId: null,
    isSample,
    accountId: 1,
    importBatchId: null,
    symbol: t.symbol,
    direction: t.direction,
    quantity: fx ? t.lots : t.shares,
    openTime: grdb(t.openTime),
    closeTime: grdb(t.closeTime),
    timeBasis: "utc",
    durationMin: t.durationMin,
    openPrice: t.openPrice,
    closePrice: t.closePrice,
    sl: t.sl,
    tp: t.tp,
    netProfit: t.netProfit,
    commission: t.commission,
    swap: t.swap,
    // The Mac stores unknown MAE/MFE as 0 (D-18 is the desktop importer's change).
    mae: fx ? t.maePips : t.maePoints,
    mfe: fx ? t.mfePips : t.mfePoints,
    rMultiple: t.rMultiple,
    session: t.session,
    dayOfWeek: t.dayOfWeek,
    hour: t.hour,
    timeToMfeMin: t.timeToMFEMin,
    slDist: fx ? t.slDistPips : t.slDistPoints,
    slippage: fx ? t.slippagePips : t.slippagePoints,
    rangeSize: t.rangeSize,
    hitBreakeven: t.hitBreakeven,
    scaledIn: t.scaledIn,
    sweepDepth: fx ? t.sweepDepth : null,
    usedFvg: fx ? t.usedFVG : null,
    volRegime: fx ? t.volRegime : null,
    magic: fx ? t.magic : null,
    postClose15m: fx ? t.postClose15m : null,
    postClose30m: fx ? t.postClose30m : null,
    biasAtEntry: fx ? t.biasAtEntry : null,
    sector: fx ? null : t.sector,
    industry: fx ? null : t.industry,
    volume: fx ? null : t.volume,
    avgVolume: fx ? null : t.avgVolume,
    comment: t.comment,
    notes: t.notes,
    tags: tagsJson(t.tags),
    emotion: t.emotion,
    checklist: t.checklistData ? t.checklistData : "{}",
    // The harness fixes importedAt (the Mac's "now") to 2026-01-01 so outputs are reproducible.
    importedAt: "2026-01-01 00:00:00.000",
    updatedAt: "2026-01-01 00:00:00.000",
  };
}

function main(argv) {
  const i = argv.indexOf("--golden");
  const golden = resolve(i >= 0 ? argv[i + 1] : join(here, "../../golden"));
  const manifest = JSON.parse(readFileSync(join(golden, "fixtures/manifest.json"), "utf8"));
  const formatOf = new Map(manifest.fixtures.map((f) => [f.id, f.format]));
  let written = 0;
  for (const brand of ["dojix", "greenwick"]) {
    const refDir = join(golden, "reference", brand);
    const outDir = join(golden, "fixtures", brand);
    if (!existsSync(refDir)) continue;
    for (const old of readdirSync(outDir).filter((n) => n.endsWith(".trades.json"))) rmSync(join(outDir, old));
    for (const name of readdirSync(refDir).filter((n) => n.endsWith(".json")).sort()) {
      const doc = JSON.parse(readFileSync(join(refDir, name), "utf8"));
      const journal = doc.import?.journal;
      if (!Array.isArray(journal)) continue; // scale sets (counts only) and failed runs
      const source = SOURCE[formatOf.get(doc.fixture)] ?? "generic";
      const body = { note: "Fictional. The Mac app's stored journal for this fixture, exported from the Tier B reference.",
        fixture: doc.fixture, trades: journal.map((t) => toStoredTrade(t, brand, source)) };
      writeFileSync(join(outDir, `${basename(name, ".json")}.trades.json`), JSON.stringify(body, null, 1) + "\n");
      written++;
    }
  }
  console.log(`wrote ${written} .trades.json files`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
