import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getAnalysisResult,
  type SpendOverviewResult,
  type AbcResult,
  type KraljicResult,
  type CycleTimeResult,
  type PerformanceSpendResult,
  type RecommendationsResult,
  type SourcingCoverageResult,
} from "@/lib/analysis-types";
import type { ReportMetrics } from "@/lib/report-templates";
import {
  defaultReportConfig,
  normalizeReportConfig,
  type ReportConfig,
} from "@/lib/report-config";
import { getSupplierCategoryMap } from "@/lib/suppliers";
import { computeCycleBreakdown } from "@/lib/cycle-breakdown";
import { loadTemporalMatrix } from "@/lib/temporal-load";
import { assembleSupplierFocus } from "@/lib/report-focus";
import type { ReportFocusData } from "@/lib/report-focus-types";
import { readRiskModelStamp } from "@/lib/risk-model-server";
import {
  ReportDocument,
  type ReportAnalyses,
} from "@/components/Reports/ReportDocument";

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const { id } = await params;

  const summary = await prisma.executiveSummary.findUnique({
    where: { id },
    include: { generatedByUser: true, period: true },
  });
  if (!summary) notFound();

  const stored = summary.metricsJson as unknown as ReportMetrics & {
    config?: ReportConfig;
  };
  const periodId = summary.periodId!;

  const [
    spend,
    abc,
    kraljic,
    cycleTime,
    performance,
    recommendations,
    sourcingCoverage,
    supplierCategory,
    stamp,
  ] = await Promise.all([
    getAnalysisResult<SpendOverviewResult>(periodId, "spend_overview"),
    getAnalysisResult<AbcResult>(periodId, "abc"),
    getAnalysisResult<KraljicResult>(periodId, "kraljic"),
    getAnalysisResult<CycleTimeResult>(periodId, "cycle_time"),
    getAnalysisResult<PerformanceSpendResult>(periodId, "performance_spend"),
    getAnalysisResult<RecommendationsResult>(periodId, "recommendations"),
    // Null for a report persisted before this analysis existed — the appendix
    // section is simply omitted, exactly like a missing cycle_time.
    getAnalysisResult<SourcingCoverageResult>(periodId, "sourcing_coverage"),
    getSupplierCategoryMap(),
    // Live config stamp — read at request time so the footer reflects the config
    // that produced THIS rendering (reports re-render from live analyses).
    readRiskModelStamp(),
  ]);

  // Reports persisted before Batch 5 lack the `cycle_framing` marker. Render
  // their stored pre/post cycle narrative as historical context rather than
  // back-filling them with the new monitoring view.
  const legacyCycle =
    stored.cycle_framing !== "monitoring"
      ? (stored.narratives?.cycle_time ?? null)
      : null;

  // Old reports (pre-3c) have no config: default to standard / all sections.
  // Reports saved before the settings-panel rebuild carry the OLD config shape
  // (no `focus`, plus the removed filter fields) — normalizeReportConfig maps them
  // to portfolio focus and drops the dead fields (see lib/report-config).
  const config: ReportConfig = stored.config
    ? normalizeReportConfig(stored.config)
    : defaultReportConfig({
        mode: "single",
        singleId: periodId,
        fromId: periodId,
        toId: periodId,
      });

  // Process family needs the cycle-time breakdown (per-supplier IQR + stage
  // anomalies). Compute it server-side for this period's span, reusing the
  // already-loaded (Mode A) abc + performance for the roster join — so it's in the
  // report data at render time (incl. PDF), no client fetch. Temporal is PERIOD-AWARE:
  // a persisted (single-year) report compares that year vs its prior (with the
  // no-prior / partial-year note states), matching the live Action Priorities page.
  const pStart = summary.period.startDate.toISOString().slice(0, 10);
  const pEnd = summary.period.endDate.toISOString().slice(0, 10);
  const [breakdown, temporal] = await Promise.all([
    computeCycleBreakdown(pStart, pEnd, { abc, performance_spend: performance }),
    loadTemporalMatrix({ selectedPeriodId: periodId }),
  ]);

  // Focus → supplier: assemble the brief's per-supplier data server-side (read-only,
  // same queries as the modal's routes) so it's present in the static / PDF render.
  const focusData: ReportFocusData =
    config.focus.kind === "supplier" && config.focus.supplierId
      ? {
          kind: "supplier",
          data: await assembleSupplierFocus(config.focus.supplierId, pStart, pEnd),
        }
      : null;

  const analyses: ReportAnalyses = {
    spend_overview: spend,
    abc,
    kraljic,
    cycle_time: cycleTime,
    performance_spend: performance,
    recommendations,
    sourcing_coverage: sourcingCoverage,
    breakdown,
    temporal,
  };

  return (
    <ReportDocument
      meta={{
        title: summary.title,
        periodLabel: summary.period.name,
        generatedBy: summary.generatedByUser.name,
        generatedAt: summary.createdAt.toISOString(),
        filename: `${summary.title.replace(/[^\w-]+/g, "_")}.pdf`,
        configVersion: stamp.version,
        configFingerprint: stamp.fingerprint,
      }}
      analyses={analyses}
      config={config}
      supplierCategory={supplierCategory}
      focusData={focusData}
      legacyCycle={legacyCycle}
    />
  );
}
