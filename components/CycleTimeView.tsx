"use client";

import { useState } from "react";
import type {
  CycleTimeResult,
  CycleDescriptive,
  KraljicQuadrant,
} from "@/lib/analysis-types";
import {
  Card,
  CardContent,
  CardDescription,
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
import { Button } from "@/components/ui/button";
import { StatBlock } from "@/components/ui/stat-block";
import { MonthlyCycleTrendChart } from "@/components/charts/MonthlyCycleTrendChart";
import { CycleTimeBoxPlot } from "@/components/charts/CycleTimeBoxPlot";
import { CycleStatGrid } from "@/components/CycleTime/CycleStatGrid";
import { StageDecompositionTable } from "@/components/CycleTime/StageDecompositionTable";
import type { ControlExposure } from "@/lib/cycle-time-types";
import { SortArrow } from "@/components/RankingCells";
import { useTableSort, type SortDir } from "@/lib/use-table-sort";
import { cardElevation, formatCompactCurrency } from "@/lib/utils";
import { METHOD_LABEL, visibleTransitions } from "@/lib/cycle-mix";

const QUAD_ORDER: KraljicQuadrant[] = [
  "Strategic",
  "Leverage",
  "Bottleneck",
  "Routine",
];

// 2-decimal medians (precision audit AA — cycle-time medians show 2dp).
const d2 = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));

// ---- Sortable column header (shadcn TableHead + shared SortArrow) ---------- #
function SortHead({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = "left",
  defaultDir = "desc",
}: {
  label: string;
  sortKey: string;
  active: boolean;
  dir: SortDir;
  onSort: (key: string, defaultDir: SortDir) => void;
  align?: "left" | "right";
  defaultDir?: SortDir;
}) {
  return (
    <TableHead className={align === "right" ? "text-right" : ""}>
      <button
        type="button"
        onClick={() => onSort(sortKey, defaultDir)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        {label}
        <SortArrow active={active} dir={active ? dir : "desc"} />
      </button>
    </TableHead>
  );
}

// ---- Cycle time by Kraljic quadrant (descriptives, sortable) --------------- #
type QuadCycleRow = { order: number; quadrant: KraljicQuadrant } & CycleDescriptive;

function CycleByQuadrantTable({ data }: { data: CycleTimeResult }) {
  const rows: QuadCycleRow[] = QUAD_ORDER.map((q, i) => ({
    order: i,
    quadrant: q,
    ...data.cycle_by_quadrant[q],
  }));
  const { sorted, sort, toggle } = useTableSort<QuadCycleRow, string>(
    rows,
    (r, k) => (r as unknown as Record<string, number | string | null>)[k],
    "order",
    "asc",
  );
  return (
    <Card className={cardElevation}>
      <CardHeader>
        <CardTitle>Cycle Time by Exposure positioning</CardTitle>
        <CardDescription>Total cycle days per Exposure position (Kraljic matrix quadrants).</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead label="Quadrant" sortKey="order" active={sort.key === "order"} dir={sort.dir} onSort={toggle} defaultDir="asc" />
              <SortHead label="N" sortKey="n" active={sort.key === "n"} dir={sort.dir} onSort={toggle} align="right" />
              <SortHead label="Average" sortKey="mean" active={sort.key === "mean"} dir={sort.dir} onSort={toggle} align="right" />
              <SortHead label="Median" sortKey="median" active={sort.key === "median"} dir={sort.dir} onSort={toggle} align="right" />
              <SortHead label="P25" sortKey="p25" active={sort.key === "p25"} dir={sort.dir} onSort={toggle} align="right" />
              <SortHead label="P75" sortKey="p75" active={sort.key === "p75"} dir={sort.dir} onSort={toggle} align="right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((q) => (
              <TableRow key={q.quadrant}>
                <TableCell className="font-medium">{q.quadrant}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{q.n}</TableCell>
                <TableCell className="text-right tabular-nums">{d2(q.mean)}</TableCell>
                <TableCell className="text-right tabular-nums">{d2(q.median)}</TableCell>
                <TableCell className="text-right tabular-nums">{d2(q.p25)}</TableCell>
                <TableCell className="text-right tabular-nums">{d2(q.p75)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ---- 3-way match by Kraljic quadrant (pass rate, sortable) ----------------- #
type MatchRow = {
  order: number;
  quadrant: KraljicQuadrant;
  n: number;
  pass_rate_pct: number | null;
  is_worst: boolean;
};

// Cycle-median-per-quadrant row — the sibling sub-table inside the Control Exposure
// card (same quadrants + N basis as the pass-rate table).
type QuadMedianRow = {
  order: number;
  quadrant: KraljicQuadrant;
  n: number;
  median: number | null;
};

// Spend-at-risk narrative — states only the factual magnitudes (rate, $ at risk,
// % of spend, suppliers spanned, value-vs-count share). Deliberately makes NO
// causal claim ("diffuse", "not tied to payment/quality/PO size") — those were a
// baked pre-recompute test result, never re-verified. Self-omits when nothing failed.
function ControlInsight({ c }: { c: ControlExposure }) {
  if (c.n_failed === 0) {
    return (
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        No POs failed the 3-way match this period — no spend at risk.
      </p>
    );
  }
  const oneIn = Math.round(c.n_total / c.n_failed);
  const byCount = c.n_total > 0 ? (c.n_failed / c.n_total) * 100 : 0;
  return (
    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
      Roughly 1 in {oneIn} POs ({c.n_failed} of {c.n_total}) failed the 3-way match this period,
      carrying{" "}
      <strong className="font-medium text-foreground">{formatCompactCurrency(c.failed_spend)}</strong>{" "}
      of spend — <strong className="font-medium text-foreground">{c.pct_at_risk.toFixed(1)}%</strong>{" "}
      of the {formatCompactCurrency(c.total_spend)} total, spread across{" "}
      <strong className="font-medium text-foreground">{c.n_failing_suppliers}</strong> of{" "}
      {c.n_total_suppliers} active suppliers. Those failed POs are {c.pct_at_risk.toFixed(1)}% of spend
      by value and {byCount.toFixed(1)}% of POs by count.
    </p>
  );
}

// Kraljic "supply-risk" pair (high supply risk = the two right-hand quadrants).
const HIGH_RISK_QUADRANTS = new Set<KraljicQuadrant>(["Strategic", "Bottleneck"]);

const joinQuads = (qs: string[]): string =>
  qs.length <= 1
    ? qs[0] ?? ""
    : qs.length === 2
      ? `${qs[0]} and ${qs[1]}`
      : `${qs.slice(0, -1).join(", ")}, and ${qs[qs.length - 1]}`;

// Data-driven cycle-by-quadrant insight — everything (which quadrants are slow/fast,
// the gap, and whether the supply-risk clause even applies) is DERIVED from the live
// per-quadrant medians. No hardcoded quadrant names: if the ranking shifts on a
// different period, the wording follows it; flat/degenerate cases self-omit.
// ---- Cycle time by BUYING METHOD (sibling of CycleByQuadrantTable) -------- #
// Same shape and slot as the quadrant table — cycle_by_method mirrors
// cycle_by_quadrant's descriptives, plus the internal-cycle column (total minus
// PO->Delivery physical lead time). This is the cut that explains the pooled
// number: cycle time is near-deterministic in buying method, so the portfolio
// mean is a weighted mixture of these five rows.
type MethodCycleRow = {
  order: number;
  method: string;
  internal_mean: number | null;
  internal_median: number | null;
} & CycleDescriptive;

const METHOD_ORDER = ["spot_buy", "call_off", "rfq", "tender", "direct"];

function CycleByMethodTable({ data }: { data: CycleTimeResult }) {
  const byMethod = data.cycle_by_method ?? {};
  // Known methods first (procurement order), then any unknown ones. Computed
  // unconditionally — the "no data" guard sits AFTER the hook below, because
  // useTableSort must run in the same order on every render (rules-of-hooks).
  const keys = [
    ...METHOD_ORDER.filter((m) => byMethod[m]),
    ...Object.keys(byMethod).filter((m) => !METHOD_ORDER.includes(m)).sort(),
  ];
  const rows: MethodCycleRow[] = keys.map((m, i) => ({
    order: i,
    method: m,
    mean: byMethod[m].mean,
    median: byMethod[m].median,
    p25: byMethod[m].p25,
    p75: byMethod[m].p75,
    n: byMethod[m].n,
    internal_mean: byMethod[m].internal?.mean ?? null,
    internal_median: byMethod[m].internal?.median ?? null,
  }));
  const { sorted, sort, toggle } = useTableSort<MethodCycleRow, string>(
    rows,
    (r, k) => (r as unknown as Record<string, number | string | null>)[k],
    "order",
    "asc",
  );
  const slowest = (() => {
    const withData = rows.filter((r) => r.n > 0 && r.median != null);
    if (withData.length === 0) return null;
    return withData.reduce((a, b) => ((b.median as number) > (a.median as number) ? b : a)).method;
  })();
  // Analyses cached before cycle_by_method existed carry no methods — render nothing.
  if (rows.length === 0) return null;
  return (
    <Card className={cardElevation}>
      <CardHeader>
        <CardTitle>Cycle Time by Buying method</CardTitle>
        <CardDescription>
          Total cycle days per buying method, and the internal portion (excluding
          PO&nbsp;to&nbsp;Delivery supplier lead time). The portfolio average is a weighted
          mixture of these rows, so a change in method mix moves it on its own.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead label="Method" sortKey="order" active={sort.key === "order"} dir={sort.dir} onSort={toggle} defaultDir="asc" />
              <SortHead label="N" sortKey="n" active={sort.key === "n"} dir={sort.dir} onSort={toggle} align="right" />
              <SortHead label="Average" sortKey="mean" active={sort.key === "mean"} dir={sort.dir} onSort={toggle} align="right" />
              <SortHead label="Median" sortKey="median" active={sort.key === "median"} dir={sort.dir} onSort={toggle} align="right" />
              <SortHead label="Internal avg" sortKey="internal_mean" active={sort.key === "internal_mean"} dir={sort.dir} onSort={toggle} align="right" />
              <SortHead label="Internal median" sortKey="internal_median" active={sort.key === "internal_median"} dir={sort.dir} onSort={toggle} align="right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow key={r.method}>
                <TableCell className="font-medium">{METHOD_LABEL[r.method] ?? r.method}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{r.n}</TableCell>
                <TableCell
                  className={`text-right tabular-nums ${r.method === slowest ? "font-semibold text-destructive" : ""}`}
                >
                  {r.mean != null ? r.mean.toFixed(2) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.median != null ? r.median.toFixed(2) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{r.internal_mean != null ? r.internal_mean.toFixed(2) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{r.internal_median != null ? r.internal_median.toFixed(2) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <YoyTransitionTable data={data} />
      </CardContent>
    </Card>
  );
}

// ---- Year-over-year transition table (second sub-table of the method card) --- #
// LAYOUT: this lives INSIDE the buying-method card rather than as a fifth
// standalone card on an already-dense page. The two tables are the same lens —
// "how do the methods differ" and "how did they change" — and Control Exposure
// already sets the precedent of one card holding two related sub-tables.
//
// ⚠️ DECOMPOSITION ONLY, no p-values. Shift-share is an arithmetic identity
// (pooled = mix + within) with no distributional assumptions, so nothing here can
// be misread as a test result. Per-cell tests would put ten hypotheses in a table
// where nineteen of twenty are null after correction. The one result that survives
// correction is stated once, in the glance, with its q-value and power.
function YoyTransitionTable({ data }: { data: CycleTimeResult }) {
  const rows = visibleTransitions(data, "total");
  if (rows.length === 0) return null;
  // Signed day + its share of the earlier period's pooled mean.
  const cell = (d: number | null, pctv: number | null) =>
    d == null
      ? "—"
      : `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}d${
          pctv == null ? "" : ` (${pctv >= 0 ? "+" : "−"}${Math.abs(pctv).toFixed(1)}%)`
        }`;
  const NOTE: Record<string, string> = {
    magnitude_masked: "Pooled looks flat — the methods moved",
    sign_reversal: "Pooled points the opposite way to the methods",
  };
  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium">Year over year</h3>
      <p className="mb-2 text-sm text-muted-foreground">
        The pooled change split into the part explained by a shift in method
        <span> </span>mix and the part the methods actually moved. These two always sum to the
        pooled change. Percentages are of the earlier year&rsquo;s pooled mean.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Transition</TableHead>
            <TableHead className="text-right">Pooled change</TableHead>
            <TableHead className="text-right">Mix effect</TableHead>
            <TableHead className="text-right">Within effect</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((t) => (
            <TableRow key={`${t.from}-${t.to}`}>
              <TableCell className="font-medium">
                {t.from} → {t.to}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {cell(t.pooled_change, t.pooled_change_pct)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {cell(t.mix_effect, t.mix_effect_pct)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {cell(t.within_effect, t.within_effect_pct)}
              </TableCell>
              <TableCell
                className={t.pooled_misleading ? "text-[var(--warning)]" : "text-muted-foreground"}
              >
                {t.reason ? NOTE[t.reason] : "Pooled and methods agree"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-2 text-xs text-muted-foreground">
        Mix + within equals the pooled change exactly; the displayed figures are each
        rounded to 2 decimals, so a column may differ from the total by 0.01.
      </p>
    </div>
  );
}

function CycleInsight({ rows }: { rows: QuadMedianRow[] }) {
  const withData = rows.filter(
    (r): r is QuadMedianRow & { median: number } => r.n > 0 && r.median != null,
  );
  if (withData.length < 2) return null; // nothing to compare

  const medians = withData.map((r) => r.median);
  const maxMed = Math.max(...medians);
  const minMed = Math.min(...medians);
  const gap = maxMed - minMed;
  const roundedGap = Math.round(gap);

  // Flat (or within a day) → self-omit the comparison, just state the flatness.
  if (roundedGap < 1) {
    return (
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Cycle time is essentially flat across exposure quadrants (medians {d2(minMed)}–{d2(maxMed)}d).
      </p>
    );
  }

  const slow = withData.filter((r) => r.median === maxMed).map((r) => r.quadrant);
  const fast = withData.filter((r) => r.median === minMed).map((r) => r.quadrant);

  // Risk-axis clause ONLY when the data supports it: all four quadrants present and
  // both high-risk quadrants strictly slower than both low-risk ones.
  const hr = withData.filter((r) => HIGH_RISK_QUADRANTS.has(r.quadrant)).map((r) => r.median);
  const lr = withData.filter((r) => !HIGH_RISK_QUADRANTS.has(r.quadrant)).map((r) => r.median);
  const riskAxis =
    withData.length === 4 &&
    hr.length === 2 &&
    lr.length === 2 &&
    Math.min(...hr) > Math.max(...lr);

  const slowVerb = slow.length > 1 ? "run" : "runs";
  return (
    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
      <strong className="font-medium text-foreground">{joinQuads(slow)}</strong> {slowVerb} about{" "}
      {roundedGap} day{roundedGap === 1 ? "" : "s"} slower than {joinQuads(fast)} ({d2(maxMed)}d vs{" "}
      {d2(minMed)}d median)
      {riskAxis
        ? ", consistent with the supply-risk axis — higher-risk quadrants carry the longer cycles"
        : ""}
      .
    </p>
  );
}

function ThreeWayMatchTable({
  data,
  control,
}: {
  data: CycleTimeResult;
  control?: ControlExposure;
}) {
  const rows: MatchRow[] = QUAD_ORDER.map((q, i) => ({
    order: i,
    quadrant: q,
    ...data.three_way_match_by_quadrant[q],
  }));
  const { sorted, sort, toggle } = useTableSort<MatchRow, string>(
    rows,
    (r, k) => (r as unknown as Record<string, number | string | null>)[k],
    "order",
    "asc",
  );

  const quadTable = (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHead label="Quadrant" sortKey="order" active={sort.key === "order"} dir={sort.dir} onSort={toggle} defaultDir="asc" />
          <SortHead label="N" sortKey="n" active={sort.key === "n"} dir={sort.dir} onSort={toggle} align="right" />
          <SortHead label="Pass Rate" sortKey="pass_rate_pct" active={sort.key === "pass_rate_pct"} dir={sort.dir} onSort={toggle} align="right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((m) => (
          <TableRow key={m.quadrant}>
            <TableCell className="font-medium">{m.quadrant}</TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">{m.n}</TableCell>
            <TableCell
              className={`text-right tabular-nums ${m.is_worst ? "font-semibold text-destructive" : ""}`}
            >
              {m.pass_rate_pct != null ? `${m.pass_rate_pct.toFixed(1)}%` : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  const cycleRows: QuadMedianRow[] = QUAD_ORDER.map((q, i) => ({
    order: i,
    quadrant: q,
    n: data.cycle_by_quadrant[q].n,
    median: data.cycle_by_quadrant[q].median,
  }));
  // Slowest = highest median cycle among quadrants with POs — mirrors the pass-rate
  // table's is_worst (which reds the lowest pass rate).
  const slowestQuadrant = (() => {
    const withData = cycleRows.filter((r) => r.n > 0 && r.median != null);
    if (withData.length === 0) return null;
    return withData.reduce((a, b) => ((b.median as number) > (a.median as number) ? b : a)).quadrant;
  })();
  const {
    sorted: cycleSorted,
    sort: cycleSort,
    toggle: cycleToggle,
  } = useTableSort<QuadMedianRow, string>(
    cycleRows,
    (r, k) => (r as unknown as Record<string, number | string | null>)[k],
    "order",
    "asc",
  );

  const cycleTable = (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHead label="Quadrant" sortKey="order" active={cycleSort.key === "order"} dir={cycleSort.dir} onSort={cycleToggle} defaultDir="asc" />
          <SortHead label="N" sortKey="n" active={cycleSort.key === "n"} dir={cycleSort.dir} onSort={cycleToggle} align="right" />
          <SortHead label="Median" sortKey="median" active={cycleSort.key === "median"} dir={cycleSort.dir} onSort={cycleToggle} align="right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {cycleSorted.map((r) => (
          <TableRow key={r.quadrant}>
            <TableCell className="font-medium">{r.quadrant}</TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">{r.n}</TableCell>
            <TableCell
              className={`text-right tabular-nums ${r.quadrant === slowestQuadrant ? "font-semibold text-destructive" : ""}`}
            >
              {r.median != null ? `${d2(r.median)} d` : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  // Reports / range-compute don't pass `control` → keep the original bare table.
  if (!control) {
    return (
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>3-Way Match by Exposure positioning</CardTitle>
          <CardDescription>
            Share of POs passing the 3-way match, by Exposure position (Kraljic matrix quadrants).
          </CardDescription>
        </CardHeader>
        <CardContent>{quadTable}</CardContent>
      </Card>
    );
  }

  // Dashboard: spend-at-risk control framing (headline + insight), quadrant table demoted.
  return (
    <Card className={cardElevation}>
      <CardHeader>
        <CardTitle>Match compliance and cycle time, by exposure quadrant</CardTitle>
        <CardDescription>
          How each Kraljic exposure quadrant performs on match compliance and cycle time.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatBlock
            size="comfortable"
            label="Spend through failed matches"
            value={formatCompactCurrency(control.failed_spend)}
            sublabel="PO / delivery / invoice didn't reconcile"
          />
          <StatBlock
            size="comfortable"
            label="Share of total spend"
            value={`${control.pct_at_risk.toFixed(1)}%`}
            sublabel={`of ${formatCompactCurrency(control.total_spend)}`}
          />
          <StatBlock
            size="comfortable"
            label="Failed POs"
            value={String(control.n_failed)}
            sublabel={`across ${control.n_failing_suppliers} suppliers`}
          />
        </div>
        {/* Two lenses on the same exposure quadrants, side by side — each with its
            own insight beneath (compliance story left, cycle story right). */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-2 text-sm font-medium text-muted-foreground">
              Pass rate by exposure positioning
            </h4>
            {quadTable}
            <ControlInsight c={control} />
          </div>
          <div>
            <h4 className="mb-2 text-sm font-medium text-muted-foreground">
              Cycle time by exposure positioning
            </h4>
            {cycleTable}
            <CycleInsight rows={cycleRows} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- Longest-cycle POs table (sortable, top 10 + show all) ----------------- #
// The orders running furthest above the window's mean total cycle. Rendered in
// reports / range-compute; the dashboard hides it (showAnomaliesTable={false})
// since PO-level detail moved to the per-supplier drill-down.
//
// ⚠️ NOT an outlier test, and it must not be labelled as one. See Methodology 3.4:
// the cycle distribution is a bounded plateau (excess kurtosis ~-1.19), so every
// spread-based detector — Tukey 1.5x and 3x, MAD-z>3.5, z>3 — flags NOTHING. This
// is a descriptive top-slice, so the table leads with DAYS ABOVE AVERAGE, which a
// reader can act on, rather than a z-score, which would imply a normality basis.
function AnomaliesTable({
  data,
  mean,
  methodByPo,
}: {
  data: CycleTimeResult["anomalies"];
  mean: number;
  // Buying method per PO, supplied where the caller has the breakdown. The flagged
  // set is almost entirely `direct` — the only method whose cycle range reaches the
  // threshold at all — so naming it stops a reader inferring a process failure.
  methodByPo?: Record<string, string>;
}) {
  const [showAll, setShowAll] = useState(false);
  const { sorted, sort, toggle } = useTableSort<CycleTimeResult["anomalies"][number], string>(
    data,
    (r, k) => (r as unknown as Record<string, number | string | null>)[k],
    "cycle_days",
    "desc",
  );
  const rows = showAll ? sorted : sorted.slice(0, 10);
  return (
    <Card id="cycle-anomalies" className={cardElevation}>
      <CardHeader>
        <CardTitle>Longest-cycle POs</CardTitle>
        <CardDescription>
          The orders running furthest above this window&rsquo;s {Math.round(mean)}-day
          average cycle. A descriptive list of the slowest orders, not a statistical
          outlier test &mdash; see Methodology.
          {methodByPo ? " Buying method is shown because these are almost always direct awards, which carry the longest lead times by design." : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No order ran far enough above the window average to stand out this period.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead label="PO ID" sortKey="po_id" active={sort.key === "po_id"} dir={sort.dir} onSort={toggle} defaultDir="asc" />
                  <SortHead label="Supplier" sortKey="supplier_name" active={sort.key === "supplier_name"} dir={sort.dir} onSort={toggle} defaultDir="asc" />
                  <SortHead label="Invoice Date" sortKey="invoice_date" active={sort.key === "invoice_date"} dir={sort.dir} onSort={toggle} defaultDir="asc" />
                  {methodByPo && <TableHead>Method</TableHead>}
                  <SortHead label="Cycle Days" sortKey="cycle_days" active={sort.key === "cycle_days"} dir={sort.dir} onSort={toggle} align="right" />
                  <TableHead className="text-right">vs average</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.po_id}>
                    <TableCell className="font-medium">{a.po_id}</TableCell>
                    <TableCell>{a.supplier_name}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {a.invoice_date ?? "—"}
                    </TableCell>
                    {methodByPo && (
                      <TableCell className="text-muted-foreground">
                        {METHOD_LABEL[methodByPo[a.po_id] ?? ""] ?? methodByPo[a.po_id] ?? "—"}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">{a.cycle_days ?? "—"}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-destructive">
                      {a.cycle_days != null && mean > 0
                        ? `+${Math.round(a.cycle_days - mean)}d`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {data.length > 10 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 no-print"
                onClick={() => setShowAll((s) => !s)}
              >
                {showAll ? "Show top 10" : `View all ${data.length}`}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Distribution interpretation (dashboard-only; below the box plot) ------ #
// Two self-omitting lines read from the already-computed distribution + anomalies.
function DistributionInsight({ data }: { data: CycleTimeResult }) {
  const { mean, median } = data.distribution;
  // Skew fires only when the average meaningfully exceeds the median (≥ 0.5 day).
  const skew = mean != null && median != null && mean - median >= 0.5 ? { mean, median } : null;
  const outCds = data.anomalies
    .map((a) => a.cycle_days)
    .filter((v): v is number => v != null);
  // Outlier-direction fires only when every outlier is slower than the median.
  const slow =
    median != null && outCds.length > 0 && outCds.every((v) => v > median)
      ? { max: Math.max(...outCds) }
      : null;
  if (!skew && !slow) return null;
  return (
    <ul
      className="mt-3 list-disc space-y-1 pl-5 pt-3 text-sm text-muted-foreground"
      style={{ borderTop: "0.5px solid var(--border)" }}
    >
      {skew && (
        <li>
          Slow-skewed — the average{" "}
          <strong className="font-medium text-foreground">{skew.mean.toFixed(1)} d</strong> edges above
          the median{" "}
          <strong className="font-medium text-foreground">{skew.median.toFixed(1)} d</strong>; a few
          slow POs pull it right while the fast side stays compact.
        </li>
      )}
      {slow && (
        <li>
          Outliers are all delays — every outlier sits on the slow side (up to{" "}
          <strong className="font-medium text-foreground">{slow.max} d</strong>), so the risk is
          one-directional.
        </li>
      )}
    </ul>
  );
}

export function CycleTimeView({
  data,
  embedded = false,
  showAnomaliesTable = true,
  methodByPo,
  showMonthlyTrend = true,
  showStatGrid = true,
  showStageDecomposition = true,
  showDistributionInsight = false,
  showMethodBreakdown = false,
  controlExposure,
  onOutlierClick,
}: {
  data: CycleTimeResult;
  embedded?: boolean;
  // The dashboard hides the Outlier POs table (PO detail moved to the per-supplier
  // drill-down); reports + range-compute keep it (default true).
  showAnomaliesTable?: boolean;
  // Per-PO buying method for the longest-cycle table. Optional: range-compute has
  // no breakdown to derive it from, and the column simply omits there.
  methodByPo?: Record<string, string>;
  // The dashboard replaces the Monthly Cycle Time Trend with the stage-occupancy
  // chart (in CycleTimeClient); reports + range-compute keep the trend (default true).
  showMonthlyTrend?: boolean;
  // The dashboard renders the stat grid itself (above the anomaly flags, with a 5th
  // "Slowest stage" card); reports + range-compute keep it here (default true).
  showStatGrid?: boolean;
  // The dashboard moves the stage decomposition into the merged "Stage breakdown"
  // section; reports + range-compute keep it here (default true).
  showStageDecomposition?: boolean;
  // Dashboard-only interpretation lines below the box plot (skew + outlier
  // direction). Off by default so reports/range-compute keep the box plot as-is.
  showDistributionInsight?: boolean;
  /** Dashboard-only: the per-buying-method cycle table. Default false so reports +
   *  range-compute keep their existing layout unchanged. */
  showMethodBreakdown?: boolean;
  // Dashboard-only spend-at-risk data for the 3-way-match section. Omitted in
  // reports/range-compute → the bare pass-rate table renders as before.
  controlExposure?: ControlExposure;
  // Dashboard: clicking a box-plot outlier dot opens that supplier's detail panel.
  // Omitted in reports → dots keep their pin-in-editor behaviour.
  onOutlierClick?: (supplierId: string) => void;
}) {
  const d = data.distribution;

  return (
    <>
      {showStatGrid && <CycleStatGrid data={data} embedded={embedded} />}

      {showMonthlyTrend && (
        <Card className={cardElevation}>
          <CardHeader>
            <CardTitle>Monthly Cycle Time Trend</CardTitle>
            <CardDescription>
              Average total procure-to-pay days by month, with a trailing 3-month
              rolling average.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MonthlyCycleTrendChart
              trend={data.monthly_trend}
              rolling={data.rolling_avg_trend}
            />
          </CardContent>
        </Card>
      )}

      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>Cycle Time Distribution</CardTitle>
          <CardDescription>
            Median, typical range, and outliers across all POs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CycleTimeBoxPlot
            distribution={d}
            anomalies={data.anomalies}
            interactive={embedded}
            onOutlierClick={onOutlierClick}
          />
          {showDistributionInsight && <DistributionInsight data={data} />}
        </CardContent>
      </Card>

      {showStageDecomposition && (
        <Card className={cardElevation}>
          <CardHeader>
            <CardTitle>Stage Decomposition</CardTitle>
            <CardDescription>
              Where time is spent across the four procure-to-pay sub-processes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StageDecompositionTable data={data} />
          </CardContent>
        </Card>
      )}

      {controlExposure ? (
        // Dashboard: the consolidated Control Exposure card holds BOTH per-quadrant
        // sub-tables (pass rate + cycle) — no separate standalone cycle card.
        <ThreeWayMatchTable data={data} control={controlExposure} />
      ) : (
        // Reports / range-compute (no control): keep the standalone cycle card
        // beside the bare pass-rate table, unchanged.
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CycleByQuadrantTable data={data} />
          <ThreeWayMatchTable data={data} />
        </div>
      )}

      {showMethodBreakdown && <CycleByMethodTable data={data} />}

      {showAnomaliesTable && (
        <AnomaliesTable
          data={data.anomalies}
          mean={data.distribution.mean ?? 0}
          methodByPo={methodByPo}
        />
      )}
    </>
  );
}
