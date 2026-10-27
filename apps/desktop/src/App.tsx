import { useEffect, useState } from "react";
import type { AppInfo, BrandConfig, JournalRow, ScreenId } from "@dojix-desktop/core";
import { AppShell, JournalScreen, PlaceholderScreen, StartupError } from "@dojix-desktop/ui";
import type { Ipc } from "./ipc";

const JOURNAL_PAGE = 500;

export interface AppProps {
  brand: BrandConfig;
  ipc: Ipc;
}

export function App({ brand, ipc }: AppProps) {
  const [screen, setScreen] = useState<ScreenId>("journal");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [rows, setRows] = useState<JournalRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipc
      .appInfo()
      .then(async (loaded) => {
        if (cancelled) return;
        setInfo(loaded);
        if (loaded.storage.kind !== "ready") return;
        const trades = await ipc.listTrades(JOURNAL_PAGE);
        if (!cancelled) setRows(trades);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailure(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [ipc]);

  const storage = info?.storage;
  const errorMessage = failure ?? (storage?.kind === "error" ? storage.message : null);
  const label = brand.sidebar.flatMap((s) => s.items).find((i) => i.id === screen)?.label ?? "";
  const setAside = storage?.kind === "ready" && storage.setAside;

  return (
    <AppShell brand={brand} active={screen} onNavigate={setScreen} status={<Status info={info} />}>
      {setAside && (
        <p className="notice" role="status" data-testid="set-aside-notice">
          The previous journal file could not be read, so it was moved to the set-aside folder
          and a new journal was started. Nothing was deleted.
        </p>
      )}
      {errorMessage !== null ? (
        <StartupError productName={brand.productName} message={errorMessage} />
      ) : screen === "journal" ? (
        <JournalScreen brand={brand} rows={rows} />
      ) : (
        <PlaceholderScreen title={label} />
      )}
    </AppShell>
  );
}

function Status({ info }: { info: AppInfo | null }) {
  if (info === null) return null;
  const encrypted = info.storage.kind === "ready" && info.storage.encrypted;
  return (
    <>
      <div data-testid="db-status" data-encrypted={encrypted ? "true" : "false"}>
        {encrypted ? <span className="ok">● Journal encrypted</span> : "Journal not open"}
      </div>
      <div data-testid="app-version">v{info.version}</div>
    </>
  );
}
