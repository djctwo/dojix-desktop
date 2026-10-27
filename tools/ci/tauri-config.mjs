// CI helper: prints the JSON merge (RFC 7386) of Tauri config overlays, for the TAURI_CONFIG
// environment variable that plain `cargo` builds read (the Tauri CLI does this itself).
//   node tools/ci/tauri-config.mjs apps/desktop/src-tauri/tauri.dojix.conf.json [more.json ...]
import { readFileSync } from "node:fs";

function merge(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

const merged = process.argv
  .slice(2)
  .map((file) => JSON.parse(readFileSync(file, "utf8")))
  .reduce((acc, patch) => merge(acc, patch), {});
delete merged.$schema;
process.stdout.write(JSON.stringify(merged));
