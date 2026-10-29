import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { matchesShortcut, parseShortcut, useShortcuts, type ShortcutBinding } from "./shortcuts";

afterEach(cleanup);

const key = (init: Partial<KeyboardEventInit> & { key: string; code?: string }) => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  code: "",
  ...init,
});

describe("parseShortcut", () => {
  it("reads modifiers and the key", () => {
    expect(parseShortcut("Ctrl+Shift+E")).toEqual({ ctrl: true, shift: true, alt: false, key: "E" });
    expect(parseShortcut("F1")).toEqual({ ctrl: false, shift: false, alt: false, key: "F1" });
    expect(() => parseShortcut("Ctrl+")).toThrow(/no key/);
    expect(() => parseShortcut("Cmd+1")).toThrow(/unknown modifier/);
  });
});

describe("matchesShortcut", () => {
  it("matches digits by physical key, letters case-insensitively, shifted symbols loosely", () => {
    expect(matchesShortcut(key({ key: "1", code: "Digit1", ctrlKey: true }), "Ctrl+1")).toBe(true);
    expect(matchesShortcut(key({ key: "¡", code: "Digit1", altKey: true }), "Alt+1")).toBe(true);
    expect(matchesShortcut(key({ key: "1", code: "Numpad1", ctrlKey: true }), "Ctrl+1")).toBe(true);
    expect(matchesShortcut(key({ key: "1", code: "Digit1" }), "Ctrl+1")).toBe(false);
    expect(matchesShortcut(key({ key: "E", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+E")).toBe(true);
    expect(matchesShortcut(key({ key: "e", ctrlKey: true }), "Ctrl+Shift+E")).toBe(false);
    expect(matchesShortcut(key({ key: "n", ctrlKey: true }), "Ctrl+N")).toBe(true);
    expect(matchesShortcut(key({ key: "?", ctrlKey: true, shiftKey: true }), "Ctrl+?")).toBe(true);
    expect(matchesShortcut(key({ key: "/", code: "Slash", ctrlKey: true, shiftKey: true }), "Ctrl+?")).toBe(true);
    expect(matchesShortcut(key({ key: ",", ctrlKey: true }), "Ctrl+,")).toBe(true);
    expect(matchesShortcut(key({ key: "F1" }), "F1")).toBe(true);
    expect(matchesShortcut(key({ key: "1", code: "Digit1", ctrlKey: true, metaKey: true }), "Ctrl+1")).toBe(false);
    expect(matchesShortcut(key({ key: "Enter", ctrlKey: true }), parseShortcut("Ctrl+Enter"))).toBe(true);
  });
});

function Harness({ bindings, enabled }: { bindings: ShortcutBinding[]; enabled?: boolean }) {
  useShortcuts(bindings, enabled);
  return null;
}

describe("useShortcuts", () => {
  it("runs the first matching binding and prevents the browser default", () => {
    const run = vi.fn();
    const other = vi.fn();
    render(<Harness bindings={[{ keys: ["F1", "Ctrl+?"], run }, { keys: ["F1"], run: other }]} />);
    const e = new KeyboardEvent("keydown", { key: "F1", cancelable: true });
    window.dispatchEvent(e);
    expect(run).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F1", repeat: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F2" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while a modal dialog is open or when disabled", () => {
    const run = vi.fn();
    const { rerender } = render(<Harness bindings={[{ keys: ["F1"], run }]} />);
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F1" }));
    modal.remove();
    rerender(<Harness bindings={[{ keys: ["F1"], run }]} enabled={false} />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F1" }));
    expect(run).not.toHaveBeenCalled();
  });
});
