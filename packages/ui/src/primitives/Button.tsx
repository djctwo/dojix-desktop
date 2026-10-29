import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "secondary" | "primary" | "danger" | "ghost" | "link";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | undefined;
  size?: "default" | "small" | undefined;
  /** Shows a spinner, sets aria-busy and blocks clicks (the button stays focusable). */
  loading?: boolean | undefined;
  icon?: ReactNode | undefined;
}

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** The app's button. Defaults to type="button" so it never submits a form by accident. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "default", loading = false, icon, className, children, type, onClick, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes(
        "button",
        variant !== "secondary" && `button-${variant}`,
        size === "small" && "button-small",
        className,
      )}
      aria-busy={loading || undefined}
      onClick={loading ? undefined : onClick}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: the accessible name (also shown as the tooltip). */
  label: string;
  size?: "default" | "small" | undefined;
  children: ReactNode;
}

/** A square button with only an icon. `label` names it for screen readers and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "default", className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes("icon-button", size === "small" && "icon-button-small", className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
});

export { classes as cx };
