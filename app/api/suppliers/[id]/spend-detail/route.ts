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
import { getRangeAnalyses } from "@/lib/range-analyses";
import { getEnrichedPurchases } from "@/lib/enriched-purchase";
import { getPoLines } from "@/lib/po-lines";
import type { SpendDetail } from "@/lib/spend-overview-types";

export const runtime = "nodejs";

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Period-scoped spend decomposition for one supplier (by externalId): identity +
 * stats + spend-by-item + every PO in the selected span. ABC/Kraljic chips are
 * scoped to the SELECTED period (via getRangeAnalyses — same source as the
 * ranking table), so a supplier absent from that period shows "—".
 *
 * Suppliers with no in-span activity but a real identity still return 200 with
 * zeroed stats (the panel renders an honest "no activity in this period" view).
 * 404 only for a genuinely unknown supplier id. Login required; any role.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  // Optional period scope. Both must be valid YYYY-MM-DD with end >= start;
  // omit both for all-time (backward compat). paymentDate is non-null here, so
  // filtering it matches the COALESCE(paymentDate, prDate) tag the ranking uses.
  const sp = new URL(request.url).searchParams;
  const start = sp.get("start");
  const end = sp.get("end");
  let dateFilter: { gte: Date; lte: Date } | undefined;
  if (start || end) {
    if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) {
      return NextResponse.json(
        { error: "start and end must both be YYYY-MM-DD" },
        { status: 400 },
      );
    }
    if (end < start) {
      return NextResponse.json(
        { error: "end must be on or after start" },
        { status: 400 },
      );
    }
    dateFilter = {
      gte: new Date(`${start}T00:00:00`),
      lte: new Date(`${end}T23:59:59`),
    };
  }

  // Identity first, so suppliers absent from the span still render. Also load
  // ALL periods + this supplier's per-period metric rows so performance can be
  // scoped to the selected span (single-period composite / range composite).
  const [metricRows, supplier, periods] = await Promise.all([
    prisma.supplierMetric.findMany({
      where: { supplierExternalId: id },
      select: {
        periodId: true,
        supplierName: true,
        category: true,
        compositeScore: true,
      },
    }),
    prisma.supplier.findUnique({
      where: { id },
      select: { supplierName: true, country: true, category: true, status: true },
    }),
    prisma.reportingPeriod.findMany({
      orderBy: { startDate: "asc" },
      select: { id: true, name: true, startDate: true, endDate: true },
    }),
  ]);

  // Genuinely unknown supplier → 404. (Absence from a PERIOD is a 200 below.)
  if (metricRows.length === 0 && !supplier) {
    return NextResponse.json({ error: "Supplier not found" }, { status: 404 });
  }

  // periodId → composite, and the latest-period metric row (for identity + the
  // constant soft inputs used by the range composite).
  const periodOrder = new Map(periods.map((p, i) => [p.id, i]));
  const compositeByPeriod = new Map(
    metricRows.map((m) => [m.periodId, m.compositeScore]),
  );
  const latestMetric =
    metricRows.length > 0
      ? metricRows.reduce((a, b) =>
          (periodOrder.get(b.periodId) ?? -1) > (periodOrder.get(a.periodId) ?? -1) ? b : a,
        )
      : null;
  const metric = latestMetric;

  // PO-grain rows (from the view) for stats + the "All invoices" (per-PO) tab, and
  // the supplier's LINE rows (from PoLine, lock C) for the spend-by-item cut. Both
  // scoped to the same supplier + order-year (poDate) span.
  const span = dateFilter
    ? { start: dateFilter.gte, end: dateFilter.lte }
    : {};
  const [purchases, lines] = await Promise.all([
    getEnrichedPurchases({ supplierExternalId: id, ...span }),
    getPoLines({ supplierExternalId: id, ...span }),
  ]);

  // Invoice-document count for this supplier's in-span (void-excluded) POs. Invoice
  // is 1:1 with the PO (verified), so this equals purchases.length — but sourcing it
  // from the Invoice table makes the panel's "Invoices" / "Avg invoice" honest.
  const invSpanCond = dateFilter
    ? Prisma.sql`AND ep."poDate" >= ${dateFilter.gte} AND ep."poDate" <= ${dateFilter.lte}`
    : Prisma.empty;
  const invRows = await prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT COUNT(i.id)::int AS n
    FROM "EnrichedPurchase" ep
    JOIN "Invoice" i ON i."poId" = ep."poId"
    WHERE ep."supplierExternalId" = ${id} ${invSpanCond}
  `);
  const invoiceCount = invRows[0]?.n ?? 0;

  // Dominant (highest-value) line per PO → the representative item label the
  // per-PO "All invoices" table + chart show (a PO can now hold several lines).
  const dominantByPo = new Map<string, { itemName: string; unit: string; value: number }>();
  for (const l of lines) {
    const cur = dominantByPo.get(l.poId);
    if (!cur || l.lineValueUsd > cur.value) {
      dominantByPo.set(l.poId, { itemName: l.itemName, unit: l.unit, value: l.lineValueUsd });
    }
  }

  // ABC + Kraljic scoped to the SELECTED period (same source as the ranking).
  // With no span, fall back to the latest period's analysis (backward compat).
  let abcClass: SpendDetail["supplier"]["abcClass"] = null;
  let kraljicQuadrant: SpendDetail["supplier"]["kraljicQuadrant"] = null;
  let zone: SpendDetail["supplier"]["zone"] = null;
  // The filter-live range composite (Stage 2) for this supplier — read from the
  // SAME performance_spend analysis the zone chip comes from, so the panel's
  // range performance number agrees with the Classification page's zones.
  let rangePerfScore: number | null = null;
  if (start && end) {
    const analyses = await getRangeAnalyses(start, end);
    abcClass =
      analyses?.abc?.classifications.find((c) => c.supplier_id === id)?.abc_class ?? null;
    kraljicQuadrant =
      analyses?.kraljic?.quadrant_assignments.find((q) => q.supplier_id === id)
        ?.quadrant ?? null;
    const perfEntry = analyses?.performance_spend?.suppliers.find(
      (s) => s.supplier_id === id,
    );
    zone = perfEntry?.zone ?? null;
    rangePerfScore = perfEntry?.performance_score ?? null;
  } else {
    const latestPeriod = await prisma.reportingPeriod.findFirst({
      orderBy: { startDate: "desc" },
      select: { id: true },
    });
    if (latestPeriod) {
      const [abc, kraljic, perf] = await Promise.all([
        getAnalysisResult<AbcResult>(latestPeriod.id, "abc"),
        getAnalysisResult<KraljicResult>(latestPeriod.id, "kraljic"),
        getAnalysisResult<PerformanceSpendResult>(latestPeriod.id, "performance_spend"),
      ]);
      abcClass = abc?.classifications.find((c) => c.supplier_id === id)?.abc_class ?? null;
      kraljicQuadrant =
        kraljic?.quadrant_assignments.find((q) => q.supplier_id === id)?.quadrant ?? null;
      zone = perf?.suppliers.find((s) => s.supplier_id === id)?.zone ?? null;
    }
  }

  // Stats over the in-span POs (0 POs → zeros).
  let totalSpend = 0;
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const p of purchases) {
    totalSpend += p.totalValueUsd;
    const d = p.invoiceDate ?? p.prDate;
    if (d && (!earliest || d < earliest)) earliest = d;
    if (d && (!latest || d > latest)) latest = d;
  }

  // Spend-by-item over the supplier's LINES (line-grain, lock C): spend = Σ line
  // value; invoiceCount = number of DISTINCT POs that include the item — which,
  // under the 1:1 PO↔Invoice, is the count of distinct invoices including it.
  const byItemMap = new Map<string, { pos: Set<string>; totalSpend: number }>();
  for (const l of lines) {
    const cur = byItemMap.get(l.itemName) ?? { pos: new Set<string>(), totalSpend: 0 };
    cur.pos.add(l.poId);
    cur.totalSpend += l.lineValueUsd;
    byItemMap.set(l.itemName, cur);
  }
  const byItem = [...byItemMap.entries()]
    .map(([itemName, v]) => ({ itemName, invoiceCount: v.pos.size, totalSpend: v.totalSpend }))
    .sort((a, b) => b.totalSpend - a.totalSpend);

  // One row per PO (= per invoice) for the "All invoices" tab; the item column
  // shows the PO's dominant line. quantity/unit are PO-grain; unitPriceUsd is not
  // meaningful across multiple lines (unused by the panel).
  const pos = purchases
    .map((p) => {
      const dom = dominantByPo.get(p.poId);
      return {
        poId: p.poId,
        itemName: dom?.itemName ?? "—",
        prDate: iso(p.prDate),
        invoiceDate: iso(p.invoiceDate),
        paymentDate: iso(p.paymentDate),
        quantity: p.quantity,
        unit: dom?.unit ?? "",
        unitPriceUsd: 0,
        totalValueUsd: p.totalValueUsd,
      };
    })
    .sort((a, b) =>
      (b.paymentDate ?? b.prDate ?? "").localeCompare(
        a.paymentDate ?? a.prDate ?? "",
      ),
    );

  // --- Period-scoped performance (A3/A7) ------------------------------------ #
  // Which periods fall inside the selected span (same containment rule as the
  // Python compute: period fully within [start, end]). Period dates are stored
  // in UTC, so the window bounds must be UTC too — parsing "YYYY-MM-DDT…" without
  // a Z would use the server's local zone and mis-bound the comparison.
  const inWindow =
    start && end
      ? periods.filter(
          (p) =>
            p.startDate >= new Date(`${start}T00:00:00.000Z`) &&
            p.endDate <= new Date(`${end}T23:59:59.999Z`),
        )
      : [];

  const performance: SpendDetail["supplier"]["performance"] = {
    score: null,
    mode: "all",
    periodLabel: null,
    previousScore: null,
    previousLabel: null,
    latestScore: null,
    latestLabel: null,
  };
  if (!dateFilter) {
    // No span → latest snapshot (backward compat).
    performance.mode = "all";
    performance.score = latestMetric?.compositeScore ?? null;
    performance.periodLabel = latestMetric
      ? (periods.find((p) => p.id === latestMetric.periodId)?.name ?? null)
      : null;
  } else if (inWindow.length === 1) {
    // Single-year → that period's composite + previous active period for delta.
    performance.mode = "single";
    const sel = inWindow[0];
    performance.score = compositeByPeriod.get(sel.id) ?? null;
    performance.periodLabel = sel.name;
    const selIdx = periodOrder.get(sel.id) ?? -1;
    // Nearest earlier period that the supplier actually has a metric row for.
    const prev = [...periods]
      .filter((p) => (periodOrder.get(p.id) ?? -1) < selIdx && compositeByPeriod.has(p.id))
      .pop();
    if (prev) {
      performance.previousScore = compositeByPeriod.get(prev.id) ?? null;
      performance.previousLabel = prev.name;
    }
  } else if (inWindow.length > 1) {
    // Range → the FILTER-LIVE composite (Stage 2), read from the same
    // performance_spend analysis as the zone chip, so the panel's number agrees
    // with the Classification page's zones/composite (one engine, no divergence).
    // "Latest" is the most recent in-window period the supplier is active in,
    // kept for the context sub-line.
    performance.mode = "range";
    performance.periodLabel = `${inWindow[0].name}–${inWindow[inWindow.length - 1].name}`;
    performance.score = rangePerfScore;
    const lastActive = [...inWindow]
      .filter((p) => compositeByPeriod.has(p.id))
      .pop();
    if (lastActive) {
      performance.latestScore = compositeByPeriod.get(lastActive.id) ?? null;
      performance.latestLabel = lastActive.name;
    }
  }

  // Period-scoped portfolio context (Spend insights cards): rank by spend, share
  // of the period total, and active-supplier count — one grouped aggregate over
  // the same span. A supplier absent from the span isn't in the groups, so its
  // rank/percent are null.
  const poDateWhere = dateFilter
    ? Prisma.sql`WHERE "poDate" >= ${dateFilter.gte} AND "poDate" <= ${dateFilter.lte}`
    : Prisma.empty;
  const spendBySupplier = await prisma.$queryRaw<
    { id: string; spend: number }[]
  >(Prisma.sql`
    SELECT "supplierExternalId" AS id, SUM("totalValueUsd")::float8 AS spend
    FROM "EnrichedPurchase"
    ${poDateWhere}
    GROUP BY "supplierExternalId"
  `);
  const activeSupplierCount = spendBySupplier.length;
  const periodTotal = spendBySupplier.reduce((acc, r) => acc + (Number(r.spend) || 0), 0);
  const rankIdx = spendBySupplier
    .map((r) => ({ id: r.id, spend: Number(r.spend) || 0 }))
    .sort((a, b) => b.spend - a.spend)
    .findIndex((r) => r.id === id);
  const rank = rankIdx >= 0 && totalSpend > 0 ? rankIdx + 1 : null;
  const percentOfTotal =
    totalSpend > 0 && periodTotal > 0 ? (totalSpend / periodTotal) * 100 : null;

  const detail: SpendDetail = {
    supplier: {
      id,
      name: metric?.supplierName ?? supplier?.supplierName ?? purchases[0]?.supplierName ?? id,
      category: metric?.category ?? supplier?.category ?? null,
      country: supplier?.country ?? null,
      // Master-data retirement (display-only badge). Unknown-status fallback is
      // false so a purchases-only supplier (no master row) never reads as retired.
      retired: supplier ? supplier.status !== "active" : false,
      abcClass,
      kraljicQuadrant,
      zone,
      performance,
    },
    stats: {
      totalSpend,
      invoiceCount,
      earliestDate: iso(earliest),
      latestDate: iso(latest),
      avgInvoiceValue: invoiceCount > 0 ? totalSpend / invoiceCount : 0,
      rank,
      percentOfTotal,
      activeSupplierCount,
    },
    byItem,
    pos,
  };

  return NextResponse.json(detail);
}
