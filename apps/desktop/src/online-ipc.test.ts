// @vitest-environment node
// The typed online bindings call exactly the shell's online commands, with the argument names
// Tauri expects (Rust snake_case parameters arrive as camelCase).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: unknown }[] = [];
const listeners: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.push(event);
    handler({ payload: { state: "connected" } });
    return () => undefined;
  }),
}));

const { tauriOnlineIpc } = await import("./ipc");

const rustCommands = (): string[] => {
  const src = readFileSync(fileURLToPath(new URL("../src-tauri/src/net/commands.rs", import.meta.url)), "utf8");
  const list = src.slice(src.indexOf("pub const COMMANDS"));
  return [...list.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1] ?? "");
};

describe("online IPC bindings", () => {
  beforeEach(() => {
    calls.length = 0;
    listeners.length = 0;
  });

  it("cover every online command with the right argument names", async () => {
    const ipc = tauriOnlineIpc;
    await ipc.settings();
    await ipc.updateSettings({ aiEnabled: true });
    await ipc.setSecret("anthropic_api_key", "sk-fictional");
    await ipc.hasSecret("finnhub_api_key");
    await ipc.deleteSecret("polygon_api_key");
    await ipc.testConnection("oanda_import");
    await ipc.aiModels();
    await ipc.aiPreview("prompt");
    await ipc.aiRun("prompt", "abc", true);
    await ipc.aiReports(20);
    await ipc.deleteAiReport(3);
    await ipc.quotesStart(["EUR/USD"]);
    await ipc.quotesStop();
    await ipc.quotesStatus();
    await ipc.calendarWeek(false);
    await ipc.finnhubQuote("FICT");
    await ipc.finnhubProfile("FICT");
    await ipc.finnhubSearch("fict");
    await ipc.oandaFetchHistory(null);
    expect(calls.map((c) => c.cmd).sort()).toEqual(rustCommands().sort());
    const args = Object.fromEntries(calls.map((c) => [c.cmd, c.args]));
    expect(args.ai_run).toEqual({ prompt: "prompt", requestSha256: "abc", consent: true });
    expect(args.online_settings_set).toEqual({ patch: { aiEnabled: true } });
    expect(args.set_secret).toEqual({ account: "anthropic_api_key", value: "sk-fictional" });
    expect(args.oanda_fetch_history).toEqual({ days: null });
    expect(args.ai_reports_list).toEqual({ limit: 20 });
  });

  it("subscribes to the price events and can unsubscribe", async () => {
    const ticks: unknown[] = [];
    const stopTicks = tauriOnlineIpc.onQuoteTick((t) => ticks.push(t));
    const stopStatus = tauriOnlineIpc.onQuoteStatus((s) => ticks.push(s));
    await Promise.resolve();
    await Promise.resolve();
    stopTicks();
    stopStatus();
    const early = tauriOnlineIpc.onQuoteTick(() => undefined);
    early();
    await Promise.resolve();
    expect(listeners).toEqual(["quote_tick", "quote_status", "quote_tick"]);
    expect(ticks.length).toBe(2);
  });
});
