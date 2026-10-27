// Shapes exchanged between the Rust shell and the UI. Pure types plus small helpers.

/** One row of the Journal list. Money stays decimal text, exactly as stored. */
export interface JournalRow {
  id: number;
  symbol: string;
  direction: "BUY" | "SELL";
  closeTime: string;
  netProfit: string;
}

export type StorageState =
  | { kind: "ready"; encrypted: boolean; schemaVersion: number; setAside: boolean }
  | { kind: "error"; code: string; message: string };

/** Startup status reported by the shell. Never contains paths, keys or trade data. */
export interface AppInfo {
  brand: string;
  productName: string;
  version: string;
  dataDirSource: "default" | "override";
  vaultBackend: string;
  storage: StorageState;
}

/** True when the journal opened and is encrypted at rest. */
export function journalIsReadyAndEncrypted(info: AppInfo): boolean {
  return info.storage.kind === "ready" && info.storage.encrypted;
}
