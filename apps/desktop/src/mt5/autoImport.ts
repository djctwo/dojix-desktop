// MT5 auto-import, the web view's half (SPEC §5.1, §5.4; docs/MT5.md). The Rust watcher finds
// new or changed MT5 trade files in the folders the user enabled and queues them; this module
// reads each queued file, parses it with `packages/importers` (the same parser as a manual
// import) and hands the result back to the shell to commit. Framework-free, so it is tested
// with a mocked IPC.

import type { Mt5ImportOutcome, Mt5ImportSummary } from "@dojix-desktop/core";
import { ImportError, importTradeFile } from "@dojix-desktop/importers";
import type { Ipc } from "../ipc";

/** Formats an auto-import may commit (anything else is "not a trade file"). */
export const MT5_AUTO_FORMATS = ["mt5_32col", "dojix_export", "mt5_report"] as const;
type Mt5AutoFormat = (typeof MT5_AUTO_FORMATS)[number];

function isAutoFormat(format: string): format is Mt5AutoFormat {
  return (MT5_AUTO_FORMATS as readonly string[]).includes(format);
}

/** Parses a queued file's bytes into what `mt5_import_commit` takes. Never throws. */
export function mt5OutcomeFor(bytes: Uint8Array, fileName: string, now: number): Mt5ImportOutcome {
  try {
    const result = importTradeFile(bytes, { brand: "dojix", now, fileName });
    if (!isAutoFormat(result.format)) return { kind: "not_trade_file", format: result.format };
    return {
      kind: "trades",
      format: result.format,
      trades: result.trades,
      parsed: result.parsed,
      duplicatesInFile: result.duplicatesInFile,
      issues: result.issues,
    };
  } catch (e) {
    if (e instanceof ImportError) return { kind: "error", code: e.code, message: e.message };
    return { kind: "error", code: "internal", message: e instanceof Error ? e.message : String(e) };
  }
}

export type Mt5AutoImportIpc = Pick<Ipc, "mt5Status" | "mt5Read" | "mt5ImportCommit" | "onEvent">;

export interface Mt5AutoImportOptions {
  ipc: Mt5AutoImportIpc;
  /** Epoch ms ("importedAt"). */
  now?: () => number;
  /** After each handled file (for a toast and a journal refresh). */
  onImported?: (summary: Mt5ImportSummary) => void;
  /** A call that failed (the file stays queued or is read again later). */
  onError?: (error: unknown) => void;
  /** Files handled per pass before the queue is looked at again. */
  batchSize?: number;
}

export interface Mt5AutoImport {
  /** Handles every queued file; resolves when the queue is empty (or stopped). */
  drain(): Promise<void>;
  stop(): void;
}

/**
 * Starts auto-import: drains the queue now (which also starts the watcher after an unlock)
 * and again whenever the shell reports queued files. Only one drain runs at a time.
 */
export function startMt5AutoImport(options: Mt5AutoImportOptions): Mt5AutoImport {
  const { ipc } = options;
  const now = options.now ?? Date.now;
  const batchSize = Math.max(1, options.batchSize ?? 20);
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;

  const report = (e: unknown) => options.onError?.(e);

  /** One pass; true when files are still queued. */
  const pass = async (): Promise<boolean> => {
    const status = await ipc.mt5Status();
    const batch = status.pending.slice(0, batchSize);
    for (const file of batch) {
      if (stopped) return false;
      let bytes: Uint8Array;
      try {
        bytes = await ipc.mt5Read(file.token);
      } catch (e) {
        report(e);
        continue;
      }
      const outcome = mt5OutcomeFor(bytes, file.fileName, now());
      let summary: Mt5ImportSummary;
      try {
        summary = await ipc.mt5ImportCommit(file.token, outcome);
      } catch (e) {
        report(e);
        continue;
      }
      options.onImported?.(summary);
    }
    return status.pending.length > batch.length;
  };

  const drain = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        let more = true;
        while (more && !stopped) {
          again = false;
          more = (await pass()) || again;
        }
      } catch (e) {
        report(e);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const unlisten = ipc.onEvent("mt5_file_ready", () => {
    void drain();
  });
  void drain();

  return {
    drain,
    stop() {
      stopped = true;
      unlisten();
    },
  };
}
