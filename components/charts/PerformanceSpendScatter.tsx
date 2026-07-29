"use client";

import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { ChartFrame } from "./ChartFrame";
import { PinnableDot } from "./PinnableDot";
import { useAnimatedDomain, paddedDomain, type Domain } from "./useAnimatedDomain";
import { buildSpendAxis, spendMoneyAndShare } from "@/lib/spend-axis";
import { QUADRANT_COLORS, ZONE_COLORS } from "@/lib/chart-colors";
import type {
  PerformanceSpendSupplier,
  PerformanceZone,
} from "@/lib/analysis-types";

const ZONE_ORDER: PerformanceZone[] = [
  "Stars",
  "Critical Issues",
  "Hidden Gems",
  "Long Tail",
];

type ScatterTooltipProps = {
  active?: boolean;
  payload?: Array<{ payload: PerformanceSpendSupplier }>;
  // Injected by Recharts via cloneElement from the <Tooltip content> prop.
  total?: number;
};

function ScatterTooltip({ active, payload, total = 0 }: ScatterTooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border bg-background p-2 text-xs shadow-sm">
      <div className="font-medium">{d.supplier_name}</div>
      <div className="mt-1">
        <span className="text-muted-foreground">Zone: </span>
        <span className="font-medium" style={{ color: ZONE_COLORS[d.zone] }}>{d.zone}</span>
      </div>
      <div className="text-muted-foreground">
        Exposure:{" "}
        <span style={{ color: QUADRANT_COLORS[d.kraljic_quadrant] }}>{d.kraljic_quadrant}</span>
      </div>
      <div className="mt-1 text-muted-foreground">
        Spend {spendMoneyAndShare(d.total_spend_usd, total)} &middot; Performance{" "}
        {d.performance_score.toFixed(1)}
      </div>
    </div>
  );
}

export function PerformanceSpendScatter({
  suppliers,
  thresholds,
  zoomZone = null,
  onDotClick,
}: {
  suppliers: PerformanceSpendSupplier[];
  thresholds: { spend_median: number; performance_median: number };
  /** When set, the axes animate-zoom to fit this zone's suppliers (Change 1). */
  zoomZone?: PerformanceZone | null;
  /** Fires with the supplier id when a point is clicked. */
  onDotClick?: (supplierId: string) => void;
}) {
  // This chart owns its OWN colour system: dots coloured by Performance-vs-Spend
  // ZONE (deliberately distinct from the Kraljic matrix's quadrant palette so the
  // two scatters read apart). The Kraljic quadrant is a tooltip cross-ref only.
  const series = ZONE_ORDER.map((z) => ({
    key: z,
    color: ZONE_COLORS[z],
    data: suppliers.filter((s) => s.zone === z),
  }));
  const present = series.filter((s) => s.data.length > 0);

  // VIZ-ONLY %-of-spend axis: positions stay at log_spend; only the labels change.
  const total = suppliers.reduce((sum, s) => sum + s.total_spend_usd, 0);
  const axis = buildSpendAxis(
    suppliers.map((s) => s.log_spend),
    total,
  );

  // Numeric full domains (tween endpoints). X mirrors buildSpendAxis; Y is the
  // fixed performance scale [0,100].
  const xsAll = suppliers.map((s) => s.log_spend);
  const fullX: Domain = axis.domain ?? [Math.min(...xsAll) - 0.5, Math.max(...xsAll) + 0.5];
  const fullY: Domain = [0, 100];

  const group = zoomZone ? suppliers.filter((s) => s.zone === zoomZone) : [];
  const zoomed = group.length > 0;
  const target = zoomed
    ? {
        x: paddedDomain(group.map((s) => s.log_spend), fullX[1] - fullX[0]),
        y: paddedDomain(group.map((s) => s.performance_score), fullY[1] - fullY[0], {
          clamp: [0, 100],
        }),
      }
    : { x: fullX, y: fullY };

  const view = useAnimatedDomain(target);
  const atFull =
    !zoomed &&
    Math.abs(view.x[0] - fullX[0]) < 1e-6 &&
    Math.abs(view.x[1] - fullX[1]) < 1e-6 &&
    Math.abs(view.y[0] - fullY[0]) < 1e-6 &&
    Math.abs(view.y[1] - fullY[1]) < 1e-6;

  return (
    <ChartFrame height={450}>
      <ScatterChart margin={{ left: 24, right: 24, top: 16, bottom: 28 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          type="number"
          dataKey="log_spend"
          name="Total Spend"
          domain={atFull ? axis.domain ?? ["auto", "auto"] : view.x}
          ticks={atFull ? axis.ticks : undefined}
          tickFormatter={axis.tickFormatter}
          allowDataOverflow
          tick={{ fontSize: 11 }}
          label={{
            value: "Spend (% of total) →",
            position: "insideBottom",
            offset: -12,
            fontSize: 12,
          }}
        />
        <YAxis
          type="number"
          dataKey="performance_score"
          name="Performance"
          domain={atFull ? [0, 100] : view.y}
          width={56}
          allowDataOverflow
          tick={{ fontSize: 11 }}
          label={{
            value: "Performance Score →",
            angle: -90,
            position: "insideLeft",
            offset: 10,
            fontSize: 12,
          }}
        />
        <Tooltip
          content={<ScatterTooltip total={total} />}
          cursor={{ strokeDasharray: "3 3" }}
        />
        {/* Top-aligned so the legend labels don't collide with the bottom
            X-axis title (they previously overlapped/overflowed). */}
        <Legend verticalAlign="top" height={32} wrapperStyle={{ fontSize: 12 }} />
        <ReferenceLine
          x={thresholds.spend_median}
          stroke="var(--muted-foreground)"
          strokeDasharray="6 4"
        />
        <ReferenceLine
          y={thresholds.performance_median}
          stroke="var(--muted-foreground)"
          strokeDasharray="6 4"
        />
        {present.map((s) => (
          <Scatter
            key={s.key}
            name={s.key}
            // When zoomed, show ONLY the selected zone's dots (others → []).
            data={zoomZone && s.key !== zoomZone ? [] : s.data}
            fill={s.color}
            fillOpacity={0.8}
            shape={<PinnableDot onSelect={onDotClick} />}
            isAnimationActive={false}
          />
        ))}
      </ScatterChart>
    </ChartFrame>
  );
}
