import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../a11y/focus";
import { Button, cx } from "../primitives/Button";

export interface DialogProps {
  open: boolean;
  /** Escape, the backdrop (unless `dismissible` is false) and Cancel buttons call it. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode | undefined;
  children?: ReactNode | undefined;
  /** Buttons row (right-aligned). */
  footer?: ReactNode | undefined;
  /** "alertdialog" for confirmations that interrupt (unsaved changes, delete). */
  role?: "dialog" | "alertdialog" | undefined;
  /** False: Escape and the backdrop don't close it (a choice is required). */
  dismissible?: boolean | undefined;
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  wide?: boolean | undefined;
  testId?: string | undefined;
}

/**
 * Modal dialog: rendered in a portal on <body>, focus moves in and is trapped, Escape closes,
 * focus returns to the opener on close. The page behind is hidden from screen readers by
 * aria-modal.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  role = "dialog",
  dismissible = true,
  initialFocus,
  wide = false,
  testId,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, open, initialFocus);
  useEffect(() => {
    if (!open || !dismissible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismissible, onClose]);
  if (!open) return null;
  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={cx("dialog", wide && "dialog-wide")}
        role={role}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description !== undefined ? `${id}-desc` : undefined}
        tabIndex={-1}
        data-testid={testId}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        {description !== undefined && (
          <p id={`${id}-desc`} className="dialog-description">
            {description}
          </p>
        )}
        {children}
        {footer !== undefined && <div className="actions">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string | undefined;
  /** Red confirm button for destructive actions. */
  destructive?: boolean | undefined;
  busy?: boolean | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string | undefined;
}

/** Yes/no confirmation. Focus starts on Cancel, so Enter never confirms a destructive action by accident. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
  testId,
}: ConfirmDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      role="alertdialog"
      title={title}
      description={description}
      initialFocus={cancel}
      testId={testId}
      footer={
        <>
          <Button ref={cancel} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
