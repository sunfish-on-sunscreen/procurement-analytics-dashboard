"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  defaultReportConfig,
  type ReportConfig,
} from "@/lib/report-config";
import type { PeriodSelection } from "@/lib/period-constants";
import type { ConfigStamp } from "@/lib/risk-model";
import {
  buildSupplierDetail,
  type SupplierDirectory,
} from "@/lib/supplier-detail";
import type { ReportFocusData } from "@/lib/report-focus-types";
import {
  TONE_PRESET_PROMPTS,
  type BriefNarrativeResult,
  type GeneratedBriefProse,
  type NarrativeStatus,
} from "@/lib/report-llm-types";
import { buttonVariants } from "@/components/ui/button";
import {
  ReportDocument,
  type ReportAnalyses,
} from "@/components/Reports/ReportDocument";
import {
  ReportEditorSidebar,
  type SupplierOption,
} from "@/components/Reports/ReportEditorSidebar";
import { FilterStatusStrip } from "@/components/Reports/FilterStatusStrip";
import { PinProvider } from "@/components/Reports/PinContext";
import { SupplierDetailPanel } from "@/components/Reports/SupplierDetailPanel";

type PeriodOption = { id: string; name: string };

/**
 * Resolve a period selection to a date span + label. Periods are year-named
 * ("2024"), so a single year is just a one-year range — the editor fetches both
 * modes through /api/analyses/compute-range.
 */
function periodSpan(
  period: PeriodSelection,
  yearById: Map<string, string>,
): { startDate: string; endDate: string; label: string } | null {
  if (period.mode === "single") {
    const y = period.singleId ? yearById.get(period.singleId) : undefined;
    if (!y) return null;
    return { startDate: `${y}-01-01`, endDate: `${y}-12-31`, label: y };
  }
  const yf = period.fromId ? yearById.get(period.fromId) : undefined;
  const yt = period.toId ? yearById.get(period.toId) : undefined;
  if (!yf || !yt) return null;
  const [lo, hi] = Number(yf) <= Number(yt) ? [yf, yt] : [yt, yf];
  return {
    startDate: `${lo}-01-01`,
    endDate: `${hi}-12-31`,
    label: lo === hi ? lo : `${lo}–${hi}`,
  };
}

export function ReportEditor({
  defaultPeriod,
  periods,
  allCategories,
  supplierCategory,
  supplierDirectory,
  generatedBy,
  configStamp,
}: {
  defaultPeriod: PeriodSelection;
  periods: PeriodOption[];
  allCategories: string[];
  supplierCategory: Record<string, string>;
  supplierDirectory: SupplierDirectory;
  generatedBy: string;
  configStamp: ConfigStamp;
}) {
  const router = useRouter();
  const yearById = useMemo(
    () => new Map(periods.map((p) => [p.id, p.name])),
    [periods],
  );

  const [config, setConfig] = useState<ReportConfig>(() =>
    defaultReportConfig(defaultPeriod),
  );
  // Loaded data and errors are tagged with the span key they belong to, so
  // `loading` is derived (no synchronous setState in the effect).
  const [loaded, setLoaded] = useState<{
    key: string;
    analyses: ReportAnalyses;
    stamp?: ConfigStamp;
  } | null>(null);
  const [errored, setErrored] = useState<{ key: string; msg: string } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  // Single cross-chart pin (Batch 6b). Lifted here so every chart + the detail
  // panel read from one source. Clears on period change (different data).
  const [pinnedSupplierId, setPinnedSupplierId] = useState<string | null>(null);
  // Settings sidebar open state, lifted (Batch 6c).
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const span = periodSpan(config.period, yearById);
  const startDate = span?.startDate ?? "";
  const endDate = span?.endDate ?? "";
  const label = span?.label ?? "";
  const spanKey = `${startDate}_${endDate}`;
  // Single-year reports send their period id so the report's temporal family is
  // period-aware (that year vs its prior), mirroring the Action Priorities page.
  const selectedPeriodId =
    config.period.mode === "single" ? config.period.singleId : null;

  const analyses = loaded?.key === spanKey ? loaded.analyses : null;
  // The stamp travels WITH the fetched analyses so the footer always identifies the
  // config that produced the numbers on screen, not the stale page-load config.
  const activeStamp =
    loaded?.key === spanKey ? (loaded.stamp ?? configStamp) : configStamp;
  const error = errored?.key === spanKey ? errored.msg : null;
  const loading = !!startDate && !analyses && !error;

  // Focus → supplier picker options: span-scoped (built from the loaded
  // performance_spend suppliers, so spend reflects the selected period), joined
  // with the static category map, sorted by spend desc. Empty until analyses load.
  const supplierOptions: SupplierOption[] = useMemo(() => {
    const rows = analyses?.performance_spend?.suppliers ?? [];
    return [...rows]
      .sort((a, b) => b.total_spend_usd - a.total_spend_usd)
      .map((s) => ({
        id: s.supplier_id,
        name: s.supplier_name,
        category: supplierCategory[s.supplier_id] ?? null,
        spend: s.total_spend_usd,
      }));
  }, [analyses, supplierCategory]);

  // Clear the pin whenever the selected period changes — the pinned supplier may
  // not exist (or carry different data) in the new period. Tracking the previous
  // key in state and adjusting during render is React's endorsed alternative to a
  // setState effect (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  const [prevSpanKey, setPrevSpanKey] = useState(spanKey);
  if (prevSpanKey !== spanKey) {
    setPrevSpanKey(spanKey);
    if (pinnedSupplierId !== null) setPinnedSupplierId(null);
  }

  const pin = useCallback((id: string) => setPinnedSupplierId(id), []);
  const clearPin = useCallback(() => setPinnedSupplierId(null), []);
  const pinValue = useMemo(
    () => ({ pinnedSupplierId, pin, clear: clearPin }),
    [pinnedSupplierId, pin, clearPin],
  );

  // Assemble the pinned supplier's cross-analysis profile from loaded analyses.
  const pinnedDetail = useMemo(() => {
    if (!pinnedSupplierId || !analyses) return null;
    return buildSupplierDetail(
      pinnedSupplierId,
      {
        abc: analyses.abc,
        kraljic: analyses.kraljic,
        performance_spend: analyses.performance_spend,
        cycle_time: analyses.cycle_time,
        recommendations: analyses.recommendations,
      },
      supplierCategory,
      supplierDirectory,
    );
  }, [pinnedSupplierId, analyses, supplierCategory, supplierDirectory]);

  // Escape closes the panel.
  useEffect(() => {
    if (!pinnedSupplierId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinnedSupplierId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinnedSupplierId]);

  // Fetch analyses on PERIOD CHANGE only — startDate/endDate are the deps, so
  // tone/detail/section/filter edits re-render without refetching. Uses the
  // report-specific endpoint (not the dashboard compute-range) so the assembled
  // data carries the anomaly-hub extras (breakdown + temporal) for all 3 families.
  useEffect(() => {
    if (!startDate || !endDate) return;
    const key = `${startDate}_${endDate}`;
    let cancelled = false;
    fetch("/api/reports/analyses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        selectedPeriodId
          ? { startDate, endDate, selectedPeriodId }
          : { startDate, endDate },
      ),
    })
      .then(async (res) => {
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error || "Compute failed");
        }
        return res.json() as Promise<ReportAnalyses & { configStamp?: ConfigStamp }>;
      })
      .then((data) => {
        if (cancelled) return;
        // Keep the stamp that came WITH these numbers; the render falls back to the
        // page-load prop until the first fetch lands (referencing the prop here would
        // wrongly add it to this period-keyed effect's deps).
        const { configStamp: fetchedStamp, ...rest } = data;
        setLoaded({ key, analyses: rest as ReportAnalyses, stamp: fetchedStamp });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setErrored({
            key,
            msg: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [startDate, endDate, selectedPeriodId]);

  // Focus → supplier: fetch the brief's per-supplier data (item breakdown +
  // trajectory), keyed on (supplierId, span). Separate from the analyses fetch so
  // changing focus doesn't refetch the whole payload — analyses are cached per span
  // and don't depend on focus.
  const focusSupplierId =
    config.focus.kind === "supplier" ? config.focus.supplierId : null;
  const [focusLoaded, setFocusLoaded] = useState<{
    key: string;
    data: ReportFocusData;
  } | null>(null);
  const focusKey = focusSupplierId ? `${focusSupplierId}_${spanKey}` : "";
  const focusData =
    focusKey && focusLoaded?.key === focusKey ? focusLoaded.data : null;

  useEffect(() => {
    if (!focusSupplierId || !startDate || !endDate) return;
    const key = `${focusSupplierId}_${startDate}_${endDate}`;
    let cancelled = false;
    fetch("/api/reports/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supplierId: focusSupplierId, startDate, endDate }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("focus fetch failed"))))
      .then((d) => {
        if (!cancelled) setFocusLoaded({ key, data: { kind: "supplier", data: d } });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [focusSupplierId, startDate, endDate]);

  // --- Optional LLM narrative (editor-only; NEVER persisted) ----------------
  // A regeneration reads differently from identical numbers, so the printed PDF is
  // the record — generation runs on an explicit Generate click, one request each.
  const tone = config.tone ?? "operational";
  // The instruction textarea seeds from the selected tone's preset and re-seeds when
  // the tone changes (render-time previous-value pattern — no setState-in-effect).
  const [narrativePrompt, setNarrativePrompt] = useState(
    () => TONE_PRESET_PROMPTS[tone],
  );
  const [prevTone, setPrevTone] = useState(tone);
  if (prevTone !== tone) {
    setPrevTone(tone);
    setNarrativePrompt(TONE_PRESET_PROMPTS[tone]);
  }

  // The generated result is tagged with the (supplier, span, tone) key it belongs to,
  // so changing any of them reverts the brief to the template until re-generated. A
  // stale in-flight response lands under its own key and is ignored by the compare.
  const narrativeKey = focusSupplierId ? `${focusSupplierId}_${spanKey}_${tone}` : "";
  const [narrative, setNarrative] = useState<{
    key: string;
    status: NarrativeStatus;
    result: BriefNarrativeResult | null;
  }>({ key: "", status: "idle", result: null });
  const narrativeStatus: NarrativeStatus =
    narrative.key === narrativeKey ? narrative.status : "idle";
  const narrativeResult = narrative.key === narrativeKey ? narrative.result : null;
  const generatedNarrative: {
    prose: GeneratedBriefProse;
    model: string;
    inputsHash: string;
  } | null = narrativeResult?.available
    ? {
        prose: narrativeResult.prose,
        model: narrativeResult.model,
        inputsHash: narrativeResult.inputsHash,
      }
    : null;
  const canGenerate =
    !!focusSupplierId && !!focusData && narrativeStatus !== "loading";

  // Plain handler (not useCallback) — it's a click handler passed to a non-memoized
  // child, and its span-derived closure values defeat manual-memoization preservation
  // under the React Compiler, which memoizes it automatically anyway.
  const onGenerateNarrative = async () => {
    if (!focusSupplierId || !startDate || !endDate) return;
    const key = `${focusSupplierId}_${startDate}_${endDate}_${tone}`;
    setNarrative({ key, status: "loading", result: null });
    try {
      const res = await fetch("/api/reports/brief-narrative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId: focusSupplierId,
          startDate,
          endDate,
          selectedPeriodId,
          tone,
          prompt: narrativePrompt,
        }),
      });
      const data = (await res.json().catch(() => null)) as BriefNarrativeResult | null;
      if (!res.ok || !data) {
        setNarrative({
          key,
          status: "unavailable",
          result: { available: false, reason: "error" },
        });
        return;
      }
      setNarrative({
        key,
        status: data.available ? "generated" : "unavailable",
        result: data,
      });
    } catch {
      setNarrative({
        key,
        status: "unavailable",
        result: { available: false, reason: "error" },
      });
    }
  };

  const canSave = config.period.mode === "single";

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        redirect?: string;
      };
      if (!res.ok || !data.redirect) {
        toast.error(data.error || "Save failed");
        return;
      }
      toast.success("Report saved");
      router.push(data.redirect);
      router.refresh();
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  }

  const meta = {
    title: `Report Preview — ${label}`,
    periodLabel: label,
    generatedBy,
    generatedAt: new Date().toISOString(),
    filename: `Report_${label.replace(/[^\w-]+/g, "_")}.pdf`,
    ephemeral: config.period.mode === "range",
    configStamp: activeStamp,
  };

  return (
    <div className="flex">
      <ReportEditorSidebar
        config={config}
        onConfigChange={setConfig}
        periods={periods}
        supplierOptions={supplierOptions}
        allCategories={allCategories}
        canSave={canSave}
        saving={saving}
        onSave={handleSave}
        pdfFilename={meta.filename}
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        narrative={
          config.focus.kind === "supplier"
            ? {
                prompt: narrativePrompt,
                onPromptChange: setNarrativePrompt,
                onGenerate: onGenerateNarrative,
                onResetPrompt: () => setNarrativePrompt(TONE_PRESET_PROMPTS[tone]),
                status: narrativeStatus,
                canGenerate,
                result: narrativeResult,
              }
            : undefined
        }
      />

      <div className="relative min-w-0 flex-1">
        <div className="no-print flex items-center justify-between gap-4 border-b bg-background/95 px-3 py-2">
          <Link
            href="/reports"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <span className="truncate text-sm font-medium">{meta.title}</span>
        </div>

        <div className="no-print">
          <FilterStatusStrip config={config} />
        </div>

        <PinProvider value={pinValue}>
          <div className="px-3 py-4">
            {loading ? (
              <div className="flex items-center gap-2 py-16 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Computing analyses for {label}…
              </div>
            ) : error ? (
              <p className="py-16 text-center text-sm text-destructive">
                Failed to compute analyses: {error}
              </p>
            ) : analyses ? (
              <ReportDocument
                key={spanKey}
                meta={meta}
                analyses={analyses}
                config={config}
                supplierCategory={supplierCategory}
                focusData={focusData}
                generatedNarrative={generatedNarrative}
                narrativeUnavailable={narrativeStatus === "unavailable"}
                embedded
              />
            ) : null}
          </div>

          <div className="no-print">
            <SupplierDetailPanel detail={pinnedDetail} onClose={clearPin} />
          </div>
        </PinProvider>
      </div>
    </div>
  );
}
