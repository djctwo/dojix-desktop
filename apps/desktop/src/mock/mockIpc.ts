// The mock IPC: the whole `Ipc` contract in memory, over fictional fixture journals. Used by
// `vite --mode <brand>` with VITE_IPC=mock (dev), the Playwright specs, and unit tests. It never
// ships in a release build (main.tsx imports it only when VITE_IPC is "mock"; ci.yml checks).
//
// URL parameters (mock builds only):
//   ?fixture=f2|f1|empty   journal to load (default f2: a year of trades)
//   ?gate=none|locked|setup|olderCopy|storageError|lockFailed|setAside|saveFailing
//                          launch gate or banner (default none)
//   ?now=2026-09-30T12:00:00Z  "now" for analytics (default: that instant, so screenshots are stable)
//   ?latency=300           ms delay on every call (loading states)
//   ?fail=journal_trades,quotes_get  commands that reject (error states)

import {
  type AppInfo,
  type BrandId,
  type JournalRow,
  type LockStatus,
  type StoredTrade,
} from "@dojix-desktop/core";
import {
  COMMAND_INFO,
  type CallArgs,
  type CommandName,
  type EconomicEvent,
  type EventName,
  type Events,
  type Ipc,
  type JournalMutation,
  type MutationResult,
  type ResultOf,
  type StrategyCheckpoint,
} from "../ipc/contract";
import type { MockFixture } from "./fixtures";

export type MockGate = "none" | "locked" | "setup" | "olderCopy" | "storageError" | "lockFailed" | "setAside" | "saveFailing";

export interface MockOptions {
  brand: BrandId;
  productName: string;
  fixture: MockFixture;
  gate: MockGate;
  /** Epoch ms used as "now" by the analytics (and the sample clock). */
  now: number;
  latencyMs: number;
  fail: readonly CommandName[];
}

/** The App Lock password of every mock gate. Fictional, test-only. */
export const MOCK_PASSWORD = "fictional-pass-1";
export const MOCK_DEFAULT_NOW = Date.parse("2026-09-30T12:00:00Z");

const GATES: readonly MockGate[] = ["none", "locked", "setup", "olderCopy", "storageError", "lockFailed", "setAside", "saveFailing"];
const FIXTURES: readonly MockFixture[] = ["f2", "f1", "empty"];

/** Reads the mock options from a query string (unknown values fall back to the defaults). */
export function mockOptionsFromSearch(search: string, brand: BrandId, productName: string): MockOptions {
  const q = new URLSearchParams(search);
  const fixture = q.get("fixture");
  const gate = q.get("gate");
  const now = Date.parse(q.get("now") ?? "");
  const latency = Number(q.get("latency"));
  const fail = (q.get("fail") ?? "")
    .split(",")
    .filter((n): n is CommandName => n in COMMAND_INFO);
  return {
    brand,
    productName,
    fixture: FIXTURES.includes(fixture as MockFixture) ? (fixture as MockFixture) : "f2",
    gate: GATES.includes(gate as MockGate) ? (gate as MockGate) : "none",
    now: Number.isFinite(now) ? now : MOCK_DEFAULT_NOW,
    latencyMs: Number.isFinite(latency) && latency > 0 ? Math.min(latency, 10_000) : 0,
    fail,
  };
}

const THROTTLE = { attempts: 0, waitSeconds: 0, unreadable: false, message: null };

type Handler = (args: never) => unknown;

export interface MockIpc extends Ipc {
  /** Sends a shell event to the subscribers (tests drive `trades_changed`, `save_failed`, …). */
  emit<E extends EventName>(event: E, payload: Events[E]): void;
  /** Current in-memory trades (tests assert on mutations). */
  trades(): readonly StoredTrade[];
  /** Commands called so far, in order. */
  readonly calls: CommandName[];
}

function toRow(t: StoredTrade): JournalRow {
  return { id: t.id, symbol: t.symbol, direction: t.direction, closeTime: t.closeTime, netProfit: t.netProfit };
}

/** Deterministic fictional price for a symbol (no network in the mock). */
function fakePrice(symbol: string): number {
  let h = 2166136261;
  for (const c of symbol) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const forex = /^[A-Z]{6}$/.test(symbol);
  return forex ? 0.6 + (h % 9000) / 10000 : 20 + (h % 40000) / 100;
}

export function createMockIpc(options: MockOptions, initial: readonly StoredTrade[]): MockIpc {
  let trades: StoredTrade[] = [...initial];
  let deleted: { token: string; rows: StoredTrade[] } | null = null;
  let tokenSeq = 0;
  let wrong = 0;
  const lockEnabled = options.gate === "locked" || options.gate === "setup" || options.gate === "olderCopy";
  const base = {
    lockEnabled,
    lockRequired: options.gate === "setup",
    vaultBackend: "mock",
    throttle: THROTTLE,
    idleLockMinutes: 15,
    saveFailing: options.gate === "saveFailing",
    setAside: options.gate === "setAside",
  };
  let status: LockStatus =
    options.gate === "locked"
      ? { phase: "locked", vaultUnreadable: false, held: false, ...base }
      : options.gate === "setup"
        ? { phase: "setup", ...base }
        : options.gate === "olderCopy"
          ? {
              phase: "olderCopy",
              fileSavedAtMs: options.now - 86_400_000 * 3,
              fileGeneration: 3,
              recordSavedAtMs: options.now - 86_400_000,
              recordGeneration: 9,
              needsPassword: true,
              ...base,
            }
          : options.gate === "lockFailed"
            ? { phase: "failed", code: "vault_failed", message: "The system keyring did not answer.", ...base }
            : { phase: "unlocked", ...base };
  const settings = new Map<string, unknown>();
  const prefs: Record<string, unknown> = {};
  let checkpoints: StrategyCheckpoint[] = [];
  let checklist: string[] = ["Followed my plan", "Waited for confirmation", "Risk within limits"];
  let watchlist: string[] = [...new Set(initial.map((t) => t.symbol))].slice(0, 5);
  const listeners = new Map<EventName, Set<(payload: unknown) => void>>();
  const calls: CommandName[] = [];

  const unlocked = () => {
    if (status.phase !== "unlocked") throw { code: "locked", message: "The journal is locked." };
  };
  const emit = <E extends EventName>(event: E, payload: Events[E]) => {
    for (const h of listeners.get(event) ?? []) h(payload);
  };
  const setUnlocked = (extra: Partial<typeof base> = {}): LockStatus => {
    status = { phase: "unlocked", ...base, lockEnabled: status.lockEnabled, ...extra };
    return status;
  };
  const touch = (t: StoredTrade, fields: Partial<StoredTrade>): StoredTrade => ({
    ...t,
    ...fields,
    updatedAt: new Date(options.now).toISOString().replace("T", " ").replace("Z", ""),
  });
  const mutate = (m: JournalMutation): MutationResult => {
    unlocked();
    const byId = (id: number) => {
      const t = trades.find((x) => x.id === id);
      if (!t) throw { code: "not_found", message: "That trade no longer exists." };
      return t;
    };
    const replace = (id: number, fields: Partial<StoredTrade>) => {
      const t = byId(id);
      trades = trades.map((x) => (x.id === id ? touch(t, fields) : x));
      return { changed: 1 };
    };
    switch (m.kind) {
      case "notes":
        return replace(m.id, { notes: m.notes });
      case "tags":
        return replace(m.id, { tags: JSON.stringify(m.tags) });
      case "emotion":
        return replace(m.id, { emotion: m.emotion });
      case "checklist":
        return replace(m.id, { checklist: JSON.stringify(m.checklist) });
      case "costs":
        return replace(m.id, { commission: m.commission, swap: m.swap });
      case "edit":
        return replace(m.id, m.fields);
      case "delete":
      case "deleteAll": {
        const ids = m.kind === "deleteAll" ? new Set(trades.map((t) => t.id)) : new Set(m.ids);
        const rows = trades.filter((t) => ids.has(t.id));
        trades = trades.filter((t) => !ids.has(t.id));
        const token = `undo-${++tokenSeq}`;
        deleted = { token, rows };
        return { changed: rows.length, undoToken: token };
      }
      case "restoreDeleted": {
        if (!deleted || deleted.token !== m.token) throw { code: "undo_expired", message: "Nothing to undo." };
        const rows = deleted.rows;
        trades = [...trades, ...rows].sort((a, b) => (a.closeTime < b.closeTime ? 1 : a.closeTime > b.closeTime ? -1 : b.id - a.id));
        deleted = null;
        return { changed: rows.length };
      }
      case "add": {
        const id = Math.max(0, ...trades.map((t) => t.id)) + 1;
        const t = m.trade;
        const row: StoredTrade = {
          id,
          ticket: String(800000 + id),
          source: "manual",
          externalId: null,
          isSample: false,
          accountId: 1,
          importBatchId: null,
          symbol: t.symbol,
          direction: t.direction,
          quantity: t.quantity,
          openTime: t.openTime,
          closeTime: t.closeTime,
          timeBasis: "utc",
          durationMin: 0,
          openPrice: t.openPrice,
          closePrice: t.closePrice,
          sl: t.sl,
          tp: t.tp,
          netProfit: "0",
          commission: t.commission,
          swap: t.swap,
          mae: null,
          mfe: null,
          rMultiple: null,
          session: options.brand === "dojix" ? "LONDON" : "REGULAR",
          dayOfWeek: "Mon",
          hour: 0,
          timeToMfeMin: null,
          slDist: null,
          slippage: null,
          rangeSize: null,
          hitBreakeven: null,
          scaledIn: null,
          sweepDepth: null,
          usedFvg: null,
          volRegime: null,
          magic: null,
          postClose15m: null,
          postClose30m: null,
          biasAtEntry: null,
          sector: null,
          industry: null,
          volume: null,
          avgVolume: null,
          comment: "",
          notes: t.notes,
          tags: JSON.stringify(t.tags),
          emotion: null,
          checklist: "{}",
          importedAt: t.closeTime,
          updatedAt: t.closeTime,
        };
        trades = [row, ...trades];
        return { changed: 1 };
      }
    }
  };

  const handlers: { [K in CommandName]?: (args: CallArgs<K>[0]) => ResultOf<K> } = {
    app_info: (): AppInfo => ({
      brand: options.brand,
      productName: options.productName,
      version: "0.1.0-mock",
      dataDirSource: "override",
      vaultBackend: "mock",
      storage:
        options.gate === "storageError"
          ? { kind: "error", code: "vault_unavailable", message: "No system keyring was found." }
          : { kind: "ready", encrypted: true, schemaVersion: 1, setAside: options.gate === "setAside" },
    }),
    journal_query: ({ limit }) => {
      unlocked();
      return trades.slice(0, Math.min(limit, 5000)).map(toRow);
    },
    lock_status: () => status,
    lock_unlock: ({ password }) => {
      if (password !== MOCK_PASSWORD) {
        wrong += 1;
        throw { code: "wrong_password", message: `Incorrect password (${wrong}/5)` };
      }
      wrong = 0;
      return setUnlocked();
    },
    lock_setup: () => {
      status = { ...status, lockEnabled: true };
      return setUnlocked({ lockEnabled: true });
    },
    lock_enable: () => {
      status = { ...status, lockEnabled: true };
      return "complete";
    },
    lock_change: () => "complete",
    lock_disable: () => {
      status = { ...status, lockEnabled: false };
      return status;
    },
    lock_now: () => {
      if (!status.lockEnabled) return false;
      status = { phase: "locked", vaultUnreadable: false, held: false, ...base, lockEnabled: true };
      emit("locked", null);
      return true;
    },
    lock_activity: () => null,
    older_copy_open: ({ confirmed }) => {
      if (!confirmed) throw { code: "not_confirmed", message: "Confirm first." };
      return setUnlocked();
    },
    prefs_set_idle: ({ minutes }) => {
      status = { ...status, idleLockMinutes: minutes };
      return null;
    },
    erase_all: ({ confirmation }) => {
      if (confirmation !== options.productName) throw { code: "confirmation", message: `Type ${options.productName} to confirm.` };
      trades = [];
      status = { phase: "unlocked", ...base, lockEnabled: false };
      return status;
    },
    save_retry: () => {
      status = { ...status, saveFailing: false };
      return null;
    },
    app_quit: () => null,
    backup_export: () => "Fictional-backup.dxbk",
    backup_pick: () => ({ fileName: "Fictional-backup.dxbk", kind: "desktop", needsPassword: true }),
    backup_restore: () => ({ source: "desktop", trades: trades.length, checkpoints: 0, settings: 0, notices: [] }),

    journal_trades: () => {
      unlocked();
      return trades;
    },
    journal_mutate: ({ mutation }) => {
      const result = mutate(mutation);
      queueMicrotask(() => emit("trades_changed", null));
      return result;
    },
    checklist_rules_get: () => checklist,
    checklist_rules_set: ({ rules }) => {
      checklist = [...rules];
      return null;
    },
    screenshot_list: () => [],
    export_save: ({ suggestedName }) => suggestedName,
    clipboard_write_temporary: () => null,
    settings_get: ({ key }) => settings.get(key) ?? null,
    settings_set: ({ key, value }) => {
      settings.set(key, value);
      return null;
    },
    prefs_get: () => ({ ...prefs }),
    prefs_set: ({ key, value }) => {
      prefs[key] = value;
      return null;
    },
    checkpoints_list: () => checkpoints,
    checkpoints_add: ({ date, title, description }) => {
      const c = { id: checkpoints.length + 1, date, title, description };
      checkpoints = [...checkpoints, c];
      return c;
    },
    checkpoints_delete: ({ id }) => {
      checkpoints = checkpoints.filter((c) => c.id !== id);
      return null;
    },
    import_history: () => [],
    mapping_presets_list: () => [],
    data_info: () => ({
      trades: trades.length,
      sampleTrades: trades.filter((t) => t.isSample === true || t.isSample === 1).length,
      journalBytes: trades.length * 900,
    }),
    has_secret: () => false,
    ai_reports_list: () => [],
    updates_check: () => ({ available: false, version: null, notes: null }),
    mt5_discover: () => [],
    watchlist_get: () => watchlist,
    watchlist_set: ({ symbols }) => {
      watchlist = [...symbols];
      return null;
    },
    quotes_get: ({ symbols }) =>
      symbols.map((symbol, i) => ({ symbol, price: fakePrice(symbol), change: (i % 3) - 1, changePercent: ((i % 5) - 2) / 10, at: options.now })),
    symbol_search: ({ query }) =>
      [...new Set(trades.map((t) => t.symbol))]
        .filter((s) => s.includes(query.trim().toUpperCase()))
        .map((symbol) => ({ symbol, description: `${symbol} (fictional)` })),
    company_profile: ({ symbol }) => ({ symbol, name: `${symbol} Fictional Corp.`, sector: "Technology", industry: "Software", marketCap: null }),
    calendar_week: ({ weekStartMs }): EconomicEvent[] => [
      { id: "e1", at: weekStartMs + 86_400_000 + 12.5 * 3_600_000, currency: "USD", title: "Fictional jobs report", impact: "high" },
      { id: "e2", at: weekStartMs + 2 * 86_400_000 + 8 * 3_600_000, currency: "EUR", title: "Fictional rate decision", impact: "medium" },
    ],
  };

  const ipc: MockIpc = {
    calls,
    emit,
    trades: () => trades,
    call(name, ...args) {
      calls.push(name);
      const run = (): unknown => {
        if (options.fail.includes(name)) throw { code: "mock_failure", message: `The mock was told to fail ${name}.` };
        const handler = handlers[name] as Handler | undefined;
        if (!handler) throw { code: "unavailable", message: `The mock IPC doesn't implement ${name} yet.` };
        return handler(args[0] as never);
      };
      return new Promise((resolve, reject) => {
        const settle = () => {
          try {
            resolve(run() as never);
          } catch (e) {
            reject(e);
          }
        };
        if (options.latencyMs > 0) setTimeout(settle, options.latencyMs);
        else queueMicrotask(settle);
      });
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (payload: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(handler as (payload: unknown) => void);
    },
  };
  return ipc;
}
