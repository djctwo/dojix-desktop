// The ONLY module that talks to the Tauri shell (boundary.test.ts enforces it). Everything else
// uses the `Ipc` contract (ipc/contract.ts), so the UI runs on the mock IPC in a plain browser
// and the shell could be swapped later (SPEC 7.1).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { COMMAND_INFO, type Ipc, unavailable } from "./ipc/contract";

export const tauriIpc: Ipc = {
  call(name, ...args) {
    if (COMMAND_INFO[name].status !== "available") return Promise.reject(unavailable(name));
    return invoke(name, args[0] ?? {});
  },
  on(event, handler) {
    let stop: (() => void) | null = null;
    let cancelled = false;
    listen(event, (e) => handler(e.payload as never))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  },
};
