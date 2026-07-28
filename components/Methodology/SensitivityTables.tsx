"use client";

import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";
import {
  getSensitivityRecomputing,
  subscribeSensitivityRecomputing,
} from "@/lib/sensitivity-status";
import type {
  SensitivityView,
  SensitivityData,
  SensitivityWindow,
} from "@/lib/sensitivity";

// Deterministic timestamp format (fixed zone) so the client render matches SSR — same guard
// the report footer uses.
const dateFmt = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
});
const fmtDate = (iso: string) => dateFmt.format(new Date(iso));

const WINDOW_ORDER = ["2024", "2025", "2026", "RANGE"] as const;
const WINDOW_LABEL: Record<string, string> = {
  "2024": "2024",
  "2025": "2025",
  "2026": "2026",
  RANGE: "All years",
};
const COMPOSITE_DIMS: [string, string][] = [
  ["quality_score", "Quality"],
  ["delivery_score", "Delivery"],
  ["process_score", "Process"],
  ["risk_score", "Risk"],
];
const SUPPLY_DIMS: [string, string][] = [
  ["supply_concentration", "Concentration"],
  ["cost_premium", "Cost premium"],
  ["import_friction", "Import friction"],
];

type Group = "composite" | "supplyRisk";
function cell(win: SensitivityWindow | undefined, group: Group, dropped: string) {
  return win?.[group].find((d) => d.dropped === dropped);
}
const fmtRho = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(1)}%`);

function orderedWindows(data: SensitivityData): (SensitivityWindow | undefined)[] {
  return WINDOW_ORDER.map((label) => data.windows.find((w) => w.label === label));
}

function RhoTable({ data }: { data: SensitivityData }) {
  const wins = orderedWindows(data);
  return (
    <div className="overflow-x-auto">
      <p className="mb-1 text-xs font-medium text-foreground">
        Ranking — drop-one rank correlation (ρ) vs the default ordering
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-foreground">
            <th rowSpan={2} className="py-1.5 pr-3 text-left align-bottom font-medium">Window</th>
            <th colSpan={4} className="py-1.5 pr-3 text-center font-medium">Composite — drop dimension (ρ)</th>
            <th colSpan={3} className="py-1.5 text-center font-medium">Supply risk — drop component (ρ)</th>
          </tr>
          <tr className="border-b text-foreground">
            {COMPOSITE_DIMS.map(([, label]) => (
              <th key={label} className="py-1.5 pr-3 text-right font-medium">{label}</th>
            ))}
            {SUPPLY_DIMS.map(([, label], i) => (
              <th key={label} className={cn("py-1.5 text-right font-medium", i < SUPPLY_DIMS.length - 1 && "pr-3")}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WINDOW_ORDER.map((label, r) => {
            const win = wins[r];
            const isRange = label === "RANGE";
            return (
              <tr key={label} className={cn(!isRange && "border-b")}>
                <td className={cn("py-1.5 pr-3", isRange && "font-medium text-foreground")}>{WINDOW_LABEL[label]}</td>
                {COMPOSITE_DIMS.map(([id]) => (
                  <td key={id} className="py-1.5 pr-3 text-right tabular-nums">{fmtRho(cell(win, "composite", id)?.rho)}</td>
                ))}
                {SUPPLY_DIMS.map(([id], i) => (
                  <td key={id} className={cn("py-1.5 text-right tabular-nums", i < SUPPLY_DIMS.length - 1 && "pr-3")}>{fmtRho(cell(win, "supplyRisk", id)?.rho)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ChurnTable({ data }: { data: SensitivityData }) {
  const wins = orderedWindows(data);
  return (
    <div className="overflow-x-auto">
      <p className="mb-1 text-xs font-medium text-foreground">
        Classification — % of suppliers changing performance zone / Kraljic quadrant
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-foreground">
            <th rowSpan={2} className="py-1.5 pr-3 text-left align-bottom font-medium">Window</th>
            <th colSpan={4} className="py-1.5 pr-3 text-center font-medium">Composite — % zone change</th>
            <th colSpan={3} className="py-1.5 text-center font-medium">Supply risk — % Kraljic quadrant change</th>
          </tr>
          <tr className="border-b text-foreground">
            {COMPOSITE_DIMS.map(([, label]) => (
              <th key={label} className="py-1.5 pr-3 text-right font-medium">{label}</th>
            ))}
            {SUPPLY_DIMS.map(([, label], i) => (
              <th key={label} className={cn("py-1.5 text-right font-medium", i < SUPPLY_DIMS.length - 1 && "pr-3")}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WINDOW_ORDER.map((label, r) => {
            const win = wins[r];
            const isRange = label === "RANGE";
            return (
              <tr key={label} className={cn(!isRange && "border-b")}>
                <td className={cn("py-1.5 pr-3", isRange && "font-medium text-foreground")}>{WINDOW_LABEL[label]}</td>
                {COMPOSITE_DIMS.map(([id]) => (
                  <td key={id} className="py-1.5 pr-3 text-right tabular-nums">{fmtPct(cell(win, "composite", id)?.zone_pct)}</td>
                ))}
                {SUPPLY_DIMS.map(([id], i) => (
                  <td key={id} className={cn("py-1.5 text-right tabular-nums", i < SUPPLY_DIMS.length - 1 && "pr-3")}>{fmtPct(cell(win, "supplyRisk", id)?.quad_pct)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The §3.5 sensitivity tables, rendered from the PERSISTED snapshot (Stage C). The numbers are
 * live data, never hardcoded, and the block never presents a snapshot as current when it is not:
 *  - recomputing → a "recomputing" banner (auto-rerun after a config save is in flight);
 *  - stale       → banner naming the fingerprint it belongs to, tables greyed;
 *  - absent      → "not yet computed", no tables;
 *  - fresh       → tables + a computed-at / fingerprint caption.
 */
export function SensitivityTables({ view }: { view: SensitivityView }) {
  const recomputing = useSyncExternalStore(
    subscribeSensitivityRecomputing,
    getSensitivityRecomputing,
    () => false,
  );
  const snapshot = view.status === "fresh" || view.status === "stale" ? view.snapshot : null;
  const dimmed = recomputing || view.status === "stale";

  return (
    <div className="space-y-3">
      {recomputing ? (
        <div className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs text-foreground">
          <span className="font-medium">Recomputing…</span> the configuration changed, so the
          drop-one analysis is re-running (~60s). These tables update when it finishes.
        </div>
      ) : view.status === "absent" ? (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Not yet computed for the current configuration. It is computed automatically when the
          risk model is saved.
        </div>
      ) : view.status === "stale" ? (
        <div className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-foreground">
          <span className="font-medium">From a previous configuration.</span> These figures were
          computed under config fingerprint{" "}
          <span className="tabular-nums">{snapshot!.configFingerprint}</span> ({fmtDate(snapshot!.computedAt)}),
          not the current one (<span className="tabular-nums">{view.currentFingerprint}</span>).
          Read them as historical; they refresh when sensitivity recomputes.
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Computed {fmtDate(snapshot!.computedAt)} · config fingerprint{" "}
          <span className="tabular-nums">{snapshot!.configFingerprint}</span>.
        </p>
      )}

      {snapshot && (
        <div className={cn("space-y-4", dimmed && "opacity-50")} aria-hidden={dimmed || undefined}>
          <RhoTable data={snapshot.data} />
          <ChurnTable data={snapshot.data} />
        </div>
      )}
    </div>
  );
}
