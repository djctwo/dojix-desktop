import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  cloneElement,
  isValidElement,
  useId,
} from "react";
import { cx } from "../primitives/Button";

export interface FieldProps {
  label: ReactNode;
  /** One control element; Field wires its id, aria-describedby and aria-invalid. */
  children: ReactNode;
  hint?: ReactNode | undefined;
  /** Validation message; marks the control invalid and is announced. */
  error?: ReactNode | undefined;
  inline?: boolean | undefined;
  className?: string | undefined;
}

/** A labelled form control with hint and error text wired for screen readers. */
export function Field({ label, children, hint, error, inline = false, className }: FieldProps) {
  const id = useId();
  const hintId = hint !== undefined ? `${id}-hint` : undefined;
  const errorId = error !== undefined && error !== null && error !== false ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, {
        id: (children.props["id"] as string | undefined) ?? id,
        "aria-describedby": describedBy,
        "aria-invalid": errorId ? true : undefined,
      })
    : children;
  const controlId = isValidElement<Record<string, unknown>>(children)
    ? ((children.props["id"] as string | undefined) ?? id)
    : undefined;
  return (
    <div className={cx("field", inline && "field-inline", className)}>
      <label className="field-label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {hintId && (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {errorId && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" className={cx("input", className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("input", className)} {...rest} />;
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  options: readonly SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Native select (keyboard and screen-reader behaviour come from the platform). */
export function Select<T extends string>({ options, value, onChange, className, ...rest }: SelectProps<T>) {
  return (
    <select className={cx("input", className)} value={value} onChange={(e) => onChange(e.target.value as T)} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function Checkbox({ label, checked, onChange, className, ...rest }: CheckboxProps) {
  return (
    <label className={cx("check", className)}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} {...rest} />
      <span>{label}</span>
    </label>
  );
}

export interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  /** Show the label next to the switch (default) or only to screen readers. */
  showLabel?: boolean | undefined;
  testId?: string | undefined;
}

/** An on/off setting (role="switch"). Space and Enter toggle it like any button. */
export function Switch({ label, checked, onChange, disabled = false, showLabel = true, testId }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={showLabel ? undefined : label}
      className="switch"
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {showLabel && <span>{label}</span>}
    </button>
  );
}
