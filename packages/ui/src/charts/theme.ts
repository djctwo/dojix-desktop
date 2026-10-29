import type { ThemeColors } from "../theme/tokens";

/**
 * The ECharts theme for the current brand, built from the resolved design tokens so charts
 * follow the same colours as the rest of the UI. Series colours: the brand accent first, then
 * the shared semantic palette in the order the Mac charts use it.
 */
export function chartTheme(c: ThemeColors): Record<string, unknown> {
  const axis = {
    axisLine: { show: true, lineStyle: { color: c.borderSubtle } },
    axisTick: { show: false },
    axisLabel: { color: c.textSecondary, fontFamily: c.fontMono, fontSize: 11 },
    splitLine: { show: true, lineStyle: { color: c.borderSubtle } },
    nameTextStyle: { color: c.textSecondary },
  };
  return {
    color: [
      c.accent,
      c.semantic.blue,
      c.semantic.green,
      c.semantic.purple,
      c.semantic.cyan,
      c.semantic.pink,
      c.semantic.red,
      c.semantic.amber,
    ],
    backgroundColor: "transparent",
    textStyle: { color: c.textSecondary, fontFamily: c.fontUi, fontSize: 12 },
    legend: { textStyle: { color: c.textSecondary }, icon: "roundRect", itemWidth: 10, itemHeight: 10 },
    tooltip: {
      backgroundColor: c.bgCard,
      borderColor: c.border,
      borderWidth: 1,
      textStyle: { color: c.textPrimary, fontFamily: c.fontUi, fontSize: 12 },
      extraCssText: "border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.35);",
    },
    grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
    categoryAxis: { ...axis, splitLine: { show: false } },
    valueAxis: axis,
    timeAxis: { ...axis, splitLine: { show: false } },
    logAxis: axis,
    line: { symbol: "none", lineStyle: { width: 2 } },
    bar: { itemStyle: { borderRadius: [3, 3, 0, 0] } },
    visualMap: { textStyle: { color: c.textSecondary } },
  };
}
