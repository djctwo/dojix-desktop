import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriceTick, StreamStatus } from "@dojix-desktop/core";
import { createOnlineIpc } from "../ipc/online";
import { createMockIpc, MOCK_DEFAULT_NOW, type MockOptions } from "./mockIpc";
import { mockDigest, mockPrice } from "./online";

const make = (o: Partial<MockOptions> = {}) => {
  const ipc = createMockIpc(
    { brand: "dojix", productName: "Dojix", fixture: "f1", gate: "none", now: MOCK_DEFAULT_NOW, latencyMs: 0, fail: [], online: false, ...o },
    [],
  );
  return { ipc, online: createOnlineIpc(ipc) };
};

afterEach(() => vi.useRealTimers());

describe("mock online commands (docs/ONLINE.md)", () => {
  it("start switched off with no keys, like the app, and never return a key", async () => {
    const { online } = make();
    const s = await online.settings();
    expect(s).toMatchObject({ aiEnabled: false, liveSource: "off", finnhubEnabled: false, calendarEnabled: true, aiConsented: false });
    expect(Object.values(s.keys).every((v) => v === false)).toBe(true);
    await online.setSecret("anthropic_api_key", "sk-fictional-key");
    expect(await online.hasSecret("anthropic_api_key")).toBe(true);
    expect(JSON.stringify(await online.settings())).not.toContain("sk-fictional-key");
    await expect(online.setSecret("finnhub_api_key", "x")).rejects.toMatchObject({ code: "invalid" });
    await expect(online.setSecret("polygon_api_key", "bad key")).rejects.toMatchObject({ code: "invalid" });
    await online.deleteSecret("anthropic_api_key");
    expect(await online.hasSecret("anthropic_api_key")).toBe(false);
    expect(await online.testConnection("anthropic")).toEqual({ ok: false, message: "No key is stored for this provider." });
    expect((await online.testConnection("mt5_file")).ok).toBe(true);
  });

  it("AI: preview, then off / no_key / consent_required / preview_mismatch, then a saved report", async () => {
    const { online } = make();
    expect((await online.aiModels()).map((m) => m.id)).toContain("claude-opus-5-5");
    const preview = await online.aiPreview("Fictional summary");
    expect(preview.headers.find(([h]) => h === "x-api-key")?.[1]).not.toMatch(/sk-/);
    expect(preview.requestSha256).toBe(mockDigest(preview.body));
    expect(preview.byteCount).toBe(preview.body.length);
    await expect(online.aiRun("Fictional summary", preview.requestSha256, false)).rejects.toMatchObject({ code: "off" });
    await online.updateSettings({ aiEnabled: true, aiModel: "claude-sonnet-5-5" });
    await expect(online.aiRun("Fictional summary", preview.requestSha256, false)).rejects.toMatchObject({ code: "no_key" });
    await online.setSecret("anthropic_api_key", "sk-fictional");
    const p2 = await online.aiPreview("Fictional summary");
    await expect(online.aiRun("Fictional summary", preview.requestSha256, false)).rejects.toMatchObject({ code: "preview_mismatch" });
    await expect(online.aiRun("Fictional summary", p2.requestSha256, false)).rejects.toMatchObject({ code: "consent_required" });
    const report = await online.aiRun("Fictional summary", p2.requestSha256, true);
    expect(report.responseText).toContain("Fictional");
    expect((await online.settings()).aiConsented).toBe(true);
    expect(await online.aiReports(10)).toEqual([report]);
    await online.deleteAiReport(report.id);
    expect(await online.aiReports(10)).toEqual([]);
    expect((await online.updateSettings({ aiModel: "" })).aiModel).toBe("claude-opus-5-5");
  });

  it("live prices: off without a source, then ticks and status events until stopped", async () => {
    vi.useFakeTimers();
    const { online } = make();
    await expect(online.quotesStart(["EURUSD"])).rejects.toMatchObject({ code: "off" });
    await online.updateSettings({ liveSource: "twelve_data_ws" });
    const ticks: PriceTick[] = [];
    const states: StreamStatus[] = [];
    const stopT = online.onQuoteTick((t) => ticks.push(t));
    const stopS = online.onQuoteStatus((s) => states.push(s));
    const started = await online.quotesStart(["EURUSD", "GBP/USD"]);
    expect(started.symbols).toEqual(["EUR/USD", "GBP/USD"]);
    expect(started.latest).toHaveLength(2);
    expect(states).toEqual([{ state: "connected" }]);
    vi.advanceTimersByTime(4000);
    expect(ticks).toHaveLength(4);
    expect(ticks[0]!.ask).toBeGreaterThan(ticks[0]!.bid);
    expect((await online.quotesStatus()).status).toEqual({ state: "connected" });
    await online.updateSettings({ liveSource: "polygon_ws" });
    expect((await online.quotesStatus()).symbols).toEqual([]);
    await online.quotesStop();
    expect(states.at(-1)).toEqual({ state: "disconnected" });
    vi.advanceTimersByTime(4000);
    expect(ticks).toHaveLength(4);
    stopT();
    stopS();
  });

  it("calendar: a fictional week, and off when switched off", async () => {
    const { online } = make();
    const week = await online.calendarWeek(false);
    expect(week.events.length).toBeGreaterThan(2);
    expect(week.stale).toBe(false);
    for (const e of week.events) expect(e.title).toContain("Fictional");
    await online.updateSettings({ calendarEnabled: false });
    await expect(online.calendarWeek(true)).rejects.toMatchObject({ code: "off" });
  });

  it("Finnhub (Greenwick): off, no_key, then quotes, profiles and search", async () => {
    const { online } = make({ brand: "greenwick", productName: "Greenwick" });
    await expect(online.finnhubQuote("FIXA")).rejects.toMatchObject({ code: "off" });
    await online.updateSettings({ finnhubEnabled: true });
    await expect(online.finnhubSearch("fix")).rejects.toMatchObject({ code: "no_key" });
    await online.setSecret("finnhub_api_key", "fictional");
    expect((await online.finnhubQuote("FIXA")).currentPrice).toBeCloseTo(mockPrice("FIXA"));
    expect((await online.finnhubProfile("FIXA")).name).toContain("Fictional");
    expect((await online.finnhubSearch("fix.")).map((r) => r.symbol)).toEqual(["FIX.B"]);
    expect(await online.finnhubSearch("  ")).toEqual([]);
    await expect(online.quotesStart(["FIXA"])).rejects.toMatchObject({ code: "unsupported" });
    await expect(online.oandaFetchHistory(30)).rejects.toMatchObject({ code: "unsupported" });
    const dojix = make().online;
    await expect(dojix.finnhubQuote("FIXA")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("OANDA import and the ?online=on start; every command needs an unlocked journal", async () => {
    const { online } = make({ online: true });
    const s = await online.settings();
    expect(s).toMatchObject({ aiEnabled: true, liveSource: "twelve_data_rest" });
    expect(Object.values(s.keys).every(Boolean)).toBe(true);
    expect((await online.oandaFetchHistory(null)).pages).toBe(0);
    await online.deleteSecret("oanda_account_id");
    await expect(online.oandaFetchHistory(7)).rejects.toMatchObject({ code: "no_key" });
    const locked = make({ gate: "locked" }).online;
    await expect(locked.settings()).rejects.toMatchObject({ code: "locked" });
    expect(mockPrice("EURUSD")).toBeLessThan(2);
  });
});
