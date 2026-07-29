"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  SpendOverviewResult,
  AbcResult,
  SourcingCoverageResult,
} from "@/lib/analysis-types";
import type { SupplierRankingRow } from "@/lib/spend-overview-types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatBlock } from "@/components/ui/stat-block";
import { cardElevation, formatCompactCurrency } from "@/lib/utils";
import { SpendByCategoryChart } from "@/components/charts/SpendByCategoryChart";
import { MonthlySpendTrendChart } from "@/components/charts/MonthlySpendTrendChart";
import { TopSuppliersCard } from "@/components/analysis/OverviewCharts";
import { PinProvider } from "@/components/Reports/PinContext";
import { SupplierRankingTable } from "./SupplierRankingTable";
import { SpendDecompositionPanel } from "./SpendDecompositionPanel";
import { AbcParetoCard } from "./AbcParetoCard";
import { CompetitiveCoverageCard } from "./CompetitiveCoverageCard";
import { InsightsPanel } from "./InsightsPanel";

const num0 = new Intl.NumberFormat("en-US");

/** "from 2024 to 2026" (range) / "in 2026" (single year), tolerant of label shape. */
function periodPhrase(periodLabel: string, isRangeMode: boolean): string {
  if (!periodLabel) return "this period";
  if (isRangeMode) {
    const parts = periodLabel.split(/[–-]/).map((s) => s.trim());
    if (parts.length === 2 && parts[0] && parts[1]) return `from ${parts[0]} to ${parts[1]}`;
    return periodLabel;
  }
  return `in ${periodLabel}`;
}

type PageData = {
  spend_overview: SpendOverviewResult;
  // Invoice-document count for the span (sourced from the Invoice table in the
  // route). Equals the PO count under the verified 1:1, but feeds the "invoice"
  // KPIs so their source matches their label.
  total_invoices: number;
  abc: AbcResult | null;
  // Nullable at the boundary like `abc` — a span served from a pre-existing cache
  // row set won't carry it, so every consumer must guard rather than assume.
  sourcing_coverage: SourcingCoverageResult | null;
  ranking: SupplierRankingRow[];
};

/**
 * Client wrapper for the Spend Overview page. Fetches page data for the span
 * (charts + supplier ranking), owns the selected-supplier drill-down, and wires
 * Top-10 bar clicks to the panel via a dashboard-scoped PinProvider.
 */
export function SpendOverviewClient({
  startDate,
  endDate,
  periodLabel,
  isRangeMode,
}: {
  startDate: string;
  endDate: string;
  periodLabel: string;
  isRangeMode: boolean;
}) {
  // Loaded data / error are tagged with the span key they belong to, so loading
  // is derived (no synchronous setState in the effect — matches ReportEditor).
  const spanKey = `${startDate}_${endDate}`;
  const [loaded, setLoaded] = useState<{ key: string; data: PageData } | null>(null);
  const [errored, setErrored] = useState<{ key: string; msg: string } | null>(null);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);

  const data = loaded?.key === spanKey ? loaded.data : null;
  const error = errored?.key === spanKey ? errored.msg : null;

  // Clear the drill-down when the span changes (different supplier population).
  const [prevSpanKey, setPrevSpanKey] = useState(spanKey);
  if (prevSpanKey !== spanKey) {
    setPrevSpanKey(spanKey);
    if (selectedSupplierId !== null) setSelectedSupplierId(null);
  }

  useEffect(() => {
    const key = `${startDate}_${endDate}`;
    let cancelled = false;
    fetch("/api/spend-overview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error || "Failed to load");
        }
        return res.json() as Promise<PageData>;
      })
      .then((d) => {
        if (!cancelled) setLoaded({ key, data: d });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setErrored({ key, msg: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [startDate, endDate]);

  const pinValue = useMemo(
    () => ({
      pinnedSupplierId: selectedSupplierId,
      pin: (id: string) => setSelectedSupplierId(id),
      clear: () => setSelectedSupplierId(null),
    }),
    [selectedSupplierId],
  );

  if (error) {
    return <p className="py-16 text-center text-sm text-destructive">{error}</p>;
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading spend overview…
      </div>
    );
  }

  const spend = data.spend_overview;
  // "Invoices" is sourced from the Invoice table (route `total_invoices`), not the
  // PO count. Identical value under the verified 1:1; honest about its source.
  const totalInvoices = data.total_invoices;
  const avgInvoiceValue = totalInvoices > 0 ? spend.total_spend / totalInvoices : 0;
  const phrase = periodPhrase(periodLabel, isRangeMode);
  const perSupplier =
    spend.active_suppliers > 0 ? totalInvoices / spend.active_suppliers : 0;
  // ⚠️ Distinct REAL category count — NOT `by_category.length` (capped at top-8 +
  // synthetic "Other" for the donut). Prefer the compute-layer truth; fall back to
  // the complete `top_suppliers_by_category` key set for pre-2026-07-14 cached rows.
  const categoryCount =
    spend.total_categories ??
    (spend.top_suppliers_by_category
      ? Object.keys(spend.top_suppliers_by_category).length
      : spend.by_category.length);

  return (
    <>
      {data.abc && (
        <InsightsPanel
          spendOverview={spend}
          totalInvoices={totalInvoices}
          abc={data.abc}
          ranking={data.ranking}
          sourcingCoverage={data.sourcing_coverage}
          periodLabel={periodLabel}
          isRangeMode={isRangeMode}
        />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatBlock
          size="lg"
          label="Total spend"
          value={formatCompactCurrency(spend.total_spend)}
          sublabel={phrase}
        />
        <StatBlock
          size="lg"
          label="Total invoices"
          value={num0.format(totalInvoices)}
          sublabel={`${perSupplier.toFixed(1)} per supplier`}
        />
        <StatBlock
          size="lg"
          label="Active suppliers"
          value={num0.format(spend.active_suppliers)}
          sublabel={`across ${categoryCount} categories`}
        />
        <StatBlock
          size="lg"
          label="Avg invoice value"
          value={formatCompactCurrency(avgInvoiceValue)}
          sublabel="per invoice"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className={cardElevation}>
          <CardHeader>
            <CardTitle>Spend by Category</CardTitle>
          </CardHeader>
          <CardContent>
            <SpendByCategoryChart data={spend.by_category} />
          </CardContent>
        </Card>
        {/* Top-10 bar clicks open the decomposition panel via this provider. */}
        <PinProvider value={pinValue}>
          <TopSuppliersCard spend={spend} elevated />
        </PinProvider>
      </div>

      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>Monthly Spend Trend</CardTitle>
        </CardHeader>
        <CardContent>
          <MonthlySpendTrendChart data={spend.monthly_trend} />
        </CardContent>
      </Card>

      {/* Competitive coverage sits between the category donut and the ABC/Pareto
          card: it is a spend-composition cut (how the money left the building),
          so it belongs with the other composition surfaces rather than on a page
          of its own. */}
      {data.sourcing_coverage && (
        <CompetitiveCoverageCard data={data.sourcing_coverage} />
      )}

      {data.abc && <AbcParetoCard abc={data.abc} />}

      <SupplierRankingTable
        rows={data.ranking}
        onSupplierClick={setSelectedSupplierId}
        selectedSupplierId={selectedSupplierId}
      />

      <SpendDecompositionPanel
        supplierId={selectedSupplierId}
        startDate={startDate}
        endDate={endDate}
        onClose={() => setSelectedSupplierId(null)}
      />
    </>
  );
}
