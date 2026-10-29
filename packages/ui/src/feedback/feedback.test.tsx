import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, Dialog } from "./Dialog";
import { TOAST_MS, ToastProvider, UNDO_MS, useToast, type ToastApi } from "./Toast";

afterEach(cleanup);

const grabbed: { api: ToastApi | null } = { api: null };
function Grab() {
  const toast = useToast();
  useEffect(() => {
    grabbed.api = toast;
  }, [toast]);
  return null;
}

describe("toasts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("close by themselves after 3.5 s; errors are alerts", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    act(() => {
      grabbed.api!.success("Trades imported successfully");
      grabbed.api!.error("Import failed");
      grabbed.api!.info("Heads up");
    });
    expect(screen.getByTestId("toast-success").getAttribute("role")).toBe("status");
    expect(screen.getByTestId("toast-error").getAttribute("role")).toBe("alert");
    act(() => vi.advanceTimersByTime(TOAST_MS - 1));
    expect(screen.queryByTestId("toast-success")).not.toBeNull();
    act(() => vi.advanceTimersByTime(2));
    expect(screen.queryByTestId("toast-success")).toBeNull();
    expect(screen.queryByTestId("toast-info")).toBeNull();
  });

  it("undo runs onUndo inside 5 s, otherwise onCommit once", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    act(() => void grabbed.api!.undo("Deleted 3 trades", onUndo, onCommit));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    act(() => void grabbed.api!.undo("Deleted 3 trades", onUndo, onCommit));
    act(() => vi.advanceTimersByTime(TOAST_MS + 100));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(UNDO_MS));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("pause while hovered or focused, and dismiss with ×", () => {
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    const onExpire = vi.fn();
    let id = 0;
    act(() => {
      id = grabbed.api!.show({ kind: "info", message: "Paused", onExpire });
    });
    const toast = screen.getByTestId("toast-info");
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(TOAST_MS * 3));
    expect(screen.queryByTestId("toast-info")).not.toBeNull();
    fireEvent.mouseLeave(toast);
    fireEvent.focus(toast);
    fireEvent.blur(toast);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("toast-info")).toBeNull();
    expect(onExpire).toHaveBeenCalledTimes(1);
    act(() => grabbed.api!.dismiss(id));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("useToast needs a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Grab />)).toThrow(/ToastProvider/);
    vi.restoreAllMocks();
  });
});

function DialogHarness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Rename"
        description="Give it a name."
        initialFocus={first}
        dismissible={dismissible}
        testId="dlg"
        footer={<button onClick={() => setOpen(false)}>Done</button>}
      >
        <input ref={first} aria-label="Name" />
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("is modal, labelled, traps focus, closes on Escape and returns focus", () => {
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Rename" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(input);
    const done = screen.getByRole("button", { name: "Done" });
    done.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(dialog, { key: "a" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a backdrop click unless a choice is required", () => {
    const { unmount } = render(<DialogHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.mouseDown(screen.getByTestId("dlg").parentElement as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    render(<DialogHarness dismissible={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.mouseDown(screen.getByTestId("dlg").parentElement as HTMLElement);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("with nothing focusable keeps focus on the dialog", () => {
    render(<Dialog open onClose={() => undefined} title="Note" />);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
  });
});

describe("ConfirmDialog", () => {
  it("starts on Cancel and confirms with the destructive button", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete all trades?"
        description="You can undo for 5 seconds."
        confirmLabel="Delete all"
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
        testId="confirm"
      />,
    );
    expect(screen.getByRole("alertdialog", { name: "Delete all trades?" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete all" }).className).toContain("button-danger");
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
