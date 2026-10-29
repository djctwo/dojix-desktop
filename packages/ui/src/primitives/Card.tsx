import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./Button";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode | undefined;
  subtitle?: ReactNode | undefined;
  /** Buttons at the right of the title (export, help, …). */
  actions?: ReactNode | undefined;
  footer?: ReactNode | undefined;
  /** The Mac's gold/teal bar along the top edge (`accentTopBar`). */
  accent?: boolean | undefined;
  /** Hover tint (Mac `cardStyle`). */
  hover?: boolean | undefined;
  /** Heading level of the title (default 2). */
  level?: 2 | 3 | undefined;
}

/** The standard surface: 12px radius, 1px border, card background (Mac `cardStyle`). */
export function Card({
  title,
  subtitle,
  actions,
  footer,
  accent = false,
  hover = false,
  level = 2,
  className,
  children,
  ...rest
}: CardProps) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section className={cx("card", accent && "card-accent", hover && "card-hover", className)} {...rest}>
      {(title !== undefined || actions !== undefined) && (
        <header className="card-header">
          {title !== undefined && <Heading className="card-title">{title}</Heading>}
          {actions !== undefined && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {subtitle !== undefined && <p className="card-subtitle">{subtitle}</p>}
      <div className="card-body">{children}</div>
      {footer !== undefined && <footer className="card-footer">{footer}</footer>}
    </section>
  );
}

/** A nested surface inside a card (Mac `insetSurface`). */
export function Inset({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("inset", className)} {...rest} />;
}
