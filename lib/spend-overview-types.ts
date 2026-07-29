import type { KraljicQuadrant, PerformanceZone } from "@/lib/analysis-types";

/** One row of the Spend Overview supplier ranking table (period/range-scoped). */
export type SupplierRankingRow = {
  supplier_id: string;
  supplier_name: string;
  category: string | null;
  total_spend: number;
  // Invoice documents for this supplier over the span (Invoice is 1:1 with the
  // void-excluded purchase order, so this equals the PO count but is sourced from
  // invoices to match the "Invoices" / "Avg invoice" column labels).
  invoice_count: number;
  avg_invoice_value: number;
  abc_class: "A" | "B" | "C" | null;
  kraljic_quadrant: KraljicQuadrant | null;
  rank: number;
  // True when the supplier has no purchases in the selected period (rendered
  // muted, ranked last). The supplier still exists (identity + snapshot score).
  inactive: boolean;
  // True when the supplier is RETIRED master data (status !== "active"). Distinct
  // from `inactive` above: display-only badge, never filters or reorders.
  retired: boolean;
};

/** Per-supplier spend decomposition (all-time) for the drill-down panel. */
export type SpendDetail = {
  supplier: {
    id: string;
    name: string;
    category: string | null;
    country: string | null;
    // True when the supplier is RETIRED master data (status !== "active").
    // Display-only badge in the detail header; never filters or changes a figure.
    retired: boolean;
    // ABC class + Kraljic quadrant for the SELECTED period (period-scoped, matches
    // the ranking table). Null when the supplier is absent from that period.
    abcClass: "A" | "B" | "C" | null;
    kraljicQuadrant: KraljicQuadrant | null;
    // Performance-vs-Spend zone for the SELECTED period (period-scoped, parallel
    // to kraljicQuadrant). Null when absent from that period.
    zone: PerformanceZone | null;
    // Period-scoped performance (P2). `score` is the SELECTED period's composite
    // (single-year) or the range composite (range, computed from aggregated raw
    // inputs). `previousScore` drives the single-year delta arrow; `latestScore`
    // is the latest-period snapshot shown alongside a range composite. In the
    // no-span (all-time) fallback, `score` is the latest snapshot.
    performance: {
      score: number | null;
      mode: "single" | "range" | "all";
      periodLabel: string | null;
      previousScore: number | null;
      previousLabel: string | null;
      latestScore: number | null;
      latestLabel: string | null;
    };
  };
  stats: {
    totalSpend: number;
    poCount: number;
    earliestDate: string | null;
    latestDate: string | null;
    avgPoValue: number;
    // Period-scoped portfolio context for the Spend insights cards. `rank` is the
    // 1-based position by spend among active suppliers (null when absent);
    // `percentOfTotal` is this supplier's share of period spend; `activeSupplierCount`
    // is the number of suppliers with any spend in the period.
    rank: number | null;
    percentOfTotal: number | null;
    activeSupplierCount: number;
  };
  byItem: { itemName: string; poCount: number; totalSpend: number }[];
  pos: {
    poId: string;
    itemName: string;
    prDate: string | null;
    invoiceDate: string | null;
    paymentDate: string | null;
    quantity: number;
    unit: string;
    unitPriceUsd: number;
    totalValueUsd: number;
  }[];
};

/** Year-by-year supplier trajectory (all years; not period-scoped). */
export type SupplierEvolution = {
  supplier: { id: string; name: string };
  periods: {
    year: string;
    periodLabel: string;
    spend: number;
    invoiceCount: number;
    abcClass: "A" | "B" | "C" | null;
    kraljicQuadrant: KraljicQuadrant | null;
    performanceScore: number | null;
    // Per-period sub-scores (P2) — null when the supplier has no metric row that
    // period. Feeds the sub-score trajectory cards in the performance expand.
    subScores: {
      quality: number;
      delivery: number;
      process: number;
      risk: number;
    } | null;
    topItems: { itemName: string; spend: number; count: number }[];
  }[];
  insights: string[];
};
