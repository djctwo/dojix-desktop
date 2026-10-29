import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleX, Info, X } from "lucide-react";

/** Mac: toasts close after 3.5 s; the Delete All Trades undo window is 5 s (SPEC 2.1). */
export const TOAST_MS = 3500;
export const UNDO_MS = 5000;

export type ToastKind = "success" | "error" | "info";

export interface ToastOptions {
  kind: ToastKind;
  message: string;
  /** One action button ("Undo", "View"). Clicking it runs `onClick` and closes the toast. */
  action?: { label: string; onClick: () => void } | undefined;
  /** ms before it closes by itself (default 3.5 s; 5 s with an Undo action). */
  duration?: number | undefined;
  /** Called when the toast closes without its action being used (timeout or ×). */
  onExpire?: (() => void) | undefined;
}

interface ToastItem extends ToastOptions {
  id: number;
}

export interface ToastApi {
  show(options: ToastOptions): number;
  success(message: string): number;
  error(message: string): number;
  info(message: string): number;
  /**
   * "Deleted 120 trades — Undo". `onUndo` runs if the user clicks Undo within 5 s; otherwise
   * `onCommit` runs when the toast closes.
   */
  undo(message: string, onUndo: () => void, onCommit?: () => void): number;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Toasts for the subtree. Mount once, near the root (AppProviders does). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  /** Open toasts by id, so closing one runs its callback exactly once. */
  const open = useRef(new Map<number, ToastOptions>());

  const remove = useCallback((id: number, expired: boolean) => {
    const item = open.current.get(id);
    if (!item) return;
    open.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
    if (expired) item.onExpire?.();
  }, []);

  const api = useMemo<ToastApi>(() => {
    const show = (options: ToastOptions) => {
      const id = next.current++;
      open.current.set(id, options);
      setItems((list) => [...list, { ...options, id }]);
      return id;
    };
    return {
      show,
      success: (message) => show({ kind: "success", message }),
      error: (message) => show({ kind: "error", message }),
      info: (message) => show({ kind: "info", message }),
      undo: (message, onUndo, onCommit) =>
        show({
          kind: "info",
          message,
          duration: UNDO_MS,
          action: { label: "Undo", onClick: onUndo },
          ...(onCommit ? { onExpire: onCommit } : {}),
        }),
      dismiss: (id) => remove(id, true),
    };
  }, [remove]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications" data-testid="toasts">
        {items.map((t) => (
          <ToastView key={t.id} item={t} onClose={(expired) => remove(t.id, expired)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onClose }: { item: ToastItem; onClose: (expired: boolean) => void }) {
  const [paused, setPaused] = useState(false);
  const duration = item.duration ?? (item.action ? UNDO_MS : TOAST_MS);
  const remaining = useRef(duration);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => close.current(true), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused]);
  const Icon = item.kind === "success" ? CircleCheck : item.kind === "error" ? CircleX : Info;
  return (
    <div
      className={`toast toast-${item.kind}`}
      role={item.kind === "error" ? "alert" : "status"}
      data-testid={`toast-${item.kind}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className="toast-icon" size={18} aria-hidden="true" />
      <span className="toast-message">{item.message}</span>
      {item.action && (
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            item.action?.onClick();
            onClose(false);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="icon-button icon-button-small" aria-label="Dismiss" onClick={() => onClose(true)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The toast API of the nearest ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a <ToastProvider> above it");
  return api;
}
