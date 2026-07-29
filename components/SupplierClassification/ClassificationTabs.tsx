"use client";

import { useState } from "react";
import Link from "next/link";
import { X, ArrowRight, Star } from "lucide-react";
import type {
  KraljicResult,
  PerformanceSpendResult,
  KraljicQuadrant,
  PerformanceZone,
  QuadrantAssignment,
  PerformanceSpendSupplier,
} from "@/lib/analysis-types";
import { QUADRANT_COLORS, ZONE_COLORS } from "@/lib/chart-colors";
import { cardElevation, formatCompactCurrency } from "@/lib/utils";
import { PillTabs } from "@/components/PillTabs";
import { KraljicScatterChart } from "@/components/charts/KraljicScatterChart";
import { PerformanceSpendScatter } from "@/components/charts/PerformanceSpendScatter";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const QUADRANT_ORDER: KraljicQuadrant[] = [
  "Strategic",
  "Leverage",
  "Bottleneck",
  "Routine",
];
const ZONE_ORDER: PerformanceZone[] = [
  "Stars",
  "Critical Issues",
  "Hidden Gems",
  "Long Tail",
];

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const num = (n: number | null, d = 1) => (n == null ? "—" : n.toFixed(d));
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function Dot({ color }: { color: string }) {
  return (
    <span
      className="mr-1 inline-block h-3 w-3 rounded-full align-middle"
      style={{ backgroundColor: color }}
    />
  );
}

type Member = { id: string; name: string; metric: string };

/** Descriptive (not prescriptive) facts about the selected group. */
type GroupInsights = {
  color: string;
  title: string;
  count: number;
  summary: { label: string; value: string }[];
  patterns: string[];
  standout: string | null;
  /** Whether `standout` is a genuine "best" (gets the ★) vs a neutral "strongest
   * here" fact in a below-median problem zone (no star). */
  starred: boolean;
  weakest: string | null;
  members: Member[];
};

/** Dominant category in the group, if one clearly dominates. Self-omits otherwise. */
function dominantCategoryPattern(
  ids: string[],
  categoryById: Map<string, string | null>,
): string | null {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const c = categoryById.get(id);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const [topCat, topN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (ids.length >= 3 && topN / ids.length >= 0.5 && topN >= 2) {
    return `Most concentrated in ${topCat} (${topN} of ${ids.length} suppliers).`;
  }
  return null;
}

// ---- Kraljic (exposure) insights ----------------------------------------- #
function kraljicInsights(
  q: KraljicQuadrant,
  assignments: QuadrantAssignment[],
  categoryById: Map<string, string | null>,
): GroupInsights {
  const group = assignments.filter((a) => a.quadrant === q);
  const spendOf = (a: QuadrantAssignment) => Math.expm1(a.log_spend);
  const totalAll = assignments.reduce((s, a) => s + spendOf(a), 0);
  const groupSpend = group.reduce((s, a) => s + spendOf(a), 0);

  const summary =
    group.length > 0
      ? [
          { label: "Avg spend", value: formatCompactCurrency(mean(group.map(spendOf))) },
          { label: "Avg risk", value: num(mean(group.map((a) => a.supply_risk_score)), 1) },
          {
            label: "Share of spend",
            value: totalAll > 0 ? `${((groupSpend / totalAll) * 100).toFixed(1)}%` : "—",
          },
        ]
      : [];

  const patterns: string[] = [];
  // Widest supply-risk spread of any non-empty quadrant (self-omits otherwise).
  const risks = group.map((a) => a.supply_risk_score);
  const selfSpread = risks.length ? Math.max(...risks) - Math.min(...risks) : -1;
  const otherSpreads = QUADRANT_ORDER.filter((qq) => qq !== q)
    .map((qq) => assignments.filter((a) => a.quadrant === qq).map((a) => a.supply_risk_score))
    .filter((r) => r.length > 0)
    .map((r) => Math.max(...r) - Math.min(...r));
  if (group.length > 1 && otherSpreads.length >= 1 && otherSpreads.every((s) => s < selfSpread)) {
    patterns.push(
      `Widest supply-risk spread of the four quadrants (${Math.min(...risks).toFixed(0)}–${Math.max(...risks).toFixed(0)}).`,
    );
  }
  const cat = dominantCategoryPattern(group.map((a) => a.supplier_id), categoryById);
  if (cat) patterns.push(cat);

  // Supply risk is LOWER-is-better, so the genuine ★ standout is the LEAST-risky
  // member (not max spend — spend has no quality polarity). The most-risky member
  // is the exposure caveat, shown for every multi-supplier group (the caveat is
  // never suppressed to flatter a supplier).
  let standout: string | null = null;
  let weakest: string | null = null;
  if (group.length > 0) {
    const safest = [...group].sort((a, b) => a.supply_risk_score - b.supply_risk_score)[0];
    standout = `${safest.supplier_name} — most secure supply (lowest risk, ${safest.supply_risk_score.toFixed(1)}) in this group.`;
    if (group.length > 1) {
      const riskiest = [...group].sort((a, b) => b.supply_risk_score - a.supply_risk_score)[0];
      // Distinct from `safest` unless every member ties on risk (then no caveat).
      if (riskiest.supplier_id !== safest.supplier_id) {
        weakest = `${riskiest.supplier_name} carries the most supply risk (${riskiest.supply_risk_score.toFixed(1)}).`;
      }
    }
  }

  const members: Member[] = [...group]
    .sort((a, b) => spendOf(b) - spendOf(a))
    .map((a) => ({
      id: a.supplier_id,
      name: a.supplier_name,
      metric: `${formatCompactCurrency(spendOf(a))} · Risk ${a.supply_risk_score.toFixed(1)}`,
    }));

  return {
    color: QUADRANT_COLORS[q],
    title: q,
    count: group.length,
    summary,
    patterns,
    standout,
    starred: true,
    weakest,
    members,
  };
}

// ---- Performance (zone) insights ----------------------------------------- #
function perfInsights(
  z: PerformanceZone,
  suppliers: PerformanceSpendSupplier[],
  categoryById: Map<string, string | null>,
): GroupInsights {
  const group = suppliers.filter((s) => s.zone === z);
  const totalAll = suppliers.reduce((s, x) => s + x.total_spend_usd, 0);
  const groupSpend = group.reduce((s, x) => s + x.total_spend_usd, 0);

  const summary =
    group.length > 0
      ? [
          { label: "Avg spend", value: formatCompactCurrency(mean(group.map((s) => s.total_spend_usd))) },
          { label: "Avg performance", value: num(mean(group.map((s) => s.performance_score)), 1) },
          {
            label: "Share of spend",
            value: totalAll > 0 ? `${((groupSpend / totalAll) * 100).toFixed(1)}%` : "—",
          },
        ]
      : [];

  const patterns: string[] = [];
  const perfs = group.map((s) => s.performance_score);
  const selfSpread = perfs.length ? Math.max(...perfs) - Math.min(...perfs) : -1;
  const otherSpreads = ZONE_ORDER.filter((zz) => zz !== z)
    .map((zz) => suppliers.filter((s) => s.zone === zz).map((s) => s.performance_score))
    .filter((p) => p.length > 0)
    .map((p) => Math.max(...p) - Math.min(...p));
  if (group.length > 1 && otherSpreads.length >= 1 && otherSpreads.every((s) => s < selfSpread)) {
    patterns.push(
      `Widest performance spread of the four zones (${Math.min(...perfs).toFixed(0)}–${Math.max(...perfs).toFixed(0)}).`,
    );
  }
  const cat = dominantCategoryPattern(group.map((s) => s.supplier_id), categoryById);
  if (cat) patterns.push(cat);

  // Stars + Hidden Gems are the ABOVE-median-performance zones (zone_of:
  // hi_perf = perf > median); Critical Issues + Long Tail are below median. Only
  // star the top performer where "best" genuinely means good — in a below-median
  // problem zone even the strongest is sub-median, so state it as a neutral fact.
  const aboveMedian = z === "Stars" || z === "Hidden Gems";
  let standout: string | null = null;
  let starred = false;
  let weakest: string | null = null;
  if (group.length > 0) {
    const best = [...group].sort((a, b) => b.performance_score - a.performance_score)[0];
    if (aboveMedian) {
      standout = `${best.supplier_name} — highest performance (${best.performance_score.toFixed(1)}) in this group.`;
      starred = true;
    } else {
      standout = `Strongest here: ${best.supplier_name} (${best.performance_score.toFixed(1)}).`;
      starred = false;
    }
    if (group.length > 1) {
      const worst = [...group].sort((a, b) => a.performance_score - b.performance_score)[0];
      if (worst.supplier_id !== best.supplier_id) {
        weakest = `${worst.supplier_name} is the weakest performer (${worst.performance_score.toFixed(1)}).`;
      }
    }
  }

  const members: Member[] = [...group]
    .sort((a, b) => b.total_spend_usd - a.total_spend_usd)
    .map((s) => ({
      id: s.supplier_id,
      name: s.supplier_name,
      metric: `${formatCompactCurrency(s.total_spend_usd)} · Perf ${s.performance_score.toFixed(1)}`,
    }));

  return {
    color: ZONE_COLORS[z],
    title: z,
    count: group.length,
    summary,
    patterns,
    standout,
    starred,
    weakest,
    members,
  };
}

/**
 * Descriptive group-insights panel (Change 2). Facts derived from the group's
 * suppliers — summary stats, self-omitting notable patterns, a named standout —
 * plus the member list and the Action Dashboard hand-off. Deliberately
 * CLASSIFICATION-ONLY: no per-supplier treatment ranking (that's the AD's job).
 */
function GroupInsightsPanel({
  insights,
  onSupplierClick,
  onClear,
}: {
  insights: GroupInsights;
  onSupplierClick: (id: string) => void;
  onClear: () => void;
}) {
  const { color, title, count, summary, patterns, standout, starred, weakest, members } = insights;
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          <Dot color={color} />
          {title} · {count} supplier{count === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-foreground/5"
        >
          Clear <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {count === 0 ? (
        <p className="py-3 text-center text-xs text-muted-foreground">
          No suppliers in this group for the selected period.
        </p>
      ) : (
        <>
          {/* Summary stats */}
          {summary.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {summary.map((s) => (
                <span
                  key={s.label}
                  className="rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground"
                >
                  {s.label} <span className="font-medium tabular-nums text-foreground">{s.value}</span>
                </span>
              ))}
            </div>
          )}

          {/* Named standout (a descriptive fact, not a treatment ranking). The ★
              is shown only when the standout is a genuine "best" (least-risky /
              above-median top performer); below-median problem zones render a
              neutral "Strongest here" fact with no star. */}
          {standout &&
            (starred ? (
              <p className="flex items-start gap-1.5 text-xs">
                <Star className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-[var(--warning)] text-[var(--warning)]" />
                <span>{standout}</span>
              </p>
            ) : (
              <p className="text-xs">{standout}</p>
            ))}
          {weakest && <p className="mt-1 text-xs text-muted-foreground">{weakest}</p>}

          {/* Self-omitting patterns */}
          {patterns.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {patterns.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          {/* Member list — names + key metrics (spend, risk/perf) */}
          <ul className="mt-2 max-h-52 divide-y overflow-y-auto border-t pt-1">
            {members.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onSupplierClick(m.id)}
                  title={m.name}
                  className="flex w-full items-center justify-between gap-3 px-1 py-1.5 text-left text-sm hover:bg-foreground/5"
                >
                  <span className="truncate">{m.name}</span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{m.metric}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-2 border-t pt-2">
            <Link
              href="/action-dashboard"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              View &amp; treat these in Action Priorities <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

/** Absolute "reset zoom" affordance shown over the scatter when a group is zoomed. */
function ResetZoomButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border bg-card/90 px-2 py-1 text-xs font-medium shadow-sm backdrop-blur hover:bg-muted"
    >
      <X className="h-3.5 w-3.5" /> Reset zoom
    </button>
  );
}

function KraljicTab({
  kraljic,
  categoryById,
  onSupplierClick,
}: {
  kraljic: KraljicResult | null;
  categoryById: Map<string, string | null>;
  onSupplierClick: (id: string) => void;
}) {
  const [selected, setSelected] = useState<KraljicQuadrant | null>(null);

  if (!kraljic) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No Exposure positioning data for this period.
      </p>
    );
  }
  const byQuadrant = new Map(kraljic.quadrant_profiles.map((p) => [p.quadrant, p]));
  const insights = selected ? kraljicInsights(selected, kraljic.quadrant_assignments, categoryById) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <KraljicScatterChart
          assignments={kraljic.quadrant_assignments}
          thresholds={kraljic.axis_thresholds}
          zoomQuadrant={selected}
          onDotClick={onSupplierClick}
        />
        {selected && <ResetZoomButton onClick={() => setSelected(null)} />}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Quadrant</TableHead>
            <TableHead className="text-right">Suppliers</TableHead>
            <TableHead className="text-right">Total spend</TableHead>
            <TableHead className="text-right">% of spend</TableHead>
            <TableHead className="text-right">Avg performance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {QUADRANT_ORDER.map((q) => {
            const p = byQuadrant.get(q);
            const isSel = selected === q;
            return (
              <TableRow
                key={q}
                onClick={() => setSelected(isSel ? null : q)}
                className={`cursor-pointer ${
                  isSel ? "bg-foreground/5 ring-1 ring-inset ring-foreground/25" : "hover:bg-muted/40"
                }`}
              >
                <TableCell className="font-medium">
                  <Dot color={QUADRANT_COLORS[q]} /> {q}
                </TableCell>
                <TableCell className="text-right tabular-nums">{p?.n_suppliers ?? 0}</TableCell>
                <TableCell className="text-right tabular-nums">{usd(p?.total_spend ?? 0)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(p?.pct_of_total_spend ?? 0)}%</TableCell>
                <TableCell className="text-right tabular-nums">{num(p?.avg_performance_score ?? null, 2)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {insights && (
        <GroupInsightsPanel
          insights={insights}
          onSupplierClick={onSupplierClick}
          onClear={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function PerformanceTab({
  perf,
  categoryById,
  onSupplierClick,
}: {
  perf: PerformanceSpendResult;
  categoryById: Map<string, string | null>;
  onSupplierClick: (id: string) => void;
}) {
  const [selected, setSelected] = useState<PerformanceZone | null>(null);
  const byZone = new Map(perf.zone_profiles.map((p) => [p.zone, p]));
  const insights = selected ? perfInsights(selected, perf.suppliers, categoryById) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <PerformanceSpendScatter
          suppliers={perf.suppliers}
          thresholds={perf.axis_thresholds}
          zoomZone={selected}
          onDotClick={onSupplierClick}
        />
        {selected && <ResetZoomButton onClick={() => setSelected(null)} />}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Zone</TableHead>
            <TableHead className="text-right">Suppliers</TableHead>
            <TableHead className="text-right">Total spend</TableHead>
            <TableHead className="text-right">% of spend</TableHead>
            <TableHead className="text-right">Avg performance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ZONE_ORDER.map((z) => {
            const p = byZone.get(z);
            const isSel = selected === z;
            return (
              <TableRow
                key={z}
                onClick={() => setSelected(isSel ? null : z)}
                className={`cursor-pointer ${
                  isSel ? "bg-foreground/5 ring-1 ring-inset ring-foreground/25" : "hover:bg-muted/40"
                }`}
              >
                <TableCell className="font-medium">
                  <Dot color={ZONE_COLORS[z]} /> {z}
                </TableCell>
                <TableCell className="text-right tabular-nums">{p?.n_suppliers ?? 0}</TableCell>
                <TableCell className="text-right tabular-nums">{usd(p?.total_spend_usd ?? 0)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(p?.pct_of_total_spend ?? 0)}%</TableCell>
                <TableCell className="text-right tabular-nums">{num(p?.avg_performance ?? null, 2)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {insights && (
        <GroupInsightsPanel
          insights={insights}
          onSupplierClick={onSupplierClick}
          onClear={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/**
 * Two-tab card: Exposure positioning (Kraljic) and Performance positioning, each
 * a scatter + a profile table. Clicking a profile row animate-zooms the scatter
 * into that group and expands a descriptive insights panel below; clicking a
 * scatter point opens that supplier's detail panel. Switching tabs unmounts the
 * other's local selection, so each tab resets its own view.
 */
export function ClassificationTabs({
  kraljic,
  perf,
  categoryById,
  onSupplierClick,
}: {
  kraljic: KraljicResult | null;
  perf: PerformanceSpendResult;
  categoryById: Map<string, string | null>;
  onSupplierClick: (id: string) => void;
}) {
  const [tab, setTab] = useState<"kraljic" | "performance">("kraljic");

  return (
    <Card className={cardElevation}>
      <CardHeader className="pb-2">
        <CardTitle>Classification views</CardTitle>
        <PillTabs
          className="mt-2"
          tabs={[["kraljic", "Exposure positioning"], ["performance", "Performance positioning"]] as const}
          active={tab}
          onChange={setTab}
        />
        {/* The two tabs deliberately use DIFFERENT palettes (Kraljic quadrant vs
            performance zone), so name what colour encodes on the active tab. */}
        <p className="mt-2 text-xs text-muted-foreground">
          {tab === "kraljic"
            ? "Colours show Kraljic quadrant."
            : "Colours show performance zone."}
        </p>
      </CardHeader>
      <CardContent className="p-4">
        {tab === "kraljic" ? (
          <KraljicTab kraljic={kraljic} categoryById={categoryById} onSupplierClick={onSupplierClick} />
        ) : (
          <PerformanceTab perf={perf} categoryById={categoryById} onSupplierClick={onSupplierClick} />
        )}
      </CardContent>
    </Card>
  );
}
