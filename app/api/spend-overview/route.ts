import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { getRangeAnalyses } from "@/lib/range-analyses";
import { getRetiredSupplierIds } from "@/lib/suppliers";
import type { AbcResult, KraljicResult } from "@/lib/analysis-types";
import type { SupplierRankingRow } from "@/lib/spend-overview-types";
import { Prisma } from "@/lib/generated/prisma/client";

export const runtime = "nodejs";

/**
 * Spend Overview page data for a date span: the cached spend_overview analysis
 * (charts) plus a server-side supplier ranking. The ranking aggregates the span
 * by supplier (spend / invoice count / avg), merged with ABC class + Kraljic
 * quadrant from the analyses and category from the supplier catalog.
 * Login required (read-only); any role.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { startDate, endDate } = (body ?? {}) as {
    startDate?: string;
    endDate?: string;
  };
  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: "startDate and endDate are required" },
      { status: 400 },
    );
  }

  const analyses = await getRangeAnalyses(startDate, endDate);
  if (!analyses || !analyses.spend_overview) {
    return NextResponse.json(
      { error: "No spend data for this period." },
      { status: 400 },
    );
  }

  const abc = analyses.abc as AbcResult | null;
  const kraljic = analyses.kraljic as KraljicResult | null;
  const abcBySupplier = new Map(
    (abc?.classifications ?? []).map((c) => [c.supplier_id, c]),
  );
  const quadrantBySupplier = new Map(
    (kraljic?.quadrant_assignments ?? []).map((q) => [q.supplier_id, q]),
  );

  // Per-supplier aggregate over the span from the derived EnrichedPurchase view.
  // Filter mirrors the Python load (poDate = order-year membership) so totals
  // reconcile with spend_overview.
  //
  // "Invoices" on this page means invoice documents. Invoice is 1:1 with the
  // (void-excluded) purchase order — verified 647:647, with zero POs carrying no
  // invoice or more than one — so counting Invoice rows joined to the view yields
  // the same figure the PO grain did, now sourced from invoices to match the
  // "Invoices" / "Avg invoice" labels. Spend stays PO-grain (SUM over the view);
  // the 1:1 join cannot fan it out.
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T23:59:59`);
  const agg = await prisma.$queryRaw<
    { id: string; invoice_count: number; total_spend: number }[]
  >(Prisma.sql`
    SELECT ep."supplierExternalId" AS id,
           COUNT(i.id)::int AS invoice_count,
           SUM(ep."totalValueUsd")::float8 AS total_spend
    FROM "EnrichedPurchase" ep
    JOIN "Invoice" i ON i."poId" = ep."poId"
    WHERE ep."poDate" >= ${start}
      AND ep."poDate" <= ${end}
    GROUP BY ep."supplierExternalId"
  `);
  const aggById = new Map(agg.map((r) => [r.id, r]));

  // The full supplier roster (identity) — one row per supplier.
  // Including ALL suppliers means those with $0 in the period appear too, muted
  // and ranked last (they still exist; only their period activity is empty).
  // ⚠️ SupplierMetric is now per-period (P2): without `distinct` this fans out to
  // one row per supplier-period and duplicates every supplier in the ranking.
  // Identity/category are period-invariant, so keep any one row per supplier.
  const roster = await prisma.supplierMetric.findMany({
    select: { supplierExternalId: true, supplierName: true, category: true },
    distinct: ["supplierExternalId"],
    orderBy: { periodId: "desc" },
  });

  // Master-data retirement (status !== "active"), for a display-only badge. Does
  // NOT filter or reorder — retired suppliers keep their spend and rank.
  const retiredIds = await getRetiredSupplierIds();

  const ranking: SupplierRankingRow[] = roster
    .map((s) => {
      const a = aggById.get(s.supplierExternalId);
      const abcRow = abcBySupplier.get(s.supplierExternalId);
      const krRow = quadrantBySupplier.get(s.supplierExternalId);
      const invoiceCount = a ? Number(a.invoice_count) || 0 : 0;
      const totalSpend = a ? Number(a.total_spend) || 0 : 0;
      return {
        supplier_id: s.supplierExternalId,
        supplier_name: s.supplierName,
        category: s.category ?? null,
        total_spend: totalSpend,
        invoice_count: invoiceCount,
        avg_invoice_value: invoiceCount > 0 ? totalSpend / invoiceCount : 0,
        abc_class: abcRow?.abc_class ?? null,
        kraljic_quadrant: krRow?.quadrant ?? null,
        rank: 0,
        inactive: invoiceCount === 0,
        retired: retiredIds.has(s.supplierExternalId),
      };
    })
    .sort((a, b) => b.total_spend - a.total_spend)
    .map((row, i) => ({ ...row, rank: i + 1 }));

  // Total invoice count for the span (= Σ per-supplier invoice_count). Equal to the
  // Python spend_overview PO count under the verified 1:1, but sourced from invoices
  // so the "Total invoices" / "Avg invoice value" KPIs match their labels.
  const totalInvoices = agg.reduce((sum, r) => sum + (Number(r.invoice_count) || 0), 0);

  return NextResponse.json({
    spend_overview: analyses.spend_overview,
    total_invoices: totalInvoices,
    abc: analyses.abc ?? null,
    // Competitive sourcing coverage — how the spend reached the market. Nullable at
    // the boundary like `abc`: a span computed before this analysis existed can be
    // served from a cache row set that predates it, and the page renders without it.
    sourcing_coverage: analyses.sourcing_coverage ?? null,
    ranking,
  });
}
