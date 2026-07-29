"use client";

import type {
  SpendOverviewResult,
  AbcResult,
  SourcingCoverageResult,
} from "@/lib/analysis-types";
import type { SupplierRankingRow } from "@/lib/spend-overview-types";
import {
  buildSpendConcentration,
  paretoExpectedCount,
  PARETO_REFERENCE_PCT,
} from "@/lib/spend-concentration";
import { cardElevation, formatCompactCurrency } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const num0 = new Intl.NumberFormat("en-US");
const pct1 = (value: number) => `${value.toFixed(1)}%`;
const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/** "from 2024 to 2026" (range) / "in 2025" (single year), tolerant of label shape. */
function periodPhrase(periodLabel: string, isRangeMode: boolean): string {
  if (!periodLabel) return "in this period";
  if (isRangeMode) {
    const parts = periodLabel.split(/[–-]/).map((s) => s.trim());
    if (parts.length === 2 && parts[0] && parts[1]) return `from ${parts[0]} to ${parts[1]}`;
    return `over ${periodLabel}`;
  }
  return `in ${periodLabel}`;
}

/** Smallest supplier count whose cumulative spend reaches `targetPct` of total. */
function suppliersToReach(rows: SupplierRankingRow[], total: number, targetPct: number): number {
  if (total <= 0) return 0;
  const sorted = [...rows].sort((a, b) => b.total_spend - a.total_spend);
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i].total_spend;
    if (share(cum, total) >= targetPct) return i + 1;
  }
  return sorted.length;
}

/**
 * Consolidated analytical summary at the top of Spend Overview. Replaces the
 * per-section card descriptions with one period-aware narrative computed
 * client-side from already-loaded analyses (no new API / Python). Insights are
 * spend-overview-internal only — cross-page insights are deferred to report sync.
 */
export function InsightsPanel({
  spendOverview,
  totalInvoices,
  abc,
  ranking,
  sourcingCoverage,
  periodLabel,
  isRangeMode,
}: {
  spendOverview: SpendOverviewResult;
  /** Invoice-document count for the span (route `total_invoices`), used wherever
   *  the prose says "invoices" so the word matches its source. */
  totalInvoices: number;
  abc: AbcResult;
  ranking: SupplierRankingRow[];
  /** Null when the span is served from a cache row set predating this analysis. */
  sourcingCoverage: SourcingCoverageResult | null;
  periodLabel: string;
  isRangeMode: boolean;
}) {
  const total = spendOverview.total_spend;
  const phrase = periodPhrase(periodLabel, isRangeMode);

  // Concentration (ABC).
  const aN = abc.summary.A.n;
  const cN = abc.summary.C.n;
  const aPct = abc.summary.A.pct_of_spend * 100;
  const cPct = abc.summary.C.pct_of_spend * 100;
  // ⚠️ The adjective derives from TOP-FIFTH SHARE, never from
  // `summary.A.pct_of_spend`. Class A is defined as the suppliers covering the first
  // 80% of spend, so that figure is pinned to (0.80 − largest_single_share, 0.80] by
  // construction: on this data it never leaves [73.4%, 80%], so it always selected
  // "heavily concentrated" and always fired the "typical Pareto distribution" clause,
  // both of which are false here. See lib/spend-concentration for the full note.
  const conc = buildSpendConcentration(abc);

  // Categories (descending). ⚠️ `by_category` is a top-8 + synthetic "Other"
  // rollup for the donut — so it must NOT be used to COUNT or NAME categories.
  // The true distinct-category count comes from the compute layer
  // (`total_categories`); the `top_suppliers_by_category` key count is a complete
  // fallback for pre-2026-07-14 cached rows; `named` excludes "Other" from any
  // naming so the rollup bucket is never printed as a real category.
  const OTHER = "Other";
  const categories = [...spendOverview.by_category].sort((a, b) => b.total - a.total);
  const named = categories.filter((c) => c.category !== OTHER);
  const totalCategories =
    spendOverview.total_categories ??
    (spendOverview.top_suppliers_by_category
      ? Object.keys(spendOverview.top_suppliers_by_category).length
      : named.length);
  const topCategory = named[0];
  const secondCategory = named[1] ?? null;
  const topCatPct = topCategory ? share(topCategory.total, total) : 0;
  // "Dominates" only when the top category's share is genuinely large — ≥ 40% or
  // ≥ 1.5× the second category. Otherwise it is merely "the largest".
  const topCatDominates =
    topCategory != null &&
    (topCatPct >= 40 ||
      (secondCategory != null &&
        secondCategory.total > 0 &&
        topCategory.total >= 1.5 * secondCategory.total));
  const top3 = named.slice(0, 3);
  const top3Pct = share(
    top3.reduce((s, c) => s + c.total, 0),
    total,
  );
  // Categories needed to cover 80% of spend. The "Other" rollup still contributes
  // its spend to the cumulative, but is never COUNTED as a category.
  let catCum = 0;
  let catsTo80 = 0;
  for (const c of categories) {
    catCum += c.total;
    if (c.category !== OTHER) catsTo80 += 1;
    if (share(catCum, total) >= 80) break;
  }

  // Top supplier (with invoice count joined from the ranking).
  const topSupplier = spendOverview.top_suppliers[0];
  const topSupplierInvoices = topSupplier
    ? (ranking.find((r) => r.supplier_id === topSupplier.supplier_id)?.invoice_count ?? null)
    : null;

  // Monthly rhythm.
  const monthTotals = spendOverview.monthly_trend.map((m) => m.total);
  const hasRhythm = monthTotals.length >= 2;
  const sortedMonths = [...monthTotals].sort((a, b) => a - b);
  const median =
    sortedMonths.length === 0
      ? 0
      : sortedMonths.length % 2 === 1
        ? sortedMonths[(sortedMonths.length - 1) / 2]
        : (sortedMonths[sortedMonths.length / 2 - 1] + sortedMonths[sortedMonths.length / 2]) / 2;
  const minMonth = sortedMonths[0] ?? 0;
  const maxMonth = sortedMonths[sortedMonths.length - 1] ?? 0;

  // Spend concentration over ACTIVE suppliers (the ranking now also carries
  // $0/inactive rows, which must not inflate the long-tail count).
  const activeRanking = ranking.filter((r) => !r.inactive);
  const sup50 = suppliersToReach(activeRanking, total, 50);
  const sup80 = suppliersToReach(activeRanking, total, 80);

  return (
    <Card className={cardElevation}>
      <CardHeader>
        <CardTitle>Spend at a glance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm leading-relaxed">
        <p>
          You spent <strong>{formatCompactCurrency(total)}</strong> across{" "}
          {num0.format(totalInvoices)} invoices with{" "}
          {num0.format(spendOverview.active_suppliers)} suppliers {phrase}.
          {conc && (
            <>
              {" "}
              Spend is <strong>{conc.word}</strong>: the top {conc.topCount} suppliers — a
              fifth of the roster — hold <strong>{pct1(conc.topSharePct)}</strong> of it,
              against the {PARETO_REFERENCE_PCT}% the 80/20 rule would predict.
            </>
          )}{" "}
          Class A covers {aN} suppliers ({pct1(aPct)} of spend) and the bottom {cN} (Class C)
          contribute just {pct1(cPct)}.
          {conc &&
            (conc.meetsPareto
              ? " That is the classic Pareto shape ABC assumes, so Class A is a genuinely short list."
              : " Spend here is flatter than the 80/20 rule assumes, so Class A is a broad group rather than a short list — a property of this spend base, not a fault of the method.")}
        </p>

        {topCategory && (
          <div className="space-y-1">
            <h3 className="font-medium">Where the money goes</h3>
            <p>
              <strong>{topCategory.category}</strong>{" "}
              {topCatDominates ? "dominates at" : "is the largest at"}{" "}
              {formatCompactCurrency(topCategory.total)} ({pct1(topCatPct)})
              of total spend. The top{" "}
              {top3.length} categories — {top3.map((c) => c.category).join(", ")} — together
              account for {pct1(top3Pct)} of all spend.
              {topSupplier && (
                <>
                  {" "}
                  The largest supplier, <strong>{topSupplier.supplier_name}</strong>, alone
                  represents {formatCompactCurrency(topSupplier.total)} (
                  {pct1(share(topSupplier.total, total))})
                  {topSupplierInvoices != null
                    ? ` across ${num0.format(topSupplierInvoices)} invoices.`
                    : "."}
                </>
              )}
            </p>
          </div>
        )}

        {/* ⚠️ TWO SENTENCES, AND THE SPLIT IS NEVER ONE NUMBER. Reporting a single
            "competitive %" forces the 44.78% framework share onto one side or the
            other and misstates coverage by that whole amount in whichever direction
            it falls. The second sentence is the DATA GAP stated as a finding: it
            names a concrete schema fix, which is more actionable than any coverage
            percentage on this page. */}
        {sourcingCoverage && sourcingCoverage.total_spend > 0 && (
          <div className="space-y-1">
            <h3 className="font-medium">How the spend reached the market</h3>
            <p>
              <strong>{pct1(sourcingCoverage.by_bucket.competed.spend_pct)}</strong> of
              spend was competitively sourced through an RFQ or tender,{" "}
              <strong>{pct1(sourcingCoverage.by_bucket.framework.spend_pct)}</strong> drew
              on framework agreements, and{" "}
              <strong>{pct1(sourcingCoverage.by_bucket.uncompeted.spend_pct)}</strong> was
              awarded directly or bought on the spot without a sourcing event.
            </p>
            <p className="text-muted-foreground">
              The framework share is reported separately because its competitive basis{" "}
              <strong className="text-foreground">cannot be verified</strong>: a call-off
              draws on an agreement normally competed once at award, but framework records
              carry no link to the sourcing event that awarded them. That leaves{" "}
              {formatCompactCurrency(sourcingCoverage.unverifiable_share.spend)} —{" "}
              {pct1(sourcingCoverage.unverifiable_share.spend_pct)} of all spend — that
              this dashboard can neither confirm nor deny was competed. Linking a framework
              to its awarding event would close the largest measurement gap on this page.
            </p>
          </div>
        )}

        <div className="space-y-1">
          <h3 className="font-medium">Patterns worth noting</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {hasRhythm && (
              <li>
                Monthly spend runs a median of {formatCompactCurrency(median)}, ranging{" "}
                {formatCompactCurrency(minMonth)} to {formatCompactCurrency(maxMonth)} across
                the period.
              </li>
            )}
            {activeRanking.length > 0 && (
              <li>
                It takes {sup50} of {activeRanking.length} supplier
                {activeRanking.length === 1 ? "" : "s"} to reach half of spend and {sup80} to
                reach 80% — {pct1(share(sup80, activeRanking.length))} of the roster, where the
                80/20 rule would predict about {paretoExpectedCount(activeRanking.length)}.
                {conc &&
                  (conc.meetsPareto
                    ? " That is close to the classic Pareto split."
                    : " The spend base is broad rather than top-heavy.")}
              </li>
            )}
            {totalCategories > 0 && (
              <li>
                Spend spans {totalCategories} categor{totalCategories === 1 ? "y" : "ies"};
                the top {catsTo80} cover 80% of it, so diversification is{" "}
                {catsTo80 <= 2 ? "narrow" : catsTo80 <= 5 ? "moderate" : "broad"}.
              </li>
            )}
          </ul>
        </div>

        <p className="text-xs italic text-muted-foreground">
          Click any supplier row below for product-level decomposition. Use the period
          selector above to filter to specific years.
        </p>
      </CardContent>
    </Card>
  );
}
