import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

/** True when the OS asks for reduced motion. Charts and transitions turn their animation off. */
export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const m = media();
  if (!m) return () => undefined;
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

/** React hook form of `prefersReducedMotion`, updated when the OS setting changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
