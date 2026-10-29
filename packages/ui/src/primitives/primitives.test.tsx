import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Badge, Kbd } from "./Badge";
import { Button, IconButton } from "./Button";
import { Card, Inset } from "./Card";
import { HelpTip } from "./HelpTip";
import { MetricCard, MetricGrid } from "./MetricCard";
import { Section } from "./Section";
import { PillTabs, SegmentedControl, TabPanel } from "./Tabs";
import { SCREEN_ICONS, ScreenIcon } from "./icons";

afterEach(cleanup);

describe("Button", () => {
  it("is type=button by default and ignores clicks while loading", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const b = screen.getByRole("button", { name: "Save" });
    expect(b.getAttribute("type")).toBe("button");
    expect(b.className).toBe("button");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} loading variant="primary" size="small">
        Save
      </Button>,
    );
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.className).toContain("button-primary");
    expect(b.className).toContain("button-small");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("icon buttons are named by their label", () => {
    render(
      <IconButton label="Export PDF" size="small">
        <svg />
      </IconButton>,
    );
    const b = screen.getByRole("button", { name: "Export PDF" });
    expect(b.getAttribute("title")).toBe("Export PDF");
    expect(b.className).toContain("icon-button-small");
  });
});

describe("Card, Badge, Kbd, Inset", () => {
  it("renders title, subtitle, actions and footer", () => {
    render(
      <Card title="Win rate" subtitle="Last 30 days" actions={<button>x</button>} footer="footer" accent hover level={3} data-testid="c">
        <Inset>body</Inset>
      </Card>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Win rate" })).toBeTruthy();
    expect(screen.getByTestId("c").className).toBe("card card-accent card-hover");
    expect(screen.getByText("Last 30 days")).toBeTruthy();
    expect(screen.getByText("footer").tagName).toBe("FOOTER");
    expect(screen.getByText("body").className).toBe("inset");
  });

  it("badges carry their tone", () => {
    render(
      <>
        <Badge>Gold</Badge>
        <Badge tone="loss">Loss</Badge>
        <Kbd>Ctrl</Kbd>
      </>,
    );
    expect(screen.getByText("Gold").className).toBe("badge");
    expect(screen.getByText("Loss").className).toBe("badge badge-loss");
    expect(screen.getByText("Ctrl").tagName).toBe("KBD");
  });
});

describe("MetricCard", () => {
  it("shows label, value with tone, subtitle and help", () => {
    render(
      <MetricGrid label="Headline">
        <MetricCard label="Net P&L" value="$1,234.00" tone="profit" subtitle="12 trades" help="Sum of net profit." testId="m" small />
      </MetricGrid>,
    );
    expect(screen.getByRole("group", { name: "Headline" })).toBeTruthy();
    const card = screen.getByTestId("m");
    expect(card.className).toContain("metric-small");
    expect(card.querySelector(".metric-value")?.className).toContain("tone-profit");
    expect(screen.getByRole("button", { name: "What is Net P&L?" })).toBeTruthy();
  });
});

describe("HelpTip", () => {
  it("opens on click and closes on Escape or an outside click", () => {
    render(<HelpTip term="Expectancy" definition="Average result per trade." />);
    const b = screen.getByRole("button", { name: "What is Expectancy?" });
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(b.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.hidden).toBe(true);
    fireEvent.click(b);
    expect(tip.hidden).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tip.hidden).toBe(true);
    fireEvent.focus(b);
    expect(tip.hidden).toBe(false);
    fireEvent.pointerDown(document.body);
    expect(tip.hidden).toBe(true);
    fireEvent.mouseEnter(b.parentElement as HTMLElement);
    expect(tip.hidden).toBe(false);
    fireEvent.mouseLeave(b.parentElement as HTMLElement);
    fireEvent.blur(b);
    expect(tip.hidden).toBe(true);
  });
});

function TabsHarness() {
  const [tab, setTab] = useState<"a" | "b" | "c">("a");
  return (
    <>
      <PillTabs
        label="Cats"
        idPrefix="t"
        selected={tab}
        onSelect={setTab}
        items={[
          { id: "a", label: "Alpha", hint: "Alt+1" },
          { id: "b", label: "Beta" },
          { id: "c", label: "Gamma" },
        ]}
      />
      <TabPanel idPrefix="t" selected={tab}>
        panel {tab}
      </TabPanel>
    </>
  );
}

describe("PillTabs", () => {
  it("is an ARIA tab list with arrow, Home and End keys", () => {
    render(<TabsHarness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs[0]?.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("t-tab-a");
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Beta" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(screen.getByText("panel c")).toBeTruthy();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(screen.getByText("panel a")).toBeTruthy();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(screen.getByText("panel c")).toBeTruthy();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(screen.getByText("panel a")).toBeTruthy();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "x" });
    fireEvent.click(screen.getByRole("tab", { name: "Gamma" }));
    expect(screen.getByText("panel c")).toBeTruthy();
  });
});

describe("SegmentedControl", () => {
  it("is a radio group", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Mode"
        value="all"
        onChange={onChange}
        testId="seg"
        options={[
          { id: "essential", label: "Essential" },
          { id: "all", label: "All" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Essential" }));
    expect(onChange).toHaveBeenCalledWith("essential");
    fireEvent.keyDown(screen.getByRole("radio", { name: "All" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("essential");
  });
});

describe("Section", () => {
  it("collapses and reports the change", () => {
    const onOpenChange = vi.fn();
    render(
      <Section title="Prop firm" collapsible onOpenChange={onOpenChange} testId="s">
        <p>inside</p>
      </Section>,
    );
    const toggle = screen.getByRole("button", { name: "Prop firm" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => toggle.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByText("inside").parentElement?.hidden).toBe(true);
  });

  it("renders a plain heading when not collapsible", () => {
    render(
      <Section title="Overview">
        <p>x</p>
      </Section>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeTruthy();
  });
});

describe("ScreenIcon", () => {
  it("has an icon for every screen and hides it from screen readers", () => {
    expect(Object.keys(SCREEN_ICONS)).toHaveLength(10);
    const { container } = render(<ScreenIcon screen="pulse" />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
