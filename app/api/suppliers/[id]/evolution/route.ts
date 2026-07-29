import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma/client";
import { getSession } from "@/lib/auth";
import {
  getAnalysisResult,
  type AbcResult,
  type KraljicResult,
  type PerformanceSpendResult,
} from "@/lib/analysis-types";
import { getPoLines } from "@/lib/po-lines";
import type { SupplierEvolution } from "@/lib/spend-overview-types";

export const runtime = "nodejs";

const pct = (from: number, to: number) =>
  from > 0 ? Math.round(((to - from) / from) * 100) : null;

/**
 * Year-by-year trajectory for one supplier: spend, invoice count, ABC class,
 * Kraljic quadrant, performance score, and top items per period. Built from the
 * per-period (Mode A) analyses + the Purchase table. NOT period-scoped — always
 * all available years. Login required (read-only); any role.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const [periods, lines, metricRows, supplier] = await Promise.all([
    prisma.reportingPeriod.findMany({
      orderBy: { startDate: "asc" },
      select: { id: true, name: true, startDate: true, endDate: true },
    }),
    // The supplier's LINE rows (all years), carrying the order-year `period` for
    // bucketing + item detail for the product-mix (lock C).
    getPoLines({ supplierExternalId: id }),
    // Per-period sub-scores (P2) for the sub-score trajectory cards.
    prisma.supplierMetric.findMany({
      where: { supplierExternalId: id },
      select: {
        periodId: true,
        supplierName: true,
        qualityScore: true,
        deliveryScore: true,
        processScore: true,
        riskScore: true,
      },
    }),
    prisma.supplier.findUnique({
      where: { id },
      select: { supplierName: true },
    }),
  ]);

  if (lines.length === 0 && !supplier) {
    return NextResponse.json({ error: "Supplier not found" }, { status: 404 });
  }

  const metric = metricRows[0] ?? null;
  // periodId → that period's five sub-scores.
  const subByPeriod = new Map(
    metricRows.map((m) => [
      m.periodId,
      {
        quality: m.qualityScore,
        delivery: m.deliveryScore,
        process: m.processScore,
        risk: m.riskScore,
      },
    ]),
  );

  // Read each period's analyses in parallel.
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
  // (1:1 with the void-excluded PO). Keyed by EnrichedPurchase.period — the same
  // order-year bucket the line loop uses — so each year's count is invoice-sourced.
  const invByYearRows = await prisma.$queryRaw<{ period: string; n: number }[]>(Prisma.sql`
    SELECT ep.period AS period, COUNT(i.id)::int AS n
    FROM "EnrichedPurchase" ep
    JOIN "Invoice" i ON i."poId" = ep."poId"
    WHERE ep."supplierExternalId" = ${id}
    GROUP BY ep.period
  `);
  const invoiceByYear = new Map(invByYearRows.map((r) => [r.period, r.n]));

  const periodsOut: SupplierEvolution["periods"] = analysesByPeriod.map(
    ({ period, abc, kraljic, perf }) => {
      // Order-year membership: the line's own `period` (== PurchaseOrder.period).
      const inPeriod = lines.filter((l) => l.period === period.name);
      let spend = 0;
      const itemMap = new Map<string, { spend: number; pos: Set<string> }>();
      for (const l of inPeriod) {
        spend += l.lineValueUsd;
        const cur = itemMap.get(l.itemName) ?? { spend: 0, pos: new Set<string>() };
        cur.spend += l.lineValueUsd;
        cur.pos.add(l.poId);
        itemMap.set(l.itemName, cur);
      }
      const topItems = [...itemMap.entries()]
        .map(([itemName, v]) => ({ itemName, spend: v.spend, count: v.pos.size }))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 5);

      return {
        year: period.name,
        periodLabel: period.name,
        spend,
        invoiceCount: invoiceByYear.get(period.name) ?? 0,
        abcClass:
          abc?.classifications.find((c) => c.supplier_id === id)?.abc_class ??
          null,
        kraljicQuadrant:
          kraljic?.quadrant_assignments.find((q) => q.supplier_id === id)
            ?.quadrant ?? null,
        performanceScore:
          perf?.suppliers.find((s) => s.supplier_id === id)?.performance_score ??
          null,
        subScores: subByPeriod.get(period.id) ?? null,
        topItems,
      };
    },
  );

  // Lightweight insights from active periods.
  const insights: string[] = [];
  const active = periodsOut.filter((p) => p.spend > 0 || p.invoiceCount > 0);
  if (active.length > 0) {
    insights.push(`First active in ${active[0].year}.`);
    if (active.length >= 2) {
      const first = active[0];
      const last = active[active.length - 1];
      const g = pct(first.spend, last.spend);
      if (g != null) {
        insights.push(
          `Spend ${g >= 0 ? "grew" : "fell"} ${Math.abs(g)}% from ${first.year} to ${last.year}.`,
        );
      }
      const classes = [...new Set(active.map((p) => p.abcClass).filter(Boolean))];
      const quads = [...new Set(active.map((p) => p.kraljicQuadrant).filter(Boolean))];
      if (classes.length === 1 && quads.length === 1) {
        insights.push(`Consistently ${classes[0]} / ${quads[0]} across active years.`);
      } else {
        insights.push("Classification changed across years.");
      }
    }
  }
  if (active.length === 1) {
    insights.push(
      `Limited evolution data — supplier active only in ${active[0].year}.`,
    );
  }

  const evolution: SupplierEvolution = {
    supplier: { id, name: supplier?.supplierName ?? metric?.supplierName ?? id },
    periods: periodsOut,
    insights,
  };
  return NextResponse.json(evolution);
}
