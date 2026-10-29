import { type ReactNode, useId, useState } from "react";
import { ChevronRight } from "lucide-react";

export interface SectionProps {
  title: string;
  children: ReactNode;
  /** Collapsible like the Mac's `CollapsibleSection`; open by default. */
  collapsible?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  /** Controlled open state (with `onOpenChange`). */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  testId?: string | undefined;
}

/** A titled group of cards with the Mac's uppercase section label. */
export function Section({ title, children, collapsible = false, defaultOpen = true, open, onOpenChange, testId }: SectionProps) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const id = useId();
  const toggle = () => {
    setOwn(!isOpen);
    onOpenChange?.(!isOpen);
  };
  return (
    <section className="section" aria-labelledby={`${id}-title`} data-testid={testId}>
      {collapsible ? (
        <h2 className="section-heading">
          <button
            type="button"
            className="section-header"
            id={`${id}-title`}
            aria-expanded={isOpen}
            aria-controls={`${id}-body`}
            onClick={toggle}
          >
            <ChevronRight className="nav-section-chevron" size={14} aria-hidden="true" />
            {title}
          </button>
        </h2>
      ) : (
        <h2 className="section-header" id={`${id}-title`}>
          {title}
        </h2>
      )}
      <div id={`${id}-body`} hidden={!isOpen}>
        {children}
      </div>
    </section>
  );
}
