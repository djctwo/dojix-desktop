// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Mt5ImportOutcome, Mt5ImportSummary, Mt5PendingFile, Mt5Status } from "@dojix-desktop/core";
import type { ShellEvent } from "../ipc";
import { mt5OutcomeFor, startMt5AutoImport, type Mt5AutoImportIpc } from "./autoImport";

const SAMPLE = readFileSync(
  fileURLToPath(new URL("../../../../mql5/samples/DojixExport_10000001_20261028.csv", import.meta.url)),
);
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const enc = (s: string) => new TextEncoder().encode(s);

function status(pending: Mt5PendingFile[]): Mt5Status {
  return { active: true, prefix32: "", folders: [], files: [], pending, lastImport: null };
}

function file(token: number, fileName = `DojixExport_10000001_2026102${token}.csv`): Mt5PendingFile {
  return { token, folderId: "f1", fileName, size: 100 };
}

function summary(fileName: string, inserted: number): Mt5ImportSummary {
  return { fileName, folderId: "f1", format: "dojix_export", result: "imported", message: null, parsed: inserted, inserted, duplicates: 0, skipped: 0, atMs: NOW };
}

/** A fake shell: a queue of files with bytes; commits remove them from the queue. */
function fakeShell(files: Record<number, { name: string; bytes: Uint8Array }>) {
  const queue = new Map(Object.entries(files).map(([t, f]) => [Number(t), f]));
  const listeners = new Map<ShellEvent, (payload: unknown) => void>();
  const commits: Array<{ token: number; outcome: Mt5ImportOutcome }> = [];
  const ipc: Mt5AutoImportIpc = {
    mt5Status: vi.fn(async () => status([...queue.entries()].map(([t, f]) => file(t, f.name)))),
    mt5Read: vi.fn(async (token: number) => {
      const f = queue.get(token);
      if (!f) throw { code: "not_pending", message: "gone" };
      return f.bytes;
    }),
    mt5ImportCommit: vi.fn(async (token: number, outcome: Mt5ImportOutcome) => {
      const f = queue.get(token);
      if (!f) throw { code: "not_pending", message: "gone" };
      queue.delete(token);
      commits.push({ token, outcome });
      return summary(f.name, outcome.kind === "trades" ? outcome.trades.length : 0);
    }),
    onEvent: (event, handler) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  return { ipc, queue, commits, listeners };
}

describe("mt5OutcomeFor", () => {
  it("parses a DojixExport file into trades", () => {
    const outcome = mt5OutcomeFor(SAMPLE, "DojixExport_10000001_20261028.csv", NOW);
    expect(outcome.kind).toBe("trades");
    if (outcome.kind !== "trades") return;
    expect(outcome.format).toBe("dojix_export");
    expect(outcome.trades.length).toBe(3);
    expect(outcome.parsed).toBe(3);
    expect(outcome.duplicatesInFile).toBe(0);
  });

  it("calls any other CSV not a trade file", () => {
    expect(mt5OutcomeFor(enc("Date,Amount\n2026-01-01,5\n"), "x.csv", NOW)).toEqual({ kind: "not_trade_file", format: "generic" });
  });

  it("reports a refused file as an error, never throws", () => {
    expect(mt5OutcomeFor(new Uint8Array(), "DojixExport_1_20261028.csv", NOW)).toMatchObject({ kind: "error", code: "empty_file" });
    const header = `${new TextDecoder().decode(SAMPLE).split("\r\n")[0]}\r\n`;
    const noRows = mt5OutcomeFor(enc(header), "DojixExport_1_20261028.csv", NOW);
    expect(noRows.kind).toBe("trades");
  });

  it("turns an unexpected parser failure into an error outcome", () => {
    const outcome = mt5OutcomeFor(null as unknown as Uint8Array, "x.csv", NOW);
    expect(outcome).toMatchObject({ kind: "error", code: "internal" });
  });

  it("keeps row issues (a truncated last line is reported, not dropped)", () => {
    const text = new TextDecoder().decode(SAMPLE);
    const cut = enc(`${text}500004,EURUSD,BUY`);
    const outcome = mt5OutcomeFor(cut, "DojixExport_1_20261028.csv", NOW);
    expect(outcome.kind).toBe("trades");
    if (outcome.kind !== "trades") return;
    expect(outcome.trades.length).toBe(3);
    expect(outcome.issues.map((i) => i.code)).toEqual(["too_few_columns"]);
  });
});

describe("startMt5AutoImport", () => {
  it("drains the queue at start: reads, parses and commits every file", async () => {
    const shell = fakeShell({ 1: { name: "DojixExport_10000001_20261028.csv", bytes: SAMPLE }, 2: { name: "DojixExport_2_20261028.csv", bytes: enc("hello\n") } });
    const imported: Mt5ImportSummary[] = [];
    const auto = startMt5AutoImport({ ipc: shell.ipc, now: () => NOW, onImported: (s) => imported.push(s) });
    await auto.drain();
    expect(shell.queue.size).toBe(0);
    expect(shell.commits.map((c) => [c.token, c.outcome.kind])).toEqual([
      [1, "trades"],
      [2, "not_trade_file"],
    ]);
    expect(imported.map((s) => s.inserted)).toEqual([3, 0]);
    auto.stop();
  });

  it("drains again when the shell reports queued files", async () => {
    const shell = fakeShell({});
    const auto = startMt5AutoImport({ ipc: shell.ipc, now: () => NOW });
    await auto.drain();
    expect(shell.commits.length).toBe(0);
    shell.queue.set(7, { name: "DojixExport_7_20261028.csv", bytes: SAMPLE });
    shell.listeners.get("mt5_file_ready")?.(1);
    await auto.drain();
    expect(shell.commits.map((c) => c.token)).toEqual([7]);
    auto.stop();
    expect(shell.listeners.has("mt5_file_ready")).toBe(false);
  });

  it("works through a long queue in batches", async () => {
    const files: Record<number, { name: string; bytes: Uint8Array }> = {};
    for (let t = 1; t <= 7; t++) files[t] = { name: `DojixExport_${t}_20261028.csv`, bytes: SAMPLE };
    const shell = fakeShell(files);
    const auto = startMt5AutoImport({ ipc: shell.ipc, now: () => NOW, batchSize: 3 });
    await auto.drain();
    expect(shell.commits.map((c) => c.token)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(shell.ipc.mt5Status).toHaveBeenCalledTimes(3);
    auto.stop();
  });

  it("runs one drain at a time; a request during a drain runs one more pass", async () => {
    const shell = fakeShell({ 1: { name: "DojixExport_1_20261028.csv", bytes: SAMPLE } });
    const auto = startMt5AutoImport({ ipc: shell.ipc, now: () => NOW });
    const first = auto.drain();
    shell.queue.set(2, { name: "DojixExport_2_20261028.csv", bytes: SAMPLE });
    const second = auto.drain();
    expect(second).toBe(first);
    await second;
    expect(shell.commits.map((c) => c.token)).toEqual([1, 2]);
    auto.stop();
  });

  it("keeps going when a read or a commit fails, and reports it", async () => {
    const shell = fakeShell({ 1: { name: "DojixExport_1_20261028.csv", bytes: SAMPLE }, 2: { name: "DojixExport_2_20261028.csv", bytes: SAMPLE } });
    const errors: unknown[] = [];
    let reads = 0;
    const read = shell.ipc.mt5Read;
    shell.ipc.mt5Read = vi.fn(async (token: number) => {
      reads += 1;
      if (reads === 1) {
        shell.queue.delete(token);
        throw { code: "changed", message: "changed" };
      }
      return read(token);
    });
    const commit = shell.ipc.mt5ImportCommit;
    shell.ipc.mt5ImportCommit = vi.fn(async (token: number, outcome: Mt5ImportOutcome) => {
      await commit(token, outcome);
      throw { code: "save_failed", message: "not saved" };
    });
    const auto = startMt5AutoImport({ ipc: shell.ipc, now: () => NOW, onError: (e) => errors.push(e) });
    await auto.drain();
    expect(errors).toEqual([
      { code: "changed", message: "changed" },
      { code: "save_failed", message: "not saved" },
    ]);
    auto.stop();
  });

  it("a locked journal (status fails) is reported and nothing is read", async () => {
    const shell = fakeShell({ 1: { name: "DojixExport_1_20261028.csv", bytes: SAMPLE } });
    shell.ipc.mt5Status = vi.fn(async () => {
      throw { code: "locked", message: "The journal is locked." };
    });
    const errors: unknown[] = [];
    const auto = startMt5AutoImport({ ipc: shell.ipc, onError: (e) => errors.push(e) });
    await auto.drain();
    expect(errors).toEqual([{ code: "locked", message: "The journal is locked." }]);
    expect(shell.ipc.mt5Read).not.toHaveBeenCalled();
    auto.stop();
  });

  it("stops between files and ignores drains after stop", async () => {
    const shell = fakeShell({ 1: { name: "DojixExport_1_20261028.csv", bytes: SAMPLE }, 2: { name: "DojixExport_2_20261028.csv", bytes: SAMPLE } });
    let auto: ReturnType<typeof startMt5AutoImport> | null = null;
    const commit = shell.ipc.mt5ImportCommit;
    shell.ipc.mt5ImportCommit = vi.fn(async (token: number, outcome: Mt5ImportOutcome) => {
      auto?.stop();
      return commit(token, outcome);
    });
    auto = startMt5AutoImport({ ipc: shell.ipc });
    await auto.drain();
    expect(shell.commits.map((c) => c.token)).toEqual([1]);
    await auto.drain();
    expect(shell.commits.length).toBe(1);
  });
});
