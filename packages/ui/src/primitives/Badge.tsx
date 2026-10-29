import type { HTMLAttributes } from "react";
import { cx } from "./Button";

export type BadgeTone = "accent" | "profit" | "loss" | "warning" | "info" | "neutral";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone | undefined;
}

/** A small pill label (Mac semantic "Dim" backgrounds). */
export function Badge({ tone = "accent", className, ...rest }: BadgeProps) {
  return <span className={cx("badge", tone !== "accent" && `badge-${tone}`, className)} {...rest} />;
}

/** A keyboard key, as shown in shortcut hints and the Help page. */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx("kbd", className)} {...rest} />;
}
