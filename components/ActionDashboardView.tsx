"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DollarSign,
  Gauge,
  GitBranch,
  Loader2,
  Settings,
  TrendingUp,
  TriangleAlert,
  Users,
} from "lucide-react";
import type {
  RecommendationsResult,
  RecommendationsNarrative,
  RecommendationCategory,
  Recommendation,
  CycleTimeResult,
  PerformanceSpendResult,
  PerformanceSpendSupplier,
  KraljicResult,
  KraljicQuadrant,
  PerformanceZone,
} from "@/lib/analysis-types";
import { ActionInsightCard, firstTabOfGroup } from "@/components/ActionInsightCard";
import { type InsightKey, type InsightCtx } from "@/lib/action-insights";
import type {
  CycleBreakdown,
  CycleFlagKey,
  SupplierFlagState,
  AbcClass,
} from "@/lib/cycle-time-types";
import {
  ACTION_GROUPS,
  CATEGORY_LABEL,
  CATEGORY_COLOR_VAR,
} from "@/lib/action-priorities";
import { deriveCycleFlags } from "@/lib/cycle-flags";
import {
  buildAnomalyHub,
  CLASSIFICATION_DISAGREEMENT_CUTOFF,
  type CrossAnomalyRow,
  type ClassificationAnomalyRow,
  type AnomalyFamily,
  type AnomalyHub,
} from "@/lib/anomaly-crossref";
import {
  buildTemporalAnomalies,
  type TemporalLoad,
  type TemporalAnomalyRow,
} from "@/lib/temporal-anomalies";
import { UnifiedSupplierDetailModal } from "@/components/UnifiedSupplierDetailModal";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatBlock } from "@/components/ui/stat-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PerfBar, SortArrow } from "@/components/RankingCells";
import { useTableSort, type SortDir } from "@/lib/use-table-sort";
import { ABC_COLORS, QUADRANT_COLORS } from "@/lib/chart-colors";
import { cardElevation, cn } from "@/lib/utils";

// ---- stable en-US formatters (hydration-safe) ----------------------------- //
const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const intFmt = new Intl.NumberFormat("en-US");

// Family accent tokens (light + dark safe).
const PROCESS_ACCENT = "var(--warning)"; // amber — process (cycle execution)
const CLASS_ACCENT = "var(--zone-hidden-gems)"; // violet — lens disagreement
const TEMPORAL_ACCENT = "var(--temporal)"; // cyan — changed over time

// One icon per "Where to act" group, coloured with the group's own token (same
// var the title uses) — icon + colour reinforce the section, they don't replace
// the colour. Icons live at the GROUP level; the per-category rows keep their dots.
const GROUP_ICON: Record<
  "spend" | "suppliers" | "process",
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  spend: DollarSign,
  suppliers: Users,
  process: Settings,
};

type DetailTab = "classification" | "spend" | "process";

/** "in 2025" (single year) / "from 2024 to 2026" (range), from the ISO span. */
function periodPhrase(startDate: string, endDate: string, isRangeMode: boolean): string {
  const sy = startDate?.slice(0, 4);
  const ey = endDate?.slice(0, 4);
  if (!sy || !ey) return "in this period";
  if (!isRangeMode || sy === ey) return `in ${sy}`;
  return `from ${sy} to ${ey}`;
}

// ---- interpretive lines (reused from the previous synthesis) --------------- //
function spendInsight(n: RecommendationsNarrative): string {
  if (!n.top_category_name) return "Spend is spread fairly evenly across categories.";
  const s = Math.round(n.top_category_share_pct);
  return n.top_category_share_pct >= 50
    ? `Spend is heavily concentrated — ${n.top_category_name} alone is ${s}% of the total.`
    : `${n.top_category_name} is the largest category at ${s}% of spend.`;
}
function suppliersInsight(n: RecommendationsNarrative): string {
  return n.top10_in_attention > 0
    ? `${n.top10_in_attention} of the top-10 spenders need attention — high-spend suppliers underperforming or hard to replace.`
    : "None of the top-10 spenders are flagged for attention this period.";
}
function processInsight(n: RecommendationsNarrative): string {
  return n.slowest_stage_name && n.slowest_stage_avg_days != null
    ? `One internal stage — ${n.slowest_stage_name} — drives most of the cycle delay, averaging ${n.slowest_stage_avg_days.toFixed(1)} days.`
    : "Internal stages are balanced — none exceeds the 8-day flag.";
}

// ===========================================================================
// Shared chip primitives (match the Process Health roster table + hub chips).
// ===========================================================================

/** Tinted category/position chip (color-mix tint + token text); null → muted "—". */
function TintChip({ color, label }: { color: string | null; label: string | null }) {
  if (!color || !label) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
    >
      {label}
    </span>
  );
}

// Process-flag identity — mirrors Process Health's FLAG_META exactly.
const FLAG_META: Record<CycleFlagKey, { label: string; color: string }> = {
  has_outlier: { label: "Outlier", color: "var(--warning)" },
  inconsistent: { label: "Inconsistent", color: "var(--primary)" },
  has_stage_dom: { label: "Stage-dom", color: "var(--destructive)" },
};
const FLAG_ORDER: CycleFlagKey[] = ["has_outlier", "inconsistent", "has_stage_dom"];

/** Small family chip (dot + label) used in the unified "Anomalies" column. */
function FamilyChip({
  color,
  label,
  title,
  dot = true,
}: {
  color: string;
  label: string;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />}
      {label}
    </span>
  );
}

/** The "Anomalies" cell — every family's signals for one supplier, as compact chips. */
function AnomalyCell({ row }: { row: UnifiedAnomalyRow }) {
  const chips: React.ReactNode[] = [];
  // Process — the cycle flags.
  if (row.process) {
    for (const k of FLAG_ORDER.filter((f) => row.process!.flags[f])) {
      chips.push(<FamilyChip key={`p-${k}`} color={FLAG_META[k].color} label={FLAG_META[k].label} />);
    }
  }
  // Lens disagreement — the spread + verdict.
  if (row.classification) {
    chips.push(
      <FamilyChip
        key="c-gap"
        color={CLASS_ACCENT}
        dot={false}
        label={`Lens gap ${row.classification.disagreement}`}
        title={row.classification.verdict}
      />,
    );
  }
  // Changed over time — the sharp moves.
  if (row.temporal) {
    const t = row.temporal;
    if (t.quadrant) {
      chips.push(
        <FamilyChip
          key="t-q"
          color={TEMPORAL_ACCENT}
          dot={false}
          label={`${t.quadrant.from} → ${t.quadrant.to}`}
          title={t.quadrant.axes_flipped === 2 ? "Diagonal quadrant move" : "Adjacent quadrant move"}
        />,
      );
    }
    if (t.spend) {
      chips.push(
        <FamilyChip
          key="t-s"
          color={TEMPORAL_ACCENT}
          dot={false}
          label={`Spend ${t.spend.pct > 0 ? "+" : ""}${t.spend.pct}%`}
          title={`${usd(t.spend.from)} → ${usd(t.spend.to)}`}
        />,
      );
    }
    if (t.score) {
      chips.push(
        <FamilyChip
          key="t-sc"
          color={TEMPORAL_ACCENT}
          dot={false}
          label={`Score ${t.score.delta > 0 ? "+" : ""}${t.score.delta}`}
          title={`${t.score.from.toFixed(1)} → ${t.score.to.toFixed(1)}`}
        />,
      );
    }
  }
  return <div className="flex flex-wrap items-center gap-1">{chips}</div>;
}

// ===========================================================================
// Unified anomaly rows — one row per distinct flagged supplier, carrying every
// family it trips. Position (ABC/Kraljic/spend/perf) is sourced ONCE from the
// canonical span analyses (breakdown roster ABC + performance_spend), so the
// table reconciles with the rest of the page. PRESENTATION ONLY — the flagged
// set + per-family detail come straight from buildAnomalyHub.
// ===========================================================================
type UnifiedAnomalyRow = {
  supplier_id: string;
  supplier_name: string;
  total_spend_usd: number | null;
  abc_class: AbcClass | null;
  kraljic_quadrant: KraljicQuadrant | null;
  zone: PerformanceZone | null;
  performance_score: number | null;
  families: Set<AnomalyFamily>;
  important: boolean;
  process?: CrossAnomalyRow;
  classification?: ClassificationAnomalyRow;
  temporal?: TemporalAnomalyRow;
};

function buildUnifiedRows(
  hub: AnomalyHub,
  perfById: Map<string, PerformanceSpendSupplier>,
  abcById: Map<string, AbcClass>,
): UnifiedAnomalyRow[] {
  const processById = new Map(hub.process.rows.map((r) => [r.supplier_id, r]));
  const classById = new Map(hub.classification.rows.map((r) => [r.supplier_id, r]));
  const tempById = new Map((hub.temporal?.rows ?? []).map((r) => [r.supplier_id, r]));

  const rows: UnifiedAnomalyRow[] = [];
  for (const [id, families] of hub.familiesBySupplier) {
    const p = perfById.get(id);
    const proc = processById.get(id);
    const cls = classById.get(id);
    const tmp = tempById.get(id);
    // Canonical span position (same sources the rest of the page reads).
    const abc_class =
      abcById.get(id) ?? cls?.abc_class ?? proc?.abc_class ?? tmp?.abc_class ?? null;
    const kraljic_quadrant =
      p?.kraljic_quadrant ?? cls?.kraljic_quadrant ?? proc?.kraljic_quadrant ?? tmp?.kraljic_quadrant ?? null;
    const zone = p?.zone ?? cls?.zone ?? proc?.zone ?? tmp?.zone ?? null;
    const total_spend_usd =
      p?.total_spend_usd ?? proc?.total_spend_usd ?? cls?.total_spend_usd ?? null;
    rows.push({
      supplier_id: id,
      supplier_name: p?.supplier_name ?? proc?.supplier_name ?? cls?.supplier_name ?? tmp?.supplier_name ?? id,
      total_spend_usd,
      abc_class,
      kraljic_quadrant,
      zone,
      performance_score: p?.performance_score ?? null,
      families,
      important: abc_class === "A" || kraljic_quadrant === "Strategic",
      process: proc,
      classification: cls,
      temporal: tmp,
    });
  }
  return rows;
}

// ===========================================================================
// 1. Priorities at a glance — prose narrative (mirrors "Cycle at a glance").
// ===========================================================================
function PrioritiesGlancePanel({
  narrative,
  hub,
  tail,
  phrase,
}: {
  narrative: RecommendationsNarrative;
  hub: AnomalyHub | null;
  tail: Recommendation | undefined;
  phrase: string;
}) {
  const concShare = Math.round(narrative.top_category_share_pct);
  const heavy = narrative.top_category_share_pct >= 50;

  // "Worth noting" bullets — computed from the hub (available once the breakdown
  // resolves). Each self-omits when its data is absent.
  const bullets: React.ReactNode[] = [];
  if (hub) {
    if (hub.importantUnionCount > 0) {
      bullets.push(
        <li key="important">
          <strong>{hub.importantUnionCount}</strong> of{" "}
          <strong>{hub.distinctFlagged}</strong> flagged supplier
          {hub.distinctFlagged === 1 ? "" : "s"} sit on important relationships (A-tier or
          Strategic)
          {hub.process.importantSpend > 0 ? (
            <>
              , carrying <strong>{usd(hub.process.importantSpend)}</strong> of process-anomaly
              spend
            </>
          ) : null}
          .
        </li>,
      );
    }
    const cls = hub.classification.rows[0];
    if (cls) {
      bullets.push(
        <li key="lens">
          <strong>{cls.supplier_name}</strong> shows the widest lens disagreement — a{" "}
          <strong>{cls.disagreement}</strong>-point spread ({cls.verdict.toLowerCase()}).
        </li>,
      );
    }
    const tmp = hub.temporal?.rows[0];
    if (tmp) {
      const move = tmp.quadrant
        ? `${tmp.quadrant.from} → ${tmp.quadrant.to}`
        : tmp.spend
          ? `spend ${tmp.spend.pct > 0 ? "+" : ""}${tmp.spend.pct}%`
          : tmp.score
            ? `score ${tmp.score.delta > 0 ? "+" : ""}${tmp.score.delta} pts`
            : "a sharp move";
      bullets.push(
        <li key="temporal">
          <strong>{tmp.supplier_name}</strong> moved most year-over-year ({move}).
        </li>,
      );
    }
    if (hub.compoundCount > 0) {
      bullets.push(
        <li key="compound">
          <strong>{hub.compoundCount}</strong> supplier{hub.compoundCount === 1 ? "" : "s"} trip
          more than one analysis — the strongest cross-cutting signals.
        </li>,
      );
    }
  }

  return (
    <Card className={cardElevation}>
      <CardHeader>
        <CardTitle>Priorities at a glance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm leading-relaxed">
        <p>
          Your procurement covers{" "}
          <strong>{intFmt.format(narrative.n_suppliers)} active suppliers</strong> and{" "}
          <strong>{usd(narrative.total_spend)}</strong> {phrase}.
          {narrative.top_category_name && (
            <>
              {" "}
              {heavy ? "Spend is heavily concentrated" : "The largest category"} —{" "}
              <strong>{narrative.top_category_name}</strong> {heavy ? "alone is" : "is"}{" "}
              <strong>{concShare}%</strong> of the total
              {heavy ? "" : " of spend"}
              {narrative.top10_in_attention > 0 ? (
                <>
                  {" "}
                  — and <strong>{narrative.top10_in_attention}</strong> of the top-10 suppliers by
                  spend need attention
                </>
              ) : null}
              .
            </>
          )}{" "}
          This page flags <span className="font-medium text-foreground">where</span> to focus; the{" "}
          <span className="font-medium text-foreground">what</span> to do stays with you.
        </p>

        {narrative.top_category_name && (
          <div className="space-y-1">
            <h3 className="font-medium">Where the exposure sits</h3>
            <p>
              <strong>{narrative.top_category_name}</strong> is the portfolio&apos;s largest
              structural exposure at <strong>{concShare}%</strong> of spend.
              {narrative.a_items_count != null && narrative.a_items_count > 0 && (
                <>
                  {" "}
                  A handful of <strong>{narrative.a_items_count}</strong> A-tier supplier
                  {narrative.a_items_count === 1 ? "" : "s"} concentrate the bulk of it
                </>
              )}
              {tail && tail.tail_supplier_count != null && (
                <>
                  , while <strong>{intFmt.format(tail.tail_supplier_count)}</strong> tail suppliers
                  together make up just{" "}
                  <strong>{(tail.tail_spend_share_pct ?? 0).toFixed(0)}%</strong> of spend
                </>
              )}
              .
            </p>
          </div>
        )}

        {bullets.length > 0 && (
          <div className="space-y-1">
            <h3 className="font-medium">Worth noting</h3>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">{bullets}</ul>
          </div>
        )}

        <p className="text-xs italic text-muted-foreground">
          Click any supplier row below for its cross-analysis detail, or use the anomaly cards to
          filter the roster.
        </p>
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// 2. Stat grid — clean StatBlock cards (label + big number + descriptor).
// ===========================================================================
function PrioritiesStatGrid({
  narrative,
  hub,
  pending,
}: {
  narrative: RecommendationsNarrative;
  hub: AnomalyHub | null;
  pending: boolean;
}) {
  const skeleton = (
    <span className="inline-block h-7 w-14 animate-pulse rounded bg-muted align-middle" />
  );
  const t = hub?.temporal;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatBlock
        size="comfortable"
        label="Category concentration"
        value={`${Math.round(narrative.top_category_share_pct)}%`}
        sublabel={narrative.top_category_name || "largest category"}
      />
      <StatBlock
        size="comfortable"
        label="Flagged suppliers"
        value={hub ? intFmt.format(hub.distinctFlagged) : pending ? skeleton : "—"}
        sublabel={
          hub
            ? `${hub.process.flaggedCount} process · ${hub.classification.flaggedCount} lens · ${t?.flaggedCount ?? 0} time`
            : "cross-analysis anomalies"
        }
      />
      <StatBlock
        size="comfortable"
        label="Flagged & important (A-tier / Strategic)"
        value={hub ? intFmt.format(hub.importantUnionCount) : pending ? skeleton : "—"}
        sublabel={
          hub && hub.process.importantSpend > 0
            ? `${usd(hub.process.importantSpend)} of anomaly spend`
            : "A-tier or Strategic, flagged"
        }
      />
      <StatBlock
        size="comfortable"
        label="Big spenders flagged (of 10)"
        value={`${narrative.top10_in_attention}`}
        sublabel="of your 10 largest suppliers"
      />
    </div>
  );
}

// ===========================================================================
// 3. Where to act — 8 categories compressed into 3 compact group cards.
// ===========================================================================
type CategoryMeta = {
  metric: string | null;
  suppliers: SupplierRow[] | null;
  href: string | null;
};
type SupplierRow = { supplierId: string | null; name: string; main: string; sub?: string; context?: string };

function supplierRows(items: Recommendation[], kind: RecommendationCategory): SupplierRow[] {
  return items.map((r) => {
    if (kind === "critical_spend")
      return {
        supplierId: r.supplier_id ?? null,
        name: r.supplier_name ?? "—",
        context: r.abc_class ?? undefined,
        main: r.total_spend_usd != null ? usd(r.total_spend_usd) : "—",
        sub: r.share_pct != null ? `${r.share_pct.toFixed(1)}%` : undefined,
      };
    if (kind === "critical_issues_engagement")
      return {
        supplierId: r.supplier_id ?? null,
        name: r.supplier_name ?? "—",
        context: r.kraljic_quadrant ?? undefined,
        main: r.total_spend_usd != null ? usd(r.total_spend_usd) : "—",
        sub: r.performance_score != null ? r.performance_score.toFixed(0) : undefined,
      };
    if (kind === "hidden_gems_promotion")
      return {
        supplierId: r.supplier_id ?? null,
        name: r.supplier_name ?? "—",
        main: r.performance_score != null ? r.performance_score.toFixed(0) : "—",
        sub: r.total_spend_usd != null ? usd(r.total_spend_usd) : undefined,
      };
    // bottleneck_risk
    return {
      supplierId: r.supplier_id ?? null,
      name: r.supplier_name ?? "—",
      context: r.country ?? undefined,
      main: r.supply_risk_score != null ? r.supply_risk_score.toFixed(0) : "—",
      sub: r.total_spend_usd != null ? usd(r.total_spend_usd) : undefined,
    };
  });
}

function categoryMeta(
  cat: RecommendationCategory,
  recs: Recommendation[],
  narrative: RecommendationsNarrative | undefined,
): CategoryMeta {
  switch (cat) {
    case "concentration": {
      const top = recs[0];
      const share = top?.share_pct ?? narrative?.top_category_share_pct ?? 0;
      const name = top?.category ?? narrative?.top_category_name ?? "";
      return {
        metric: name ? `${Math.round(share)}% · ${name}` : null,
        suppliers: null,
        href: "/spend-overview",
      };
    }
    case "tail_spend": {
      const t = recs[0];
      return {
        metric: t
          ? `${intFmt.format(t.tail_supplier_count ?? 0)} suppliers · ${(t.tail_spend_share_pct ?? 0).toFixed(0)}% of spend`
          : null,
        suppliers: null,
        href: null,
      };
    }
    case "process_improvement": {
      const imp = recs[0];
      const quad = imp?.scope
        ? imp.scope.replace(/^Quadrant:\s*/, "").replace(/\s*compliance$/i, "")
        : null;
      return {
        metric: imp ? `${imp.impact_score.toFixed(1)}% fail${quad ? ` · ${quad}` : ""}` : null,
        suppliers: null,
        href: null,
      };
    }
    case "slow_stage": {
      if (narrative?.slowest_stage_name && narrative.slowest_stage_avg_days != null)
        return {
          metric: `${narrative.slowest_stage_name} · ${narrative.slowest_stage_avg_days.toFixed(1)}d`,
          suppliers: null,
          href: null,
        };
      const s = recs[0];
      return {
        metric: s
          ? `${(s.scope ?? "Stage").replace(/^Stage:\s*/, "")} · ${(s.avg_days ?? 0).toFixed(1)}d`
          : "balanced",
        suppliers: null,
        href: null,
      };
    }
    case "critical_spend":
    case "critical_issues_engagement":
    case "hidden_gems_promotion":
    case "bottleneck_risk":
      return { metric: null, suppliers: supplierRows(recs, cat), href: null };
    default:
      return { metric: null, suppliers: null, href: null };
  }
}

function CategoryRow({
  cat,
  count,
  population,
  metric,
  onOpen,
}: {
  cat: RecommendationCategory;
  count: number;
  /** Full population for a top-5-capped category; when it exceeds `count`, the row
   *  reads "count of population" so it reconciles with the Classification page. */
  population?: number;
  metric: string | null;
  /** Opens the group's floating insight card, pre-selected to this row's tab. */
  onOpen: () => void;
}) {
  const color = CATEGORY_COLOR_VAR[cat];
  const countLabel =
    population != null && population > count ? `${count} of ${population}` : `${count}`;
  return (
    <li className="border-t first:border-t-0">
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-sm font-medium">{CATEGORY_LABEL[cat]}</span>
          {metric && <span className="truncate text-xs text-muted-foreground">{metric}</span>}
          <span
            className="ml-auto font-mono text-xs text-muted-foreground"
            title={
              population != null && population > count
                ? `Top ${count} shown of ${population} in this zone`
                : undefined
            }
          >
            {countLabel}
          </span>
          <span className="shrink-0 text-xs font-medium text-muted-foreground">View more →</span>
        </div>
      </button>
    </li>
  );
}

function WhereToAct({
  recommendations,
  byCat,
  population,
  narrative,
  insights,
  onOpenPanel,
}: {
  recommendations: Recommendation[];
  byCat: Record<RecommendationCategory, number>;
  /** For the top-5-capped categories only: the full zone/quadrant population, so
   *  the row can read "5 of 12" instead of a misleading "5". */
  population: Partial<Record<RecommendationCategory, number>>;
  narrative: RecommendationsNarrative | undefined;
  insights: Record<"spend" | "suppliers" | "process", string | null>;
  /** Opens the floating insight card on the given tab. */
  onOpenPanel: (key: InsightKey) => void;
}) {
  const of = (t: RecommendationCategory) => recommendations.filter((r) => r.type === t);
  return (
    <Card className={cardElevation}>
      <CardHeader>
        <CardTitle>Where to act</CardTitle>
        <CardDescription>
          What the Spend, Supplier, and Process analyses each surfaced — grouped by analysis, not
          ranked. Open any row for the full picture and why it matters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {ACTION_GROUPS.map((group) => {
            const groupCount = group.categories.reduce((n, c) => n + (byCat[c] ?? 0), 0);
            const insight = insights[group.id];
            const GroupIcon = GROUP_ICON[group.id];
            return (
              <div key={group.id} className="flex flex-col rounded-lg border bg-card/40 p-3">
                <div className="flex items-center gap-2">
                  <GroupIcon className="size-[18px] shrink-0" style={{ color: group.colorVar }} />
                  <span className="text-sm font-semibold" style={{ color: group.colorVar }}>
                    {group.title}
                  </span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {groupCount} to review
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">— {group.tagline}</p>
                {insight && (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{insight}</p>
                )}
                <ul className="mt-2 flex flex-col">
                  {group.categories.map((cat) => (
                    <CategoryRow
                      key={cat}
                      cat={cat}
                      count={byCat[cat] ?? 0}
                      population={population[cat]}
                      metric={categoryMeta(cat, of(cat), narrative).metric}
                      onOpen={() => onOpenPanel(cat)}
                    />
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => onOpenPanel(firstTabOfGroup(group.id))}
                  className="mt-2 self-end text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                >
                  View more →
                </button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// 4. Cross-analysis anomalies — 3 family count cards + one filterable table.
// ===========================================================================
type FamilyFilter = "process" | "classification" | "temporal" | "important" | "compound";

function FamilyCard({
  icon: Icon,
  color,
  label,
  count,
  descriptor,
  active,
  disabled,
  onSelect,
  onViewMore,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  color: string;
  label: string;
  count: number;
  descriptor: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  onViewMore: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2">
        <Icon
          className={cn("size-[18px] shrink-0", disabled && "text-muted-foreground")}
          style={disabled ? undefined : { color }}
        />
        <span className={cn("text-sm font-medium", disabled && "text-muted-foreground")}>{label}</span>
        <span className={cn("ml-auto text-lg font-semibold tabular-nums", disabled && "text-muted-foreground")}>
          {count}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{descriptor}</p>
    </>
  );
  if (disabled) {
    return (
      <div className="flex cursor-not-allowed flex-col gap-2 rounded-lg border bg-muted/20 p-4 text-left opacity-60" aria-disabled>
        {body}
      </div>
    );
  }
  // Two explicit actions (a full-card button can't nest these): filter the roster
  // below, or open the insight card. The card highlights while its filter is active.
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-muted/30 p-4 text-left transition-colors",
        active ? "ring-2 ring-inset ring-foreground/40" : "",
      )}
    >
      {body}
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={active}
          className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          {active ? "Filtering roster ↓" : "Filter roster →"}
        </button>
        <button
          type="button"
          onClick={onViewMore}
          className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          View more →
        </button>
      </div>
    </div>
  );
}

const FILTER_LABEL: Record<FamilyFilter, string> = {
  process: "Process",
  classification: "Lens disagreement",
  temporal: "Changed over time",
  important: "Important only",
  compound: "In 2+ families",
};

function AnomalyFilterChips({
  active,
  counts,
  onSelect,
}: {
  active: FamilyFilter | null;
  counts: { all: number } & Record<FamilyFilter, number>;
  onSelect: (f: FamilyFilter | null) => void;
}) {
  const chip = (isActive: boolean) =>
    cn(
      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
      isActive
        ? "border-foreground/30 bg-foreground/10 text-foreground"
        : "bg-muted/30 text-muted-foreground hover:bg-muted/50",
    );
  const order: FamilyFilter[] = ["process", "classification", "temporal", "important", "compound"];
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => onSelect(null)} aria-pressed={active === null} className={chip(active === null)}>
        All ({counts.all})
      </button>
      {order.map((f) => (
        <button key={f} type="button" onClick={() => onSelect(f)} aria-pressed={active === f} className={chip(active === f)}>
          {FILTER_LABEL[f]} ({counts[f]})
        </button>
      ))}
    </div>
  );
}

// Sortable shadcn TableHead + shared SortArrow (matches the Process Health roster).
function SortHead({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = "left",
  defaultDir = "desc",
  width,
}: {
  label: string;
  sortKey: string;
  active: boolean;
  dir: SortDir;
  onSort: (key: string, defaultDir: SortDir) => void;
  align?: "left" | "right" | "center";
  defaultDir?: SortDir;
  width?: string;
}) {
  const alignText = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  const alignJustify = align === "right" ? "flex-row-reverse" : align === "center" ? "justify-center" : "";
  return (
    <TableHead className={`${alignText} ${width ?? ""}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey, defaultDir)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${alignJustify}`}
      >
        {label}
        <SortArrow active={active} dir={active ? dir : "desc"} />
      </button>
    </TableHead>
  );
}

function AnomalyTable({
  rows,
  activeFilter,
  counts,
  onSelectFilter,
  onSupplier,
  selectedSupplierId,
}: {
  rows: UnifiedAnomalyRow[];
  activeFilter: FamilyFilter | null;
  counts: { all: number } & Record<FamilyFilter, number>;
  onSelectFilter: (f: FamilyFilter | null) => void;
  onSupplier?: (id: string) => void;
  selectedSupplierId: string | null;
}) {
  const filtered = rows.filter((r) => {
    if (!activeFilter) return true;
    if (activeFilter === "important") return r.important;
    if (activeFilter === "compound") return r.families.size >= 2;
    return r.families.has(activeFilter);
  });

  const { sorted, sort, toggle } = useTableSort<UnifiedAnomalyRow, string>(
    filtered,
    (r, k) => {
      switch (k) {
        case "supplier_name":
          return r.supplier_name;
        case "total_spend_usd":
          return r.total_spend_usd;
        case "abc_class":
          return r.abc_class;
        case "kraljic_quadrant":
          return r.kraljic_quadrant;
        case "performance_score":
          return r.performance_score;
        default:
          return null;
      }
    },
    "total_spend_usd",
    "desc",
  );

  return (
    <Card id="anomaly-roster" className={cardElevation}>
      <CardHeader>
        <CardTitle>Flagged suppliers</CardTitle>
        <CardDescription>
          Every supplier tripping a process, lens-disagreement, or changed-over-time anomaly — one
          table. Filter by family, or click a row for its cross-analysis detail.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AnomalyFilterChips active={activeFilter} counts={counts} onSelect={onSelectFilter} />
            {activeFilter && (
              <span className="text-xs text-muted-foreground">
                Showing {filtered.length} of {rows.length} suppliers
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Counts overlap: a supplier flagged by two families is counted once in the
            total, so the family counts add up to more than All.
          </p>
        </div>

        {sorted.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[44px] text-right">#</TableHead>
                  <SortHead label="Supplier" sortKey="supplier_name" active={sort.key === "supplier_name"} dir={sort.dir} onSort={toggle} defaultDir="asc" />
                  <SortHead label="Spend" sortKey="total_spend_usd" active={sort.key === "total_spend_usd"} dir={sort.dir} onSort={toggle} align="right" width="w-[100px]" />
                  <SortHead label="ABC" sortKey="abc_class" active={sort.key === "abc_class"} dir={sort.dir} onSort={toggle} align="center" defaultDir="asc" width="w-[64px]" />
                  <SortHead label="Kraljic quadrant" sortKey="kraljic_quadrant" active={sort.key === "kraljic_quadrant"} dir={sort.dir} onSort={toggle} align="center" defaultDir="asc" width="w-[120px]" />
                  <SortHead label="Performance" sortKey="performance_score" active={sort.key === "performance_score"} dir={sort.dir} onSort={toggle} align="right" width="w-[140px]" />
                  <TableHead className="w-[260px]">Anomalies</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r, i) => (
                  <TableRow
                    key={r.supplier_id}
                    onClick={() => onSupplier?.(r.supplier_id)}
                    className={cn(
                      onSupplier && "cursor-pointer",
                      r.supplier_id === selectedSupplierId
                        ? "bg-foreground/5 ring-1 ring-inset ring-foreground/30"
                        : "hover:bg-muted/40",
                    )}
                  >
                    <TableCell className="text-right tabular-nums text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">{r.supplier_name}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {r.total_spend_usd != null ? usd(r.total_spend_usd) : "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <TintChip color={r.abc_class ? ABC_COLORS[r.abc_class] : null} label={r.abc_class} />
                    </TableCell>
                    <TableCell className="text-center">
                      <TintChip color={r.kraljic_quadrant ? QUADRANT_COLORS[r.kraljic_quadrant] : null} label={r.kraljic_quadrant} />
                    </TableCell>
                    <TableCell className="text-right">
                      <PerfBar score={r.performance_score} />
                    </TableCell>
                    <TableCell>
                      <AnomalyCell row={r} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {activeFilter ? "No suppliers match this filter." : "No cross-analysis anomalies flagged this period."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CrossAnalysisAnomalies({
  hub,
  pending,
  degraded,
  temporal,
  activeFilter,
  onSelectFamily,
  onOpenPanel,
}: {
  hub: AnomalyHub | null;
  pending: boolean;
  degraded: boolean;
  temporal?: TemporalLoad | null;
  activeFilter: FamilyFilter | null;
  onSelectFamily: (f: FamilyFilter) => void;
  /** Opens the anomalies insight card on the given family tab. */
  onOpenPanel: (key: InsightKey) => void;
}) {
  const header = (
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4" style={{ color: PROCESS_ACCENT }} aria-hidden />
        Cross-analysis anomalies
      </CardTitle>
      <CardDescription>
        Where the process, classification, and changed-over-time lenses each flag a supplier. Click
        a family to filter the roster below.
      </CardDescription>
    </CardHeader>
  );

  if (pending || !hub) {
    return (
      <Card className={cardElevation}>
        {header}
        <CardContent>
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Cross-referencing anomalies…
          </div>
        </CardContent>
      </Card>
    );
  }

  const { process, classification, temporal: tAnom } = hub;

  // Temporal family card descriptor + disabled state reflect the period-aware load.
  let tempCount = tAnom?.flaggedCount ?? 0;
  let tempDescriptor: string;
  let tempDisabled = false;
  if (temporal?.kind === "partial-year") {
    tempDescriptor = `${temporal.label} is a partial year — not compared`;
    tempDisabled = true;
    tempCount = 0;
  } else if (temporal?.kind === "no-prior") {
    tempDescriptor = `${temporal.label} is the earliest period — no prior year`;
    tempDisabled = true;
    tempCount = 0;
  } else if (!temporal || temporal.kind === "insufficient") {
    tempDescriptor = "Needs at least two reporting periods";
    tempDisabled = true;
    tempCount = 0;
  } else if (tAnom && tAnom.flaggedCount > 0) {
    tempDescriptor = `${tAnom.latestLabel} vs ${tAnom.priorLabel} · Spend ${tAnom.byDetector.spend} · Quadrant ${tAnom.byDetector.quadrant} · Score ${tAnom.byDetector.score}`;
  } else {
    tempDescriptor = tAnom ? `No sharp moves (${tAnom.latestLabel} vs ${tAnom.priorLabel})` : "No sharp year-over-year moves";
    tempDisabled = true;
  }

  const processDescriptor = `Outlier ${process.flagMix.has_outlier} · Inconsistent ${process.flagMix.inconsistent} · Stage-dom ${process.flagMix.has_stage_dom}`;
  const classDescriptor = classification.rows[0]
    ? `Widest gap ${classification.rows[0].disagreement} · ≥${CLASSIFICATION_DISAGREEMENT_CUTOFF}-pt spread`
    : `≥${CLASSIFICATION_DISAGREEMENT_CUTOFF}-pt spread across spend · performance · supply-risk`;

  return (
    <Card className={cardElevation}>
      {header}
      <CardContent className="flex flex-col gap-4">
        {degraded && (
          <p className="text-xs text-muted-foreground/80">
            Full breakdown unavailable — process family showing outlier flags only.
          </p>
        )}
        {hub.distinctFlagged === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No cross-analysis anomalies flagged this period.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <FamilyCard
              icon={Gauge}
              color={PROCESS_ACCENT}
              label="Process"
              count={process.flaggedCount}
              descriptor={processDescriptor}
              active={activeFilter === "process"}
              disabled={process.flaggedCount === 0}
              onSelect={() => onSelectFamily("process")}
              onViewMore={() => onOpenPanel("process")}
            />
            <FamilyCard
              icon={GitBranch}
              color={CLASS_ACCENT}
              label="Lens disagreement"
              count={classification.flaggedCount}
              descriptor={classDescriptor}
              active={activeFilter === "classification"}
              disabled={classification.flaggedCount === 0}
              onSelect={() => onSelectFamily("classification")}
              onViewMore={() => onOpenPanel("classification")}
            />
            <FamilyCard
              icon={TrendingUp}
              color={TEMPORAL_ACCENT}
              label="Changed over time"
              count={tempCount}
              descriptor={tempDescriptor}
              active={activeFilter === "temporal"}
              disabled={tempDisabled}
              onSelect={() => onSelectFamily("temporal")}
              onViewMore={() => onOpenPanel("temporal")}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// Main view.
// ===========================================================================
type ActionGroupId = (typeof ACTION_GROUPS)[number]["id"];

export function ActionDashboardView({
  data,
  cycleTime,
  perf,
  kraljic,
  startDate,
  endDate,
  temporal,
  supplierCategory,
  isRangeMode,
}: {
  data: RecommendationsResult;
  cycleTime?: CycleTimeResult | null;
  perf?: PerformanceSpendResult | null;
  kraljic?: KraljicResult | null;
  startDate?: string;
  endDate?: string;
  /** Period-aware year-over-year comparison for the hub's temporal family. */
  temporal?: TemporalLoad | null;
  /** Supplier → category map (server-loaded) for the Concentration insight panel. */
  supplierCategory?: Record<string, string>;
  isRangeMode?: boolean;
}) {
  const { recommendations, summary_stats } = data;
  const narrative = summary_stats.narrative;
  const byCat = summary_stats.by_category;

  // The three zone/quadrant recommendation lists are capped at the top 5 in the
  // compute layer, so their `byCat` count is ≤ 5 even when the underlying pool is
  // larger — which contradicted the Classification page (e.g. the Critical Issues
  // zone shows 12 there but "5" here). Surface the full population so the card
  // reads "5 of 12". Only these three are capped; every other category (Critical
  // Spend = all A-tier, Concentration, Tail, Process, Slow stage) already shows a
  // complete count, so they get no "of M".
  const cappedPopulation = useMemo(() => {
    let criticalIssues = 0;
    let hiddenGems = 0;
    let bottleneck = 0;
    for (const s of perf?.suppliers ?? []) {
      if (s.zone === "Critical Issues") criticalIssues++;
      else if (s.zone === "Hidden Gems") hiddenGems++;
      if (s.kraljic_quadrant === "Bottleneck") bottleneck++;
    }
    return {
      critical_issues_engagement: criticalIssues,
      hidden_gems_promotion: hiddenGems,
      bottleneck_risk: bottleneck,
    } as Partial<Record<RecommendationCategory, number>>;
  }, [perf]);

  // ---- In-place supplier detail (one modal, three analysis tabs) ----------- //
  const canDrill = !!(perf && startDate && endDate);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("classification");
  const [activeFilter, setActiveFilter] = useState<FamilyFilter | null>(null);
  // Which "View more →" insight panel is open (one at a time across all 11 cards).
  const [openPanel, setOpenPanel] = useState<InsightKey | null>(null);

  const spanKey = `${startDate ?? ""}_${endDate ?? ""}`;
  const [prevSpan, setPrevSpan] = useState(spanKey);
  if (prevSpan !== spanKey) {
    setPrevSpan(spanKey);
    if (selectedSupplierId !== null) setSelectedSupplierId(null);
    if (activeFilter !== null) setActiveFilter(null);
    if (openPanel !== null) setOpenPanel(null);
  }
  const openSupplier = (id: string, tab: DetailTab) => {
    setDetailTab(tab);
    setSelectedSupplierId(id);
  };

  // ---- Breakdown fetch + anomaly hub (lifted here so the glance, stat grid,
  //      and the one table all read ONE hub — same as Process Health) -------- //
  const [bd, setBd] = useState<{ key: string; data?: CycleBreakdown; err?: string } | null>(null);
  useEffect(() => {
    if (!startDate || !endDate) return;
    let cancelled = false;
    const k = `${startDate}_${endDate}`;
    fetch(`/api/cycle-time/breakdown?start=${startDate}&end=${endDate}`)
      .then(async (res) => {
        if (!res.ok)
          throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Failed to load breakdown");
        return res.json() as Promise<CycleBreakdown>;
      })
      .then((d) => { if (!cancelled) setBd({ key: k, data: d }); })
      .catch((e: unknown) => { if (!cancelled) setBd({ key: k, err: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [startDate, endDate]);

  const breakdown = bd?.key === spanKey ? bd.data : undefined;
  const breakdownErr = bd?.key === spanKey ? bd.err : undefined;
  const hasSpan = !!(startDate && endDate);
  const pending = hasSpan && !breakdown && !breakdownErr;
  const degraded = !breakdown && !!breakdownErr;

  const hub = useMemo<AnomalyHub | null>(() => {
    if (!breakdown && !degraded) return null; // still loading
    const anomalies = cycleTime?.anomalies ?? [];
    const roster = breakdown?.bySupplier ?? [];
    const stageAnomalies = breakdown?.stageAnomalies ?? [];
    // Process flags: full derivation when breakdown present; else outlier-only.
    let flagsBySupplier: Map<string, SupplierFlagState>;
    if (breakdown) {
      flagsBySupplier = deriveCycleFlags({ roster, anomalies, stageAnomalies }).flagsBySupplier;
    } else {
      flagsBySupplier = new Map();
      for (const a of anomalies)
        if (!flagsBySupplier.has(a.supplier_id))
          flagsBySupplier.set(a.supplier_id, { has_outlier: true, inconsistent: false, has_stage_dom: false });
    }
    const supplyRiskById = new Map<string, number>();
    for (const q of kraljic?.quadrant_assignments ?? []) supplyRiskById.set(q.supplier_id, q.supply_risk_score);
    const temporalAnomalies = temporal?.kind === "ok" ? buildTemporalAnomalies(temporal.matrix) : null;
    return buildAnomalyHub({
      flagsBySupplier,
      perfSuppliers: perf?.suppliers ?? [],
      roster,
      supplyRiskById,
      temporal: temporalAnomalies,
    });
  }, [breakdown, degraded, cycleTime, kraljic, perf, temporal]);

  // Unified rows + reconciled position (canonical span ABC + perf).
  const { unifiedRows, filterCounts } = useMemo(() => {
    if (!hub) return { unifiedRows: [] as UnifiedAnomalyRow[], filterCounts: null };
    const perfById = new Map((perf?.suppliers ?? []).map((s) => [s.supplier_id, s]));
    const abcById = new Map<string, AbcClass>();
    for (const r of breakdown?.bySupplier ?? []) if (r.abc_class) abcById.set(r.supplier_id, r.abc_class);
    const rows = buildUnifiedRows(hub, perfById, abcById);
    const counts = {
      all: hub.distinctFlagged,
      process: hub.process.flaggedCount,
      classification: hub.classification.flaggedCount,
      temporal: hub.temporal?.flaggedCount ?? 0,
      important: hub.importantUnionCount,
      compound: hub.compoundCount,
    };
    return { unifiedRows: rows, filterCounts: counts };
  }, [hub, perf, breakdown]);

  // Row → modal: process-family members open the Process tab (richest cycle
  // detail); everything else opens Classification (where lens + evolution live).
  const onAnomalySupplier = canDrill
    ? (id: string) => {
        const row = unifiedRows.find((r) => r.supplier_id === id);
        openSupplier(id, row && row.families.has("process") ? "process" : "classification");
      }
    : undefined;

  const selectFamily = (f: FamilyFilter) => {
    setActiveFilter((cur) => (cur === f ? null : f));
    requestAnimationFrame(() => {
      const el = document.getElementById("anomaly-roster");
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
    });
  };

  const insights: Record<ActionGroupId, string | null> = {
    spend: narrative ? spendInsight(narrative) : null,
    suppliers: narrative ? suppliersInsight(narrative) : null,
    process: narrative ? processInsight(narrative) : null,
  };

  const phrase = periodPhrase(startDate ?? "", endDate ?? "", !!isRangeMode);
  const tailRec = recommendations.find((r) => r.type === "tail_spend");

  // ---- "View more →" tabbed floating insight card — one open at a time, built
  //      from the data already on this page (+ the server-loaded category map). -- //
  const insightCtx = useMemo<InsightCtx>(
    () => ({
      recommendations,
      perf: perf ?? null,
      kraljic: kraljic ?? null,
      cycleTime: cycleTime ?? null,
      breakdown,
      hub,
      narrative,
      supplierCategory: supplierCategory ?? {},
    }),
    [recommendations, perf, kraljic, cycleTime, breakdown, hub, narrative, supplierCategory],
  );
  // Per-tab count badges — the number each card/row already shows (population for
  // the top-5-capped categories; flaggedCount for families).
  const insightTabCounts = useMemo<Partial<Record<InsightKey, number>>>(
    () => ({
      concentration: byCat.concentration ?? 0,
      critical_spend: byCat.critical_spend ?? 0,
      tail_spend: byCat.tail_spend ?? 0,
      critical_issues_engagement: cappedPopulation.critical_issues_engagement ?? 0,
      hidden_gems_promotion: cappedPopulation.hidden_gems_promotion ?? 0,
      bottleneck_risk: cappedPopulation.bottleneck_risk ?? 0,
      process_improvement: byCat.process_improvement ?? 0,
      slow_stage: byCat.slow_stage ?? 0,
      process: hub?.process.flaggedCount ?? 0,
      classification: hub?.classification.flaggedCount ?? 0,
      temporal: hub?.temporal?.flaggedCount ?? 0,
    }),
    [byCat, cappedPopulation, hub],
  );
  const openInsight = (key: InsightKey) => setOpenPanel(key);
  // A row click inside the card CLOSES the card first, then opens the supplier
  // modal — no stacked dialogs (single scrim, unambiguous Esc). Process family →
  // Process tab; everything else → Classification.
  const onCardSupplier = canDrill
    ? (id: string) => {
        const tab: DetailTab = openPanel === "process" ? "process" : "classification";
        setOpenPanel(null);
        openSupplier(id, tab);
      }
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Where to focus across your spend, supplier, and process analyses — flagged, not prescribed.
      </p>

      {narrative ? (
        <>
          <PrioritiesGlancePanel narrative={narrative} hub={hub} tail={tailRec} phrase={phrase} />
          <PrioritiesStatGrid narrative={narrative} hub={hub} pending={pending} />
        </>
      ) : (
        <Card className={cardElevation}>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Priorities summary is unavailable for this period.
          </CardContent>
        </Card>
      )}

      <WhereToAct
        recommendations={recommendations}
        byCat={byCat}
        population={cappedPopulation}
        narrative={narrative}
        insights={insights}
        onOpenPanel={openInsight}
      />

      <CrossAnalysisAnomalies
        hub={hub}
        pending={pending}
        degraded={degraded}
        temporal={temporal}
        activeFilter={activeFilter}
        onSelectFamily={selectFamily}
        onOpenPanel={openInsight}
      />

      {hub && hub.distinctFlagged > 0 && filterCounts && (
        <AnomalyTable
          rows={unifiedRows}
          activeFilter={activeFilter}
          counts={filterCounts}
          onSelectFilter={setActiveFilter}
          onSupplier={onAnomalySupplier}
          selectedSupplierId={selectedSupplierId}
        />
      )}

      {recommendations.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No priorities flagged for this period.
          </CardContent>
        </Card>
      )}

      {/* Tabbed floating insight card ("View more →") — one per group, over a scrim.
          CONDITIONALLY MOUNTED: setting openPanel = null removes the card + its
          overlay from the tree atomically, so a row-click's close-then-open of the
          supplier modal can never leave a second scrim stacked (no modal-over-modal). */}
      {openPanel != null && (
        <ActionInsightCard
          openKey={openPanel}
          ctx={insightCtx}
          tabCounts={insightTabCounts}
          startDate={startDate ?? ""}
          endDate={endDate ?? ""}
          onTab={openInsight}
          onClose={() => setOpenPanel(null)}
          onSupplier={onCardSupplier}
        />
      )}

      {/* In-place unified supplier detail — one centered modal, three analysis tabs. */}
      {canDrill && perf && startDate && endDate && (
        <UnifiedSupplierDetailModal
          supplierId={selectedSupplierId}
          initialTab={detailTab}
          startDate={startDate}
          endDate={endDate}
          kraljic={kraljic ?? null}
          perf={perf}
          cycleTime={cycleTime ?? null}
          onClose={() => setSelectedSupplierId(null)}
          onSupplierClick={(id) => openSupplier(id, "classification")}
        />
      )}
    </div>
  );
}
