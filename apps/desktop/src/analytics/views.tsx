// Views for the registry's analytics components. Screen teams register one per component id
// (docs/UI.md "Adding an analytics card"); a component without a view shows its field preview.
//
// HourlyPnLChart below is the worked example: a typed model from core, a chart through <EChart>,
// money through core's formatters with the user's locale.

import { asCompactCurrency, type HourlyPnLModel } from "@dojix-desktop/core";
import { AnalyticsViewRegistry, type ChartOption, defineAnalyticsView, EChart, readThemeColors } from "@dojix-desktop/ui";
import { useMemo } from "react";

function HourlyPnLView({ model, locale }: { model: HourlyPnLModel; locale: string }) {
  const option = useMemo<ChartOption>(() => {
    const c = readThemeColors();
    return {
      grid: { left: 8, right: 8, top: 12, bottom: 4, containLabel: true },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: model.hourlyData.map((r) => `${r.hour}:00`) },
      yAxis: { type: "value" },
      series: [
        {
          type: "bar",
          name: "P&L",
          data: model.hourlyData.map((r) => ({ value: r.pnl, itemStyle: { color: r.pnl >= 0 ? c.profit : c.loss } })),
        },
      ],
    };
  }, [model]);
  const best = model.best;
  const summary = best
    ? `P&L by hour (${model.zoneLabel}), ${model.hourlyData.length} hours with trades. Best: ${best.hour}:00 (${asCompactCurrency(best.pnl, locale)}).`
    : `P&L by hour (${model.zoneLabel}): no trades.`;
  return (
    <>
      {best && (
        <p className="card-subtitle">
          Best: <span className="mono">{best.hour}:00</span> ({asCompactCurrency(best.pnl, locale)})
        </p>
      )}
      <EChart option={option} ariaLabel={summary} height={200} testId="chart-hourly-pnl" />
    </>
  );
}

export const analyticsViews = new AnalyticsViewRegistry().register(
  defineAnalyticsView<HourlyPnLModel>({
    id: "HourlyPnLChart",
    title: "P&L by Hour",
    help: "Net P&L of the trades opened in each hour, summed. Hours without trades are left out.",
    span: 2,
    view: HourlyPnLView,
  }),
);
