import { describe, expect, it, vi } from "vitest";
import type { StoredTrade } from "@dojix-desktop/core";
import { loadFixture, parseFixture } from "./fixtures";
import { createMockIpc, MOCK_DEFAULT_NOW, MOCK_PASSWORD, mockOptionsFromSearch, type MockOptions } from "./mockIpc";

const options = (o: Partial<MockOptions> = {}): MockOptions => ({
  brand: "dojix",
  productName: "Dojix",
  fixture: "f1",
  gate: "none",
  now: MOCK_DEFAULT_NOW,
  latencyMs: 0,
  fail: [],
  online: false,
  ...o,
});

describe("mock options", () => {
  it("reads the query string and falls back to defaults", () => {
    expect(mockOptionsFromSearch("?fixture=empty&gate=locked&now=2026-01-02T00:00:00Z&latency=50&fail=journal_trades,nope", "greenwick", "Greenwick")).toEqual({
      brand: "greenwick",
      productName: "Greenwick",
      fixture: "empty",
      gate: "locked",
      now: Date.parse("2026-01-02T00:00:00Z"),
      latencyMs: 50,
      fail: ["journal_trades"],
      online: false,
    });
    expect(mockOptionsFromSearch("?fixture=bad&gate=bad&latency=-1&now=bad", "dojix", "Dojix")).toMatchObject({
      fixture: "f2",
      gate: "none",
      now: MOCK_DEFAULT_NOW,
      latencyMs: 0,
      fail: [],
    });
  });
});

describe("fixtures", () => {
  it("loads both brands' fictional journals in repository order", async () => {
    const dojix = await loadFixture("f2", "dojix");
    const greenwick = await loadFixture("f1", "greenwick");
    expect(dojix).toHaveLength(600);
    expect(dojix[0]!.closeTime >= dojix[1]!.closeTime).toBe(true);
    expect(greenwick[0]?.symbol).toBe("FIXA");
    expect(await loadFixture("empty", "dojix")).toEqual([]);
    expect(() => parseFixture("{}")).toThrow(/no trades/);
  });
});

describe("mock IPC", () => {
  it("answers the Phase 1 commands from the fixture", async () => {
    const trades = await loadFixture("f1", "dojix");
    const ipc = createMockIpc(options(), trades);
    expect((await ipc.call("app_info")).storage).toEqual({ kind: "ready", encrypted: true, schemaVersion: 1, setAside: false });
    const rows = await ipc.call("journal_query", { limit: 2 });
    expect(rows).toEqual([{ id: 5, symbol: "EURUSD", direction: "BUY", closeTime: trades[0]?.closeTime, netProfit: "80" }]
      .concat([{ id: trades[1]!.id, symbol: trades[1]!.symbol, direction: trades[1]!.direction, closeTime: trades[1]!.closeTime, netProfit: trades[1]!.netProfit }]));
    expect(await ipc.call("journal_trades")).toHaveLength(5);
    expect(ipc.calls).toEqual(["app_info", "journal_query", "journal_trades"]);
  });

  it("runs the lock flows with the fictional password", async () => {
    const ipc = createMockIpc(options({ gate: "locked" }), []);
    expect((await ipc.call("lock_status")).phase).toBe("locked");
    await expect(ipc.call("journal_query", { limit: 1 })).rejects.toMatchObject({ code: "locked" });
    await expect(ipc.call("lock_unlock", { password: "x" })).rejects.toMatchObject({ message: "Incorrect password (1/5)" });
    expect((await ipc.call("lock_unlock", { password: MOCK_PASSWORD })).phase).toBe("unlocked");
    expect(await ipc.call("lock_change", { current: "a", password: "b", confirmation: "b" })).toBe("complete");
    const locked = vi.fn();
    ipc.on("locked", locked);
    expect(await ipc.call("lock_now")).toBe(true);
    expect(locked).toHaveBeenCalled();
    expect((await ipc.call("lock_status")).phase).toBe("locked");
    await expect(ipc.call("erase_all", { confirmation: "nope" })).rejects.toMatchObject({ code: "confirmation" });
    const erased = await ipc.call("erase_all", { confirmation: "Dojix" });
    expect(erased).toMatchObject({ phase: "unlocked", lockEnabled: false });
    expect(await ipc.call("lock_now")).toBe(false);
    expect(await ipc.call("lock_enable", { password: "a", confirmation: "a" })).toBe("complete");
    expect((await ipc.call("lock_disable", { password: "a" })).lockEnabled).toBe(false);
    await ipc.call("prefs_set_idle", { minutes: 5 });
    expect((await ipc.call("lock_status")).idleLockMinutes).toBe(5);
  });

  it("older copy, setup, failed and storage-error gates", async () => {
    const older = createMockIpc(options({ gate: "olderCopy" }), []);
    await expect(older.call("older_copy_open", { password: null, confirmed: false })).rejects.toMatchObject({ code: "not_confirmed" });
    expect((await older.call("older_copy_open", { password: MOCK_PASSWORD, confirmed: true })).phase).toBe("unlocked");
    const setup = createMockIpc(options({ gate: "setup" }), []);
    expect((await setup.call("lock_status")).lockRequired).toBe(true);
    expect((await setup.call("lock_setup", { password: "a", confirmation: "a" })).lockEnabled).toBe(true);
    expect((await createMockIpc(options({ gate: "lockFailed" }), []).call("lock_status")).phase).toBe("failed");
    expect((await createMockIpc(options({ gate: "storageError" }), []).call("app_info")).storage.kind).toBe("error");
  });

  it("mutates the journal, emits trades_changed and undoes deletes", async () => {
    const trades = await loadFixture("f1", "dojix");
    const ipc = createMockIpc(options(), trades);
    const changed = vi.fn();
    const stop = ipc.on("trades_changed", changed);
    const id = trades[0]!.id;
    await ipc.call("journal_mutate", { mutation: { kind: "notes", id, notes: "fictional note" } });
    await ipc.call("journal_mutate", { mutation: { kind: "tags", id, tags: ["a", "b"] } });
    await ipc.call("journal_mutate", { mutation: { kind: "emotion", id, emotion: "CALM" } });
    await ipc.call("journal_mutate", { mutation: { kind: "checklist", id, checklist: { "Followed my plan": true } } });
    await ipc.call("journal_mutate", { mutation: { kind: "costs", id, commission: "1.5", swap: "0" } });
    await ipc.call("journal_mutate", { mutation: { kind: "edit", id, fields: { comment: "edited" } } });
    const t = ipc.trades().find((x) => x.id === id) as StoredTrade;
    expect([t.notes, t.tags, t.emotion, t.checklist, t.commission, t.comment]).toEqual([
      "fictional note",
      '["a","b"]',
      "CALM",
      '{"Followed my plan":true}',
      "1.5",
      "edited",
    ]);
    await Promise.resolve();
    expect(changed).toHaveBeenCalled();
    await expect(ipc.call("journal_mutate", { mutation: { kind: "notes", id: 999, notes: "" } })).rejects.toMatchObject({ code: "not_found" });
    const del = await ipc.call("journal_mutate", { mutation: { kind: "delete", ids: [id] } });
    expect(del.changed).toBe(1);
    expect(ipc.trades()).toHaveLength(4);
    await ipc.call("journal_mutate", { mutation: { kind: "restoreDeleted", token: del.undoToken as string } });
    expect(ipc.trades()).toHaveLength(5);
    expect(ipc.trades()[0]?.id).toBe(id);
    await expect(ipc.call("journal_mutate", { mutation: { kind: "restoreDeleted", token: "old" } })).rejects.toMatchObject({ code: "undo_expired" });
    const all = await ipc.call("journal_mutate", { mutation: { kind: "deleteAll" } });
    expect(all.changed).toBe(5);
    await ipc.call("journal_mutate", {
      mutation: {
        kind: "add",
        trade: {
          symbol: "EURUSD",
          direction: "SELL",
          quantity: 0.1,
          openTime: "2026-09-01 10:00:00.000",
          closeTime: "2026-09-01 11:00:00.000",
          openPrice: "1.1",
          closePrice: "1.09",
          sl: "0",
          tp: "0",
          commission: "0",
          swap: "0",
          notes: "",
          tags: [],
        },
      },
    });
    expect(ipc.trades()[0]?.source).toBe("manual");
    stop();
  });

  it("serves the planned settings, prefs, lists and fictional market data", async () => {
    const trades = await loadFixture("f1", "greenwick");
    const ipc = createMockIpc(options({ brand: "greenwick", productName: "Greenwick" }), trades);
    await ipc.call("settings_set", { key: "propFirm", value: { size: 100000 } });
    expect(await ipc.call("settings_get", { key: "propFirm" })).toEqual({ size: 100000 });
    expect(await ipc.call("settings_get", { key: "missing" })).toBeNull();
    await ipc.call("prefs_set", { key: "mode", value: "essential" });
    expect(await ipc.call("prefs_get")).toEqual({ mode: "essential" });
    const c = await ipc.call("checkpoints_add", { date: "2026-01-01", title: "New rule", description: "" });
    expect(await ipc.call("checkpoints_list")).toEqual([c]);
    await ipc.call("checkpoints_delete", { id: c.id });
    expect(await ipc.call("checkpoints_list")).toEqual([]);
    await ipc.call("checklist_rules_set", { rules: ["One"] });
    expect(await ipc.call("checklist_rules_get")).toEqual(["One"]);
    expect(await ipc.call("watchlist_get")).toEqual(["FIXA"]);
    await ipc.call("watchlist_set", { symbols: ["FIXB"] });
    expect(await ipc.call("watchlist_get")).toEqual(["FIXB"]);
    expect(await ipc.call("data_info")).toEqual({ trades: 5, sampleTrades: 0, journalBytes: 4500 });
    expect(await ipc.call("backup_export", { password: null, confirmation: null })).toContain("Fictional");
    expect((await ipc.call("backup_pick"))?.kind).toBe("desktop");
    expect((await ipc.call("backup_restore", { password: null })).trades).toBe(5);
    for (const name of ["screenshot_list", "import_history", "mapping_presets_list", "mt5_discover"] as const) {
      expect(await (ipc.call as (n: string, a?: unknown) => Promise<unknown>)(name, { tradeId: 1 })).toEqual([]);
    }
    expect(await ipc.call("has_secret", { account: "finnhub_api_key" })).toBe(false);
    expect((await ipc.call("updates_check")).available).toBe(false);
    expect(await ipc.call("export_save", { kind: "pdf", suggestedName: "Report.pdf", base64: "" })).toBe("Report.pdf");
    expect(await ipc.call("clipboard_write_temporary", { text: "x", clearAfterSeconds: 30 })).toBeNull();
    expect(await ipc.call("lock_activity")).toBeNull();
    expect(await ipc.call("app_quit", { force: false })).toBeNull();
    await expect(ipc.call("import_commit", { token: "t", mappings: {} })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("fails on request and adds latency", async () => {
    vi.useFakeTimers();
    const ipc = createMockIpc(options({ fail: ["lock_status"], latencyMs: 200 }), []);
    const p = ipc.call("lock_status");
    const assertion = expect(p).rejects.toMatchObject({ code: "mock_failure" });
    vi.advanceTimersByTime(200);
    await assertion;
    vi.useRealTimers();
  });
});
