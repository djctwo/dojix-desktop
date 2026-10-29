import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import type { EventName, Events, Ipc } from "../ipc/contract";

const IpcContext = createContext<Ipc | null>(null);

export function IpcProvider({ ipc, children }: { ipc: Ipc; children: ReactNode }) {
  return <IpcContext.Provider value={ipc}>{children}</IpcContext.Provider>;
}

/** The IPC of the running app (Tauri or mock). */
export function useIpc(): Ipc {
  const ipc = useContext(IpcContext);
  if (!ipc) throw new Error("useIpc needs an <IpcProvider> above it");
  return ipc;
}

/** Subscribes to a shell event for the component's lifetime. The latest handler is always used. */
export function useIpcEvent<E extends EventName>(event: E, handler: (payload: Events[E]) => void): void {
  const ipc = useIpc();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  }, [handler]);
  useEffect(() => ipc.on(event, (payload) => latest.current(payload)), [ipc, event]);
}
