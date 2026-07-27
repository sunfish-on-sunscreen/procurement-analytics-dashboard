import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireAuth } from "@/lib/auth";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cardElevation } from "@/lib/utils";
import { SHOW_METHODOLOGY } from "@/lib/feature-flags";
import { readRiskModel } from "@/lib/risk-model-server";
import { RiskModelSettings } from "@/components/Methodology/RiskModelSettings";

// ONE source of truth for section identity: number (shown in the heading and in a
// print-only suffix on every in-prose reference), title, and anchor id. In-prose
// references are NAMED anchors, never numeric strings — a "see Section 3.2" reads true
// today and silently goes stale after a renumber, so the number lives only here,
// resolved from the id. Headings keep their visible number (readers cite it); prose gets
// an anchor plus a print:inline "(§N)" so a printout stays navigable without a link.
const SECTIONS = {
  provenance: { n: "1", title: "Data Provenance & Scope" },
  population: { n: "1.1", title: "Population and scope" },
  "data-structure": { n: "1.2", title: "Data structure" },
  definitions: { n: "1.3", title: "Key definitions" },
  unit: { n: "1.4", title: "Unit of analysis" },
  repro: { n: "1.5", title: "Reproducibility" },

  "cross-cutting": { n: "2", title: "Cross-Cutting Method" },
  normalization: { n: "2.1", title: "Fixed-bound normalization" },
  "median-split": { n: "2.2", title: "Median-split classification" },
  polarity: { n: "2.3", title: "Two opposite risks — polarity" },
  "missing-data": { n: "2.4", title: "Missing-data handling" },
  aggregation: { n: "2.5", title: "Aggregation of rounded components" },
  recompute: { n: "2.6", title: "Recompute-on-read and report reproducibility" },
  hazards: { n: "2.7", title: "Cross-cutting inference hazards" },

  composite: { n: "3", title: "The Performance Composite" },
  "sub-scores": { n: "3.1", title: "Sub-scores" },
  "composite-score": { n: "3.2", title: "The composite score" },
  "weight-config": { n: "3.3", title: "Weight configuration" },
  "risk-score": { n: "3.4", title: "Risk sub-score" },
  sensitivity: { n: "3.5", title: "Weight-sensitivity analysis" },

  "per-analysis": { n: "4", title: "Per-Analysis Methods" },
  "spend-overview": { n: "4.1", title: "Spend overview" },
  abc: { n: "4.2", title: "ABC / Pareto analysis" },
  kraljic: { n: "4.3", title: "Kraljic matrix segmentation" },
  "performance-spend": { n: "4.4", title: "Performance vs spend" },
  "cycle-time": { n: "4.5", title: "Cycle time — process health" },
  recommendations: { n: "4.6", title: "Action recommendations" },
  sourcing: { n: "4.7", title: "Competitive sourcing coverage" },

  reading: { n: "5", title: "Reading the Composite and the Classification Lenses" },
  "reading-structural": { n: "5.1", title: "The composite becomes more structural the more you aggregate" },
  "reading-findings": { n: "5.2", title: "Findings about the dataset, not defects in the model" },
  "reading-lenses": { n: "5.3", title: "The analyses are not independent readings of a supplier" },

  assumptions: { n: "6", title: "Assumptions and Limitations" },
  "dead-metrics": { n: "7", title: "Dead Metrics — measured, then deliberately not shown" },
  periods: { n: "8", title: "Reporting Periods" },
  calibration: { n: "9", title: "Calibration Benchmarks" },
  references: { n: "10", title: "References" },
} as const;

type SectionId = keyof typeof SECTIONS;

// A print-safe in-prose reference. On screen it is a plain anchor link; on paper it also
// prints "(§N)" so the reader can find the target without a clickable link. The number
// comes from SECTIONS, so it can never disagree with the target heading.
function Ref({ to, children }: { to: SectionId; children: ReactNode }) {
  return (
    <>
      <a href={`#${to}`} className="text-foreground underline decoration-dotted underline-offset-2">
        {children}
      </a>
      <span className="hidden print:inline"> (§{SECTIONS[to].n})</span>
    </>
  );
}

// Anchor-scroll sub-nav. ANCHOR-SCROLL ONLY (no tabs — this page is printed, and tabs
// would print only the active one); every section stays in the DOM. Hidden when printing.
function SubNav() {
  const items: SectionId[] = [
    "provenance", "cross-cutting", "composite", "per-analysis", "reading",
    "assumptions", "dead-metrics", "periods", "calibration", "references",
  ];
  return (
    <nav className="print:hidden rounded-lg border bg-muted/30 p-3 text-sm">
      <p className="mb-2 font-medium text-foreground">On this page</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {items.map((id) => (
          <li key={id}>
            <a href={`#${id}`} className="text-muted-foreground hover:text-foreground">
              {SECTIONS[id].n}. {SECTIONS[id].title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// Headings render the visible number from SECTIONS; the anchor id is attached to the
// section wrapper, so number, id, and print-suffix all derive from one place.
function H2({ id }: { id: SectionId }) {
  return <CardTitle>{SECTIONS[id].n}. {SECTIONS[id].title}</CardTitle>;
}
function H3({ id }: { id: SectionId }) {
  return (
    <h3 className="text-base font-semibold text-foreground">
      {SECTIONS[id].n} {SECTIONS[id].title}
    </h3>
  );
}

export default async function MethodologyPage() {
  if (!SHOW_METHODOLOGY) notFound();

  await requireAuth();
  const riskModel = await readRiskModel();

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Methodology</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How this dashboard analyzes mining procurement data, and the sources
          behind it.
        </p>
      </div>

      <SubNav />

      {/* 1. Data Provenance & Scope */}
      <Card id="provenance" className={cardElevation}>
        <CardHeader>
          <H2 id="provenance" />
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section id="population" className="space-y-2">
            <H3 id="population" />
            <p>
              The dashboard covers <strong>647 purchase orders</strong> from{" "}
              <strong>55 suppliers</strong> across <strong>14 categories</strong> and 9
              supplier countries, totalling <strong>$707,687,316.20</strong> in spend.
              A purchase order is tagged to a reporting period by its{" "}
              <strong>order year</strong>.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-foreground">
                    <th className="py-1.5 pr-3 font-medium">Window</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Purchase orders</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Spend</th>
                    <th className="py-1.5 text-right font-medium">Suppliers scored</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b"><td className="py-1.5 pr-3">2024</td><td className="py-1.5 pr-3 text-right tabular-nums">240</td><td className="py-1.5 pr-3 text-right tabular-nums">$248.99M</td><td className="py-1.5 text-right tabular-nums">50</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">2025</td><td className="py-1.5 pr-3 text-right tabular-nums">250</td><td className="py-1.5 pr-3 text-right tabular-nums">$277.33M</td><td className="py-1.5 text-right tabular-nums">51</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">2026</td><td className="py-1.5 pr-3 text-right tabular-nums">157</td><td className="py-1.5 pr-3 text-right tabular-nums">$181.37M</td><td className="py-1.5 text-right tabular-nums">50</td></tr>
                  <tr><td className="py-1.5 pr-3 font-medium text-foreground">Range (all years, default)</td><td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">647</td><td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">$707.69M</td><td className="py-1.5 text-right font-medium tabular-nums text-foreground">55</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              The default view is <strong>Range</strong> (all three years). A supplier is{" "}
              <strong>
                scored only if it has at least one purchase order in the selected window
              </strong>
              , so a single year scores <strong>50, 51, and 50</strong> suppliers
              respectively — fewer than the full <strong>55-supplier roster</strong>,
              which the Range view scores in full. The roster is constant; the scored
              count is window-dependent.
            </p>
          </section>

          <section id="data-structure" className="space-y-2">
            <H3 id="data-structure" />
            <p>
              The records are a <strong>normalized 12-table document model</strong>, not
              a flat table — one row per real document, linked into the procure-to-pay
              chain:
            </p>
            <p className="rounded-md bg-muted/50 p-2 text-xs">
              Requisition → Sourcing event + Responses (competitively sourced methods
              only) → Purchase order + PO lines → Goods receipt(s) + GRN lines → Invoice
              + Invoice lines → Payment; a call-off instead draws against a Framework
              agreement.
            </p>
            <p>
              Row counts: 55 suppliers · 21 frameworks · 647 requisitions · 226 sourcing
              events · 677 responses · 647 purchase orders · 1,193 PO lines · 829 goods
              receipts · 1,508 GRN lines · 647 invoices · 1,193 invoice lines · 647
              payments. A PO-grain view (<code>EnrichedPurchase</code>) reconstructs one
              row per order from this chain; item-level detail is read from the line
              tables.
            </p>
          </section>

          <section id="definitions" className="space-y-2">
            <H3 id="definitions" />
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Three-way match</strong> — per PO line, the invoice reconciles
                with the PO and the receipt with no overpay:{" "}
                <strong>billed quantity == accepted quantity</strong> (accepted =
                received − rejected) AND{" "}
                <strong>invoice unit price == PO unit price</strong>. It tests billing
                integrity, <em>not</em> whether everything ordered arrived — a
                correctly-billed partial delivery <strong>passes</strong>. On this data,
                566 of 647 orders pass and 81 fail.
              </li>
              <li>
                <strong>Spend</strong> — the purchase-order total value
                (<code>totalValueUsd</code>), summed across orders. It is read from the
                record as posted, not recomputed as quantity × price.
              </li>
              <li>
                <strong>Unit price</strong> — a <em>line-level</em> field: the PO price
                sits on each PO line, the billed price on each invoice line. Where a
                correction has been posted, a line&apos;s effective billed price is the
                value-weighted net across its signed correction rows.
              </li>
            </ul>
          </section>

          <section id="unit" className="space-y-2">
            <H3 id="unit" />
            <p>Different surfaces score at different grains:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Supplier-level</strong> — the performance composite, ABC class,
                the Kraljic quadrant and its supply-risk score, and the performance zone.
              </li>
              <li>
                <strong>Category-level</strong> — spend by category, category
                concentration, sourcing coverage, and the cost-premium benchmark (per
                item within a category).
              </li>
              <li>
                <strong>PO-level</strong> — cycle time and its stages, and the three-way
                match.
              </li>
            </ul>
            <p>
              ⚠️{" "}
              <strong className="text-foreground">
                The Kraljic matrix plots suppliers
              </strong>{" "}
              on its two axes (spend × supply risk). Kraljic (1983) originally defined
              those axes for <strong>purchased items / product categories</strong>, not
              for suppliers; placing a whole supplier by its aggregate spend and a
              roster-derived supply-risk score is a deliberate simplification, not the
              framework&apos;s original unit.
            </p>
          </section>

          <section id="repro" className="space-y-2">
            <H3 id="repro" />
            <p>
              The dataset was{" "}
              <strong>
                generated externally and the generator is not in this repository
              </strong>
              , so <strong>the dataset is not reproducible from source</strong>. What is
              reproducible is the <em>analysis</em>: the import path takes raw operational
              measurements only, and every scorecard value is then computed server-side
              from the stored records by <code>python/scores.py</code>, deterministically
              — the same records produce the same scores on every run.
            </p>
          </section>
        </CardContent>
      </Card>

      {/* 2. Cross-Cutting Method */}
      <Card id="cross-cutting" className={cardElevation}>
        <CardHeader>
          <H2 id="cross-cutting" />
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <p>
            A handful of properties hold <em>across</em> the analyses rather than inside
            any one of them. They are collected here so each per-analysis section can name
            an input or a threshold without re-deriving the method behind it, and so the
            inference hazards — the ways reading across the data can mislead — sit in one
            place rather than scattered through the page.
          </p>

          <section id="normalization" className="space-y-2">
            <H3 id="normalization" />
            <p>
              Every sub-score is normalized to 0–100 against{" "}
              <strong>fixed industry bounds</strong>, not the population min/max, so a
              supplier is measured against absolute standards — not against whoever else
              happens to be in the dataset — and a score does not move just because the
              rest of the roster did.
            </p>
            <p className="rounded-md bg-muted/50 p-2 text-xs">
              <code>
                norm_high(v, lo, hi) = clamp((v−lo)/(hi−lo), 0, 1) × 100 · norm_low(v,
                lo, hi) = clamp((hi−v)/(hi−lo), 0, 1) × 100
              </code>
            </p>
            <p className="text-xs">
              Bounds reflect procurement conventions: near-zero-defect quality and a
              60-day lead-time ceiling; percentages are 0–100 by definition. Clamping
              means values outside a bound score 0 or 100, never negative or &gt;100.
            </p>
            <p>
              <strong className="text-foreground">
                What fixed bounds cost: two sub-score halves are throttled by their bounds.
              </strong>{" "}
              Complaint rate is scored 0–100% but real rates top out near 33%, so that
              half only occupies 66.7–100 — the defect half does roughly 2.3× the work
              inside Quality. Lead time is scored 0–60 days but real leads run 8–26.5
              days, so that half only occupies 55.8–86.7 — on-time delivery carries most
              of Delivery. The bounds are honest industry ceilings; they simply leave
              headroom this dataset never reaches.
            </p>
          </section>

          <section id="median-split" className="space-y-2">
            <H3 id="median-split" />
            <p>
              Both classification matrices cut on a <strong>median split</strong> — the
              Kraljic quadrant on the supply-risk median and the log-spend median, the
              performance zone on the composite median and the same log-spend median. The
              split direction is deliberately <em>asymmetric</em> between the two kinds of
              axis. Log-spend is continuous with no ties, so its split is strict{" "}
              <code>&gt;</code> (above the median is high-spend). The supply-risk score is a
              small integer sum with many ties at the median, so its split is{" "}
              <code>&gt;=</code> — a strict <code>&gt;</code> would dump every supplier tied
              at the median into the low-risk half and unbalance the axis. The consequence
              of splitting on a median — that a supplier near the line changes its label on
              a small score shift — is an inference hazard, treated in{" "}
              <Ref to="hazards">the cross-cutting inference hazards</Ref>.
            </p>
          </section>

          <section id="polarity" className="space-y-2">
            <H3 id="polarity" />
            <p>
              The word <em>risk</em> means two opposite things in this dashboard, and
              it is the single most likely thing to trip a reader. The{" "}
              <strong>Kraljic supply-risk score</strong> (
              <Ref to="kraljic">the Kraljic analysis</Ref>) runs{" "}
              <strong>higher = riskier</strong>{" "}
              — it is the exposure axis of the matrix. The composite&apos;s <strong>Risk sub-score</strong> (
              <Ref to="risk-score">the Risk sub-score</Ref>) runs <strong>higher = safer</strong> — it is a structural safety
              modifier on the performance score. Same word, opposite polarity, by
              design. They also share an input — the roster-concentration term — as
              the same step curve scaled: the composite carries exactly{" "}
              <strong>twice</strong> the Kraljic points (0 alternatives → 50 on the
              Kraljic axis, 100 on the composite; ≥5 → 0 on both). Read the axis
              label, not just the word.
            </p>
            <p className="text-xs">
              In configuration terms this is a single flag, <code>invertPolarity</code>: a
              composite with it set folds its weighted sum through <code>100 − x</code> so
              higher reads as safer, and one without it leaves the sum as-is so higher
              reads as riskier. It is a compute flag, not display copy — the badge each
              composite shows (&ldquo;higher = safer&rdquo; / &ldquo;higher = riskier&rdquo;)
              is authored text, never derived from the flag.
            </p>
          </section>

          <section id="missing-data" className="space-y-2">
            <H3 id="missing-data" />
            <p>
              Missing inputs are resolved <strong>asymmetrically</strong>, and the
              asymmetry is deliberate rather than an oversight, so it is stated plainly. A
              missing <strong>cost premium</strong> resolves to <strong>neutral (0)</strong>
              : a supplier with no qualifying item benchmark — because its items are
              single-source, or it never bought the same item twice — scores 0 on that
              component, exactly as an at-or-below-market supplier does. It is treated as
              &ldquo;no evidence of overpricing&rdquo;, not as a penalty. An{" "}
              <strong>unknown country</strong>, by contrast, resolves to{" "}
              <strong>maximum risk</strong> — <code>country_distance → 100</code> and{" "}
              <code>import_friction → 25</code>, the explicit safe defaults for
              &ldquo;everything else / unknown&rdquo;. The two go opposite ways on purpose:
              an unmeasurable price is genuinely uninformative, but an unidentifiable
              origin is a supply-risk fact in itself, so it is scored as the riskiest tier
              rather than waved through. Both are lookups keyed on category and country,
              never on transaction behaviour.
            </p>
          </section>

          <section id="aggregation" className="space-y-2">
            <H3 id="aggregation" />
            <p>
              Where a score is a sum of components — the Kraljic supply-risk score is
              concentration + cost premium + import friction — each component is{" "}
              <strong>rounded to two decimals first</strong> and the total is the sum of
              those rounded parts, not a rounding of the un-rounded sum. This is what lets
              the number plotted on the scatter reconcile <em>exactly</em> with the
              component bars in the detail panel: the bars add up to the dot, to the last
              digit, because the dot was never computed on a finer grain than the bars.
              The alternative — round the parts for display but plot the full-precision
              total — would show a scatter point that the panel underneath it could not
              reproduce.
            </p>
          </section>

          <section id="recompute" className="space-y-2">
            <H3 id="recompute" />
            <p>
              The transaction layer is <strong>append-only</strong>; the analytics layer is{" "}
              <strong>recompute-on-read</strong>, with no stored snapshot of a score. Every
              displayed number is derived from the current records at request time —
              single-year views from a per-period cache, range views computed live over
              the span. A change to the inputs (a correction, an import, or a weight edit)
              is followed by a full recompute of every period; nothing carries a frozen
              value that could drift from the data behind it.
            </p>
            <p>
              <strong className="text-foreground">
                What that means for a printed report.
              </strong>{" "}
              Because scores recompute rather than freeze, a report reprinted after a
              configuration change shows the <em>new</em> numbers, so the footer must
              record the configuration that produced them. Every printed report is stamped
              with each composite&apos;s version and a whole-config fingerprint (computed
              over the compute-affecting fields only, so it changes exactly when a number
              could). The printed report is therefore the only durable record of which
              configuration produced a given result — there is no role system and nothing
              else logs who changed a weight or when.
            </p>
          </section>

          <section id="hazards" className="space-y-3">
            <H3 id="hazards" />
            <p>
              Five ways of reading <em>across</em> the data can produce a confident,
              reproducible number that means nothing. Each was hit on this project or is a
              standing property of the methods used here; each is recorded so it is not
              repeated. They are inference hazards, not defects — the analyses are correct;
              the danger is in how their outputs are combined or interpreted.
            </p>

            <p>
              <strong className="text-foreground">
                (1) Simpson&apos;s paradox in the cycle-time trend.
              </strong>{" "}
              Total cycle is a mixture of five buying methods (median roughly 44 days for
              spot buys up to ~130 for direct orders), so a shift in the method mix can
              move the pooled mean opposite to how the methods themselves moved. From
              2024 to 2025 the pooled mean was essentially flat (87.0 → 87.24 days,
              +0.3%) while <strong>all five methods slowed</strong> (within-method effect
              +4.96 days: call-off +5.66, direct +6.39, RFQ +4.50, spot buy +4.18, tender
              +4.43) — the slowdown masked by a mix shift toward faster channels (−4.73).
              From 2025 to 2026 the pooled mean rose (87.24 → 89.26, +2.3%, reading as a
              worsening) while <strong>four of the five improved</strong> (within-method
              effect −3.56 days: RFQ −10.58, tender −2.45, call-off −1.51, spot buy
              −1.39, direct +0.22 essentially flat) — the rise driven entirely by a mix
              shift toward slower channels (+5.58). The fix is the shift-share
              (mix-adjusted) decomposition now shown on the Process Health trend, which
              reports the mix and within-method effects separately and flags the pooled
              figure as misleading.
            </p>
            <p>
              <strong className="text-foreground">
                (2) Selection bias in the period comparison.
              </strong>{" "}
              The within-window period comparison split the window at its midpoint by{" "}
              <code>payment</code> date, while the window itself is scoped by{" "}
              <code>order</code> date. Because an order can only be <em>paid</em> in the
              first half if its cycle was short, the early group was selected for speed
              by construction — manufacturing a highly significant &ldquo;worsening&rdquo;
              in all three windows (2024 <em>p</em> = 0.0002, 2025 <em>p</em> = 0.0001,
              2026 <em>p</em> = 5 × 10⁻¹⁰) and silently dropping the orders paid outside
              the window (32 in 2024, 38 in 2025). Splitting on order date — the same
              basis the window uses — makes the effect vanish (2024 <em>p</em> = 0.386,
              2025 <em>p</em> = 0.246, both null; 2026 has no second group) and drops no
              rows.
            </p>
            <p>
              <strong className="text-foreground">
                (3) Median-split classification churn.
              </strong>{" "}
              Every decision surface here is a{" "}
              <Ref to="median-split">median split</Ref> — the Kraljic quadrant on the
              supply-risk median, the performance zone on the composite median. A supplier
              sitting near the line changes its label on a small score shift, even when the
              overall ordering barely moves. This is a mathematical consequence of the
              cut-point choice, not a defect in the scores: the same weight perturbation
              that leaves the <em>ranking</em> almost unchanged can flip a large share of{" "}
              <em>labels</em> (the drop-one figures — up to 36.4% of performance zones —
              are in <Ref to="sensitivity">the weight-sensitivity analysis</Ref>). Read
              the ranking as robust and the quadrant / zone labels as indicative, not as
              hard categories.
            </p>

            <p>
              <strong className="text-foreground">
                (4) Variance shares are grain-dependent — always state the grain.
              </strong>{" "}
              A variance share (the fraction of composite variance a component accounts
              for, by covariance decomposition, summing to 100%) changes with the window:
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-foreground">
                    <th className="py-1.5 pr-3 font-medium">Grain</th>
                    <th className="py-1.5 pr-3 text-right font-medium">n</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Quality</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Delivery</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Process</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Risk</th>
                    <th className="py-1.5 text-left font-medium">Leader</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b"><td className="py-1.5 pr-3 font-medium text-foreground">All years (default view)</td><td className="py-1.5 pr-3 text-right tabular-nums">55</td><td className="py-1.5 pr-3 text-right tabular-nums">−1.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">35.5%</td><td className="py-1.5 pr-3 text-right tabular-nums">9.1%</td><td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">56.4%</td><td className="py-1.5">Risk</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">2024</td><td className="py-1.5 pr-3 text-right tabular-nums">50</td><td className="py-1.5 pr-3 text-right tabular-nums">−0.7%</td><td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">44.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">23.8%</td><td className="py-1.5 pr-3 text-right tabular-nums">32.8%</td><td className="py-1.5">Delivery</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">2025</td><td className="py-1.5 pr-3 text-right tabular-nums">51</td><td className="py-1.5 pr-3 text-right tabular-nums">+8.5%</td><td className="py-1.5 pr-3 text-right tabular-nums">32.9%</td><td className="py-1.5 pr-3 text-right tabular-nums">12.9%</td><td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">45.7%</td><td className="py-1.5">Risk</td></tr>
                  <tr><td className="py-1.5 pr-3">2026</td><td className="py-1.5 pr-3 text-right tabular-nums">50</td><td className="py-1.5 pr-3 text-right tabular-nums">+0.8%</td><td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">46.4%</td><td className="py-1.5 pr-3 text-right tabular-nums">15.5%</td><td className="py-1.5 pr-3 text-right tabular-nums">37.3%</td><td className="py-1.5">Delivery</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              <strong className="text-foreground">
                Consequence for reading the dashboard:
              </strong>{" "}
              a user comparing suppliers on the all-years view and then on a single year
              can get different orderings, for this systematic reason rather than because
              anything changed. On the default view the composite leans structural; on a
              single year it leans behavioural. That is not a bug, but it should be known
              before two views are compared.
            </p>
            <p>
              ⚠️{" "}
              <strong className="text-foreground">
                Standing rule: a variance share quoted without its grain is unusable.
              </strong>{" "}
              The figures above are safe to quote <em>with the grain attached</em>.
              &ldquo;Risk is the dominant term in the composite&rdquo; stated{" "}
              <em>without</em> a grain is <strong>not</strong> quotable — it is true on
              the all-years view and false on 2024 and 2026. The single claim stable at
              every grain is that <strong>Quality contributes approximately nothing</strong>{" "}
              (−1.0% to +8.5%, within ±1% at four grains of six). A fifth population —
              all 151 supplier-period rows pooled (Quality +2.4%, Delivery +42.6%,
              Process +17.5%, Risk +37.5%) — is analytically useful for the spread table
              in <Ref to="reading-structural">the aggregation note</Ref> but corresponds
              to <em>no view any user sees</em>, and should not be quoted as a description
              of the dashboard.
            </p>

            <p>
              ⚠️{" "}
              <strong className="text-foreground">
                (5) Artifact significance — a significant, reproducible number that still
                means nothing.
              </strong>{" "}
              The most dangerous hazard here is a statistic that clears every test of{" "}
              <em>reliability</em> — a small p-value, stable across re-runs — while the{" "}
              <em>quantity being tested</em> is an artifact of how it was constructed
              rather than a fact about the world. Significance answers &ldquo;is this
              reliably non-zero&rdquo;; it never answers &ldquo;does this mean
              anything&rdquo;, and the gap between the two questions is where a fabricated
              finding lives. It has appeared three times on this project, each a different
              construction:
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Requisition estimate accuracy</strong> — a mean bias significant
                at <em>p</em> &lt; 10⁻¹¹, which is purely the Jensen effect of a{" "}
                <em>nonlinear transform</em> (<code>1/(1+v) − 1</code>) of a fixed
                symmetric window; the p-value measures how precisely a known constant was
                pinned down by 647 samples, nothing about anyone&apos;s estimating (
                <Ref to="dead-metrics">dead-metrics catalogue</Ref>).
              </li>
              <li>
                <strong>The twelve-requester finding</strong> — a max-statistic
                permutation returning <em>p</em> = 0.0083 that <em>cleared Bonferroni</em>{" "}
                and was still refused, because the estimate is computed <em>from</em> the
                actual value, so causality runs backwards and there is no mechanism for the
                finding to be about (<Ref to="dead-metrics">dead-metrics catalogue</Ref>).
              </li>
              <li>
                <strong>Delivery-timing CV</strong> — a candidate risk component
                (<code>delivery_variability</code> as a coefficient of variation) returned{" "}
                <em>p</em> = 0.033 predicting next-period lateness. It dissolved under four
                checks, in order: the <strong>stable estimator</strong> (the same spread as
                a raw standard deviation is dead null, <em>p</em> = 0.97 — the CV, not the
                variability, carried the signal); the <strong>level correlation</strong>{" "}
                (the CV is −0.56 correlated with the mean days-late, so it is the level
                re-expressed through a denominator, not a spread); <strong>multiplicity</strong>{" "}
                (one hit in four tests, Bonferroni 0.133); and the{" "}
                <strong>per-transition split</strong> (significant in only one of the two
                year transitions, <em>p</em> = 0.044 against 0.22). Its full entry is in
                the <Ref to="dead-metrics">dead-metrics catalogue</Ref>.
              </li>
            </ul>
            <p>
              ⚠️{" "}
              <strong className="text-foreground">
                Standing procedure — test the outcome before the predictor.
              </strong>{" "}
              The delivery-CV near-miss was avoidable. Before testing whether a candidate
              predicts a forward outcome (next-period lateness, next-period match
              failure), first establish that the <em>outcome itself is autocorrelated</em>{" "}
              — that a supplier&apos;s value this period carries into next period — and test
              that autocorrelation <strong>per transition, never pooled</strong>. Pooling
              overlapping year-pairs inflates it: next-period lateness pooled reads{" "}
              <em>ρ</em> = −0.32, <em>p</em> = 0.005, but per transition it is −0.22 and
              −0.36, both non-significant. If the outcome does not persist, no predictor
              can honestly pass, and running the prediction test only invites a spurious
              hit that then has to be dismantled after the fact. Report the dead outcome
              and stop.
            </p>
          </section>
        </CardContent>
      </Card>

      {/* 3. The Performance Composite */}
      <Card id="composite" className={cardElevation}>
        <CardHeader>
          <H2 id="composite" />
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <p>
            Each supplier carries a 0–100 <strong>composite performance score</strong>,
            built from four sub-scores that are <strong>derived in code from raw
            operational data</strong> (deliveries, three-way-match results, and per-PO
            quality records — defect and complaint counts). Every sub-score is normalized
            to 0–100 against fixed industry bounds (
            <Ref to="normalization">fixed-bound normalization</Ref>). The source data
            contains <strong>operational measurements only</strong>; all scorecard values
            are computed in code (<code>python/scores.py</code>) at import, so every stored
            score is reproducible from the underlying records. The composite is the
            performance axis of <Ref to="performance-spend">performance vs spend</Ref> and
            the performance input to the other classification lenses.
          </p>

          <section id="sub-scores" className="space-y-2">
            <H3 id="sub-scores" />
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Quality</strong> — average of defect rate (bound 0–10%) and
                complaint rate — the share of orders with a complaint (0–100%) — both
                lower-is-better, derived <strong>per purchase order</strong> from defect
                and complaint counts.
              </li>
              <li>
                <strong>Delivery</strong> — average of on-time-delivery % (0–100,
                higher-better) and average lead time (0–60 days, lower-better).
              </li>
              <li>
                <strong>Process</strong> — three-way-match pass rate (0–100).
              </li>
              <li>
                <strong>Risk</strong> — a purely structural index: geography + roster
                concentration (see <Ref to="risk-score">the Risk sub-score</Ref>).
              </li>
            </ul>
          </section>

          <section id="composite-score" className="space-y-2">
            <H3 id="composite-score" />
            <p>
              The <strong>Performance score</strong> shown across the dashboard is a{" "}
              <strong>composite</strong> of the four weighted sub-scores (quality 30%,
              delivery 30%, process 22%, risk 18%).
            </p>
            <p className="rounded-md bg-muted/50 p-2 text-xs">
              <code>
                composite = 0.30·quality + 0.30·delivery + 0.22·process + 0.18·risk
              </code>
            </p>
            <p>
              Quality and delivery carry the most weight — in mining, defective or late
              equipment and consumables halt production. Process reflects documentation
              discipline; the structural Risk sub-score acts as a modifier. A former{" "}
              <strong>Service</strong> dimension (RFx response rate + average response
              time) was <strong>removed</strong> — it relied on manual survey estimates
              the transaction data doesn&apos;t measure — and its 15% weight was
              redistributed across the remaining four dimensions in proportion to their
              prior weights (the clean 30/30/22/18 above), leaving the relative
              priorities unchanged: Quality and Delivery co-dominant, Process above Risk.
            </p>
            <p>
              ⚠️{" "}
              <strong className="text-foreground">
                The dimensions follow a framework; the weights do not.
              </strong>{" "}
              The scoring dimensions come from <strong>Kraljic (1983)</strong> — the
              exposure / supply-risk framework — and <strong>CIPS</strong>{" "}
              supplier-scorecard guidance, which names the KPI categories a scorecard
              should cover (order fulfilment, delivery, quality, vendor risk). Neither
              prescribes weights, a scoring scale, or an aggregation formula;{" "}
              <strong>
                CIPS explicitly instructs the organisation to assign the weighting
                itself
              </strong>
              . The weights used here — 30/30/22/18 on the composite, and the component
              weights inside each risk score — are therefore an{" "}
              <strong>organisational calibration, not a citation</strong>. They reflect
              mining priorities (operational reliability dominant, audit compliance
              elevated); no published source prescribes them, and industry examples
              differ widely (40/30/20/10, 30/25/20/15/10, and others).{" "}
              <strong className="text-foreground">
                The current values are defaults pending organisational input
              </strong>{" "}
              — held in one configuration file (<code>config/risk-model.json</code>), so
              a recalibration is a settings change, not a code change. The formal
              elicitation method for this problem, the{" "}
              <strong>Analytic Hierarchy Process</strong> (Saaty, 1980), was{" "}
              <strong>not used</strong>: it requires pairwise judgments from a domain
              expert panel that was unavailable.
            </p>
            <p className="text-xs">
              For reference, AHP derives weights from pairwise comparisons of the
              dimensions on a 9-point scale — the weights are the priority (eigenvector)
              of the comparison matrix, accepted when its consistency ratio is below 0.1.
              That matrix needs an expert panel to fill it, which is the input this
              project does not have.
            </p>
          </section>

          <section id="weight-config" className="space-y-3">
            <H3 id="weight-config" />
            <p>
              The weights above are editable here — this is the organisational
              calibration the provenance note describes. Adjusting a weight or disabling
              a component saves a new config version and recomputes every period; the
              report footer then stamps that version, so a printed result stays traceable
              to the configuration that produced it (
              <Ref to="recompute">recompute-on-read and report reproducibility</Ref>).
              Every value is a default pending organisational input. Each component is
              scored on a normalized 0–100 scale and multiplied by its weight; the emitted
              point values stay on the original scale and are byte-identical (see the
              reconciliation note under <Ref to="kraljic">the Kraljic analysis</Ref>).
            </p>
            <p>
              <strong className="text-foreground">Access and provenance.</strong> Weight
              configuration is unrestricted: the project has no role system, so any user
              who can reach this page can change the weights, and nothing records who
              changed a weight or when. Because the labels move with the weights, the
              configuration that produced a given result matters — and the{" "}
              <strong>printed report is the only record of it</strong>. Every printed
              supplier brief and category deep-dive is stamped in its footer with the
              active config version and generation date, so a printout is reproducible
              from its stamp.
            </p>
            <RiskModelSettings initialModel={riskModel} />
          </section>

          <section id="risk-score" className="space-y-2">
            <H3 id="risk-score" />
            <p className="rounded-md bg-muted/50 p-2 text-xs">
              <code>
                risk = 100 − (0.6·country_distance + 0.4·roster_concentration)
              </code>
            </p>
            <p>
              Higher = safer. The sub-score is <strong>purely structural</strong> —
              geography plus supplier availability, with no performance or complaint
              term. Geographic distance tiers: Indonesia 0 · ASEAN 30 · Asia-Pacific 60 ·
              other 100. <strong>Roster concentration</strong> is a continuous 0–100
              measure of how few alternatives exist in the same category across the full
              roster (true single source → 100, ≥5 alternatives → 0) — the same roster
              signal the Kraljic supply-risk axis uses. The score is fully deterministic,
              with no random component.
            </p>
            <p>
              <strong className="text-foreground">
                What the Risk sub-score measures — and does not.
              </strong>{" "}
              Both components are <strong>static lookups</strong>:{" "}
              <code>country_distance</code> is keyed on the supplier&rsquo;s country,{" "}
              <code>roster_concentration</code> on the purchase category. Neither is
              derived from transaction behaviour. The Risk dimension therefore reflects{" "}
              <strong>
                properties of what is bought and from where, not supplier conduct
              </strong>{" "}
              — two suppliers in the same category and country receive an identical risk
              contribution regardless of their delivery, quality, or process record.
            </p>
            <p>
              The sub-score is carried almost entirely by geography. In the drop-one test
              (<Ref to="sensitivity">weight-sensitivity analysis</Ref>), dropping{" "}
              <code>country_distance</code> collapses the risk_score ranking to Spearman{" "}
              <strong>0.56–0.61</strong> and flips{" "}
              <strong>22–27% of performance zones</strong>; dropping{" "}
              <code>roster_concentration</code> leaves ρ ≈ 0.89 and moves ≤8% of zones.{" "}
              <code>country_distance</code> alone carries the sub-score.
            </p>
            <p>
              By contrast the <strong>Kraljic supply-risk score</strong> (
              <Ref to="kraljic">the Kraljic analysis</Ref>) adds one <em>computed</em>{" "}
              component, <code>cost_premium</code>, benchmarked from actual purchase
              prices — and it shows: the distinct supply_risk_score values per period
              (<strong>32 / 33 / 27</strong>) outnumber the distinct (category, country)
              pairs (<strong>29</strong>), so the Kraljic score does discriminate between
              two suppliers in the same category and country. The composite Risk sub-score,
              built only from lookups, cannot.
            </p>
            <p className="text-xs">
              Note: this composite <strong>Risk sub-score</strong> is distinct from the{" "}
              <strong>Kraljic supply-risk score</strong> (
              <Ref to="kraljic">the Kraljic analysis</Ref>) — same word, different metric,
              opposite polarity by design (here higher = safer; on the Kraljic axis higher
              = riskier; see <Ref to="polarity">polarity</Ref>). The old complaint and
              binary single-source terms were dropped: complaints now live only in Quality
              (avoiding double-counting), and the single-source flag was replaced by the
              continuous roster-concentration measure the two scores share.
            </p>
          </section>

          <section id="sensitivity" className="space-y-2">
            <H3 id="sensitivity" />
            <p>
              <strong className="text-foreground">
                Validation — weight-sensitivity analysis.
              </strong>{" "}
              Because the weights were not formally derived, they are validated the
              recognised way: perturb them and measure what moves. A{" "}
              <strong>drop-one</strong> test disables each component in turn,
              renormalises the survivors, re-runs the real scoring code, and measures the
              result <em>two</em> ways — the <strong>ranking</strong> and the{" "}
              <strong>classification</strong>. They answer different questions and give
              different answers.
            </p>
            <p>
              <strong className="text-foreground">Ranking is robust.</strong>{" "}
              Spearman-correlating the drop-one supplier ranking against the original, no
              single weight reorders the portfolio materially: on the all-years composite
              (55 suppliers, the default view) dropping Quality leaves it almost unchanged
              (ρ = 0.97), Process 0.94, Delivery 0.86, and Risk moves it most (ρ = 0.72).{" "}
              <strong>
                Every drop-one shown here — the four composite dimensions and the three
                supply-risk components, in every window — stays at or above 0.72.
              </strong>{" "}
              The performance-risk sub-score&apos;s own two internals are the one
              exception, treated in <Ref to="risk-score">the Risk sub-score</Ref>:
              dropping <code>country_distance</code> takes that ranking down to ρ =
              0.56–0.61.{" "}
              (Quality is least influential at every grain; per{" "}
              <Ref to="hazards">the grain-dependence hazard</Ref> the figures are
              grain-dependent. This is a different test from the delivery-score
              half-weighting drop-one in the{" "}
              <Ref to="dead-metrics">dead-metrics catalogue</Ref>, ρ = +0.727 / +0.794,
              which probes the two inputs <em>inside</em> one sub-score.)
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-foreground">
                    <th rowSpan={2} className="py-1.5 pr-3 text-left align-bottom font-medium">Window</th>
                    <th colSpan={4} className="py-1.5 pr-3 text-center font-medium">Composite — drop dimension (ρ)</th>
                    <th colSpan={3} className="py-1.5 text-center font-medium">Supply risk — drop component (ρ)</th>
                  </tr>
                  <tr className="border-b text-foreground">
                    <th className="py-1.5 pr-3 text-right font-medium">Quality</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Delivery</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Process</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Risk</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Concentration</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Cost premium</th>
                    <th className="py-1.5 text-right font-medium">Import friction</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b"><td className="py-1.5 pr-3">2024</td><td className="py-1.5 pr-3 text-right tabular-nums">0.98</td><td className="py-1.5 pr-3 text-right tabular-nums">0.82</td><td className="py-1.5 pr-3 text-right tabular-nums">0.87</td><td className="py-1.5 pr-3 text-right tabular-nums">0.77</td><td className="py-1.5 pr-3 text-right tabular-nums">0.80</td><td className="py-1.5 pr-3 text-right tabular-nums">0.93</td><td className="py-1.5 text-right tabular-nums">0.80</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">2025</td><td className="py-1.5 pr-3 text-right tabular-nums">0.95</td><td className="py-1.5 pr-3 text-right tabular-nums">0.82</td><td className="py-1.5 pr-3 text-right tabular-nums">0.92</td><td className="py-1.5 pr-3 text-right tabular-nums">0.73</td><td className="py-1.5 pr-3 text-right tabular-nums">0.82</td><td className="py-1.5 pr-3 text-right tabular-nums">0.93</td><td className="py-1.5 text-right tabular-nums">0.80</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">2026</td><td className="py-1.5 pr-3 text-right tabular-nums">0.98</td><td className="py-1.5 pr-3 text-right tabular-nums">0.83</td><td className="py-1.5 pr-3 text-right tabular-nums">0.94</td><td className="py-1.5 pr-3 text-right tabular-nums">0.84</td><td className="py-1.5 pr-3 text-right tabular-nums">0.86</td><td className="py-1.5 pr-3 text-right tabular-nums">0.91</td><td className="py-1.5 text-right tabular-nums">0.80</td></tr>
                  <tr><td className="py-1.5 pr-3 font-medium text-foreground">All years</td><td className="py-1.5 pr-3 text-right tabular-nums">0.97</td><td className="py-1.5 pr-3 text-right tabular-nums">0.86</td><td className="py-1.5 pr-3 text-right tabular-nums">0.94</td><td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">0.72</td><td className="py-1.5 pr-3 text-right tabular-nums">0.84</td><td className="py-1.5 pr-3 text-right tabular-nums">0.92</td><td className="py-1.5 text-right tabular-nums">0.81</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              <strong className="text-foreground">Classification is not robust.</strong>{" "}
              The same perturbation moves a large share of suppliers across a decision
              boundary. Dropping Risk from the composite flips{" "}
              <strong>36.4% of performance zones</strong> on the all-years view; dropping
              a single supply-risk component moves <strong>6–28% of Kraljic quadrants</strong>,
              depending on the window and the component. Why the two disagree — a small
              score shift flips a label near a median line while barely moving the overall
              ordering — is the median-split churn hazard (
              <Ref to="hazards">cross-cutting inference hazards</Ref>).
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-foreground">
                    <th rowSpan={2} className="py-1.5 pr-3 text-left align-bottom font-medium">Window</th>
                    <th colSpan={4} className="py-1.5 pr-3 text-center font-medium">Composite — % zone change</th>
                    <th colSpan={3} className="py-1.5 text-center font-medium">Supply risk — % Kraljic quadrant change</th>
                  </tr>
                  <tr className="border-b text-foreground">
                    <th className="py-1.5 pr-3 text-right font-medium">Quality</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Delivery</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Process</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Risk</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Concentration</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Cost premium</th>
                    <th className="py-1.5 text-right font-medium">Import friction</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b"><td className="py-1.5 pr-3">2024</td><td className="py-1.5 pr-3 text-right tabular-nums">0.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">16.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">12.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">28.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">28.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">16.0%</td><td className="py-1.5 text-right tabular-nums">18.0%</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">2025</td><td className="py-1.5 pr-3 text-right tabular-nums">3.9%</td><td className="py-1.5 pr-3 text-right tabular-nums">3.9%</td><td className="py-1.5 pr-3 text-right tabular-nums">3.9%</td><td className="py-1.5 pr-3 text-right tabular-nums">31.4%</td><td className="py-1.5 pr-3 text-right tabular-nums">19.6%</td><td className="py-1.5 pr-3 text-right tabular-nums">21.6%</td><td className="py-1.5 text-right tabular-nums">21.6%</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">2026</td><td className="py-1.5 pr-3 text-right tabular-nums">4.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">8.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">8.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">28.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">6.0%</td><td className="py-1.5 pr-3 text-right tabular-nums">26.0%</td><td className="py-1.5 text-right tabular-nums">26.0%</td></tr>
                  <tr><td className="py-1.5 pr-3 font-medium text-foreground">All years</td><td className="py-1.5 pr-3 text-right tabular-nums">3.6%</td><td className="py-1.5 pr-3 text-right tabular-nums">10.9%</td><td className="py-1.5 pr-3 text-right tabular-nums">7.3%</td><td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">36.4%</td><td className="py-1.5 pr-3 text-right tabular-nums">18.2%</td><td className="py-1.5 pr-3 text-right tabular-nums">14.5%</td><td className="py-1.5 text-right tabular-nums">18.2%</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              <strong className="text-foreground">How to read this.</strong> The{" "}
              <em>ranking</em> is safe to use for prioritisation — it holds under any of
              these weight choices. The{" "}
              <strong>
                quadrant and zone labels should be read as indicative, not as hard
                categories
              </strong>
              : a supplier near a boundary can land on either side under a defensible
              reweighting. This is also why the weights are configurable rather than
              fixed — the labels are genuinely sensitive to the weight choice, so the
              choice belongs to the organisation, not to the code.
            </p>
          </section>
        </CardContent>
      </Card>

      {/* ==SECTIONS_END== */}
    </div>
  );
}
