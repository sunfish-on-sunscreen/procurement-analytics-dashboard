import type { RecommendationCategory } from "@/lib/analysis-types";

/**
 * Shared presentation metadata for the Action Priorities categories — one source
 * of truth for the view + the card. Colours are theme tokens (--priority-*), so
 * they're dark-mode safe (no hardcoded hex). Categories are organised into three
 * analysis GROUPS (Spend / Suppliers / Process) via ACTION_GROUPS below; the flat
 * CATEGORY_ORDER matches that grouped order (drives the filter pills + presence).
 */
export const CATEGORY_ORDER: RecommendationCategory[] = [
  // Spend
  "concentration",
  "critical_spend",
  "tail_spend",
  // Suppliers
  "critical_issues_engagement",
  "hidden_gems_promotion",
  "bottleneck_risk",
  // Process
  "process_improvement",
  "slow_stage",
];

export const CATEGORY_LABEL: Record<RecommendationCategory, string> = {
  critical_issues_engagement: "Critical Issues",
  bottleneck_risk: "Bottleneck Risk Mitigation",
  hidden_gems_promotion: "Hidden Gems Promotion",
  process_improvement: "Process Improvement",
  concentration: "Concentration",
  critical_spend: "Critical Spend",
  tail_spend: "Tail Spend",
  slow_stage: "Slowest Stage",
};

/** CSS custom-property references (theme-aware, light + dark). */
export const CATEGORY_COLOR_VAR: Record<RecommendationCategory, string> = {
  critical_issues_engagement: "var(--priority-engage)",
  bottleneck_risk: "var(--priority-mitigate)",
  hidden_gems_promotion: "var(--priority-promote)",
  process_improvement: "var(--priority-improve)",
  concentration: "var(--priority-concentrate)",
  critical_spend: "var(--priority-steward)",
  tail_spend: "var(--priority-consolidate)",
  slow_stage: "var(--priority-slowstage)",
};

/** One-line "why this matters" framing shown under each section heading. */
export const CATEGORY_WHY: Record<RecommendationCategory, string> = {
  critical_issues_engagement:
    "The widest gap between what you pay and what you get — high-spend suppliers performing below the portfolio median.",
  bottleneck_risk:
    "Low-spend but hard to replace — high supply risk with few ready alternatives.",
  hidden_gems_promotion:
    "Strong performers you're barely using — room to shift more spend their way.",
  process_improvement:
    "Internal process friction slowing the procure-to-pay cycle.",
  concentration:
    "Where spend is most concentrated by category — resilience exposure, not performance.",
  critical_spend:
    "The vital few — your largest supplier relationships (A-tier), which concentrate the most spend and warrant the most oversight.",
  tail_spend:
    "The long tail — many tiny suppliers that add administrative overhead for little spend.",
  slow_stage:
    "The internal procure-to-pay stage(s) taking longest — where the workflow leaks the most time.",
};

/** One generic, light soft-nudge per category (same for every card in it). */
export const CATEGORY_NUDGE: Record<RecommendationCategory, string> = {
  critical_issues_engagement: "Suggested: performance review before renewal.",
  bottleneck_risk: "Suggested: line up a qualified second source.",
  hidden_gems_promotion: "Suggested: evaluate for an expanded share of wallet.",
  process_improvement: "Suggested: review the flagged stage's handoffs.",
  concentration: "Suggested: diversification / second-source review.",
  critical_spend: "Suggested: confirm contract + SLA coverage.",
  tail_spend: "Suggested: review for consolidation opportunities.",
  slow_stage: "Suggested: review the stage's workflow.",
};

/**
 * The three analysis GROUPS the page is organised into — "what the analyses
 * found → what's worth acting on." Each group draws its categories from ONE
 * diagnostic analysis (Spend / Suppliers / Process). `colorVar` paints the spine
 * + title; `categories` is the display order WITHIN the group.
 */
export type ActionGroup = {
  id: "spend" | "suppliers" | "process";
  title: string;
  tagline: string;
  lead: string;
  colorVar: string;
  categories: RecommendationCategory[];
};

export const ACTION_GROUPS: ActionGroup[] = [
  {
    id: "spend",
    title: "From your Spend analysis",
    tagline: "Where the money is exposed",
    lead: "Category concentration, your most critical relationships, and the long tail — the structural shape of where spend sits.",
    colorVar: "var(--priority-steward)",
    categories: ["concentration", "critical_spend", "tail_spend"],
  },
  {
    id: "suppliers",
    title: "From your Supplier analysis",
    tagline: "Who needs attention",
    lead: "Suppliers to engage, promote, or de-risk — drawn from the value-vs-risk and performance-vs-spend screens.",
    colorVar: "var(--priority-engage)",
    categories: [
      "critical_issues_engagement",
      "hidden_gems_promotion",
      "bottleneck_risk",
    ],
  },
  {
    id: "process",
    title: "From your Process analysis",
    tagline: "Where the workflow leaks",
    lead: "Compliance gaps and the slowest internal stages in the procure-to-pay cycle.",
    colorVar: "var(--priority-improve)",
    categories: ["process_improvement", "slow_stage"],
  },
];
