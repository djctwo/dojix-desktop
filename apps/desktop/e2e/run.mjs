// Real-binary end-to-end smoke test through tauri-driver (W3C WebDriver). CI only: it launches
// the desktop app, so never run it on a maintainer's machine.
//
//   node apps/desktop/e2e/run.mjs --brand dojix --app <binary> [--out <dir>] [--native-driver <path>]
//
// For each run it uses a fresh scratch data folder and a scratch vault namespace, then checks:
//   1. the app opens on the empty Journal with the brand's name and accent colour;
//   2. a trade added through the real write path survives a restart;
//   3. nothing in the data folder is a plaintext SQLite file, and the logs hold no trade data
//      or paths.
// Zero dependencies: a minimal WebDriver client over fetch.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const BRANDS = {
  dojix: { productName: "Dojix", accent: "#e8b44c" },
  greenwick: { productName: "Greenwick", accent: "#00d4aa" },
};
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const PORT = 4444;
const BASE = `http://127.0.0.1:${PORT}`;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

const { values: opts } = parseArgs({
  options: {
    brand: { type: "string" },
    app: { type: "string" },
    out: { type: "string", default: "e2e-output" },
    "native-driver": { type: "string" },
    driver: { type: "string", default: "tauri-driver" },
  },
});
const brand = BRANDS[opts.brand];
if (!brand || !opts.app) {
  console.error("usage: run.mjs --brand dojix|greenwick --app <binary>");
  process.exit(2);
}
mkdirSync(opts.out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(condition, message) {
  if (!condition) throw new Error(`CHECK FAILED: ${message}`);
  console.log(`ok - ${message}`);
}

async function wd(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.value ?? json)}`);
  }
  return json.value;
}

async function waitForDriver() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/status`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("tauri-driver did not start");
}

async function newSession(args) {
  const application = resolve(opts.app);
  const capabilities = { alwaysMatch: { "tauri:options": { application, args } } };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const value = await wd("POST", "/session", { capabilities });
      return value.sessionId;
    } catch (err) {
      lastError = err;
      console.log(`session attempt ${attempt} failed: ${err.message}`);
      await sleep(3000);
    }
  }
  throw lastError;
}

async function find(session, css, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const el = await wd("POST", `/session/${session}/element`, { using: "css selector", value: css });
      return el[ELEMENT];
    } catch (err) {
      if (Date.now() > end) throw new Error(`element ${css} not found: ${err.message}`, { cause: err });
      await sleep(250);
    }
  }
}

const text = (session, id) => wd("GET", `/session/${session}/element/${id}/text`);
const run = (session, script) => wd("POST", `/session/${session}/execute/sync`, { script, args: [] });

async function invoke(session, command) {
  const script = `
    const done = arguments[arguments.length - 1];
    window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})
      .then((value) => done({ ok: true, value }), (error) => done({ ok: false, error: String(error) }));`;
  const result = await wd("POST", `/session/${session}/execute/async`, { script, args: [] });
  if (!result.ok) throw new Error(`${command} failed: ${result.error}`);
  return result.value;
}

async function screenshot(session, name) {
  const png = await wd("GET", `/session/${session}/screenshot`);
  writeFileSync(join(opts.out, `${opts.brand}-${name}.png`), Buffer.from(png, "base64"));
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

async function main() {
  const driverArgs = ["--port", String(PORT)];
  if (opts["native-driver"]) driverArgs.push("--native-driver", opts["native-driver"]);
  const driver = spawn(opts.driver, driverArgs, { stdio: ["ignore", "inherit", "inherit"] });
  let failed = false;
  try {
    await waitForDriver();
    const dataDir = mkdtempSync(join(tmpdir(), `e2e-${opts.brand}-`));
    const vaultService = `e2e.${opts.brand}.${process.pid}.${Date.now()}`;
    const appArgs = ["--data-dir", dataDir, "--vault-service", vaultService];

    // Launch 1: empty journal, brand visible, add one trade.
    let session = await newSession(appArgs);
    await find(session, '[data-testid="journal-empty"]');
    check(true, `${brand.productName} opened on the empty Journal`);
    const name = await text(session, await find(session, '[data-testid="brand-name"]'));
    check(name === brand.productName, `sidebar shows "${brand.productName}" (got "${name}")`);
    const title = await text(session, await find(session, '[data-testid="screen-title"]'));
    check(title === "Journal", "the Journal screen is active");
    const accent = await run(
      session,
      "return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()",
    );
    check(accent.toLowerCase() === brand.accent, `accent colour is ${brand.accent} (got ${accent})`);
    const encrypted = await run(
      session,
      "return document.querySelector('[data-testid=\"db-status\"]').dataset.encrypted",
    );
    check(encrypted === "true", "status reports the journal as encrypted");
    await screenshot(session, "empty-journal");

    const before = await invoke(session, "e2e_status");
    check(before.dataDirIsOverride === true, "the scratch --data-dir was honoured");
    check(before.generation === 1, `a new journal is saved as generation 1 (got ${before.generation})`);
    await invoke(session, "e2e_add_trade");
    const after = await invoke(session, "e2e_status");
    check(after.generation === 2, `adding a trade saved generation 2 (got ${after.generation})`);
    await wd("DELETE", `/session/${session}`);
    await sleep(3000); // let the process exit and release journal.lock

    // Launch 2: the trade persisted.
    session = await newSession(appArgs);
    const table = await text(session, await find(session, '[data-testid="journal-table"]'));
    check(table.includes("TESTSYM"), "the added trade is listed after a restart");
    await screenshot(session, "after-restart");
    await wd("DELETE", `/session/${session}`);
    await sleep(2000);

    // Data at rest.
    const files = filesUnder(dataDir);
    const sealed = readFileSync(join(dataDir, "journal.sealed"));
    check(sealed.subarray(0, 4).toString("latin1") === "DXJN", "journal.sealed has the DXJN header");
    const plaintext = files.filter((f) => readFileSync(f).includes(SQLITE_MAGIC));
    check(plaintext.length === 0, `no plaintext SQLite anywhere in the data folder (${files.length} files)`);
    const logs = files.filter((f) => f.endsWith(".log")).map((f) => readFileSync(f, "utf8")).join("\n");
    check(logs.length > 0, "the app wrote a log");
    check(!logs.includes("TESTSYM"), "logs contain no trade data");
    check(!logs.includes(dataDir), "logs contain no data-folder path");
    writeFileSync(join(opts.out, `${opts.brand}-log.txt`), logs);
  } catch (err) {
    failed = true;
    console.error(err.stack ?? String(err));
  } finally {
    driver.kill();
  }
  process.exit(failed ? 1 : 0);
}

await main();
