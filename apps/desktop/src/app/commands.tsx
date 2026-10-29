import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { AppCommand } from "./shortcuts";

type Handler = () => void;

export interface CommandBus {
  /** Runs the command's handler, or keeps it until a screen subscribes (e.g. Ctrl+N opens Journal first). */
  dispatch(command: AppCommand): void;
  subscribe(command: AppCommand, handler: Handler): () => void;
}

export function createCommandBus(): CommandBus {
  const handlers = new Map<AppCommand, Set<Handler>>();
  const pending = new Set<AppCommand>();
  return {
    dispatch(command) {
      const set = handlers.get(command);
      if (set && set.size > 0) {
        for (const h of set) h();
      } else {
        pending.add(command);
      }
    },
    subscribe(command, handler) {
      const set = handlers.get(command) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(command, set);
      if (pending.delete(command)) queueMicrotask(handler);
      return () => set.delete(handler);
    },
  };
}

const CommandContext = createContext<CommandBus | null>(null);

export function CommandProvider({ children }: { children: ReactNode }) {
  const [bus] = useState(createCommandBus);
  return <CommandContext.Provider value={bus}>{children}</CommandContext.Provider>;
}

export function useCommandBus(): CommandBus {
  const bus = useContext(CommandContext);
  if (!bus) throw new Error("useCommandBus needs a <CommandProvider> above it");
  return bus;
}

/** Handles an app command (Ctrl+E, Ctrl+N, …) while the component is mounted. */
export function useAppCommand(command: AppCommand, handler: Handler): void {
  const bus = useCommandBus();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  }, [handler]);
  useEffect(() => bus.subscribe(command, () => latest.current()), [bus, command]);
}
