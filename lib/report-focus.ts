import "server-only";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  getAnalysisResult,
  type AbcResult,
  type KraljicResult,
  type PerformanceSpendResult,
} from "@/lib/analysis-types";
import { getPoLines } from "@/lib/po-lines";
import type { SupplierFocusData } from "@/lib/report-focus-types";

/**
 * Assemble the per-supplier data a Focus → supplier BRIEF needs — the item
 * breakdown (what you buy) and the year-by-year trajectory — for a report span.
 *
 * READ-ONLY and no recompute: it runs the SAME queries the modal's routes run, so
 * the numbers are identical to UnifiedSupplierDetailModal, but it does NOT touch
 * those routes:
 *   - itemBreakdown mirrors app/api/suppliers/[id]/spend-detail (byItem): purchases
 *     in the span by paymentDate, grouped by item, summed + counted, sorted desc.
 *   - trajectory mirrors app/api/suppliers/[id]/evolution: all periods, purchases
 *     bucketed by (paymentDate ?? prDate) within each period's bounds, with ABC /
 *     Kraljic / performance read from that period's cached (Mode A) analyses.
 *
 * The identity/position/anomaly/recommendation parts of the brief come from the
 * analyses the report already carries — only these two per-supplier cuts need a
 * dedicated read.
 */
export async function assembleSupplierFocus(
  supplierId: string,
  startDate: string,
  endDate: string,
): Promise<SupplierFocusData> {
  // --- item breakdown (span-scoped) — mirrors spend-detail's byItem ----------
  // Line-grain (lock C): item detail lives on PoLine. Span membership is order-year
  // (poDate), the same filter the rest of the app now uses. spend = Σ line value;
  // poCount = DISTINCT POs including the item.
  const spanLines = await getPoLines({
    supplierExternalId: supplierId,
    start: new Date(`${startDate}T00:00:00`),
    end: new Date(`${endDate}T23:59:59`),
  });

  let totalSpend = 0;
  const spanPos = new Set<string>();
  const byItemMap = new Map<string, { pos: Set<string>; totalSpend: number }>();
  for (const l of spanLines) {
    totalSpend += l.lineValueUsd;
    spanPos.add(l.poId);
    const cur = byItemMap.get(l.itemName) ?? { pos: new Set<string>(), totalSpend: 0 };
    cur.pos.add(l.poId);
    cur.totalSpend += l.lineValueUsd;
    byItemMap.set(l.itemName, cur);
  }
  const itemBreakdown = [...byItemMap.entries()]
    .map(([itemName, v]) => ({ itemName, poCount: v.pos.size, totalSpend: v.totalSpend }))
    .sort((a, b) => b.totalSpend - a.totalSpend);

  // --- YoY trajectory — mirrors the evolution route (all periods) ------------
  // Identity (name/category/country) comes from the Supplier master row; the
  // all-year LINE rows carry the order-year `period` for bucketing.
  const [periods, allLines, supplier] = await Promise.all([
    prisma.reportingPeriod.findMany({
      orderBy: { startDate: "asc" },
      select: { id: true, name: true, startDate: true, endDate: true },
    }),
    getPoLines({ supplierExternalId: supplierId }),
    prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { supplierName: true, category: true, country: true },
    }),
  ]);

  const analysesByPeriod = await Promise.all(
    periods.map(async (p) => {
      const [abc, kraljic, perf] = await Promise.all([
        getAnalysisResult<AbcResult>(p.id, "abc"),
        getAnalysisResult<KraljicResult>(p.id, "kraljic"),
        getAnalysisResult<PerformanceSpendResult>(p.id, "performance_spend"),
      ]);
      return { period: p, abc, kraljic, perf };
    }),
  );

  // Invoice documents per order-year for this supplier, from the Invoice table
  // (1:1 with the void-excluded PO) — the invoice-sourced count for the brief's
  // trajectory table. Keyed by EnrichedPurchase.period, matching the line bucket.
  const invByYearRows = await prisma.$queryRaw<{ period: string; n: number }[]>(Prisma.sql`
    SELECT ep.period AS period, COUNT(i.id)::int AS n
    FROM "EnrichedPurchase" ep
    JOIN "Invoice" i ON i."poId" = ep."poId"
    WHERE ep."supplierExternalId" = ${supplierId}
    GROUP BY ep.period
  `);
  const invoiceByYear = new Map(invByYearRows.map((r) => [r.period, r.n]));

  const trajectory = analysesByPeriod.map(({ period, abc, kraljic, perf }) => {
    // Order-year membership: the line's own `period` (== PurchaseOrder.period).
    const inPeriod = allLines.filter((l) => l.period === period.name);
    const spend = inPeriod.reduce((s, l) => s + l.lineValueUsd, 0);
    return {
      year: period.name,
      spend,
      invoiceCount: invoiceByYear.get(period.name) ?? 0,
      abcClass:
        abc?.classifications.find((c) => c.supplier_id === supplierId)?.abc_class ??
        null,
      kraljicQuadrant:
        kraljic?.quadrant_assignments.find((q) => q.supplier_id === supplierId)
          ?.quadrant ?? null,
      performanceScore:
        perf?.suppliers.find((s) => s.supplier_id === supplierId)
          ?.performance_score ?? null,
    };
  });

  return {
    supplierId,
    name: supplier?.supplierName ?? supplierId,
    category: supplier?.category ?? null,
    country: supplier?.country ?? null,
    itemBreakdown,
    totalSpend,
    poCount: spanPos.size,
    trajectory,
  };
}
