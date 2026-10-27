// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("IPC boundary", () => {
  it("only src/ipc.ts imports @tauri-apps/api", () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const roots = ["apps/desktop/src", "packages", "brands"].map((r) => join(repo, r));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (readFileSync(path, "utf8").includes("@tauri-apps/")) offenders.push(relative(repo, path));
        }
      }
    };
    roots.forEach(walk);
    expect(offenders.map((p) => p.replaceAll("\\", "/"))).toEqual(["apps/desktop/src/ipc.ts"]);
  });
});
