import type { ReactNode } from "react";
import { cx } from "../primitives/Button";

export interface ScreenProps {
  title: string;
  /** Under the title (counts, the active filter, …). */
  subtitle?: ReactNode | undefined;
  /** Right side of the header (filters, export, Essential/All). */
  actions?: ReactNode | undefined;
  children: ReactNode;
  /** No max width (tables, the analytics grid). */
  wide?: boolean | undefined;
  testId?: string | undefined;
}

/** One screen: an h1 (`screen-title`, which e2e reads) and the content below it. */
export function Screen({ title, subtitle, actions, children, wide = false, testId }: ScreenProps) {
  return (
    <section className={cx("screen", wide && "screen-wide")} aria-labelledby="screen-title" data-testid={testId}>
      <header className="screen-header">
        <h1 id="screen-title" data-testid="screen-title">
          {title}
        </h1>
        {actions !== undefined && <div className="screen-header-actions">{actions}</div>}
        {subtitle !== undefined && <p className="screen-subtitle">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}
