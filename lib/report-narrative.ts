import type {
  SpendOverviewResult,
  AbcResult,
  KraljicResult,
  CycleTimeResult,
  PerformanceSpendResult,
  RecommendationsResult,
  RecommendationAction,
  KraljicQuadrant,
  PerformanceZone,
} from "@/lib/analysis-types";
import type { CycleBreakdown } from "@/lib/cycle-time-types";
import type { TemporalLoad, TemporalAnomalies } from "@/lib/temporal-anomalies";
import type { ReportTone } from "@/lib/report-config";
import type {
  SupplierFocusData,
  FocusItem,
  FocusTrajectoryPoint,
} from "@/lib/report-focus-types";
import type { GeneratedBriefProse } from "@/lib/report-llm-types";
import { deriveCycleFlags } from "@/lib/cycle-flags";
import {
  buildAnomalyCrossref,
  buildClassificationAnomalies,
  type ClassificationAnomalyRow,
  type AnomalyCrossref,
} from "@/lib/anomaly-crossref";
import { buildTemporalAnomalies } from "@/lib/temporal-anomalies";

/**
 * The report ARGUMENT (2026-07-13 rewrite). Turns the same six analyses (+ the
 * anomaly-hub breakdown/temporal) the report already has into a decision-first
 * narrative: a computed HEADLINE (the top finding, not a fact), a SITUATION that
 * surfaces the cross-analysis joins the app computes and the old report threw away
 * (Class-A ∩ Strategic, high-spend ∩ underperforming), the top-3 DERIVED findings
 * (ranked by exposure), a prioritised ACTION table, and plain-language WORTH-WATCHING
 * moves. PURE + tone-aware — no recompute, so the numbers are identical to the
 * analyses; the three tones are prose registers over one shared fact model.
 */

// ---- input (structurally the report's ReportAnalyses) --------------------- #
export type ArgumentInput = {
  spend_overview: SpendOverviewResult | null;
  abc: AbcResult | null;
  kraljic: KraljicResult | null;
  cycle_time: CycleTimeResult | null;
  performance_spend: PerformanceSpendResult | null;
  recommendations: RecommendationsResult | null;
  breakdown?: CycleBreakdown | null;
  temporal?: TemporalLoad | null;
};

export type EvidenceStat = { label: string; value: string };
export type ActionRow = {
  priority: 1 | 2 | 3;
  action: string;
  amount: number | null;
  rationale: string;
};
export type RenderedFinding = {
  key: string;
  headline: string;
  body: string[];
  evidence: EvidenceStat[];
  recommendation: string;
  amount: number | null;
};
export type RenderedArgument = {
  headline: string;
  situation: string[];
  findings: RenderedFinding[];
  actions: ActionRow[];
  watching: { intro: string | null; items: string[] };
  /** Readable lens-disagreement rows for the appendix (no raw S/P/R codes). */
  lensRows: { supplier_name: string; verdict: string; spend: number | null }[];
  hasArgument: boolean;
};

// ---- formatting helpers --------------------------------------------------- #
const usdM = (n: number) => `$${(n / 1_000_000).toFixed(1)}M`;
const pct0 = (n: number) => `${Math.round(n)}%`;
// A spend SHARE that never rounds a real (non-zero) fraction down to "0%" — the
// long tail of small suppliers is genuinely <1%, not 0%.
const sharePct = (n: number) => (n > 0 && n < 1 ? "<1%" : pct0(n));
const intl = new Intl.NumberFormat("en-US");
const firstSentence = (s: string) => {
  const i = s.indexOf(". ");
  return i === -1 ? s : s.slice(0, i + 1);
};
const ACTION_VERB: Record<RecommendationAction, string> = {
  promote: "Promote",
  engage: "Engage",
  mitigate: "Mitigate risk for",
  improve: "Improve",
  diversify: "Diversify",
  steward: "Steward",
  consolidate: "Consolidate",
  streamline: "Streamline",
};
const andList = (xs: string[]) =>
  xs.length <= 1
    ? (xs[0] ?? "")
    : xs.length === 2
      ? `${xs[0]} and ${xs[1]}`
      : `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Percentile (0–100) → plain-English bucket for the lens-disagreement prose. */
function pctBucket(p: number): string {
  if (p <= 15) return "bottom-decile";
  if (p <= 35) return "low";
  if (p <= 65) return "mid-range";
  if (p <= 85) return "high";
  return "top-decile";
}

/** "S 0 · P 43 · R 96 · gap 96" → readable prose. */
export function lensVerdict(row: ClassificationAnomalyRow, isTop: boolean): string {
  return `${cap(pctBucket(row.spend_pct))} spend, ${pctBucket(
    row.performance_pct,
  )} performance, ${pctBucket(row.risk_pct)} supply risk — ${
    isTop ? "the widest" : "a wide"
  } lens disagreement in the roster`;
}

// ---- the shared FACT model ------------------------------------------------ #
type Finding =
  | {
      key: "critical_issues";
      score: number;
      n: number;
      spendPct: number;
      spend: number;
      leaders: { name: string; spend: number }[];
      perfMedian: number;
    }
  | {
      key: "concentration";
      score: number;
      category: string;
      pct: number;
      spend: number;
      cat2: string;
      cat2Pct: number;
    }
  | {
      key: "cycle_constraint";
      score: number;
      stage: string;
      mean: number;
      sharePct: number;
      cycleMedian: number;
    }
  | {
      key: "control_weakness";
      score: number;
      failedSpend: number;
      pctAtRisk: number;
      nFailed: number;
      nSuppliers: number;
    }
  | {
      key: "temporal_move";
      score: number;
      supplier: string;
      spendPct: number | null;
      quadFrom: string | null;
      quadTo: string | null;
      spend: number | null;
    }
  | {
      key: "lens_disagreement";
      score: number;
      supplier: string;
      verdict: string;
      spend: number | null;
    };

const STAGE_LABELS: Record<string, string> = {
  pr_to_po: "PR to PO",
  po_to_delivery: "PO to Delivery",
  delivery_to_invoice: "Delivery to Invoice",
  invoice_to_payment: "Invoice to Payment",
};
// Internal P2P stages the org controls (PO→Delivery is physical lead time).
const INTERNAL_STAGES = ["pr_to_po", "delivery_to_invoice", "invoice_to_payment"];
const STAGE_FLAG_DAYS = 8;

type SituationFacts = {
  totalSpend: number;
  totalPos: number;
  activeSuppliers: number;
  cat1: string;
  cat1Pct: number;
  classAN: number;
  classASpendPct: number;
  stratN: number;
  aAndStrategicN: number;
  aAndStrategicSpend: number;
  criticalN: number;
  criticalSpend: number;
  criticalSpendPct: number;
  aAndCriticalN: number;
  aAndCriticalSpend: number;
  criticalLeaders: { name: string; spend: number }[];
  perfMedian: number;
};

function buildFacts(input: ArgumentInput): {
  situation: SituationFacts;
  findings: Finding[];
  temporal: TemporalAnomalies | null;
  proc: AnomalyCrossref | null;
  lensRowsAll: ClassificationAnomalyRow[];
} {
  const so = input.spend_overview;
  const perf = input.performance_spend;
  const abc = input.abc;
  const kr = input.kraljic;
  const ct = input.cycle_time;

  const totalSpend = so?.total_spend ?? 0;
  const cats = [...(so?.by_category ?? [])].sort((a, b) => b.total - a.total);
  const catGrand = cats.reduce((s, c) => s + c.total, 0) || totalSpend || 1;
  const cat1 = cats[0];
  const cat2 = cats[1];

  // ---- per-supplier joins (the cross-analysis the old report discarded) ---- #
  const perfSuppliers = perf?.suppliers ?? [];
  const spendById = new Map(perfSuppliers.map((s) => [s.supplier_id, s.total_spend_usd]));
  const classAIds = new Set(
    (abc?.classifications ?? []).filter((c) => c.abc_class === "A").map((c) => c.supplier_id),
  );
  const strategicIds = new Set(
    (kr?.quadrant_assignments ?? [])
      .filter((q) => q.quadrant === "Strategic")
      .map((q) => q.supplier_id),
  );
  const criticalSuppliers = perfSuppliers.filter((s) => s.zone === "Critical Issues");
  const criticalIds = new Set(criticalSuppliers.map((s) => s.supplier_id));

  const inter = (a: Set<string>, b: Set<string>) => [...a].filter((id) => b.has(id));
  const aAndStrategic = inter(classAIds, strategicIds);
  const aAndCritical = inter(classAIds, criticalIds);
  const sumSpend = (ids: string[]) => ids.reduce((s, id) => s + (spendById.get(id) ?? 0), 0);

  const criticalZone = perf?.zone_profiles.find((z) => z.zone === "Critical Issues");
  const criticalSpend = criticalZone?.total_spend_usd ?? 0;
  const criticalSpendPct = criticalZone?.pct_of_total_spend ?? 0;
  const criticalLeaders = (perf?.top_critical_issues ?? [])
    .slice(0, 2)
    .map((s) => ({ name: s.supplier_name, spend: s.total_spend_usd }));
  const perfMedian = perf?.axis_thresholds.performance_median ?? 0;

  const situation: SituationFacts = {
    totalSpend,
    totalPos: so?.total_pos ?? 0,
    activeSuppliers: so?.active_suppliers ?? 0,
    cat1: cat1?.category ?? "—",
    cat1Pct: cat1 ? (cat1.total / catGrand) * 100 : 0,
    classAN: abc?.summary.A.n ?? 0,
    classASpendPct: (abc?.summary.A.pct_of_spend ?? 0) * 100,
    stratN: strategicIds.size,
    aAndStrategicN: aAndStrategic.length,
    aAndStrategicSpend: sumSpend(aAndStrategic),
    criticalN: criticalSuppliers.length,
    criticalSpend,
    criticalSpendPct,
    aAndCriticalN: aAndCritical.length,
    aAndCriticalSpend: sumSpend(aAndCritical),
    criticalLeaders,
    perfMedian,
  };

  // ---- anomaly families (reuse the pure hub builders) ---------------------- #
  let proc: AnomalyCrossref | null = null;
  if (input.breakdown && perf) {
    proc = buildAnomalyCrossref({
      flagsBySupplier: deriveCycleFlags({
        roster: input.breakdown.bySupplier,
        anomalies: ct?.anomalies ?? [],
        stageAnomalies: input.breakdown.stageAnomalies ?? [],
      }).flagsBySupplier,
      perfSuppliers,
      roster: input.breakdown.bySupplier,
    });
  }
  const lensRowsAll =
    perf && kr && abc
      ? buildClassificationAnomalies({
          perfSuppliers,
          supplyRiskById: new Map(
            kr.quadrant_assignments.map((q) => [q.supplier_id, q.supply_risk_score]),
          ),
          abcById: new Map(abc.classifications.map((c) => [c.supplier_id, c.abc_class])),
        }).rows
      : [];
  const temporal =
    input.temporal?.kind === "ok" ? buildTemporalAnomalies(input.temporal.matrix) : null;

  // ---- candidate findings, each scored to RANK by insight × exposure ------- #
  // The cross-analysis join (critical_issues = high-spend ∩ underperforming) is the
  // higher-order INSIGHT this app exists to surface, so it anchors the lead with a
  // base of 1.0 + its $-exposure. Raw category concentration and the cycle
  // constraint are CONTEXT — capped below 1.0 so they support, not lead. A control
  // failure or a temporal move can still outlead, but only when its exposure is
  // genuinely large (×4 ⇒ it needs ~>33% of spend to beat the cross-analysis) — the
  // "bigger story" override.
  const findings: Finding[] = [];
  const asFraction = (n: number) => (totalSpend ? n / totalSpend : 0);

  if (situation.criticalN > 0) {
    findings.push({
      key: "critical_issues",
      score: 1 + asFraction(criticalSpend),
      n: situation.criticalN,
      spendPct: criticalSpendPct,
      spend: criticalSpend,
      leaders: criticalLeaders,
      perfMedian,
    });
  }
  if (situation.cat1Pct >= 30 && cat1) {
    findings.push({
      key: "concentration",
      score: 0.5 + (situation.cat1Pct / 100) * 0.3,
      category: situation.cat1,
      pct: situation.cat1Pct,
      spend: cat1.total,
      cat2: cat2?.category ?? "—",
      cat2Pct: cat2 ? (cat2.total / catGrand) * 100 : 0,
    });
  }
  const stages = ct?.stage_breakdown;
  if (stages) {
    const means = INTERNAL_STAGES.map((k) => ({
      key: k,
      mean: (stages as Record<string, { mean: number | null }>)[k]?.mean ?? 0,
    }));
    const allMeans = (Object.values(stages) as { mean: number | null }[]).reduce(
      (s, v) => s + (v.mean ?? 0),
      0,
    );
    const slowest = [...means].sort((a, b) => b.mean - a.mean)[0];
    if (slowest && slowest.mean > STAGE_FLAG_DAYS) {
      findings.push({
        key: "cycle_constraint",
        score: 0.4 + (allMeans ? slowest.mean / allMeans : 0) * 0.3,
        stage: STAGE_LABELS[slowest.key] ?? slowest.key,
        mean: slowest.mean,
        sharePct: allMeans ? (slowest.mean / allMeans) * 100 : 0,
        cycleMedian: ct?.distribution.median ?? 0,
      });
    }
  }
  const control = input.breakdown?.controlExposure;
  if (control && control.n_failed > 0 && control.pct_at_risk >= 5) {
    findings.push({
      key: "control_weakness",
      score: asFraction(control.failed_spend) * 4,
      failedSpend: control.failed_spend,
      pctAtRisk: control.pct_at_risk,
      nFailed: control.n_failed,
      nSuppliers: control.n_failing_suppliers,
    });
  }
  if (temporal && temporal.rows.length > 0) {
    const t = temporal.rows[0];
    findings.push({
      key: "temporal_move",
      score: asFraction(t.total_spend_usd ?? 0) * 4,
      supplier: t.supplier_name,
      spendPct: t.spend?.pct ?? null,
      quadFrom: t.quadrant?.from ?? null,
      quadTo: t.quadrant?.to ?? null,
      spend: t.total_spend_usd,
    });
  }
  if (lensRowsAll.length > 0) {
    const l = lensRowsAll[0];
    findings.push({
      key: "lens_disagreement",
      score: asFraction(l.total_spend_usd) * 0.5,
      supplier: l.supplier_name,
      verdict: lensVerdict(l, true),
      spend: l.total_spend_usd,
    });
  }

  findings.sort((a, b) => b.score - a.score);
  return { situation, findings: findings.slice(0, 3), temporal, proc, lensRowsAll };
}

// ---- prose renderers (tone registers over the shared facts) --------------- #
function headlineText(f: Finding | undefined, s: SituationFacts, tone: ReportTone): string {
  if (!f) {
    return `You spent ${usdM(s.totalSpend)} with ${intl.format(
      s.activeSuppliers,
    )} suppliers, with no single exposure standing out — the portfolio is broadly balanced this period.`;
  }
  // Concentration rides as a SUPPORTING clause behind the lead finding.
  const conc =
    s.cat1Pct >= 40
      ? ` And there is little fallback: ${pct0(s.cat1Pct)} of spend sits in ${s.cat1}.`
      : "";
  switch (f.key) {
    case "critical_issues": {
      // executive: terse, no names, decision-only.
      if (tone === "executive") {
        return `The suppliers you depend on most are the ones performing worst — ${f.n} high-spend suppliers, ${pct0(
          f.spendPct,
        )} of spend, below the performance median.${conc}`;
      }
      const led = f.leaders.length
        ? `, led by ${andList(f.leaders.map((l) => `${l.name} (${usdM(l.spend)})`))}`
        : "";
      // analytical: name the quadrant + the method.
      if (tone === "analytical") {
        return `The high-spend / below-median-performance quadrant holds ${f.n} suppliers carrying ${pct0(
          f.spendPct,
        )} of spend (${usdM(
          f.spend,
        )})${led}: the concentration you depend on and the performance problem are the same set.${conc}`;
      }
      // operational: named, tactical.
      return `The suppliers you depend on most are the ones performing worst: ${f.n} high-spend suppliers carrying ${pct0(
        f.spendPct,
      )} of spend sit below the performance median${led}.${conc}`;
    }
    case "concentration":
      return tone === "executive"
        ? `Spend is concentrated in one category — ${f.category} is ${pct0(
            f.pct,
          )} of outlay — leaving the organisation exposed to a single market.`
        : `Your spend is concentrated in one category — ${f.category} is ${pct0(
            f.pct,
          )} of outlay (${usdM(f.spend)}), with ${f.cat2} a distant second at ${pct0(
            f.cat2Pct,
          )}. A shock in that market has no fallback.`;
    case "cycle_constraint":
      return tone === "executive"
        ? `Working capital is trapped in one process stage: ${f.stage} runs ${f.mean.toFixed(
            0,
          )} days, ${pct0(f.sharePct)} of the procure-to-pay cycle.`
        : `Working capital is stuck in ${f.stage}: it averages ${f.mean.toFixed(
            0,
          )} days — ${pct0(
            f.sharePct,
          )} of the cycle and the binding constraint on cash. It is an internal stage, fixable without touching a supplier.`;
    case "control_weakness":
      return `${usdM(f.failedSpend)} of spend (${pct0(
        f.pctAtRisk,
      )}) cleared payment without a complete three-way match${
        tone === "executive" ? "" : ` — a control gap spread across ${f.nSuppliers} suppliers`
      }.`;
    case "temporal_move":
      return `A dependency is forming quietly: ${
        tone === "executive" ? "a fast-growing supplier" : f.supplier
      }${
        f.spendPct != null ? ` grew ${f.spendPct > 0 ? "+" : ""}${f.spendPct}% year-on-year` : ""
      }${f.quadFrom && f.quadTo ? ` and moved ${f.quadFrom}→${f.quadTo}` : ""}.`;
    case "lens_disagreement":
      return `${
        tone === "executive" ? "One supplier" : f.supplier
      } is the roster's sharpest contradiction — ${f.verdict.toLowerCase()}.`;
  }
}

function situationParagraphs(s: SituationFacts, tone: ReportTone): string[] {
  const paras: string[] = [];
  // ¶1 — scale + concentration.
  paras.push(
    `Across ${s.totalPos ? `${intl.format(s.totalPos)} purchase orders ` : ""}${
      tone === "executive" ? "" : "in this period "
    }you spent ${usdM(s.totalSpend)} with ${intl.format(
      s.activeSuppliers,
    )} suppliers. Spend is led by ${s.cat1} at ${pct0(s.cat1Pct)} of outlay${
      s.cat1Pct >= 40 ? " — a pronounced single-category dependency" : ""
    }.`,
  );
  // ¶2 — THE CROSS-ANALYSIS JOIN (the whole point).
  if (s.classAN > 0) {
    const strat =
      s.aAndStrategicN > 0
        ? `${s.aAndStrategicN} of them are also Strategic — high-value and hard to replace`
        : `none of them sit in the Strategic quadrant`;
    if (s.aAndCriticalN > 0) {
      const method =
        tone === "analytical"
          ? ` (below the ${s.perfMedian.toFixed(0)}-point performance median)`
          : "";
      paras.push(
        `The suppliers you depend on most and the suppliers performing worst are largely the same set. Of the ${s.classAN} Class-A suppliers that carry ${pct0(
          s.classASpendPct,
        )} of spend, ${strat}; more pointedly, ${s.aAndCriticalN} are underperforming${method} — ${usdM(
          s.aAndCriticalSpend,
        )} of your most important spend is going to suppliers delivering below the median. Concentration and the performance problem are not two issues; they are one.`,
      );
    } else {
      paras.push(
        `Of the ${s.classAN} Class-A suppliers that carry ${pct0(
          s.classASpendPct,
        )} of spend, ${strat}. Encouragingly, none of your highest-value relationships fall into the underperforming (Critical Issues) zone — the concentration is not compounded by a performance problem.`,
      );
    }
  }
  // ¶3 — where the value-at-risk sits (Critical Issues zone), if any.
  if (s.criticalN > 0) {
    const led =
      tone !== "executive" && s.criticalLeaders.length
        ? ` The largest are ${andList(
            s.criticalLeaders.map((l) => `${l.name} (${usdM(l.spend)})`),
          )}.`
        : "";
    paras.push(
      `In total, ${s.criticalN} high-spend suppliers — ${pct0(
        s.criticalSpendPct,
      )} of spend — are underperforming relative to what they are paid, the portfolio's clearest value-at-risk.${led}`,
    );
  }
  return paras;
}

function findingHeadline(f: Finding, s: SituationFacts, tone: ReportTone): string {
  return headlineText(f, s, tone);
}

function findingBody(f: Finding, tone: ReportTone): string[] {
  const exec = tone === "executive";
  const method = tone === "analytical";
  switch (f.key) {
    case "critical_issues":
      return [
        exec
          ? `Committed spend delivering below par. Because the money is already flowing, a performance conversation with this group moves more than any sourcing exercise.`
          : `These suppliers sit in the high-spend, below-median-performance quadrant: you are paying premium volumes for sub-par delivery, quality, or process compliance. Because the spend is already committed, the exposure is immediate — this is where a performance conversation moves the most money.${
              method
                ? ` The quadrant is the spend-median × performance-median split; membership is data-driven, not a watchlist.`
                : ""
            }`,
      ];
    case "concentration":
      return [
        exec
          ? `A single category at ${pct0(
              f.pct,
            )} of spend concentrates price, continuity, and supply-shock risk with no substitute market.`
          : `A single category at ${pct0(
              f.pct,
            )} of spend means a disruption, price move, or supply shock in ${f.category} flows straight to the bottom line, with limited ability to substitute. ${f.cat2} is the next-largest at ${pct0(
              f.cat2Pct,
            )} — there is no second market absorbing the risk.`,
      ];
    case "cycle_constraint":
      return [
        exec
          ? `${f.stage} is the binding constraint on cash — an internal stage, improvable without touching a supplier.`
          : `At a median cycle of ${f.cycleMedian.toFixed(
              0,
            )} days, ${f.stage} alone consumes ${pct0(
              f.sharePct,
            )} of the elapsed time. It is an internal, controllable stage — improving it shortens the whole cycle and frees working capital without touching a single supplier relationship.${
              method
                ? ` "Internal" excludes PO→Delivery (physical lead time); the flag is a stage mean above ${STAGE_FLAG_DAYS} days.`
                : ""
            }`,
      ];
    case "control_weakness":
      return [
        exec
          ? `${usdM(
              f.failedSpend,
            )} paid without a complete three-way match — a governance gap, not a rounding error.`
          : `A failed three-way match means goods, order, and invoice did not reconcile before payment left — the classic opening for overpayment and duplicate billing. At ${usdM(
              f.failedSpend,
            )} across ${f.nSuppliers} suppliers, this is a governance gap, not a rounding error.`,
      ];
    case "temporal_move":
      return [
        `${exec ? "A supplier" : f.supplier} moved sharply year-on-year${
          f.spendPct != null ? ` on spend (${f.spendPct > 0 ? "+" : ""}${f.spendPct}%)` : ""
        }${
          f.quadFrom && f.quadTo ? ` and changed exposure quadrant (${f.quadFrom}→${f.quadTo})` : ""
        }. Fast movers are where dependencies form before anyone has decided to depend on them — worth a look while the relationship is still small enough to shape.`,
      ];
    case "lens_disagreement":
      return [
        `${exec ? "This supplier" : f.supplier} ranks at opposite ends of the roster depending on the lens — ${f.verdict.toLowerCase()}. A supplier that looks safe on one axis and dangerous on another rewards a closer look than any single score would suggest.`,
      ];
  }
}

function findingEvidence(f: Finding): EvidenceStat[] {
  switch (f.key) {
    case "critical_issues":
      return [
        { label: "Underperforming high-spend suppliers", value: `${f.n}` },
        { label: "Share of spend at risk", value: sharePct(f.spendPct) },
        {
          label: "Largest exposure",
          value: f.leaders[0] ? `${f.leaders[0].name} · ${usdM(f.leaders[0].spend)}` : "—",
        },
      ];
    case "concentration":
      return [
        { label: "Top category", value: f.category },
        { label: "Share of spend", value: pct0(f.pct) },
        { label: "Category spend", value: usdM(f.spend) },
      ];
    case "cycle_constraint":
      return [
        { label: "Slowest internal stage", value: f.stage },
        { label: "Average duration", value: `${f.mean.toFixed(1)} days` },
        { label: "Share of cycle", value: pct0(f.sharePct) },
      ];
    case "control_weakness":
      return [
        { label: "Spend without a clean match", value: usdM(f.failedSpend) },
        { label: "Share of spend", value: pct0(f.pctAtRisk) },
        { label: "Suppliers affected", value: `${f.nSuppliers}` },
      ];
    case "temporal_move":
      return [
        { label: "Supplier", value: f.supplier },
        {
          label: "Year-on-year spend",
          value: f.spendPct != null ? `${f.spendPct > 0 ? "+" : ""}${f.spendPct}%` : "—",
        },
        {
          label: "Exposure shift",
          value: f.quadFrom && f.quadTo ? `${f.quadFrom} → ${f.quadTo}` : "—",
        },
      ];
    case "lens_disagreement":
      return [
        { label: "Supplier", value: f.supplier },
        { label: "Lens spread", value: "≥ 80 pts" },
        { label: "Spend", value: f.spend != null ? usdM(f.spend) : "—" },
      ];
  }
}

function findingRecommendation(
  f: Finding,
  recs: RecommendationsResult | null,
): { text: string; amount: number | null } {
  const byType = (t: string) => (recs?.recommendations ?? []).filter((r) => r.type === t);
  switch (f.key) {
    case "critical_issues": {
      const names = f.leaders.map((l) => l.name);
      return {
        text: `Open structured performance reviews with ${
          names.length ? andList(names) : "the underperforming Class-A suppliers"
        }; put improvement plans (or an exit) against the ${usdM(f.spend)} at stake.`,
        amount: f.spend,
      };
    }
    case "concentration":
      return {
        text: `Reduce single-market dependency in ${f.category}: qualify at least one alternate source and split award on the next cycle.`,
        amount: f.spend,
      };
    case "cycle_constraint":
      return {
        text: `Streamline ${f.stage} — the largest internal stage in the cycle. ${
          byType("slow_stage").length ? firstSentence(byType("slow_stage")[0].reasoning) : ""
        }`.trim(),
        amount: null,
      };
    case "control_weakness":
      return {
        text: `Tighten three-way-match enforcement before payment for the ${f.nSuppliers} affected suppliers; block release on unmatched invoices.`,
        amount: f.failedSpend,
      };
    case "temporal_move":
      return {
        text: `Review ${f.supplier} now while the spend is still shapeable — confirm the growth is intended and the exposure is acceptable.`,
        amount: f.spend,
      };
    case "lens_disagreement":
      return {
        text: `Investigate ${f.supplier}: reconcile why the spend, performance, and supply-risk lenses disagree so sharply before the next award.`,
        amount: f.spend,
      };
  }
}

function buildActionTable(recs: RecommendationsResult | null): ActionRow[] {
  // ONE row per target: a supplier can carry several recs (e.g. Steward + Engage) —
  // keep only its highest-impact action so the table isn't "Engage X / Steward X"
  // wallpaper.
  const best = new Map<
    string,
    { action: string; amount: number | null; rationale: string; impact: number }
  >();
  for (const r of recs?.recommendations ?? []) {
    const target = r.supplier_name ?? r.scope ?? r.category ?? "Process";
    const cur = best.get(target);
    if (!cur || r.impact_score > cur.impact) {
      best.set(target, {
        action: `${ACTION_VERB[r.action]} ${target}`,
        amount: r.total_spend_usd ?? null,
        rationale: firstSentence(r.reasoning),
        impact: r.impact_score,
      });
    }
  }
  const rows = [...best.values()];
  // Ranked by $-EXPOSURE (amount) desc — items with no $ fall to the bottom, ordered
  // by the engine's impact score. Tiered by POSITION (P1 = top 3, P2 = next 3, P3 =
  // the rest), so the table is a real priority list rather than "everything is P1".
  rows.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1) || b.impact - a.impact);
  return rows.slice(0, 8).map((r, i) => ({
    priority: (i < 3 ? 1 : i < 6 ? 2 : 3) as 1 | 2 | 3,
    action: r.action,
    amount: r.amount,
    rationale: r.rationale,
  }));
}

function watchingItems(
  temporal: TemporalAnomalies | null,
  temporalLoad: TemporalLoad | undefined | null,
): { intro: string | null; items: string[] } {
  if (temporalLoad && temporalLoad.kind === "no-prior") {
    return { intro: `${temporalLoad.label} is the earliest period — no prior year to compare against.`, items: [] };
  }
  if (temporalLoad && temporalLoad.kind === "partial-year") {
    return {
      intro: `${temporalLoad.label} is a partial year — a year-over-year comparison vs ${temporalLoad.priorLabel} isn't meaningful yet.`,
      items: [],
    };
  }
  if (!temporal || temporal.rows.length === 0) {
    return { intro: null, items: [] };
  }
  const items = temporal.rows.slice(0, 5).map((r) => {
    const bits: string[] = [];
    if (r.spend) bits.push(`spend ${r.spend.pct > 0 ? "rose" : "fell"} ${Math.abs(r.spend.pct)}%`);
    if (r.quadrant) bits.push(`jumped ${r.quadrant.from}→${r.quadrant.to}`);
    if (r.score) bits.push(`performance moved ${r.score.delta > 0 ? "+" : ""}${r.score.delta} pts`);
    const tail =
      r.quadrant && r.quadrant.to === "Bottleneck"
        ? " — a dependency forming quietly"
        : r.quadrant && r.quadrant.to === "Strategic"
          ? " — rising into your critical set"
          : "";
    return `${r.supplier_name}'s ${andList(bits)}${tail}.`;
  });
  return {
    intro: `Year-over-year (${temporal.priorLabel} → ${temporal.latestLabel}), ${temporal.flaggedCount} supplier(s) moved sharply. The ones worth a glance:`,
    items,
  };
}

/** Build + render the full argument for a tone. Pure; numbers == the analyses. */
export function renderReportArgument(
  input: ArgumentInput,
  tone: ReportTone,
): RenderedArgument {
  const { situation, findings, temporal, lensRowsAll } = buildFacts(input);
  const rendered: RenderedFinding[] = findings.map((f) => {
    const rec = findingRecommendation(f, input.recommendations);
    return {
      key: f.key,
      headline: findingHeadline(f, situation, tone),
      body: findingBody(f, tone),
      evidence: findingEvidence(f),
      recommendation: rec.text,
      amount: rec.amount,
    };
  });
  return {
    headline: headlineText(findings[0], situation, tone),
    situation: situationParagraphs(situation, tone),
    findings: rendered,
    actions: buildActionTable(input.recommendations),
    watching: watchingItems(temporal, input.temporal),
    lensRows: lensRowsAll.slice(0, 8).map((r, i) => ({
      supplier_name: r.supplier_name,
      verdict: lensVerdict(r, i === 0),
      spend: r.total_spend_usd,
    })),
    hasArgument: situation.totalSpend > 0,
  };
}

// ==========================================================================
// SUPPLIER BRIEF (Focus → one supplier)
// A document you read on the way to a supplier meeting: a DERIVED headline (a Star
// and a Critical-Issues supplier get genuinely different opening sentences), the
// situation in prose, what's flagged in plain language, what you buy, what's moved,
// and what to say. Same computed-prose + 3-tone approach as the portfolio argument;
// numbers come from the analyses + the read-only focus assembler (no recompute).
// ==========================================================================

const ORDINALS = [
  "zeroth", "first", "second", "third", "fourth", "fifth",
  "sixth", "seventh", "eighth", "ninth", "tenth",
];
function ordinal(n: number): string {
  if (n >= 1 && n <= 10) return ORDINALS[n];
  const v = n % 100;
  const suffix =
    v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

const QUAD_MEANING: Record<KraljicQuadrant, string> = {
  Strategic: "high value and hard to replace",
  Leverage: "high value but competitively sourced",
  Bottleneck: "modest value but hard to source",
  Routine: "modest value and easily sourced",
};
const QUAD_SHORT: Record<KraljicQuadrant, string> = {
  Strategic: "strategically hard-to-replace",
  Leverage: "competitively-sourced",
  Bottleneck: "hard-to-source",
  Routine: "easily-sourced",
};
const ZONE_MEANING: Record<PerformanceZone, string> = {
  Stars: "high spend, strong performance",
  "Critical Issues": "high spend, below-median performance",
  "Hidden Gems": "modest spend, strong performance",
  "Long Tail": "modest spend, below-median performance",
};
const PROC_FLAG_PROSE: Record<
  "has_outlier" | "inconsistent" | "has_stage_dom",
  string
> = {
  has_outlier: "orders whose cycle ran far above the window average",
  inconsistent: "an inconsistent cycle — a wide spread in how long orders take",
  has_stage_dom: "orders where a single stage dominates the cycle",
};

type BriefFacts = {
  name: string;
  category: string | null;
  country: string | null;
  rank: number | null;
  totalSpend: number;
  spendPct: number;
  poCount: number;
  abcClass: "A" | "B" | "C" | null;
  quadrant: KraljicQuadrant | null;
  supplyRisk: number | null;
  zone: PerformanceZone | null;
  perfScore: number | null;
  perfMedian: number;
  aboveMedian: boolean;
  process: { has_outlier: boolean; inconsistent: boolean; has_stage_dom: boolean } | null;
  outlierPoCount: number;
  lens: string | null;
  temporal: {
    quadFrom: string | null;
    quadTo: string | null;
    spendPct: number | null;
    scoreDelta: number | null;
  } | null;
  items: FocusItem[];
  topItemsShare: number;
  trajectory: FocusTrajectoryPoint[];
  quadrantChanged: boolean;
};

export type RenderedSupplierBrief = {
  name: string;
  subtitle: string | null; // category · ABC · Kraljic · zone · country
  headline: string;
  situation: string[];
  flagged: string[]; // plain-language sentences; empty = clean
  flaggedClean: boolean;
  buy: { prose: string; items: FocusItem[]; totalSpend: number } | null;
  trajectory: { prose: string; points: FocusTrajectoryPoint[] } | null;
  recommendation: string;
  resolved: boolean; // false = supplier absent from the period
};

function buildBriefFacts(
  input: ArgumentInput,
  focus: SupplierFocusData | null,
  supplierId: string,
): BriefFacts {
  const perf = input.performance_spend;
  const abc = input.abc;
  const kr = input.kraljic;

  const psRow = perf?.suppliers.find((s) => s.supplier_id === supplierId) ?? null;
  const abcRow = abc?.classifications.find((c) => c.supplier_id === supplierId) ?? null;
  const krRow = kr?.quadrant_assignments.find((q) => q.supplier_id === supplierId) ?? null;
  const perfMedian = perf?.axis_thresholds.performance_median ?? 0;

  // name/category/country: prefer the focus assembler's identity, else an
  // analysis row / rec label.
  const name =
    focus?.name ??
    psRow?.supplier_name ??
    abcRow?.supplier_name ??
    krRow?.supplier_name ??
    input.recommendations?.recommendations.find((r) => r.supplier_id === supplierId)
      ?.supplier_name ??
    supplierId;

  // process flags (Batch 1) from the assembled breakdown.
  let process: BriefFacts["process"] = null;
  if (input.breakdown) {
    const flags = deriveCycleFlags({
      roster: input.breakdown.bySupplier,
      anomalies: input.cycle_time?.anomalies ?? [],
      stageAnomalies: input.breakdown.stageAnomalies ?? [],
    }).flagsBySupplier.get(supplierId);
    if (flags) process = flags;
  }
  const outlierPoCount = (input.cycle_time?.anomalies ?? []).filter(
    (a) => a.supplier_id === supplierId,
  ).length;

  // lens disagreement (Batch 2): only if this supplier clears the cutoff.
  let lens: string | null = null;
  if (perf && kr && abc) {
    const row = buildClassificationAnomalies({
      perfSuppliers: perf.suppliers,
      supplyRiskById: new Map(
        kr.quadrant_assignments.map((q) => [q.supplier_id, q.supply_risk_score]),
      ),
      abcById: new Map(abc.classifications.map((c) => [c.supplier_id, c.abc_class])),
    }).rows.find((r) => r.supplier_id === supplierId);
    if (row) lens = lensVerdict(row, false);
  }

  // temporal move (Batch 3): only if flagged in the period-aware matrix.
  let temporal: BriefFacts["temporal"] = null;
  if (input.temporal?.kind === "ok") {
    const t = buildTemporalAnomalies(input.temporal.matrix).rows.find(
      (r) => r.supplier_id === supplierId,
    );
    if (t) {
      temporal = {
        quadFrom: t.quadrant?.from ?? null,
        quadTo: t.quadrant?.to ?? null,
        spendPct: t.spend?.pct ?? null,
        scoreDelta: t.score?.delta ?? null,
      };
    }
  }

  const items = focus?.itemBreakdown ?? [];
  const focusTotal = focus?.totalSpend ?? psRow?.total_spend_usd ?? 0;
  const topItemsShare =
    focusTotal > 0
      ? (items.slice(0, 2).reduce((s, i) => s + i.totalSpend, 0) / focusTotal) * 100
      : 0;

  // trajectory: active years only. (Trend maths — incl. the partial-year guard —
  // live in briefTrajectory; here we only need whether the quadrant ever changed.)
  const active = (focus?.trajectory ?? []).filter(
    (t) => t.spend > 0 || t.invoiceCount > 0,
  );
  const quadrantChanged =
    new Set(active.map((t) => t.kraljicQuadrant).filter(Boolean)).size > 1;

  return {
    name,
    category: focus?.category ?? null,
    country: focus?.country ?? null,
    rank: abcRow?.rank ?? null,
    totalSpend: psRow?.total_spend_usd ?? focusTotal,
    spendPct: (abcRow?.pct ?? 0) * 100,
    poCount: focus?.poCount ?? 0,
    abcClass: abcRow?.abc_class ?? null,
    quadrant: krRow?.quadrant ?? null,
    supplyRisk: krRow?.supply_risk_score ?? null,
    zone: psRow?.zone ?? null,
    perfScore: psRow?.performance_score ?? null,
    perfMedian,
    aboveMedian: psRow != null && psRow.performance_score >= perfMedian,
    process,
    outlierPoCount,
    lens,
    temporal,
    items,
    topItemsShare,
    trajectory: active,
    quadrantChanged,
  };
}

/** THE DERIVED HEADLINE — branches on the supplier's zone (which encodes spend
 *  position × performance), enriched with rank, quadrant, and score. */
function briefHeadline(f: BriefFacts, tone: ReportTone): string {
  if (!f.zone || f.perfScore == null) {
    return `${f.name} had no recorded activity in this period.`;
  }
  const perf = f.perfScore;
  const med = f.perfMedian;
  const rankPhrase = f.rank ? `your ${ordinal(f.rank)}-largest supplier by spend` : "a supplier";
  const rankBare = rankPhrase.replace("your ", "");
  const quadShort = f.quadrant ? QUAD_SHORT[f.quadrant] : "";
  // The Stars/Critical-Issues zones are median splits, so a supplier just above the
  // spend median can land there while being small in ABSOLUTE terms. Only call it
  // "high-spend" when it genuinely is — otherwise the headline contradicts the
  // "$3.1M, 20th-largest" it then quotes.
  const genuinelyLarge = f.spendPct >= 5 || (f.rank != null && f.rank <= 10);
  switch (f.zone) {
    case "Critical Issues":
      if (tone === "executive")
        return genuinelyLarge
          ? `${f.name} is among your largest underperforming exposures — ${rankPhrase}, delivering below the performance median.`
          : `${f.name} underperforms for what you pay it — below the performance median, though a modest share of outlay.`;
      if (tone === "analytical")
        return `${f.name} sits in the high-spend / below-median-performance quadrant (Critical Issues): ${usdM(
          f.totalSpend,
        )}, ${sharePct(f.spendPct)} of spend, performance ${perf.toFixed(1)} against a ${med.toFixed(
          1,
        )} median${f.quadrant ? `, ${f.quadrant} exposure` : ""}.`;
      return genuinelyLarge
        ? `${f.name} is ${rankPhrase} and one of your clearest underperforming exposures — ${usdM(
            f.totalSpend,
          )} (${sharePct(f.spendPct)} of outlay) to a ${quadShort} supplier scoring ${perf.toFixed(
            0,
          )} against the ${med.toFixed(0)}-point performance median.`
        : `${f.name} underperforms for what you pay it — ${usdM(f.totalSpend)} (${rankBare}, ${sharePct(f.spendPct)} of outlay) at a score of ${perf.toFixed(0)}, under the ${med.toFixed(
            0,
          )}-point median. A smaller exposure, but below par.`;
    case "Stars": {
      const lever = f.quadrant === "Leverage" ? " — and where your buying power can press for terms" : "";
      if (tone === "executive")
        return genuinelyLarge
          ? `${f.name} is a high-value supplier performing well — one of your largest relationships, above the performance median. Protect it.`
          : `${f.name} is a strong performer on a modest share of spend — dependable, worth keeping close.`;
      if (tone === "analytical")
        return `${f.name} occupies the high-spend / above-median-performance quadrant (Stars): ${usdM(
          f.totalSpend,
        )}, performance ${perf.toFixed(1)} vs a ${med.toFixed(1)} median${
          f.quadrant ? `, ${f.quadrant} exposure` : ""
        }.`;
      return genuinelyLarge
        ? `${f.name} is a high-spend supplier that delivers — ${usdM(f.totalSpend)} (${rankBare}) at a performance score of ${perf.toFixed(
            0,
          )}, above the ${med.toFixed(0)}-point median. A relationship to protect${lever}.`
        : `${f.name} performs well above the bar for what you spend — ${usdM(f.totalSpend)} (${rankBare}, ${sharePct(f.spendPct)} of outlay) at a score of ${perf.toFixed(0)}, over the ${med.toFixed(
            0,
          )}-point median. A dependable relationship${lever}.`;
    }
    case "Hidden Gems":
      if (tone === "executive")
        return `${f.name} is a strong performer on modest spend — a promotion candidate.`;
      if (tone === "analytical")
        return `${f.name} sits in the low-spend / above-median-performance quadrant (Hidden Gems): performance ${perf.toFixed(
          1,
        )} vs a ${med.toFixed(1)} median on ${usdM(f.totalSpend)} of spend.`;
      return `${f.name} is a small supplier punching above its weight — a performance score of ${perf.toFixed(
        0,
      )} on just ${usdM(f.totalSpend)} (${sharePct(f.spendPct)} of spend). A candidate to entrust with more.`;
    case "Long Tail":
      if (tone === "executive")
        return `${f.name} is a small, below-median supplier — a rationalisation candidate.`;
      if (tone === "analytical")
        return `${f.name} occupies the low-spend / below-median-performance quadrant (Long Tail): ${usdM(
          f.totalSpend,
        )}, performance ${perf.toFixed(1)} vs a ${med.toFixed(1)} median.`;
      return `${f.name} is a small, underperforming supplier — ${usdM(
        f.totalSpend,
      )} at a performance score of ${perf.toFixed(0)}, below the ${med.toFixed(
        0,
      )}-point median. A candidate to rationalise or move to catalogue buys.`;
  }
}

function briefSituation(f: BriefFacts, tone: ReportTone): string[] {
  const paras: string[] = [];
  const where = f.country ? ` from ${f.country}` : "";
  const supplies = f.category ? `supplies ${f.category}${where}` : `is a supplier${where}`;
  const rankClause = f.rank
    ? ` — your ${ordinal(f.rank)}-largest supplier, ${sharePct(f.spendPct)} of total outlay`
    : "";
  paras.push(
    `${f.name} ${supplies}. Over this period you spent ${usdM(f.totalSpend)} with them${
      f.poCount ? ` across ${intl.format(f.poCount)} orders` : ""
    }${rankClause}.`,
  );
  if (f.quadrant && f.zone) {
    const method =
      tone === "analytical"
        ? ` Both placements are median splits of the current population — membership is relative, not absolute.`
        : "";
    paras.push(
      `By exposure they sit in the ${f.quadrant} quadrant (${QUAD_MEANING[f.quadrant]}); on delivered performance they fall in the ${f.zone} zone (${ZONE_MEANING[f.zone]}).${method}`,
    );
  }
  return paras;
}

function briefFlagged(f: BriefFacts): { sentences: string[]; clean: boolean } {
  const sentences: string[] = [];
  if (f.process) {
    const active = (["has_outlier", "inconsistent", "has_stage_dom"] as const).filter(
      (k) => f.process![k],
    );
    if (active.length) {
      const detail =
        f.outlierPoCount > 0 && f.process.has_outlier
          ? ` (${f.outlierPoCount} outlier PO${f.outlierPoCount === 1 ? "" : "s"})`
          : "";
      sentences.push(
        `Their procure-to-pay process shows ${andList(active.map((k) => PROC_FLAG_PROSE[k]))}${detail}.`,
      );
    }
  }
  if (f.lens) {
    sentences.push(`Across the three classification lenses they are a contradiction — ${f.lens}.`);
  }
  if (f.temporal) {
    const bits: string[] = [];
    if (f.temporal.quadFrom && f.temporal.quadTo)
      bits.push(`moved ${f.temporal.quadFrom}→${f.temporal.quadTo}`);
    if (f.temporal.spendPct != null)
      bits.push(`spend ${f.temporal.spendPct > 0 ? "rose" : "fell"} ${Math.abs(f.temporal.spendPct)}%`);
    if (f.temporal.scoreDelta != null)
      bits.push(`performance moved ${f.temporal.scoreDelta > 0 ? "+" : ""}${f.temporal.scoreDelta} pts`);
    if (bits.length) sentences.push(`Year-on-year they ${andList(bits)}.`);
  }
  return { sentences, clean: sentences.length === 0 };
}

function briefBuy(f: BriefFacts, tone: ReportTone): RenderedSupplierBrief["buy"] {
  if (f.items.length === 0) return null;
  const concentrated = f.topItemsShare >= 60;
  const top = f.items.slice(0, 2).map((i) => i.itemName);
  const lead =
    f.items.length === 1
      ? `Everything you buy from them is ${f.items[0].itemName.toLowerCase()}`
      : concentrated
        ? `What you buy from them is concentrated: ${andList(top)} alone ${
            top.length === 1 ? "is" : "are"
          } ${pct0(f.topItemsShare)} of the ${usdM(f.totalSpend)} you spend here`
        : `Your spend with them spreads across ${f.items.length} items, led by ${andList(top)}`;
  const method =
    tone === "analytical"
      ? ` (${f.items.length} distinct item${f.items.length === 1 ? "" : "s"} over the span).`
      : ".";
  return { prose: `${lead}${method}`, items: f.items, totalSpend: f.totalSpend };
}

const TRAJECTORY_PARTIAL_FRACTION = 0.5;

function briefTrajectory(f: BriefFacts, tone: ReportTone): RenderedSupplierBrief["trajectory"] {
  const active = f.trajectory;
  if (active.length < 2) {
    if (active.length === 1) {
      return {
        prose: `They were active in only one year of the window, so there is no trajectory to read yet.`,
        points: active,
      };
    }
    return null;
  }
  // Partial-year guard (mirrors the temporal family's PARTIAL_YEAR fraction): a
  // trailing year whose spend is under half the prior year's is a data artifact
  // (e.g. an incomplete 2026), not a real collapse — set it aside from the trend
  // and note it, rather than asserting a spurious "fell 72%".
  const lastYr = active[active.length - 1];
  const prevYr = active[active.length - 2];
  const partial =
    prevYr.spend > 0 && lastYr.spend < TRAJECTORY_PARTIAL_FRACTION * prevYr.spend;
  const trend = partial ? active.slice(0, -1) : active;
  // Setting aside a partial trailing year can leave a single full year — not enough
  // for a trend. Say so rather than emitting a degenerate "Over 2025–2025".
  if (trend.length < 2) {
    const only = trend[0];
    const partialTail = partial
      ? `, plus a partial ${lastYr.year} (${intl.format(lastYr.invoiceCount)} invoice${
          lastYr.invoiceCount === 1 ? "" : "s"
        }, ${usdM(lastYr.spend)})`
      : "";
    return {
      prose: `They have only one full year in the window — ${only.year}: ${usdM(
        only.spend,
      )}${
        only.performanceScore != null
          ? `, performance ${only.performanceScore.toFixed(0)}`
          : ""
      }${partialTail} — not enough for a trend yet.`,
      points: active,
    };
  }
  const first = trend[0];
  const last = trend[trend.length - 1];

  const spendPct =
    first.spend > 0 ? Math.round(((last.spend - first.spend) / first.spend) * 100) : null;
  const spendPhrase =
    spendPct == null || Math.abs(spendPct) < 10
      ? `spend has held broadly steady (around ${usdM(last.spend)}/yr)`
      : `spend has ${spendPct > 0 ? "grown" : "fallen"} ${Math.abs(spendPct)}% (${usdM(
          first.spend,
        )} → ${usdM(last.spend)})`;

  let perfPhrase = "";
  if (first.performanceScore != null && last.performanceScore != null) {
    const delta = +(last.performanceScore - first.performanceScore).toFixed(1);
    if (Math.abs(delta) < 0.5) {
      perfPhrase = ` and performance has held flat (${first.performanceScore.toFixed(
        0,
      )} → ${last.performanceScore.toFixed(0)})`;
    } else {
      const dir = delta > 0 ? "improved" : "slipped";
      const interp =
        delta < 0
          ? f.aboveMedian
            ? " — still above the median, but the direction is worth watching"
            : " — and it sits below the median"
          : " — a positive trend";
      perfPhrase = ` and performance has ${dir} ${Math.abs(delta).toFixed(1)} points (${first.performanceScore.toFixed(
        0,
      )} → ${last.performanceScore.toFixed(0)})${interp}`;
    }
  }

  const windowLabel = partial
    ? `${first.year}–${last.year}`
    : `${active.length} active years`;
  const partialNote = partial
    ? ` (${lastYr.year} is a partial year — ${intl.format(lastYr.invoiceCount)} invoice${
        lastYr.invoiceCount === 1 ? "" : "s"
      }, ${usdM(lastYr.spend)} — set aside from the trend)`
    : "";
  const quadPhrase = f.quadrantChanged
    ? ` Their exposure quadrant also shifted over the window (${andList(
        [...new Set(active.map((t) => t.kraljicQuadrant).filter(Boolean) as string[])],
      )}).`
    : "";
  const method =
    tone === "analytical"
      ? ` Per-year performance is the Mode-A composite for each period; spend is payment-date bucketed.`
      : "";
  return {
    prose: `Over ${windowLabel}, ${spendPhrase}${perfPhrase}${partialNote}.${quadPhrase}${method}`,
    points: active,
  };
}

function briefRecommendation(f: BriefFacts): string {
  const stake = f.totalSpend > 0 ? ` against the ${usdM(f.totalSpend)} at stake` : "";
  const flagClause =
    f.process && (f.process.has_outlier || f.process.has_stage_dom)
      ? " Bring the cycle-time anomalies as concrete examples."
      : "";
  if (!f.zone) {
    return `Confirm whether this relationship is still active and worth carrying in the roster.`;
  }
  switch (f.zone) {
    case "Critical Issues":
      return `Go into the meeting on performance: they are ${
        f.rank ? `a top-${f.rank} supplier` : "a high-spend supplier"
      } delivering below the median${
        f.quadrant === "Strategic" ? ", and one you cannot easily replace" : ""
      }. Agree a concrete improvement plan — or, if the market allows, a sourcing alternative —${stake}.${flagClause}`;
    case "Stars":
      return `This is a keep-warm conversation: acknowledge strong delivery, make sure the relationship rests on a formal footing (contract, SLA, quarterly review), and explore consolidating more spend here${
        f.quadrant === "Leverage" ? " while your competitive position lets you hold terms" : ""
      }.${flagClause}`;
    case "Hidden Gems":
      return `Use the meeting to test appetite for more: they perform well on modest spend, so probe capacity and quality at higher volume before steering additional work their way.`;
    case "Long Tail":
      return `Keep it light-touch: confirm whether the relationship earns its place or the spend can move to catalogue or consolidated buys.${flagClause}`;
  }
}

/** Build + render a supplier brief for a tone. Pure; numbers == the analyses +
 *  the read-only focus assembler. `focus` may be null while the editor is still
 *  fetching it — position/flagged/recommendation still render; buy/trajectory
 *  come back null and the renderer shows a loading affordance. */
export function renderSupplierBrief(
  input: ArgumentInput,
  focus: SupplierFocusData | null,
  supplierId: string,
  tone: ReportTone,
): RenderedSupplierBrief {
  const f = buildBriefFacts(input, focus, supplierId);
  const resolved = f.zone != null || f.totalSpend > 0 || f.items.length > 0;

  const subtitle =
    [
      f.category,
      f.abcClass ? `Class ${f.abcClass}` : null,
      f.quadrant,
      f.zone,
      f.country,
    ]
      .filter(Boolean)
      .join(" · ") || null;

  const { sentences, clean } = briefFlagged(f);
  return {
    name: f.name,
    subtitle,
    headline: briefHeadline(f, tone),
    situation: briefSituation(f, tone),
    flagged: sentences,
    flaggedClean: clean,
    buy: briefBuy(f, tone),
    trajectory: briefTrajectory(f, tone),
    recommendation: briefRecommendation(f),
    resolved,
  };
}

// ==========================================================================
// LLM NARRATIVE PAYLOAD — the boundary (Focus → supplier brief)
// The AGGREGATE values a generator receives to rewrite the brief's prose. Every
// number that appears in prose is pre-formatted to a display STRING here, so the
// model inserts the exact figure it was handed and never formats, rounds, rescales,
// or computes one. Deliberately carries NO raw purchase-order rows and NO line-item
// unit prices — only supplier-level scores, classifications, rank, notable deltas,
// and item NAMES with their spend SHARE. A smaller payload is a design decision the
// org can defend ("where does our data go") — see lib/report-llm.ts + Methodology.
// ==========================================================================

export type BriefFactsPayload = {
  name: string;
  category: string | null;
  country: string | null;
  rankBySpend: number | null;
  totalSpend: string; // "$62.1M"
  spendShareOfPortfolio: string; // "11%" / "<1%"
  orderCount: number;
  abcClass: "A" | "B" | "C" | null;
  kraljicQuadrant: KraljicQuadrant | null;
  kraljicMeaning: string | null;
  supplyRiskScore: number | null;
  performanceZone: PerformanceZone | null;
  zoneMeaning: string | null;
  performanceScore: string | null; // "72"
  performanceMedian: string; // "78"
  aboveMedian: boolean;
  processFlags: string[]; // plain-language, active flags only
  outlierOrderCount: number;
  lensDisagreement: string | null;
  yearOverYear: {
    quadrantFrom: string | null;
    quadrantTo: string | null;
    spendChange: string | null; // "+18%"
    performanceChange: string | null; // "+5 pts"
  } | null;
  itemCount: number;
  topItems: { name: string; share: string }[]; // top 2 — name + spend SHARE only
  activeYears: { year: string; spend: string; performanceScore: string | null }[];
};

/** Project the pure BriefFacts into the aggregate, display-formatted payload a
 *  generator receives. Pure; numbers == the analyses + the focus assembler. */
export function buildBriefPayload(
  input: ArgumentInput,
  focus: SupplierFocusData | null,
  supplierId: string,
): BriefFactsPayload {
  const f = buildBriefFacts(input, focus, supplierId);
  const activeFlags = f.process
    ? (["has_outlier", "inconsistent", "has_stage_dom"] as const)
        .filter((k) => f.process![k])
        .map((k) => PROC_FLAG_PROSE[k])
    : [];
  const yearOverYear = f.temporal
    ? {
        quadrantFrom: f.temporal.quadFrom,
        quadrantTo: f.temporal.quadTo,
        spendChange:
          f.temporal.spendPct != null
            ? `${f.temporal.spendPct > 0 ? "+" : ""}${f.temporal.spendPct}%`
            : null,
        performanceChange:
          f.temporal.scoreDelta != null
            ? `${f.temporal.scoreDelta > 0 ? "+" : ""}${f.temporal.scoreDelta} pts`
            : null,
      }
    : null;
  const topItems = f.items.slice(0, 2).map((i) => ({
    name: i.itemName,
    share: f.totalSpend > 0 ? sharePct((i.totalSpend / f.totalSpend) * 100) : "—",
  }));
  return {
    name: f.name,
    category: f.category,
    country: f.country,
    rankBySpend: f.rank,
    totalSpend: usdM(f.totalSpend),
    spendShareOfPortfolio: sharePct(f.spendPct),
    orderCount: f.poCount,
    abcClass: f.abcClass,
    kraljicQuadrant: f.quadrant,
    kraljicMeaning: f.quadrant ? QUAD_MEANING[f.quadrant] : null,
    supplyRiskScore: f.supplyRisk != null ? +f.supplyRisk.toFixed(2) : null,
    performanceZone: f.zone,
    zoneMeaning: f.zone ? ZONE_MEANING[f.zone] : null,
    performanceScore: f.perfScore != null ? f.perfScore.toFixed(0) : null,
    performanceMedian: f.perfMedian.toFixed(0),
    aboveMedian: f.aboveMedian,
    processFlags: activeFlags,
    outlierOrderCount: f.outlierPoCount,
    lensDisagreement: f.lens,
    yearOverYear,
    itemCount: f.items.length,
    topItems,
    activeYears: f.trajectory.map((t) => ({
      year: t.year,
      spend: usdM(t.spend),
      performanceScore: t.performanceScore != null ? t.performanceScore.toFixed(0) : null,
    })),
  };
}

/**
 * Overlay LLM-generated PROSE onto a template RenderedSupplierBrief, keeping every
 * non-prose field (subtitle, the buy/trajectory TABLES, resolved) exactly as computed.
 * Pure. Falls back to the template value per field when the model omitted one, and —
 * critically — keeps the template's `flaggedClean` verdict so a dropped `flagged` list
 * can never turn a genuinely-flagged supplier into "nothing flagged".
 */
export function applyGeneratedProse(
  brief: RenderedSupplierBrief,
  prose: GeneratedBriefProse,
): RenderedSupplierBrief {
  return {
    ...brief,
    headline: prose.headline || brief.headline,
    situation: prose.situation.length ? prose.situation : brief.situation,
    flagged: prose.flagged.length ? prose.flagged : brief.flagged,
    flaggedClean: brief.flaggedClean,
    buy: brief.buy
      ? { ...brief.buy, prose: prose.buyProse || brief.buy.prose }
      : brief.buy,
    trajectory: brief.trajectory
      ? { ...brief.trajectory, prose: prose.trajectoryProse || brief.trajectory.prose }
      : brief.trajectory,
    recommendation: prose.recommendation || brief.recommendation,
  };
}

// ==========================================================================
// CATEGORY DEEP-DIVE (Focus → one category)
// ==========================================================================

export type CategorySupplierRow = {
  supplier_id: string;
  name: string;
  spend: number;
  zone: PerformanceZone;
  perf: number;
  quadrant: KraljicQuadrant;
};
export type RenderedCategoryDeepDive = {
  category: string;
  headline: string;
  situation: string[];
  suppliers: CategorySupplierRow[];
  recommendation: string;
  resolved: boolean;
};

export function renderCategoryDeepDive(
  input: ArgumentInput,
  category: string,
  supplierCategory: Record<string, string>,
  tone: ReportTone,
): RenderedCategoryDeepDive {
  const perf = input.performance_spend;
  const so = input.spend_overview;
  const perfMedian = perf?.axis_thresholds.performance_median ?? 0;
  const krById = new Map(
    (input.kraljic?.quadrant_assignments ?? []).map((q) => [q.supplier_id, q.quadrant]),
  );

  const rows: CategorySupplierRow[] = (perf?.suppliers ?? [])
    .filter((s) => supplierCategory[s.supplier_id] === category)
    .map((s) => ({
      supplier_id: s.supplier_id,
      name: s.supplier_name,
      spend: s.total_spend_usd,
      zone: s.zone,
      perf: s.performance_score,
      quadrant: krById.get(s.supplier_id) ?? s.kraljic_quadrant,
    }))
    .sort((a, b) => b.spend - a.spend);

  const catFromOverview = so?.by_category.find((c) => c.category === category)?.total;
  const catTotal = catFromOverview ?? rows.reduce((s, r) => s + r.spend, 0);
  const portfolioTotal = so?.total_spend ?? catTotal;
  const share = portfolioTotal > 0 ? (catTotal / portfolioTotal) * 100 : 0;
  const n = rows.length;
  const top = rows[0];
  const topShare = catTotal > 0 && top ? (top.spend / catTotal) * 100 : 0;
  const underperformers = rows.filter((r) => r.perf < perfMedian);
  const singleSource = n === 1;
  const resolved = n > 0;

  const headline = !resolved
    ? `No active suppliers were recorded in ${category} for this period.`
    : tone === "executive"
      ? `${category} is ${pct0(share)} of spend across ${n} supplier${n === 1 ? "" : "s"}${
          singleSource ? " — single-sourced" : ""
        }.`
      : `${category} accounts for ${pct0(share)} of portfolio spend (${usdM(
          catTotal,
        )}) across ${n} supplier${n === 1 ? "" : "s"}, led by ${top.name} at ${pct0(
          topShare,
        )} of the category.`;

  const situation: string[] = [];
  if (resolved) {
    situation.push(
      singleSource
        ? `All ${usdM(catTotal)} of ${category} spend runs through a single supplier, ${top.name} — the category has no second source to fall back on.`
        : `The ${n} suppliers in ${category} share ${usdM(catTotal)} of spend; ${top.name} leads with ${pct0(
            topShare,
          )}${topShare >= 60 ? ", so the category leans heavily on one relationship" : ""}.`,
    );
    if (underperformers.length > 0) {
      situation.push(
        `On performance, ${underperformers.length} of ${n} sit below the ${perfMedian.toFixed(
          0,
        )}-point median${
          tone === "analytical" ? " (population median split)" : ""
        } — ${andList(underperformers.slice(0, 3).map((r) => `${r.name} (${r.perf.toFixed(0)})`))}.`,
      );
    } else {
      situation.push(`On performance, every supplier in the category sits at or above the ${perfMedian.toFixed(0)}-point median.`);
    }
  }

  let recommendation: string;
  if (!resolved) {
    recommendation = `No action — the category is inactive this period.`;
  } else if (singleSource) {
    recommendation = `Priority is resilience: qualify at least one alternate source for ${category} before the next award, so a single supplier's disruption can't stop the category.`;
  } else if (underperformers.length > 0) {
    recommendation = `Engage the underperformers — ${andList(
      underperformers.slice(0, 2).map((r) => r.name),
    )} — on a performance plan, and use the competition within the category to hold terms.`;
  } else {
    recommendation = `The category is healthy — maintain the current split and use the multiple sources to keep pricing competitive.`;
  }

  return { category, headline, situation, suppliers: rows, recommendation, resolved };
}
