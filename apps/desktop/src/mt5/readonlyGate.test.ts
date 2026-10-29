// @vitest-environment node
// SPEC §5.4 "Strictly read-only": the Rust MT5 module (src-tauri/src/mt5/) reaches MT5's files
// only through `mt5::ro` (list, stat, read). This gate fails the build if any file there gains a
// write, create, rename, delete or permission API, or if anything but ro.rs touches std::fs.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../src-tauri/src/mt5/", import.meta.url));

const FORBIDDEN: readonly RegExp[] = [
  /\bfs::write\b/,
  /\bFile::create\b/,
  /\bFile::create_new\b/,
  /\.write\s*\(/,
  /\.write_all\s*\(/,
  /\.append\s*\(/,
  /\.create\s*\(/,
  /\.create_new\s*\(/,
  /\.truncate\s*\(/,
  /\.set_len\s*\(/,
  /\bremove_file\b/,
  /\bremove_dir(_all)?\b/,
  /\brename\s*\(/,
  /\bfs::copy\b/,
  /\bcreate_dir(_all)?\b/,
  /\bset_permissions\b/,
  /\bset_readonly\b/,
  /\bset_modified\b/,
  /\bset_times\b/,
  /\bhard_link\b/,
  /\bsymlink(_file|_dir)?\s*\(/,
  /\bwrite_atomic\b/,
  /\bcreate_private_dir\b/,
  /\bfsec::/,
  /\bwriteln?!\s*\(/,
  /\bio::Write\b/,
  /\bCommand::new\b/,
];

/** Only ro.rs may name the file-system API at all. */
const FS_API = /\b(std::fs|fs::|File::|OpenOptions)\b|\bFile\b(?!-name|_)/;

/** Rust source without comments (so doc comments may describe what is forbidden). */
function code(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".rs"));

describe("MT5 module is read-only", () => {
  it("has its sources here", () => {
    expect(files.sort()).toEqual(["discover.rs", "mod.rs", "ro.rs", "watch.rs"]);
  });

  for (const file of files) {
    it(`${file} uses no write, rename, delete or permission API`, () => {
      const text = code(readFileSync(DIR + file, "utf8"));
      const hits = FORBIDDEN.filter((re) => re.test(text)).map(String);
      expect(hits).toEqual([]);
    });
  }

  it("only ro.rs touches std::fs, and it opens files for reading only", () => {
    for (const file of files.filter((f) => f !== "ro.rs")) {
      const text = code(readFileSync(DIR + file, "utf8"));
      expect(FS_API.test(text), file).toBe(false);
    }
    const ro = code(readFileSync(`${DIR}ro.rs`, "utf8"));
    const optionCalls = [...ro.matchAll(/options\.(\w+)\(/g)].map((m) => m[1]);
    expect(new Set(optionCalls)).toEqual(new Set(["read", "share_mode", "custom_flags", "open"]));
    expect(ro).toContain("options.read(true)");
  });

  it("the gate itself catches write APIs", () => {
    const bad = ['std::fs::write(p, b"x")', "OpenOptions::new().write(true)", "fs::rename(a, b)", "std::fs::remove_file(p)"];
    for (const sample of bad) expect(FORBIDDEN.some((re) => re.test(sample)), sample).toBe(true);
  });
});
