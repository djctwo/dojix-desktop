import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts written as the Help page shows them: "Ctrl+1", "Ctrl+Shift+E", "Alt+3",
 * "F1", "Ctrl+?", "Ctrl+,". Ctrl replaces the Mac's Cmd and Alt its Option (SPEC 2.1).
 */
export interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseShortcut(text: string): ParsedShortcut {
  const parts = text.split("+");
  // "Ctrl++" would end in two empty parts; no shortcut uses "+" so this is only a guard.
  const key = parts[parts.length - 1] ?? "";
  if (key === "") throw new Error(`shortcut "${text}" has no key`);
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  for (const m of mods) {
    if (!["ctrl", "shift", "alt"].includes(m)) throw new Error(`unknown modifier ${m} in "${text}"`);
  }
  return { ctrl: mods.has("ctrl"), shift: mods.has("shift"), alt: mods.has("alt"), key };
}

/** Keys that need Shift on common layouts; their Shift state is not compared. */
const SHIFTED = new Set(["?", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "{", "}", "|", ":", '"', "<", ">", "~"]);

/** Does the key event match the shortcut? Digits match by physical key (Alt+1 on any layout). */
export function matchesShortcut(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">, shortcut: string | ParsedShortcut): boolean {
  const s = typeof shortcut === "string" ? parseShortcut(shortcut) : shortcut;
  if (e.ctrlKey !== s.ctrl || e.altKey !== s.alt || e.metaKey) return false;
  if (/^[0-9]$/.test(s.key)) {
    return e.shiftKey === s.shift && (e.code === `Digit${s.key}` || e.code === `Numpad${s.key}` || e.key === s.key);
  }
  if (SHIFTED.has(s.key)) return e.key === s.key || (s.key === "?" && e.code === "Slash" && e.shiftKey);
  if (e.shiftKey !== s.shift) return false;
  return e.key.toLowerCase() === s.key.toLowerCase();
}

export interface ShortcutBinding {
  /** One or more spellings ("F1", "Ctrl+?"). */
  keys: readonly string[];
  run: (e: KeyboardEvent) => void;
}

/**
 * Global shortcuts on `window`. Skipped while a modal dialog is open (its own keys win) and
 * after another handler called preventDefault.
 */
export function useShortcuts(bindings: readonly ShortcutBinding[], enabled = true): void {
  const latest = useRef(bindings);
  useEffect(() => {
    latest.current = bindings;
  }, [bindings]);
  useEffect(() => {
    if (!enabled) return;
    const parsed = () => latest.current.map((b) => ({ b, keys: b.keys.map(parseShortcut) }));
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      for (const { b, keys } of parsed()) {
        if (keys.some((k) => matchesShortcut(e, k))) {
          e.preventDefault();
          b.run(e);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
