"use client";

import { useState } from "react";
import type { SpendOverviewResult } from "@/lib/analysis-types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cardElevation } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SpendByCategoryChart } from "@/components/charts/SpendByCategoryChart";
import { TopSuppliersChart } from "@/components/charts/TopSuppliersChart";
import { MonthlySpendTrendChart } from "@/components/charts/MonthlySpendTrendChart";
import { Sparkline } from "@/components/charts/Sparkline";

const ALL_CATEGORIES = "__all__";

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const num0 = new Intl.NumberFormat("en-US");

/**
 * Top suppliers chart with a visibility-only category filter. "All Categories"
 * shows the overall top 10 (spend.top_suppliers); picking a category swaps in
 * that category's top suppliers (up to 10, fewer if fewer exist — no padding).
 * If the per-category field is absent (old cached rows), the filter is hidden
 * and the card behaves exactly as before.
 */
export function TopSuppliersCard({
  spend,
  // Dashboard passes `elevated` for cardElevation parity with the other Spend
  // Overview cards; the report editor omits it → flat, matching its other cards.
  elevated = false,
}: {
  spend: SpendOverviewResult;
  elevated?: boolean;
}) {
  const byCategory = spend.top_suppliers_by_category;
  const categories = byCategory ? Object.keys(byCategory).sort() : [];
  const [selected, setSelected] = useState<string>(ALL_CATEGORIES);

  const showFilter = categories.length > 0;
  const isAll = selected === ALL_CATEGORIES;
  const data = isAll
    ? spend.top_suppliers
    : (byCategory?.[selected] ?? []);

  const items = [
    { value: ALL_CATEGORIES, label: "All Categories" },
    ...categories.map((c) => ({ value: c, label: c })),
  ];

  return (
    <Card className={elevated ? cardElevation : undefined}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{isAll ? "Top 10 Suppliers" : `Top Suppliers — ${selected}`}</CardTitle>
        {showFilter && (
          <Select
            items={items}
            value={selected}
            onValueChange={(v) => setSelected(v ?? ALL_CATEGORIES)}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All Categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <TopSuppliersChart data={data} />
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No suppliers in this category for the selected period.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function KpiCard({
  label,
  value,
  spark,
}: {
  label: string;
  value: string;
  // Batch 6c: editor-only sparkline (omit to render a plain card).
  spark?: Array<number | null | undefined>;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-2">
        <div className="text-2xl font-semibold">{value}</div>
        {spark && (
          <div className="text-primary">
            <Sparkline data={spark} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const SpendByCategoryCard = ({ spend }: { spend: SpendOverviewResult }) => (
  <Card>
    <CardHeader>
      <CardTitle>Spend by Category</CardTitle>
    </CardHeader>
    <CardContent>
      <SpendByCategoryChart data={spend.by_category} />
    </CardContent>
  </Card>
);

const MonthlyTrendCard = ({ spend }: { spend: SpendOverviewResult }) => (
  <Card>
    <CardHeader>
      <CardTitle>Monthly Spend Trend</CardTitle>
      <CardDescription>
        Realized spend, bucketed by supplier invoice date.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <MonthlySpendTrendChart data={spend.monthly_trend} />
    </CardContent>
  </Card>
);

/**
 * Spend Overview charts. `embedded` (report editor) adds KPI sparklines and stacks
 * the three chart cards (Monthly trend / By category / Top suppliers) so the report —
 * and its printed PDF — contains all three. (An earlier tabbed layout was dropped: a
 * chart inside a display:none tab is never sized by Recharts, so it printed blank.)
 * On the standalone Overview page (`embedded` false) the same three charts stack.
 */
export function OverviewCharts({
  spend,
  totalInvoices,
  embedded = false,
}: {
  spend: SpendOverviewResult;
  // Invoice-document count for the span, threaded from the report assembly (from
  // the Invoice table). Distinct from spend.total_pos (the PO count) — equal only
  // while Invoice is 1:1 with the PO — so the "Total invoices" KPI + prose below
  // count invoices, not POs.
  totalInvoices: number;
  embedded?: boolean;
}) {
  const spendSpark = embedded
    ? spend.monthly_trend.map((m) => m.total)
    : undefined;
  // Editor-only sparkline. The monthly series Python emits is a PO count; it is a
  // trend SHAPE beneath the KPI (not a labelled figure) and equals monthly invoices
  // while Invoice is 1:1 with the PO. A monthly INVOICE series would need a new
  // per-month query and is deliberately not added — only the labelled total is
  // invoice-sourced.
  const poSpark = embedded
    ? spend.monthly_trend.map((m) => m.po_count)
    : undefined;

  const summary = (
    <p className="text-sm text-muted-foreground">
      This period totaled {usd0.format(spend.total_spend)} across{" "}
      {num0.format(totalInvoices)} invoices from{" "}
      {num0.format(spend.active_suppliers)} active suppliers, with an average
      procure-to-pay cycle time of {spend.avg_cycle_time.toFixed(1)} days.
    </p>
  );

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Total Spend" value={usdCompact.format(spend.total_spend)} spark={spendSpark} />
        <KpiCard label="Total invoices" value={num0.format(totalInvoices)} spark={poSpark} />
        <KpiCard label="Active Suppliers" value={num0.format(spend.active_suppliers)} />
        <KpiCard label="Avg Cycle Time" value={`${spend.avg_cycle_time.toFixed(1)} days`} />
      </div>

      {embedded ? (
        // Stacked so every chart is mounted + sized → all three render on screen
        // AND in the printed PDF (no display:none tabs that Recharts can't rasterise).
        <>
          <MonthlyTrendCard spend={spend} />
          <SpendByCategoryCard spend={spend} />
          <TopSuppliersCard spend={spend} />
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SpendByCategoryCard spend={spend} />
            <TopSuppliersCard spend={spend} />
          </div>
          <MonthlyTrendCard spend={spend} />
        </>
      )}

      {summary}
    </>
  );
}
