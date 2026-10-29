import { useEffect, useRef } from "react";
import type { Mt5ImportSummary } from "@dojix-desktop/core";
import { startMt5AutoImport, type Mt5AutoImportIpc } from "./autoImport";

/**
 * Runs MT5 auto-import while `active` (Dojix, journal unlocked). Turning it on calls
 * `mt5_status`, which starts the watcher for the folders the user enabled; with none enabled
 * nothing is watched.
 */
export function useMt5AutoImport(
  ipc: Mt5AutoImportIpc,
  active: boolean,
  onImported: (summary: Mt5ImportSummary) => void,
): void {
  const callback = useRef(onImported);
  useEffect(() => {
    callback.current = onImported;
  }, [onImported]);

  useEffect(() => {
    if (!active) return;
    const auto = startMt5AutoImport({ ipc, onImported: (summary) => callback.current(summary) });
    return () => auto.stop();
  }, [ipc, active]);
}
