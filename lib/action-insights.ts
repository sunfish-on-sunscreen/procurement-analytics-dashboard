/**
 * Insight-panel models for Action Priorities — the "View more →" drill-downs.
 *
 * PURE + presentation-only: every panel is DERIVED from data already loaded on the
 * page (recommendations, performance_spend, kraljic, cycle_time, the fetched
 * breakdown, the anomaly hub) plus the server-loaded supplier→category map. No new
 * fetch, no new compute, no numbers changed — same template approach as the page's
 * glance panel. Different data ⇒ different prose.
 *
 * Each panel has three parts: a LEAD sentence (the finding, in prose), the EVIDENCE
 * (3 stats + the FULL-set table — not a top-5), and WHY THIS MATTERS — a
 * cross-analysis line that says something no single number on the page already says.
 * When a panel has no honest cross-analysis to add, `why` is null (a short panel
 * beats a padded one).
 */

import type {
  Recommendation,
  RecommendationCategory,
  RecommendationsNarrative,
  PerformanceSpendResult,
  KraljicResult,
  CycleTimeResult,
  KraljicQuadrant,
  PerformanceZone,
} from "@/lib/analysis-types";
import type { AnomalyHub, DisagreementAxis } from "@/lib/anomaly-crossref";
import type { CycleBreakdown } from "@/lib/cycle-time-types";
import { formatCompactCurrency } from "@/lib/utils";

// A panel is keyed either by a recommendation category (the 8 "Where to act" rows)
// or by an anomaly family (the 3 cross-analysis cards).
export type InsightKey =
  | RecommendationCategory
  | "process"
  | "classification"
  | "temporal";

export type InsightStat = { label: string; value: string; sub?: string };
export type InsightColumn = { label: string; align?: "left" | "right" | "center" };
export type InsightRow = {
  /** Non-null ⇒ the row opens the supplier modal. Null ⇒ a non-supplier row (stage / quadrant). */
  supplierId: string | null;
  cells: string[];
  /** Subtle highlight — e.g. Strategic AND below the performance median. */
  emphasis?: boolean;
  /** Dimmed — e.g. the PO→Delivery stage that is deliberately excluded from the flag. */
  muted?: boolean;
};
export type InsightTable = {
  columns: InsightColumn[];
  rows: InsightRow[];
  caption?: string;
};
export type InsightModel = {
  title: string;
  lead: string;
  stats: InsightStat[];
  table: InsightTable | null;
  why: string | null;
  footer?: { href: string; label: string };
};

export type InsightCtx = {
  recommendations: Recommendation[];
  perf: PerformanceSpendResult | null;
  kraljic: KraljicResult | null;
  cycleTime: CycleTimeResult | null;
  breakdown: CycleBreakdown | undefined;
  hub: AnomalyHub | null;
  narrative: RecommendationsNarrative | undefined;
  supplierCategory: Record<string, string>;
};

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //
const money = formatCompactCurrency;
const pct0 = (x: number) => `${Math.round(x)}%`;
const int = new Intl.NumberFormat("en-US");

type Sup = {
  id: string;
  name: string;
  spend: number;
  perf: number;
  zone: PerformanceZone;
  quadrant: KraljicQuadrant;
  risk: number | null;
  category: string | null;
};

function universe(ctx: InsightCtx): Sup[] {
  const riskById = new Map(
    (ctx.kraljic?.quadrant_assignments ?? []).map((q) => [q.supplier_id, q.supply_risk_score]),
  );
  return (ctx.perf?.suppliers ?? []).map((s) => ({
    id: s.supplier_id,
    name: s.supplier_name,
    spend: s.total_spend_usd,
    perf: s.performance_score,
    zone: s.zone,
    quadrant: s.kraljic_quadrant,
    risk: riskById.get(s.supplier_id) ?? null,
    category: ctx.supplierCategory[s.supplier_id] ?? null,
  }));
}

const totalSpendOf = (ctx: InsightCtx, u: Sup[]) =>
  ctx.narrative?.total_spend ?? u.reduce((a, s) => a + s.spend, 0);

const perfMedianOf = (ctx: InsightCtx) => ctx.perf?.axis_thresholds.performance_median ?? 0;

// --------------------------------------------------------------------------- //
// A. Concentration — the flagship cross-analysis (supplier→category join)
// --------------------------------------------------------------------------- //
function concentration(ctx: InsightCtx): InsightModel | null {
  const u = universe(ctx);
  if (!u.length) return null;
  const total = totalSpendOf(ctx, u);
  const byCat = new Map<string, Sup[]>();
  for (const s of u) {
    if (!s.category) continue;
    const arr = byCat.get(s.category) ?? [];
    arr.push(s);
    byCat.set(s.category, arr);
  }
  const cats = [...byCat.entries()]
    .map(([name, sup]) => ({ name, sup, spend: sup.reduce((a, s) => a + s.spend, 0) }))
    .sort((a, b) => b.spend - a.spend);
  if (!cats.length) return null;
  const top = cats[0];
  const next = cats[1];
  const median = perfMedianOf(ctx);
  const share = total > 0 ? (top.spend / total) * 100 : 0;
  const nextShare = next && total > 0 ? (next.spend / total) * 100 : 0;
  const inCat = [...top.sup].sort((a, b) => b.spend - a.spend);
  const strategicBelow = inCat.filter((s) => s.quadrant === "Strategic" && s.perf < median);
  const strategicAll = inCat.filter((s) => s.quadrant === "Strategic");

  const buffer = next
    ? top.spend >= 2 * next.spend
      ? "There is no meaningful buffer."
      : `${next.name} is the only comparable alternative.`
    : "It stands alone in your portfolio.";
  const lead =
    `${top.name} absorbs ${money(top.spend)} of ${money(total)} — ${pct0(share)} of everything you spend.` +
    (next ? ` The next largest is ${next.name} at ${pct0(nextShare)}.` : "") +
    ` ${buffer}`;

  const stats: InsightStat[] = [
    { label: "Category spend", value: money(top.spend) },
    { label: "Share of total", value: pct0(share) },
    { label: "Suppliers in it", value: `${inCat.length}` },
  ];

  const table: InsightTable = {
    columns: [
      { label: "Supplier" },
      { label: "Spend", align: "right" },
      { label: "Performance", align: "right" },
      { label: "Kraljic quadrant", align: "center" },
    ],
    rows: inCat.map((s) => ({
      supplierId: s.id,
      cells: [s.name, money(s.spend), s.perf.toFixed(0), s.quadrant],
      emphasis: s.quadrant === "Strategic" && s.perf < median,
    })),
    caption: median
      ? `Highlighted: Strategic (hard to replace) and below the ${median.toFixed(0)}-point performance median.`
      : undefined,
  };

  let why: string;
  if (strategicBelow.length > 0) {
    why =
      `${strategicBelow.length} of the ${inCat.length} suppliers here ${strategicBelow.length === 1 ? "is" : "are"} Strategic — hard to replace — and ${strategicBelow.length === 1 ? "scores" : "score"} below the ${median.toFixed(0)}-point performance median. ` +
      `A disruption in this category has no fallback, and the hardest-to-replace suppliers in it are among your weakest performers.`;
  } else if (strategicAll.length > 0) {
    why = `The ${strategicAll.length} Strategic supplier${strategicAll.length === 1 ? "" : "s"} in this category sit at or above the performance median — the concentration is a volume risk, not a performance one.`;
  } else {
    why = `None of the suppliers here are Strategic — the exposure is concentrated spend, but every supplier in the category has alternatives you could turn to.`;
  }

  return {
    title: `Concentration — ${top.name}`,
    lead,
    stats,
    table,
    why,
    footer: { href: "/spend-overview", label: "See the full category breakdown on Spend Overview" },
  };
}

// --------------------------------------------------------------------------- //
// B. Critical spend — the A-tier vital few
// --------------------------------------------------------------------------- //
function criticalSpend(ctx: InsightCtx): InsightModel | null {
  const recs = ctx.recommendations.filter((r) => r.type === "critical_spend");
  if (!recs.length) return null;
  const u = universe(ctx);
  const byId = new Map(u.map((s) => [s.id, s]));
  const total = totalSpendOf(ctx, u);
  const median = perfMedianOf(ctx);
  const combined = recs.reduce((a, r) => a + (r.total_spend_usd ?? 0), 0);
  const share = total > 0 ? (combined / total) * 100 : 0;
  const below = recs.filter((r) => {
    const s = r.supplier_id ? byId.get(r.supplier_id) : undefined;
    return s && s.perf < median;
  });

  const lead = `${recs.length} A-tier suppliers concentrate ${pct0(share)} of your spend — the "vital few" a Pareto split says to manage most closely.`;
  const stats: InsightStat[] = [
    { label: "A-tier suppliers", value: `${recs.length}` },
    { label: "Combined spend", value: money(combined) },
    { label: "Share of total", value: pct0(share) },
  ];
  const table: InsightTable = {
    columns: [
      { label: "Supplier" },
      { label: "Spend", align: "right" },
      { label: "Share", align: "right" },
      { label: "Performance", align: "right" },
    ],
    rows: recs.map((r) => {
      const s = r.supplier_id ? byId.get(r.supplier_id) : undefined;
      return {
        supplierId: r.supplier_id ?? null,
        cells: [
          r.supplier_name ?? "—",
          r.total_spend_usd != null ? money(r.total_spend_usd) : "—",
          r.share_pct != null ? `${r.share_pct.toFixed(1)}%` : "—",
          s ? s.perf.toFixed(0) : "—",
        ],
        emphasis: !!(s && s.perf < median),
      };
    }),
    caption: median ? `Highlighted: below the ${median.toFixed(0)}-point performance median.` : undefined,
  };
  const why =
    below.length > 0
      ? `${below.length} of these ${recs.length} vital-few suppliers score below the ${median.toFixed(0)}-point median — the relationships carrying the most spend are not automatically your best-run ones.`
      : `All ${recs.length} of the vital few score at or above the median — your largest relationships are also among your better performers.`;

  return { title: "Critical spend — the vital few", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// C. Critical issues (high spend × below median) — full zone set, not top-5
// --------------------------------------------------------------------------- //
function criticalIssues(ctx: InsightCtx): InsightModel | null {
  const u = universe(ctx);
  const inZone = u.filter((s) => s.zone === "Critical Issues").sort((a, b) => b.spend - a.spend);
  if (!inZone.length) return null;
  const median = perfMedianOf(ctx);
  const combined = inZone.reduce((a, s) => a + s.spend, 0);
  const strategic = inZone.filter((s) => s.quadrant === "Strategic");

  const lead = `${inZone.length} high-spend suppliers score below the ${median.toFixed(0)}-point performance median — real money going to relationships that under-deliver.`;
  const stats: InsightStat[] = [
    { label: "Underperforming", value: `${inZone.length}` },
    { label: "Combined spend", value: money(combined) },
    { label: "Performance median", value: median.toFixed(1) },
  ];
  const table: InsightTable = {
    columns: [
      { label: "Supplier" },
      { label: "Spend", align: "right" },
      { label: "Performance", align: "right" },
      { label: "Kraljic quadrant", align: "center" },
    ],
    rows: inZone.map((s) => ({
      supplierId: s.id,
      cells: [s.name, money(s.spend), s.perf.toFixed(0), s.quadrant],
      emphasis: s.quadrant === "Strategic",
    })),
    caption: "Highlighted: Strategic — hard to replace as well as underperforming.",
  };
  const why =
    strategic.length > 0
      ? `${strategic.length} of the ${inZone.length} are Strategic — hard to replace AND underperforming, so there's no easy exit. Start there: development, not switching, is the only lever.`
      : `None are Strategic — every underperformer here has alternatives, so you hold the leverage to push for improvement or move the spend.`;

  return { title: "Critical issues — high spend, low performance", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// D. Hidden gems (low spend × above median)
// --------------------------------------------------------------------------- //
function hiddenGems(ctx: InsightCtx): InsightModel | null {
  const u = universe(ctx);
  const inZone = u.filter((s) => s.zone === "Hidden Gems").sort((a, b) => b.perf - a.perf);
  if (!inZone.length) return null;
  const median = perfMedianOf(ctx);
  const combined = inZone.reduce((a, s) => a + s.spend, 0);
  const lowRisk = inZone.filter((s) => s.quadrant === "Leverage" || s.quadrant === "Routine");

  const lead = `${inZone.length} suppliers outperform the ${median.toFixed(0)}-point median but sit on small spend — proven quality you're barely using.`;
  const stats: InsightStat[] = [
    { label: "High performers", value: `${inZone.length}` },
    { label: "Combined spend", value: money(combined) },
    { label: "Avg performance", value: (inZone.reduce((a, s) => a + s.perf, 0) / inZone.length).toFixed(1) },
  ];
  const table: InsightTable = {
    columns: [
      { label: "Supplier" },
      { label: "Performance", align: "right" },
      { label: "Spend", align: "right" },
      { label: "Kraljic quadrant", align: "center" },
    ],
    rows: inZone.map((s) => ({
      supplierId: s.id,
      cells: [s.name, s.perf.toFixed(0), money(s.spend), s.quadrant],
      emphasis: s.quadrant === "Leverage" || s.quadrant === "Routine",
    })),
    caption: "Highlighted: low-risk (Leverage or Routine) — safe to grow.",
  };
  const why =
    lowRisk.length > 0
      ? `${lowRisk.length} of them are low-risk (Leverage or Routine) — safe to consolidate more spend toward, turning a proven performer into a bigger share of wallet without adding supply risk.`
      : `These strong performers are all hard-to-source (Strategic or Bottleneck) — growing them means securing capacity first, not just shifting volume.`;

  return { title: "Hidden gems — high performance, low spend", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// E. Bottleneck risk (Kraljic Bottleneck quadrant)
// --------------------------------------------------------------------------- //
function bottleneckRisk(ctx: InsightCtx): InsightModel | null {
  const u = universe(ctx);
  const inQ = u.filter((s) => s.quadrant === "Bottleneck").sort((a, b) => (b.risk ?? 0) - (a.risk ?? 0));
  if (!inQ.length) return null;
  const combined = inQ.reduce((a, s) => a + s.spend, 0);
  const avgRisk = inQ.reduce((a, s) => a + (s.risk ?? 0), 0) / inQ.length;
  const processFlagged = new Set((ctx.hub?.process.rows ?? []).map((r) => r.supplier_id));
  const alsoFlagged = inQ.filter((s) => processFlagged.has(s.id));

  const lead = `${inQ.length} suppliers carry high supply risk on small spend — hard to replace, easy to overlook.`;
  const stats: InsightStat[] = [
    { label: "Bottleneck suppliers", value: `${inQ.length}` },
    { label: "Combined spend", value: money(combined) },
    { label: "Avg supply risk", value: avgRisk.toFixed(0) },
  ];
  const table: InsightTable = {
    columns: [
      { label: "Supplier" },
      { label: "Spend", align: "right" },
      { label: "Supply risk", align: "right" },
      { label: "Performance", align: "right" },
    ],
    rows: inQ.map((s) => ({
      supplierId: s.id,
      cells: [s.name, money(s.spend), s.risk != null ? s.risk.toFixed(0) : "—", s.perf.toFixed(0)],
      emphasis: processFlagged.has(s.id),
    })),
    caption: "Highlighted: also tripping a process anomaly.",
  };
  const why =
    alsoFlagged.length > 0
      ? `${alsoFlagged.length} of these hard-to-replace suppliers are also tripping a process anomaly — a supplier that's slow or erratic AND that you can't easily swap out is the worst combination on the board.`
      : `None are currently flagged for process anomalies — the risk here is structural (few available sources), not operational, so the fix is qualifying alternates before you need them.`;

  return { title: "Bottleneck risk — few sources, small spend", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// F. Tail spend (derived: suppliers under 1% of total)
// --------------------------------------------------------------------------- //
function tailSpend(ctx: InsightCtx): InsightModel | null {
  const u = universe(ctx);
  if (!u.length) return null;
  const total = totalSpendOf(ctx, u);
  if (total <= 0) return null;
  const tail = u.filter((s) => s.spend / total < 0.01).sort((a, b) => b.spend - a.spend);
  if (!tail.length) return null;
  const tailSpend = tail.reduce((a, s) => a + s.spend, 0);
  const sharePct = (tailSpend / total) * 100;
  const rosterPct = (tail.length / u.length) * 100;
  const bottleneck = tail.filter((s) => s.quadrant === "Bottleneck");

  const lead = `${tail.length} suppliers each under 1% of spend together make up ${pct0(sharePct)} of the money but ${pct0(rosterPct)} of your supplier count — a long administrative tail.`;
  const stats: InsightStat[] = [
    { label: "Tail suppliers", value: `${tail.length}` },
    { label: "Of total spend", value: pct0(sharePct) },
    { label: "Of the roster", value: pct0(rosterPct) },
  ];
  const table: InsightTable = {
    columns: [
      { label: "Supplier" },
      { label: "Spend", align: "right" },
      { label: "Kraljic quadrant", align: "center" },
    ],
    rows: tail.map((s) => ({
      supplierId: s.id,
      cells: [s.name, money(s.spend), s.quadrant],
      emphasis: s.quadrant === "Bottleneck",
    })),
    caption: "Highlighted: Bottleneck — few sources despite tiny spend.",
  };
  const why =
    bottleneck.length > 0
      ? `${bottleneck.length} of the tail are Bottleneck suppliers — tiny spend, but few alternatives, so consolidation can't simply drop them. The long tail is not uniformly disposable.`
      : `None of the tail are hard-to-replace — this is a clean consolidation opportunity with no hidden single-source traps.`;

  return { title: "Tail spend — the long tail", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// G. Slowest stage — all 4 P2P stages, PO→Delivery marked excluded
// --------------------------------------------------------------------------- //
const STAGE_ROWS: { key: keyof CycleTimeResult["stage_breakdown"]; label: string; internal: boolean }[] = [
  { key: "pr_to_po", label: "PR to PO", internal: true },
  { key: "po_to_delivery", label: "PO to Delivery", internal: false },
  { key: "delivery_to_invoice", label: "Delivery to Invoice", internal: true },
  { key: "invoice_to_payment", label: "Invoice to Payment", internal: true },
];

function slowStage(ctx: InsightCtx): InsightModel | null {
  const sb = ctx.cycleTime?.stage_breakdown;
  if (!sb) return null;
  const means = STAGE_ROWS.map((r) => ({ ...r, mean: sb[r.key]?.mean ?? 0 }));
  const internal = means.filter((m) => m.internal);
  const internalSum = internal.reduce((a, m) => a + m.mean, 0) || 1;
  const slowestInternal = internal.reduce((a, b) => (b.mean > a.mean ? b : a), internal[0]);
  const flagged = slowestInternal && slowestInternal.mean > 8;

  // ⚠️ Invoice->Payment is mostly the payment TERM the organisation agreed to, not
  // delay. Without this qualifier the panel points a reader at a target roughly
  // five times bigger than what can actually be acted on. Portfolio-level only —
  // the discretionary lag is a uniform random draw with no supplier, category or
  // period signal (Methodology 9.5, entry 9), so it is never broken down.
  const split = ctx.breakdown?.paymentTermsSplit;
  const splitApplies = flagged && slowestInternal.key === "invoice_to_payment" && split != null;

  const lead = flagged
    ? `${slowestInternal.label} averages ${slowestInternal.mean.toFixed(1)} days — the longest internal stage in your procure-to-pay cycle, above the 8-day flag.` +
      (splitApplies
        ? ` Most of that is contractual, not delay: ${split.contractual_days.toFixed(0)} of the ${split.stage_mean_days.toFixed(0)} days are the agreed payment terms (${split.contractual_pct.toFixed(0)}%), leaving about ${split.discretionary_days.toFixed(0)} days of discretionary lag. Shortening the stage means renegotiating terms, not just working faster.`
        : "")
    : `No internal stage clears the 8-day flag — your procure-to-pay cadence is balanced across the stages you control.`;

  const stats: InsightStat[] = [
    { label: "Slowest internal stage", value: flagged ? slowestInternal.label : "—", sub: flagged ? `${slowestInternal.mean.toFixed(1)}d` : "balanced" },
    { label: "Share of internal cycle", value: flagged ? pct0((slowestInternal.mean / internalSum) * 100) : "—" },
    { label: "8-day flag", value: flagged ? "exceeded" : "clear" },
    ...(splitApplies
      ? [
          {
            label: "Of which addressable",
            value: `${split.discretionary_days.toFixed(1)}d`,
            sub: `${split.contractual_days.toFixed(0)}d is the agreed term`,
          } as InsightStat,
        ]
      : []),
  ];

  const table: InsightTable = {
    columns: [
      { label: "Stage" },
      { label: "Average", align: "right" },
      { label: "Note", align: "left" },
    ],
    rows: means.map((m) => ({
      supplierId: null,
      cells: [
        m.label,
        `${m.mean.toFixed(1)}d`,
        !m.internal
          ? "excluded — physical lead time"
          : flagged && m.key === slowestInternal.key
            ? splitApplies
              ? `slowest internal stage — ${split.contractual_days.toFixed(0)}d contractual, ${split.discretionary_days.toFixed(0)}d discretionary`
              : "slowest internal stage"
            : m.mean > 8
              ? "above 8-day flag"
              : "",
      ],
      muted: !m.internal,
      emphasis: flagged && m.internal && m.key === slowestInternal.key,
    })),
    caption: "PO→Delivery is the physical supplier lead time — deliberately excluded from the internal-stage flag.",
  };

  // ⚠️ The old wording here claimed this stage was "fully within your control to
  // fix". For Invoice->Payment that is false: ~80% of it is the contractual term.
  const why = splitApplies
    ? `PO→Delivery, the physical wait for goods, is excluded from the flag because it isn't yours to shorten. But Invoice→Payment is not fully yours either: ${split.contractual_pct.toFixed(0)}% of it is the payment term already agreed with the supplier. The genuinely discretionary part is about ${split.discretionary_days.toFixed(0)} days, so treating the full ${split.stage_mean_days.toFixed(0)} days as recoverable process waste overstates the opportunity roughly ${(split.stage_mean_days / Math.max(split.discretionary_days, 0.1)).toFixed(0)}-fold. Paying earlier than terms is a working-capital decision, not a process fix.`
    : `This is time inside your own accounts-payable process, not supplier lead time — largely within your control. PO→Delivery, the physical wait for goods, is excluded from the flag for exactly that reason: it isn't yours to shorten.`;

  return { title: "Slowest stage — where the cycle drags", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// H. Process improvement — 3-way-match compliance by quadrant
// --------------------------------------------------------------------------- //
const QUADRANT_ORDER: KraljicQuadrant[] = ["Strategic", "Leverage", "Bottleneck", "Routine"];

function worstFraming(worst: KraljicQuadrant): string {
  switch (worst) {
    case "Leverage":
      return `The weakest compliance is in Leverage — your highest-spend, lowest-risk, easiest relationships, the ones with plenty of alternatives and no hold over you. If documentation discipline is slipping on your easiest relationships, it's slipping everywhere.`;
    case "Strategic":
      return `The weakest compliance is in Strategic — your highest-stakes, hardest-to-replace relationships, where a missing paper trail is most dangerous and least excusable.`;
    case "Bottleneck":
      return `The weakest compliance is in Bottleneck — hard-to-replace suppliers where you already hold the least leverage to enforce process, so the control gap compounds an existing weakness.`;
    default:
      return `The weakest compliance is in Routine — low-stakes buys, but a clear signal that the three-way-match control isn't being applied consistently across the portfolio.`;
  }
}

function processImprovement(ctx: InsightCtx): InsightModel | null {
  const tw = ctx.cycleTime?.three_way_match_by_quadrant;
  if (!tw) return null;
  const ce = ctx.breakdown?.controlExposure;
  const rows = QUADRANT_ORDER.map((q) => ({ q, ...tw[q] })).filter((r) => r.n > 0);
  if (!rows.length) return null;
  const worst = rows.find((r) => r.is_worst) ?? rows.reduce((a, b) => ((b.pass_rate_pct ?? 100) < (a.pass_rate_pct ?? 100) ? b : a), rows[0]);

  const lead = ce
    ? `Roughly ${pct0(ce.pct_at_risk)} of POs fail the three-way match — ${money(ce.failed_spend)} of spend flowing without a clean paperwork trail.`
    : `The three-way-match control is failing hardest in the ${worst.q} quadrant.`;

  const stats: InsightStat[] = ce
    ? [
        { label: "POs at risk", value: pct0(ce.pct_at_risk), sub: `${int.format(ce.n_failed)} of ${int.format(ce.n_total)}` },
        { label: "Spend at risk", value: money(ce.failed_spend) },
        { label: "Suppliers involved", value: `${ce.n_failing_suppliers}`, sub: `of ${ce.n_total_suppliers} active` },
      ]
    : [{ label: "Worst quadrant", value: worst.q }];

  const table: InsightTable = {
    columns: [
      { label: "Quadrant" },
      { label: "POs", align: "right" },
      { label: "Pass rate", align: "right" },
      { label: "", align: "left" },
    ],
    rows: rows.map((r) => ({
      supplierId: null,
      cells: [r.q, int.format(r.n), r.pass_rate_pct != null ? `${r.pass_rate_pct.toFixed(1)}%` : "—", r.is_worst ? "weakest" : ""],
      emphasis: r.is_worst,
    })),
  };

  const why = worstFraming(worst.q);
  return { title: "Process improvement — three-way-match control", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// I. Process anomaly family
// --------------------------------------------------------------------------- //
function flagsText(f: { has_outlier: boolean; inconsistent: boolean; has_stage_dom: boolean }): string {
  const out: string[] = [];
  if (f.has_outlier) out.push("Outlier");
  if (f.inconsistent) out.push("Inconsistent");
  if (f.has_stage_dom) out.push("Stage-dom");
  return out.join(" · ") || "—";
}

function processFamily(ctx: InsightCtx): InsightModel | null {
  const p = ctx.hub?.process;
  if (!p || p.flaggedCount === 0) return null;
  const rows = p.rows;
  const important = rows.filter((r) => r.important);

  const lead = `${p.flaggedCount} suppliers trip at least one cycle-time anomaly — a slow, erratic, or single-stage-dominated procure-to-pay run.`;
  const stats: InsightStat[] = [
    { label: "Flagged suppliers", value: `${p.flaggedCount}` },
    { label: "On important relationships", value: `${important.length}` },
    { label: "Anomaly spend", value: money(p.importantSpend) },
  ];
  const table: InsightTable = {
    columns: [
      { label: "Supplier" },
      { label: "Anomalies" },
      { label: "ABC", align: "center" },
      { label: "Kraljic quadrant", align: "center" },
      { label: "Spend", align: "right" },
    ],
    rows: rows.map((r) => ({
      supplierId: r.supplier_id,
      cells: [
        r.supplier_name,
        flagsText(r.flags),
        r.abc_class ?? "—",
        r.kraljic_quadrant ?? "—",
        r.total_spend_usd != null ? money(r.total_spend_usd) : "—",
      ],
      emphasis: r.important,
    })),
    caption: "Highlighted: A-tier or Strategic — an anomaly you can least afford.",
  };
  const why =
    important.length > 0
      ? `${important.length} of the ${p.flaggedCount} land on important relationships (A-tier or Strategic), carrying ${money(p.importantSpend)} — the process noise clusters where a delay costs you the most, not on your incidental buys.`
      : `None sit on important relationships — the process noise is confined to low-stakes suppliers, which is the good version of this problem.`;

  return { title: "Process anomalies — cycle-time flags", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// J. Lens-disagreement family
// --------------------------------------------------------------------------- //
function axisHigh(a: DisagreementAxis): string {
  return a === "spend"
    ? "among your largest by spend"
    : a === "performance"
      ? "as a top performer"
      : "as one of your most exposed to source (high supply risk)";
}
function axisLow(a: DisagreementAxis): string {
  return a === "spend"
    ? "sits among your smallest by spend"
    : a === "performance"
      ? "scores near the bottom on performance"
      : "looks easy to replace (low supply risk)";
}

function lensFamily(ctx: InsightCtx): InsightModel | null {
  const c = ctx.hub?.classification;
  if (!c || c.flaggedCount === 0) return null;
  const rows = c.rows;
  const top = rows[0];

  const lead = `${c.flaggedCount} suppliers rank in sharply different places depending on which lens you look through — spend, performance, or supply risk.`;
  const stats: InsightStat[] = [
    { label: "Flagged suppliers", value: `${c.flaggedCount}` },
    { label: "Widest gap", value: `${Math.round(top.disagreement)} pts` },
    { label: "Across a roster of", value: `${c.rosterSize}` },
  ];
  const table: InsightTable = {
    columns: [
      { label: "Supplier" },
      { label: "Spend", align: "right" },
      { label: "Perf.", align: "right" },
      { label: "Risk", align: "right" },
      { label: "The contradiction" },
    ],
    rows: rows.map((r) => ({
      supplierId: r.supplier_id,
      cells: [
        r.supplier_name,
        `${r.spend_pct}`,
        `${r.performance_pct}`,
        `${r.risk_pct}`,
        r.verdict,
      ],
      emphasis: r.important,
    })),
    caption: "Percentiles (0–100) across the active roster; the widest gaps sit at the top.",
  };
  const why = `No single view reveals this. ${top.supplier_name} ranks ${axisHigh(top.max_axis)}, yet ${axisLow(top.min_axis)} — a ${Math.round(top.disagreement)}-point gap. Spend Overview alone would tell you to ignore them; Kraljic alone would raise the alarm. Only the contradiction, holding both lenses at once, catches it.`;

  return { title: "Lens disagreement — the same supplier, three verdicts", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// K. Changed-over-time family
// --------------------------------------------------------------------------- //
function temporalMove(r: { spend: { pct: number } | null; quadrant: { from: KraljicQuadrant; to: KraljicQuadrant } | null; score: { delta: number } | null }): string {
  if (r.quadrant) return `moved ${r.quadrant.from} → ${r.quadrant.to}`;
  if (r.spend) return `spend ${r.spend.pct > 0 ? "+" : ""}${r.spend.pct}%`;
  if (r.score) return `performance ${r.score.delta > 0 ? "+" : ""}${r.score.delta} pts`;
  return "shifted";
}

function temporalFamily(ctx: InsightCtx): InsightModel | null {
  const t = ctx.hub?.temporal;
  if (!t || t.flaggedCount === 0) return null;
  const rows = t.rows;
  const top = rows[0];

  const lead = `${t.flaggedCount} suppliers moved sharply from ${t.priorLabel} to ${t.latestLabel} — in how much you buy, how hard they are to replace, or how well they perform.`;
  const stats: InsightStat[] = [
    { label: "Suppliers moved", value: `${t.flaggedCount}` },
    { label: "Quadrant jumps", value: `${t.byDetector.quadrant}`, sub: `${t.byDetector.spend} spend · ${t.byDetector.score} score` },
    { label: "Comparable roster", value: `${t.rosterSize}` },
  ];
  const table: InsightTable = {
    columns: [
      { label: "Supplier" },
      { label: "Spend Δ", align: "right" },
      { label: "Exposure move" },
      { label: "Perf. Δ", align: "right" },
    ],
    rows: rows.map((r) => ({
      supplierId: r.supplier_id,
      cells: [
        r.supplier_name,
        r.spend ? `${r.spend.pct > 0 ? "+" : ""}${r.spend.pct}%` : "—",
        r.quadrant ? `${r.quadrant.from} → ${r.quadrant.to}` : "—",
        r.score ? `${r.score.delta > 0 ? "+" : ""}${r.score.delta}` : "—",
      ],
      emphasis: r.important,
    })),
  };
  const why = `The sharpest move is ${top.supplier_name}: ${temporalMove(top)}. Drift like this is invisible in any single-period snapshot — it only appears when you set ${t.priorLabel} against ${t.latestLabel}, which is the one thing every other card on this page can't do.`;

  return { title: "Changed over time — year-over-year moves", lead, stats, table, why };
}

// --------------------------------------------------------------------------- //
// dispatcher
// --------------------------------------------------------------------------- //
export function buildInsight(key: InsightKey, ctx: InsightCtx): InsightModel | null {
  switch (key) {
    case "concentration":
      return concentration(ctx);
    case "critical_spend":
      return criticalSpend(ctx);
    case "critical_issues_engagement":
      return criticalIssues(ctx);
    case "hidden_gems_promotion":
      return hiddenGems(ctx);
    case "bottleneck_risk":
      return bottleneckRisk(ctx);
    case "tail_spend":
      return tailSpend(ctx);
    case "slow_stage":
      return slowStage(ctx);
    case "process_improvement":
      return processImprovement(ctx);
    case "process":
      return processFamily(ctx);
    case "classification":
      return lensFamily(ctx);
    case "temporal":
      return temporalFamily(ctx);
    default:
      return null;
  }
}
