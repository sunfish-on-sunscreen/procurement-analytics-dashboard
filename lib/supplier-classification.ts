import type {
  PerformanceSpendResult,
  PerformanceSpendSupplier,
  KraljicQuadrant,
} from "@/lib/analysis-types";
import type { SynthesisKey } from "@/lib/supplier-classification-types";

/**
 * Cross-classification synthesis: combine the Kraljic quadrant with the
 * performance median split (the SAME `performance_median` the scatter uses, so
 * the synthesis and chart stay internally consistent). This mirrors the Python
 * zone convention (`hi_perf = perf > median` in compute_analyses.py `zone_of`),
 * so a supplier sitting EXACTLY at the median is treated as LOW-perf in BOTH the
 * scatter zone and this synthesis. "Below" = composite performance at or below
 * the period median; "above" = strictly above it.
 */
export type SynthesisMeta = {
  key: SynthesisKey;
  title: string;
  quadrant: KraljicQuadrant;
  /** Membership requires performance at or below the median (else strictly above). */
  below: boolean;
  /** Short descriptor of what the bucket means. */
  blurb: string;
  /** One-line recommended action shown on the cross-classification card. */
  action: string;
  /** Tailwind theme classes (border + tint + text) for the card. */
  theme: { border: string; tint: string; text: string };
};

export const SYNTHESIS_ORDER: SynthesisKey[] = [
  "strategic_under",
  "bottleneck_critical",
  "leverage_workhorse",
  "routine_risk",
];

export const SYNTHESIS_META: Record<SynthesisKey, SynthesisMeta> = {
  strategic_under: {
    key: "strategic_under",
    title: "Strategic underperformers",
    quadrant: "Strategic",
    below: true,
    blurb: "high-spend, hard-to-replace suppliers performing below the median — the priority for securing continuity and qualifying alternates before the exposure bites.",
    action: "Secure supply or qualify alternates.",
    theme: {
      border: "border-l-red-500",
      tint: "bg-red-500/5",
      text: "text-red-600 dark:text-red-400",
    },
  },
  bottleneck_critical: {
    key: "bottleneck_critical",
    title: "Bottleneck critical issues",
    quadrant: "Bottleneck",
    below: true,
    blurb: "low-spend but hard-to-replace suppliers underperforming — small dollars, but supply risk that warrants active engagement and mitigation.",
    action: "Prioritize engagement & risk mitigation.",
    theme: {
      border: "border-l-amber-500",
      tint: "bg-amber-500/5",
      text: "text-amber-600 dark:text-amber-400",
    },
  },
  leverage_workhorse: {
    key: "leverage_workhorse",
    title: "Workhorse leverage (dependable)",
    quadrant: "Leverage",
    below: false,
    blurb: "high-spend, competitive-category suppliers performing above the median — dependable volume to consolidate around.",
    action: "Consolidate volume to negotiate.",
    theme: {
      border: "border-l-green-500",
      tint: "bg-green-500/5",
      text: "text-green-600 dark:text-green-400",
    },
  },
  routine_risk: {
    key: "routine_risk",
    title: "Routine quality risks",
    quadrant: "Routine",
    below: true,
    blurb: "low-spend, low-risk suppliers underperforming — candidates to rationalize or move to catalog buys.",
    action: "Rationalize or move to catalog buys.",
    theme: {
      border: "border-l-blue-500",
      tint: "bg-blue-500/5",
      text: "text-blue-600 dark:text-blue-400",
    },
  },
};

/** Group the performance set into the four synthesis buckets. */
export function computeSynthesis(
  perf: PerformanceSpendResult,
): Record<SynthesisKey, PerformanceSpendSupplier[]> {
  const median = perf.axis_thresholds.performance_median;
  const groups: Record<SynthesisKey, PerformanceSpendSupplier[]> = {
    strategic_under: [],
    bottleneck_critical: [],
    leverage_workhorse: [],
    routine_risk: [],
  };
  for (const s of perf.suppliers) {
    // At or below the median = LOW-perf, matching the Python zone split
    // (`hi_perf = perf > median`) so an exactly-at-median supplier gets the same
    // verdict in the scatter zone and here (E11).
    const below = s.performance_score <= median;
    const meta = (Object.values(SYNTHESIS_META) as SynthesisMeta[]).find(
      (m) => m.quadrant === s.kraljic_quadrant && m.below === below,
    );
    if (meta) groups[meta.key].push(s);
  }
  // Highest-spend first within each bucket (most material names lead).
  for (const k of SYNTHESIS_ORDER) {
    groups[k].sort((a, b) => b.total_spend_usd - a.total_spend_usd);
  }
  return groups;
}
