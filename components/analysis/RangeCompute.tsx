"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { RangeAnalyses } from "@/lib/analysis-types";
import type { TemporalLoad } from "@/lib/temporal-anomalies";
import { AbcView } from "./AbcView";
import { ActionDashboardView } from "@/components/ActionDashboardView";
import { CycleTimeView } from "@/components/CycleTimeView";
import { EmptyState } from "@/components/EmptyState";

// Kraljic + performance_spend ranges are now served by the Supplier
// Classification page's own client (/api/supplier-classification), so they are
// no longer routed through RangeCompute. The "overview" view was likewise
// removed: Spend Overview renders through SpendOverviewClient in both modes, so
// the only live caller passes kind="recommendations" (Action Priorities range).
type View =
  | "abc"
  | "recommendations"
  | "cycle_time";

type State =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "done"; data: RangeAnalyses };

/**
 * Fetches /api/analyses/compute-range for a date span and renders the requested
 * view. Parents should pass a `key` derived from the dates so a new range
 * remounts this component back into the loading state.
 */
export function RangeCompute({
  kind,
  startDate,
  endDate,
  temporal,
  supplierCategory,
}: {
  kind: View;
  startDate: string;
  endDate: string;
  /** Forwarded to the Action Priorities hub's temporal family (range mode). */
  temporal?: TemporalLoad | null;
  /** Supplier → category map (server-loaded, period-independent) for the
   *  Concentration insight panel. */
  supplierCategory?: Record<string, string>;
}) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/analyses/compute-range", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error || "Compute failed");
        }
        return res.json() as Promise<RangeAnalyses>;
      })
      .then((data) => {
        if (!cancelled) setState({ status: "done", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [startDate, endDate]);

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 py-16 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Computing analyses for date range…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p className="text-sm text-destructive">
        Failed to compute analyses: {state.error}
      </p>
    );
  }

  if (kind === "abc") {
    return state.data.abc ? <AbcView abc={state.data.abc} /> : <EmptyState />;
  }
  if (kind === "recommendations") {
    return state.data.recommendations ? (
      <ActionDashboardView
        data={state.data.recommendations}
        cycleTime={state.data.cycle_time}
        perf={state.data.performance_spend}
        kraljic={state.data.kraljic}
        startDate={startDate}
        endDate={endDate}
        temporal={temporal}
        supplierCategory={supplierCategory}
        isRangeMode
      />
    ) : (
      <EmptyState />
    );
  }
  return state.data.cycle_time ? (
    <CycleTimeView data={state.data.cycle_time} />
  ) : (
    <EmptyState />
  );
}
