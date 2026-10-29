import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Checkbox, Field, Select, Switch, TextArea, TextInput } from "./Fields";

afterEach(cleanup);

describe("Field", () => {
  it("labels the control and wires hint and error for screen readers", () => {
    render(
      <Field label="Symbol" hint="Up to 10 characters" error="Only A–Z, 0–9 and dots">
        <TextInput placeholder="FIXA" />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Symbol" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0] as string)?.textContent).toBe("Up to 10 characters");
    expect(document.getElementById(ids[1] as string)?.getAttribute("role")).toBe("alert");
  });

  it("keeps a control's own id and handles non-element children", () => {
    const { rerender } = render(
      <Field label="Notes" inline>
        <TextArea id="notes" />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Notes" }).id).toBe("notes");
    expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toBeNull();
    rerender(<Field label="Plain">text only</Field>);
    expect(screen.getByText("Plain").getAttribute("for")).toBeNull();
  });
});

describe("controls", () => {
  it("Select reports the chosen value", () => {
    const onChange = vi.fn();
    render(
      <Field label="Range">
        <Select
          value="all"
          onChange={onChange}
          options={[
            { value: "all", label: "All" },
            { value: "last30", label: "30 days" },
          ]}
        />
      </Field>,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Range" }), { target: { value: "last30" } });
    expect(onChange).toHaveBeenCalledWith("last30");
  });

  it("Checkbox and Switch toggle", () => {
    const onCheck = vi.fn();
    const onSwitch = vi.fn();
    render(
      <>
        <Checkbox label="Followed my plan" checked={false} onChange={onCheck} />
        <Switch label="Allow AI analysis" checked onChange={onSwitch} testId="sw" />
        <Switch label="Hidden label" checked={false} onChange={onSwitch} showLabel={false} />
      </>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Followed my plan" }));
    expect(onCheck).toHaveBeenCalledWith(true);
    const sw = screen.getByRole("switch", { name: "Allow AI analysis" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(onSwitch).toHaveBeenCalledWith(false);
    expect(screen.getByRole("switch", { name: "Hidden label" }).getAttribute("aria-label")).toBe("Hidden label");
  });
});
