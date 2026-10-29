import { useEffect, useId, useRef, useState } from "react";
import { CircleHelp } from "lucide-react";

export interface HelpTipProps {
  /** The term being explained (names the button: "What is Profit Factor?"). */
  term: string;
  definition: string;
}

/**
 * The "?" next to a metric (Mac `HelpTooltip`): a button that shows the definition on click,
 * hover or focus. Escape or a click elsewhere closes it; screen readers get it as the button's
 * description.
 */
export function HelpTip({ term, definition }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="help-tip" ref={root} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="icon-button icon-button-small"
        aria-label={`What is ${term}?`}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      <span role="tooltip" id={id} className="help-tip-popover" hidden={!open}>
        {definition}
      </span>
    </span>
  );
}
