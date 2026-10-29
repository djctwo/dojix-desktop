// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_INFO, type CommandName, unavailable } from "./contract";

const tauri = new URL("../../src-tauri/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, tauri), "utf8");

/** Command names registered in lib.rs for release builds (the non-e2e generate_handler!). */
function rustCommands(): string[] {
  const blocks = [...read("src/lib.rs").matchAll(/generate_handler!\[([^\]]*)\]/g)].map((m) => m[1] as string);
  const release = blocks.filter((b) => !b.includes("e2e_"));
  expect(release).toHaveLength(1);
  return [...(release[0] as string).matchAll(/commands::(\w+)/g)].map((m) => m[1] as string);
}

const available = (Object.keys(COMMAND_INFO) as CommandName[]).filter((n) => COMMAND_INFO[n].status === "available");
const planned = (Object.keys(COMMAND_INFO) as CommandName[]).filter((n) => COMMAND_INFO[n].status === "planned");

describe("IPC contract vs src-tauri", () => {
  it("lists exactly the release commands lib.rs registers as available", () => {
    expect(rustCommands().sort()).toEqual([...available].sort());
  });

  it("allows every available command in capabilities/main.json, and nothing planned", () => {
    const caps = JSON.parse(read("capabilities/main.json")) as { permissions: string[] };
    const allowed = caps.permissions.filter((p) => p.startsWith("allow-")).map((p) => p.slice(6).replaceAll("-", "_"));
    expect(allowed.sort()).toEqual([...available].sort());
  });

  it("keeps planned commands out of Rust until the contract flips them", () => {
    const lib = read("src/lib.rs");
    for (const name of planned) expect(new RegExp(`commands::${name}\\b`).test(lib), name).toBe(false);
  });

  it("names a team and a purpose for every command", () => {
    for (const info of Object.values(COMMAND_INFO)) {
      expect(info.purpose.length).toBeGreaterThan(10);
      expect(["foundation", "ui-journal", "ui-dashboard", "ui-tools", "ui-brand"]).toContain(info.team);
    }
    expect(unavailable("journal_trades")).toEqual({
      code: "unavailable",
      message: "This build can't do that yet (journal_trades is not implemented).",
    });
  });
});

const invoke = vi.fn((...args: unknown[]) => Promise.resolve(args.length > 0 ? "ok" : "none"));
let listener: ((e: { payload: unknown }) => void) | null = null;
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (e: { payload: unknown }) => void) => {
    listener = cb;
    return Promise.resolve(unlisten);
  },
}));

describe("tauriIpc", () => {
  it("invokes available commands with named arguments and refuses planned ones", async () => {
    const { tauriIpc } = await import("../ipc");
    await expect(tauriIpc.call("journal_query", { limit: 5 })).resolves.toBe("ok");
    expect(invoke).toHaveBeenLastCalledWith("journal_query", { limit: 5 });
    await tauriIpc.call("lock_now");
    expect(invoke).toHaveBeenLastCalledWith("lock_now");
    await expect(tauriIpc.call("journal_trades")).rejects.toEqual(unavailable("journal_trades"));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("forwards events and unsubscribes, also when stopped before listen resolves", async () => {
    const { tauriIpc } = await import("../ipc");
    const handler = vi.fn();
    const stop = tauriIpc.on("save_failed", handler);
    await Promise.resolve();
    listener?.({ payload: true });
    expect(handler).toHaveBeenCalledWith(true);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    const early = tauriIpc.on("locked", handler);
    early();
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
