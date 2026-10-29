import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { ToastProvider } from "@dojix-desktop/ui";
import type { AnalyticsClient } from "../analytics/client";
import { AnalyticsProvider } from "../analytics/context";
import type { EngineSettings } from "../analytics/protocol";
import { IpcProvider } from "../data/IpcContext";
import type { Ipc } from "../ipc/contract";
import { CommandProvider } from "./commands";
import { SessionStateProvider } from "./sessionState";

export interface AppProvidersProps {
  ipc: Ipc;
  queryClient: QueryClient;
  createAnalyticsClient: () => AnalyticsClient;
  now?: (() => number) | undefined;
  engineSettings?: EngineSettings | undefined;
  children: ReactNode;
}

/** Everything a screen can rely on: IPC, queries, analytics, toasts, app commands, session state. */
export function AppProviders({ ipc, queryClient, createAnalyticsClient, now, engineSettings, children }: AppProvidersProps) {
  return (
    <IpcProvider ipc={ipc}>
      <QueryClientProvider client={queryClient}>
        <AnalyticsProvider createClient={createAnalyticsClient} now={now} settings={engineSettings}>
          <ToastProvider>
            <CommandProvider>
              <SessionStateProvider>{children}</SessionStateProvider>
            </CommandProvider>
          </ToastProvider>
        </AnalyticsProvider>
      </QueryClientProvider>
    </IpcProvider>
  );
}
