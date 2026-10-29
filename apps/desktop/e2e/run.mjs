// Real-binary end-to-end tests through tauri-driver (W3C WebDriver). CI only: they launch
// the desktop app, so never run them on a maintainer's machine.
//
//   node apps/desktop/e2e/run.mjs --brand dojix --app <binary> [--out <dir>]
//        [--native-driver <path>] [--scenario all|lock|layout|no-keyring|mt5]
//
// Every run uses a fresh scratch data folder and a scratch vault namespace (except "layout",
// which checks the DEFAULT data folder of a disposable CI runner).
//
// "lock" (SPEC 12, phase 1S gate), all with fictional data:
//   1. empty journal, brand visible; a trade survives a restart;
//   2. App Lock on → password-protected backup → idle lock with an injected 3 s timeout;
//   3. restart → lock screen → 5 wrong passwords (throttle) → restart → still throttled →
//      wait → right password;
//   4. an older journal copy put back → older-copy screen → password → opens, and the save
//      count never goes down;
//   5. backup restore: wrong password refused, right password restores;
//   6. "Forgot password?" → erase → a fresh, unlocked, empty journal;
//   7. data at rest: no plaintext SQLite anywhere in the data folder; logs hold no trade data,
//      paths or passwords.
// "layout": the app started with its DEFAULT data folder keeps the web view's files outside
//   it, so that folder holds no plaintext SQLite at all.
// "no-keyring" (Linux without a Secret Service): a password is required before anything is
//   created; the wrapped key lives in the data folder; App Lock can't be turned off.
// "mt5" (SPEC 5.4, phase 5 gate; Dojix): a synthetic MetaTrader tree; auto-import is off until a
//   folder is enabled; matching files are previewed first; a file already there, a file
//   rewritten in place and a new file are imported through the real importer in the web view;
//   a deleted file is reported; a restart imports nothing twice; the whole tree is unchanged
//   byte for byte while the app watches it. Greenwick: every MT5 command answers "unsupported".
// Zero dependencies: a minimal WebDriver client over fetch.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const BRANDS = {
  dojix: { productName: "Dojix", accent: "#e8b44c", identifier: "io.github.djctwo.dojix" },
  greenwick: { productName: "Greenwick", accent: "#00d4aa", identifier: "io.github.djctwo.greenwick" },
};
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const PORT = 4444;
const BASE = `http://127.0.0.1:${PORT}`;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
// Fictional passwords for a throwaway CI journal.
const PASSWORD = "fictional-pass-1";
const WRONG = "wrong-password-x";

const { values: opts } = parseArgs({
  options: {
    brand: { type: "string" },
    app: { type: "string" },
    out: { type: "string", default: "e2e-output" },
    "native-driver": { type: "string" },
    driver: { type: "string", default: "tauri-driver" },
    scenario: { type: "string", default: "all" },
  },
});
const brand = BRANDS[opts.brand];
if (!brand || !opts.app) {
  console.error("usage: run.mjs --brand dojix|greenwick --app <binary> [--scenario ...]");
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

async function endSession(session) {
  await wd("DELETE", `/session/${session}`);
  await sleep(3000); // let the process exit and release journal.lock
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

async function absent(session, css) {
  const found = await wd("POST", `/session/${session}/elements`, { using: "css selector", value: css });
  return found.length === 0;
}

const text = (session, id) => wd("GET", `/session/${session}/element/${id}/text`);
const run = (session, script) => wd("POST", `/session/${session}/execute/sync`, { script, args: [] });
const click = (session, id) => wd("POST", `/session/${session}/element/${id}/click`, {});
const type = (session, id, value) => wd("POST", `/session/${session}/element/${id}/value`, { text: value });

/** Waits until `css` shows text matching `test` (the UI updates asynchronously). */
async function waitText(session, css, test, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      last = await text(session, await find(session, css, 2000));
      if (test(last)) return last;
    } catch {
      // re-rendering
    }
    if (Date.now() > end) throw new Error(`${css} never matched (last: "${last}")`);
    await sleep(250);
  }
}

/** Calls an app command through the real IPC. Resolves {ok, value} or {ok:false, code}. */
async function call(session, command, args = {}) {
  const script = `
    const done = arguments[arguments.length - 1];
    window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
      .then((value) => done({ ok: true, value }),
            (e) => done({ ok: false, code: e && e.code ? e.code : String(e), message: e && e.message ? e.message : "" }));`;
  return wd("POST", `/session/${session}/execute/async`, { script, args: [] });
}

async function invoke(session, command, args = {}) {
  const result = await call(session, command, args);
  if (!result.ok) throw new Error(`${command} failed: ${result.code} ${result.message}`);
  return result.value;
}

async function screenshot(session, name) {
  try {
    const png = await wd("GET", `/session/${session}/screenshot`);
    writeFileSync(join(opts.out, `${opts.brand}-${name}.png`), Buffer.from(png, "base64"));
  } catch (err) {
    console.log(`(no screenshot ${name}: ${err.message})`);
  }
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function checkAtRest(dataDir, label) {
  const files = filesUnder(dataDir);
  const plaintext = files.filter((f) => readFileSync(f).includes(SQLITE_MAGIC));
  check(
    plaintext.length === 0,
    `${label}: no plaintext SQLite anywhere in the data folder (${files.length} files${
      plaintext.length ? `; found in ${plaintext.map((f) => f.slice(dataDir.length)).join(", ")}` : ""
    })`,
  );
  const logs = files.filter((f) => f.endsWith(".log")).map((f) => readFileSync(f, "utf8")).join("\n");
  check(logs.length > 0, `${label}: the app wrote a log`);
  check(!logs.includes("TESTSYM"), `${label}: logs contain no trade data`);
  check(!logs.includes(dataDir), `${label}: logs contain no data-folder path`);
  check(!logs.includes(PASSWORD) && !logs.includes(WRONG), `${label}: logs contain no password`);
  writeFileSync(join(opts.out, `${opts.brand}-${label}-log.txt`), logs);
}

function startDriver() {
  const driverArgs = ["--port", String(PORT)];
  if (opts["native-driver"]) driverArgs.push("--native-driver", opts["native-driver"]);
  return spawn(opts.driver, driverArgs, { stdio: ["ignore", "inherit", "inherit"] });
}

function dumpLogs(dir) {
  for (const file of filesUnder(dir).filter((f) => f.endsWith(".log"))) {
    console.error(`--- ${file.slice(dir.length)}\n${readFileSync(file, "utf8")}`);
  }
}

async function unlockThroughUi(session, password) {
  const field = await find(session, '[data-testid="lock-password"]');
  await type(session, field, password);
  await click(session, await find(session, '[data-testid="lock-submit"]'));
}

// ---------------------------------------------------------------------------------------------

async function lockScenario() {
  const dataDir = mkdtempSync(join(tmpdir(), `e2e-${opts.brand}-`));
  const backupPath = join(mkdtempSync(join(tmpdir(), `e2e-backup-${opts.brand}-`)), "journal.dxbk");
  const vaultService = `e2e.${opts.brand}.${process.pid}.${Date.now()}`;
  // "--flag=value" form: msedgedriver treats every arg as a Chromium-style switch.
  const appArgs = [`--data-dir=${dataDir}`, `--vault-service=${vaultService}`];
  try {
    // Launch 1: empty journal, brand visible, add one trade, turn App Lock on, back up,
    // then the injected short idle timeout locks the app.
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

    const outcome = await invoke(session, "lock_enable", { password: PASSWORD, confirmation: PASSWORD });
    check(outcome === "complete", `App Lock turned on with a complete key rotation (${outcome})`);
    const status = await invoke(session, "lock_status");
    check(status.lockEnabled === true && status.idleLockMinutes === 15, "App Lock on, idle lock 15 min by default");

    await invoke(session, "e2e_backup_export", { path: backupPath, password: PASSWORD });
    const backup = readFileSync(backupPath);
    check(backup.subarray(0, 4).toString("latin1") === "DXBK", "the backup is a password-protected DXBK file");
    check(!backup.includes(SQLITE_MAGIC), "the backup holds no plaintext SQLite");

    await invoke(session, "e2e_set_idle_seconds", { seconds: 3 });
    await find(session, '[data-testid="lock-screen"]', 40000);
    check(true, "the idle timeout locked the app (lock screen shown)");
    const query = await call(session, "journal_query", { limit: 5 });
    check(!query.ok && query.code === "locked", `the journal is gone from memory while locked (${query.code})`);
    check(await absent(session, '[data-testid="journal-table"]'), "no journal rows in the locked document");
    await screenshot(session, "idle-locked");
    await endSession(session);

    // Launch 2: lock screen; five wrong passwords through the UI hit the throttle.
    session = await newSession(appArgs);
    await find(session, '[data-testid="lock-screen"]');
    check(await absent(session, '[data-testid="journal-table"]'), "after a restart only the lock screen shows");
    for (let n = 1; n <= 5; n++) {
      await unlockThroughUi(session, WRONG);
      const expected = n < 5 ? `Incorrect password (${n}/5)` : "Try again in 30 seconds";
      const shown = await waitText(session, '[data-testid="lock-message"]', (t) => t.includes(expected));
      check(true, `wrong password ${n}: "${shown}"`);
    }
    const throttledAt = Date.now();
    await screenshot(session, "throttled");
    await endSession(session);

    // Launch 3: the wait survived the restart; the right password works after it.
    session = await newSession(appArgs);
    const waiting = await waitText(session, '[data-testid="lock-message"]', (t) => t.includes("Try again in"));
    check(true, `the throttle survived a restart ("${waiting}")`);
    const early = await call(session, "lock_unlock", { password: PASSWORD });
    check(!early.ok && early.code === "throttled", "even the right password is not checked during the wait");
    const wait = throttledAt + 31000 - Date.now();
    if (wait > 0) await sleep(wait);
    await unlockThroughUi(session, PASSWORD);
    const table = await waitText(session, '[data-testid="journal-table"]', (t) => t.includes("TESTSYM"));
    check(table.includes("TESTSYM"), "the right password unlocks the journal and the trade is there");

    // Keep an older copy, then save once more.
    const olderCopy = readFileSync(join(dataDir, "journal.sealed"));
    await invoke(session, "e2e_add_trade");
    const newest = await invoke(session, "e2e_status");
    check(newest.trades === 2, "a second trade was saved");
    await endSession(session);
    writeFileSync(join(dataDir, "journal.sealed"), olderCopy);

    // Launch 4: the older copy is refused until the password confirms it.
    session = await newSession(appArgs);
    await find(session, '[data-testid="older-copy"]');
    check(await absent(session, '[data-testid="journal-table"]'), "the older copy is not opened silently");
    await screenshot(session, "older-copy");
    await type(session, await find(session, '[data-testid="older-password"]'), PASSWORD);
    await click(session, await find(session, '[data-testid="older-open"]'));
    await find(session, '[data-testid="journal-table"]');
    const reopened = await invoke(session, "e2e_status");
    check(reopened.trades === 1, "the confirmed older copy opened (1 trade)");
    check(
      reopened.generation > newest.generation,
      `the save count never goes down (${reopened.generation} > ${newest.generation})`,
    );

    // Restore the password-protected backup (made with 1 trade) over 3 trades.
    await invoke(session, "e2e_add_trade");
    await invoke(session, "e2e_add_trade");
    const picked = await invoke(session, "e2e_backup_pick", { path: backupPath });
    check(picked.kind === "desktop" && picked.needsPassword === true, "the backup is recognised and needs its password");
    const wrongRestore = await call(session, "backup_restore", { password: WRONG });
    check(!wrongRestore.ok && wrongRestore.code === "wrong_backup_password", "a wrong backup password is refused");
    check((await invoke(session, "e2e_status")).trades === 3, "a refused restore changes nothing");
    const summary = await invoke(session, "backup_restore", { password: PASSWORD });
    check(summary.trades === 1 && summary.source === "desktop", `the backup restored (${summary.trades} trade)`);
    check((await invoke(session, "e2e_status")).trades === 1, "the journal now holds the backup's rows");

    // "Forgot password?" from the lock screen erases everything.
    // The shell reloads the web view as it locks, so the call may not get its reply back.
    await call(session, "lock_now").catch(() => null);
    await find(session, '[data-testid="lock-screen"]');
    await click(session, await find(session, '[data-testid="forgot-password"]'));
    await type(session, await find(session, '[data-testid="erase-confirm"]'), brand.productName);
    await click(session, await find(session, '[data-testid="erase-submit"]'));
    await find(session, '[data-testid="journal-empty"]');
    const erased = await invoke(session, "lock_status");
    check(erased.phase === "unlocked" && erased.lockEnabled === false, "erase started a fresh journal with App Lock off");
    check((await invoke(session, "e2e_status")).trades === 0, "the fresh journal is empty");
    await screenshot(session, "after-erase");
    await endSession(session);

    // Launch 5: the fresh journal opens without a password.
    session = await newSession(appArgs);
    await find(session, '[data-testid="journal-empty"]');
    check(true, "after erase the app opens without a password");
    await endSession(session);

    const sealed = readFileSync(join(dataDir, "journal.sealed"));
    check(sealed.subarray(0, 4).toString("latin1") === "DXJN", "journal.sealed has the DXJN header");
    checkAtRest(dataDir, "lock");
  } catch (err) {
    dumpLogs(dataDir);
    throw err;
  }
}

async function noKeyringScenario() {
  const dataDir = mkdtempSync(join(tmpdir(), `e2e-nokey-${opts.brand}-`));
  const appArgs = [`--data-dir=${dataDir}`, `--vault-service=e2e.nokey.${opts.brand}.${process.pid}`];
  try {
    let session = await newSession(appArgs);
    await find(session, '[data-testid="setup-screen"]');
    check(!existsSync(join(dataDir, "journal.sealed")), "no keyring: nothing is created before a password");
    await screenshot(session, "no-keyring-setup");
    await type(session, await find(session, '[data-testid="setup-password"]'), PASSWORD);
    await type(session, await find(session, '[data-testid="setup-confirm"]'), PASSWORD);
    await click(session, await find(session, '[data-testid="setup-submit"]'));
    await find(session, '[data-testid="journal-empty"]');
    const status = await invoke(session, "lock_status");
    check(status.lockRequired === true && status.lockEnabled === true, "App Lock is on and required");
    check(status.vaultBackend === "data-folder", `the key is kept in the data folder (${status.vaultBackend})`);
    await invoke(session, "e2e_add_trade");
    const off = await call(session, "lock_disable", { password: PASSWORD });
    check(!off.ok && off.code === "lock_required", "App Lock can't be turned off without a keyring");
    await endSession(session);
    check(existsSync(join(dataDir, "key.wrapped")), "the wrapped key file exists");

    session = await newSession(appArgs);
    await find(session, '[data-testid="lock-screen"]');
    await unlockThroughUi(session, PASSWORD);
    await waitText(session, '[data-testid="journal-table"]', (t) => t.includes("TESTSYM"));
    check(true, "after a restart the password unlocks the journal");
    await endSession(session);
    checkAtRest(dataDir, "no-keyring");
  } catch (err) {
    dumpLogs(dataDir);
    throw err;
  }
}

/** The DEFAULT data folder (no --data-dir): the web view's files must live elsewhere. */
async function layoutScenario() {
  const isWindows = process.platform === "win32";
  const localData = isWindows
    ? process.env.LOCALAPPDATA
    : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const cache = isWindows ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dataDir = join(localData, brand.identifier);
  const webviewDir = join(cache, `${brand.identifier}.webview`);
  // Launched directly (no WebDriver), so the app uses its own production web view folder.
  const env = { ...process.env };
  delete env.WEBVIEW2_USER_DATA_FOLDER;
  delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  const child = spawn(resolve(opts.app), [`--vault-service=e2e.layout.${opts.brand}.${process.pid}`], {
    env,
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 60 && !existsSync(join(dataDir, "journal.sealed")); i++) await sleep(500);
    await sleep(12000); // give the web view time to write whatever it writes
  } finally {
    child.kill();
    await sleep(3000);
  }
  check(existsSync(join(dataDir, "journal.sealed")), "the default data folder holds the journal");
  const files = filesUnder(dataDir);
  check(!files.some((f) => /EBWebView|WebKit|IndexedDB/i.test(f)), "no web view files in the data folder");
  check(existsSync(webviewDir), `the web view folder is outside it (${webviewDir.replace(homedir(), "~")})`);
  checkAtRest(dataDir, "layout");
}

// ---------------------------------------------------------------------------------------------
// MT5 auto-import

const MT5_SAMPLE_NAME = "DojixExport_10000001_20261028.csv";
const MT5_SAMPLE = readFileSync(new URL(`../../../mql5/samples/${MT5_SAMPLE_NAME}`, import.meta.url));
const MT5_TERMINAL = "0123456789ABCDEF0123456789ABCDEF";

/** Every path under `root` with its size, modification time and SHA-256. */
function treeHash(root) {
  const lines = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        lines.push(`${path.slice(root.length)}/ ${st.mtimeMs}`);
        walk(path);
      } else {
        const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
        lines.push(`${path.slice(root.length)} ${st.size} ${st.mtimeMs} ${sha}`);
      }
    }
  };
  walk(root);
  return lines.join("\n");
}

/** The sample with every ticket shifted (another day's file) or one extra row (a rewrite). */
function mt5Variant(kind) {
  const lines = MT5_SAMPLE.toString("utf8").split("\r\n").filter((l) => l !== "");
  if (kind === "grown") lines.push(lines[lines.length - 1].replace(/^500003,/, "500004,"));
  if (kind === "other-day") for (let i = 1; i < lines.length; i++) lines[i] = lines[i].replace(/^5000/, "7000");
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

async function waitFor(what, test, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function mt5Scenario() {
  const dataDir = mkdtempSync(join(tmpdir(), `e2e-mt5-${opts.brand}-`));
  const root = mkdtempSync(join(tmpdir(), "e2e-mt5-tree-"));
  const appArgs = [`--data-dir=${dataDir}`, `--vault-service=e2e.mt5.${opts.brand}.${process.pid}`];
  const appdata = join(root, "AppData", "Roaming");
  const terminal = join(appdata, "MetaQuotes", "Terminal");
  const common = join(terminal, "Common", "Files");
  const terminalFiles = join(terminal, MT5_TERMINAL, "MQL5", "Files");
  mkdirSync(common, { recursive: true });
  mkdirSync(terminalFiles, { recursive: true });
  writeFileSync(
    join(terminal, MT5_TERMINAL, "origin.txt"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("C:\\Program Files\\Fictional Markets MT5", "utf16le")]),
  );
  writeFileSync(join(common, MT5_SAMPLE_NAME), MT5_SAMPLE);
  writeFileSync(join(common, "notes.csv"), "not,a,trade\r\n");
  const trades = async (session) => (await invoke(session, "e2e_status")).trades;
  try {
    let session = await newSession(appArgs);
    await find(session, '[data-testid="journal-empty"]');
    if (opts.brand !== "dojix") {
      for (const command of ["mt5_status", "mt5_discover", "mt5_read"]) {
        const r = await call(session, command, { token: 1 });
        check(!r.ok && r.code === "unsupported", `${brand.productName}: ${command} answers "unsupported"`);
      }
      await endSession(session);
      return;
    }
    let status = await invoke(session, "mt5_status");
    check(status.active === false && status.folders.length === 0, "MT5 auto-import is off by default");
    await invoke(session, "e2e_mt5_roots", { appdata: [appdata], programFiles: [], winePrefixes: [] });
    const locations = await invoke(session, "mt5_discover");
    check(
      locations.map((l) => `${l.kind}:${l.label}`).join("|") ===
        "common:All terminals (Common\\Files)|terminal:Fictional Markets MT5",
      "discovery lists Common\\Files and the terminal, labelled from origin.txt",
    );
    const [commonLoc, terminalLoc] = locations;
    check(
      commonLoc.tradeFiles === 1 && commonLoc.otherCsvFiles === 1 && commonLoc.preview[0].fileName === MT5_SAMPLE_NAME,
      "matching files are previewed before anything is enabled",
    );
    await sleep(3000);
    check((await trades(session)) === 0, "nothing is imported before a folder is enabled");

    status = await invoke(session, "mt5_watch_set", { id: commonLoc.id, enabled: true });
    check(status.active === true && status.folders.length === 1, "enabling Common\\Files starts the watcher");
    await waitFor("the existing file to be imported", async () => (await trades(session)) === 3);
    check(true, "a file already in the folder is imported (3 trades)");
    await screenshot(session, "mt5-imported");

    writeFileSync(join(common, MT5_SAMPLE_NAME), mt5Variant("grown"));
    await waitFor("the rewritten file to be imported", async () => (await trades(session)) === 4);
    status = await invoke(session, "mt5_status");
    check(
      status.lastImport?.inserted === 1 && status.lastImport?.duplicates === 3,
      "a file rewritten in place adds only its new row (3 duplicates skipped)",
    );

    await invoke(session, "mt5_watch_set", { id: terminalLoc.id, enabled: true });
    writeFileSync(join(terminalFiles, "DojixExport_10000001_20261029.csv"), mt5Variant("other-day"));
    await waitFor("the new terminal file to be imported", async () => (await trades(session)) === 7);
    check(true, "a new file in a second enabled folder is imported");

    rmSync(join(terminalFiles, "DojixExport_10000001_20261029.csv"));
    await waitFor("the deleted file to be reported", async () =>
      (await invoke(session, "mt5_status")).files.some(
        (f) => f.fileName === "DojixExport_10000001_20261029.csv" && f.state === "deleted",
      ),
    );
    check((await trades(session)) === 7, "deleting a file reports it and removes no trades");
    status = await invoke(session, "mt5_status");
    check(
      status.files.some((f) => f.fileName === "notes.csv" && f.state === "not_trade_file"),
      "another CSV is listed as not a trade file",
    );
    await endSession(session);

    // From here on only the app touches the tree: it must not change at all.
    const before = treeHash(root);
    session = await newSession(appArgs);
    await find(session, '[data-testid="journal-table"]');
    await invoke(session, "e2e_mt5_roots", { appdata: [appdata], programFiles: [], winePrefixes: [] });
    status = await waitFor("the watcher to restart", async () => {
      const s = await invoke(session, "mt5_status");
      return s.active && s.files.some((f) => f.fileName === MT5_SAMPLE_NAME && f.state === "imported") ? s : null;
    });
    check(status.folders.length === 2, "the enabled folders survive a restart");
    await invoke(session, "mt5_rescan");
    await sleep(5000);
    check((await trades(session)) === 7, "a restart imports nothing twice");
    await invoke(session, "mt5_discover");
    await endSession(session);
    check(treeHash(root) === before, "nothing under the watched MT5 tree changed (hash of every file and folder)");
    checkAtRest(dataDir, "mt5");
  } catch (err) {
    dumpLogs(dataDir);
    throw err;
  }
}

async function main() {
  const scenarios =
    opts.scenario === "all" ? ["lock", "layout", "mt5"] : opts.scenario.split(",").map((s) => s.trim());
  let failed = false;
  for (const scenario of scenarios) {
    console.log(`=== ${opts.brand}: ${scenario}`);
    const usesDriver = scenario !== "layout";
    const driver = usesDriver ? startDriver() : null;
    try {
      if (driver) await waitForDriver();
      if (scenario === "lock") await lockScenario();
      else if (scenario === "no-keyring") await noKeyringScenario();
      else if (scenario === "layout") await layoutScenario();
      else if (scenario === "mt5") await mt5Scenario();
      else throw new Error(`unknown scenario ${scenario}`);
    } catch (err) {
      failed = true;
      console.error(err.stack ?? String(err));
    } finally {
      driver?.kill();
      await sleep(1000);
    }
  }
  process.exit(failed ? 1 : 0);
}

await main();
