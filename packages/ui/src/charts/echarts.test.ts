import { describe, expect, it } from "vitest";
import { initChart } from "./echarts";

describe("echarts registration", () => {
  it("draws an SVG chart with the registered modules", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 300 });
    Object.defineProperty(el, "clientHeight", { value: 150 });
    document.body.append(el);
    const chart = initChart(el, undefined, { renderer: "svg", width: 300, height: 150 });
    chart.setOption({
      animation: false,
      xAxis: { type: "category", data: ["a", "b"] },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: [1, -1] }, { type: "line", data: [1, 2] }],
    });
    expect(el.querySelector("svg")).not.toBeNull();
    chart.dispose();
    el.remove();
  });
});
