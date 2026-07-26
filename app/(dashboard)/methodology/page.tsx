import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cardElevation } from "@/lib/utils";
import { SHOW_METHODOLOGY } from "@/lib/feature-flags";

export default async function MethodologyPage() {
  if (!SHOW_METHODOLOGY) notFound();

  await requireAuth();

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Methodology</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How this dashboard analyzes mining procurement data, and the sources
          behind it.
        </p>
      </div>

      {/* 1. Project Background */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>1. Project Background</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            This dashboard analyzes procurement activity for a mid-sized
            Indonesian coal-mining operation — the suppliers it buys from, the
            purchase orders it raises, and how those orders move through the
            procure-to-pay (P2P) lifecycle.
          </p>
          <p>
            Procurement in heavy industry is high-stakes and high-volume: a small
            number of strategic suppliers account for the bulk of spend, late
            deliveries can halt production, and manual processes create payment
            delays and exception rework. The dashboard addresses three blind
            spots that procurement teams typically struggle with — visibility
            into <strong>spend concentration</strong>, into{" "}
            <strong>supplier quality and risk</strong>, and into{" "}
            <strong>process efficiency</strong> — by turning raw transaction data
            into three fixed, defensible analyses.
          </p>
          <p>
            The underlying data is synthetic, but it is calibrated against
            published industry benchmarks so that the patterns (spend skew, cycle
            times, quality distributions) are realistic and the analytical methods
            can be demonstrated meaningfully.
          </p>
        </CardContent>
      </Card>

      {/* 2. Data Sources */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>2. Data Sources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <div className="rounded-md border-l-4 border-primary bg-muted/50 p-3 font-medium text-foreground">
            This dashboard uses synthetic data generated for demonstration
            purposes. The data has been calibrated against industry benchmarks for
            realism.
          </div>
          <p>The calibration sources are:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>APQC Open Standards Benchmarking</strong> — procure-to-pay
              cycle times.
            </li>
            <li>
              <strong>Hackett Group P2P automation case studies</strong> —
              automation impact metrics.
            </li>
            <li>
              <strong>CIPS Knowledge Hub supplier scorecard methodology</strong> —
              the supplier-KPI categories (quality, delivery, risk). CIPS names the
              categories; it prescribes no weights (see Section 4.2).
            </li>
            <li>
              <strong>MOPS Singapore</strong> (Mean of Platts Singapore) — fuel
              pricing benchmarks.
            </li>
            <li>
              <strong>AME mining cost reports</strong> — commodity pricing
              reference.
            </li>
          </ul>
          <p>
            The dataset was originally generated externally (the generator is
            not in this repository). The import path takes{" "}
            <strong>raw operational measurements only</strong>; every scorecard
            value is then <strong>computed server-side at import</strong> by{" "}
            <code>python/scores.py</code>, deterministically, so each stored score
            is reproducible from the underlying records. A full from-scratch
            generator is planned for a future phase.
          </p>
        </CardContent>
      </Card>

      {/* 3. The Four Analyses */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>3. The Four Analyses</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              3.1 ABC / Pareto Analysis
            </h3>
            <p>
              Classifies suppliers by their cumulative contribution to total
              spend. Suppliers are ranked from highest to lowest spend, and the
              running cumulative percentage determines each supplier&apos;s class
              using <strong>fixed thresholds</strong>:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Class A</strong> — the suppliers making up the top 80% of
                spend (strategic, high-touch).
              </li>
              <li>
                <strong>Class B</strong> — the next 15% of spend (preferred,
                periodic review).
              </li>
              <li>
                <strong>Class C</strong> — the bottom 5% of spend (tail,
                consolidation candidates).
              </li>
            </ul>
            <p>
              Output includes each supplier&apos;s rank, % of spend, cumulative %,
              ABC class.
            </p>
            <p className="text-xs">
              Reference: Juran&apos;s Pareto principle (1951); CIPS spend-analysis
              methodology.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              3.2 Kraljic Matrix Segmentation
            </h3>
            <p>
              A deterministic, two-axis segmentation that maps each supplier onto
              the classic Kraljic purchasing portfolio matrix:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Profit Impact</strong> (X-axis) — supplier share of total
                spend (%), shown on a log scale so suppliers spread readably;
                high/low split at the median.
              </li>
              <li>
                <strong>Supply Risk</strong> (Y-axis) — a 0–100 composite of three
                capped components (defined below), summed and clipped to 100.
              </li>
            </ul>
            <p className="font-medium text-foreground">Supply-risk components</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Supply concentration</strong> (≤50) — a step curve on the
                number of <em>other</em> suppliers in the same category across the
                full supplier roster (all known suppliers, active or not):{" "}
                <code>0 → 50</code> (true single source), <code>1 → 35</code>,{" "}
                <code>2 → 22</code>, <code>3 → 12</code>, <code>4 → 5</code>,{" "}
                <code>≥5 → 0</code>. This <em>merges</em> the former single-source and
                category-competition components into one measure derived purely from
                the live roster — so it can never contradict the actual supplier set
                (the prior stored single-source flag disagreed with the roster for
                ~91% of flagged suppliers and double-counted with competition).
              </li>
              <li>
                <strong>Cost premium</strong> (≤25) — <em>period-scoped</em>, from
                purchase prices. For each item the benchmark is the spend-weighted
                average unit price across <em>all</em>{" "}
                suppliers selling it in the period. A supplier&apos;s item premium ={" "}
                <code>supplier_avg_unit_price / item_avg − 1</code>, counted only
                when that supplier×item has <strong>≥2 POs</strong>{" "}
                (n=1 excluded as noise) and the item has ≥2 suppliers (single-source items have no
                benchmark → neutral). The supplier&apos;s overall premium is the
                spend-weighted average of its qualifying item premiums; points ={" "}
                <code>clip(premium × 62.5, 0, 25)</code> — so +8% → 5, +20% → 12.5,
                +40%+ → 25; at or below market → <code>0</code> (never negative).
                Suppliers with no qualifying items score <code>0</code>.
              </li>
              <li>
                <strong>Import friction</strong> (≤25) — reflects Indonesia&apos;s{" "}
                <em>trade-agreement coverage</em> (AFTA, RCEP), i.e. how easy/cheap
                an origin is to import from — <em>not</em> geographic distance:{" "}
                <code>ID → 0</code> (domestic), <code>AFTA/ASEAN → 8</code>,{" "}
                <code>RCEP non-ASEAN (JP, KR, CN, AU, NZ) → 16</code>, everything
                else / unknown → <code>25</code> (explicit safe default).
              </li>
            </ul>
            <p className="text-xs">
              The dataset is synthetic but realistic — prices, origins, and
              category structure mirror Indonesian mining-procurement patterns.
            </p>
            <p>
              A <strong>median split</strong> on each axis divides the supplier
              set into four quadrants, each mapping to a distinct management
              approach:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Strategic</strong> (high spend, high risk) — partnership
                and joint planning.
              </li>
              <li>
                <strong>Leverage</strong> (high spend, low risk) — competitive
                negotiation and volume consolidation.
              </li>
              <li>
                <strong>Bottleneck</strong> (low spend, high risk) — secure
                supply, develop alternatives, buffer stock.
              </li>
              <li>
                <strong>Routine</strong> (low spend, low risk) — automate and
                simplify.
              </li>
            </ul>
            <p>
              Unlike clustering, the assignment is fully deterministic — the same
              data always produces the same quadrants — and the axes are directly
              interpretable in procurement terms.
            </p>
            <p className="text-xs">
              Reference: Kraljic, P. (1983). &ldquo;Purchasing must become supply
              management.&rdquo; Harvard Business Review.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              3.3 Performance vs Spend Diagnostic
            </h3>
            <p>
              A two-axis diagnostic crossing spend volume with supplier
              performance score. Suppliers are split into 4 zones via median
              lines:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Stars</strong> (high spend + high performance): preserve
                and partner.
              </li>
              <li>
                <strong>Critical Issues</strong> (high spend + low performance):
                top priority for engagement.
              </li>
              <li>
                <strong>Hidden Gems</strong> (low spend + high performance):
                promotion candidates.
              </li>
              <li>
                <strong>Long Tail</strong> (low spend + low performance):
                simplify or rationalize.
              </li>
            </ul>
            <p>
              The diagnostic cross-references with the Kraljic quadrant analysis
              via the color coding on the scatter, surfacing engagement
              priorities. Performance score uses the composite score (quality 30%,
              delivery 30%, process 22%, risk 18% — see Section 4.2, where the weights
              are an organisational calibration choice, not a CIPS prescription).
            </p>
            <p className="text-xs">
              Reference: CIPS supplier scorecard methodology (dimension selection);
              cross-tabulation diagnostic pattern from strategic sourcing practice.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              3.4 Cycle Time — Process Health Monitoring + Period Comparison
            </h3>
            <p>
              The Cycle Time page monitors total procure-to-pay duration as an
              ongoing process-health signal rather than a one-time before/after
              event. It applies six statistical methods:
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                <strong>Time-series descriptive statistics</strong>: monthly
                average cycle time with a 3-month rolling average for trend
                smoothing.
              </li>
              <li>
                <strong>Distribution analysis</strong>: median and the{" "}
                <strong>typical range</strong> (interquartile range, IQR) — the
                P25–P75 band covering the middle 50% of POs, computed via
                linear-interpolation quantiles — plus a percentile summary of the
                cycle-time distribution.
              </li>
              <li>
                <strong>Stage-level descriptive statistics</strong>: PR to PO,
                PO to delivery, delivery to invoice, and invoice to payment
                subprocess durations.
              </li>
              <li>
                <strong>Longest-cycle orders</strong>: a descriptive cut listing the
                orders furthest above the window&apos;s mean total cycle. See 3.4.1 for
                what this is and — importantly — what it is not.
              </li>
              <li>
                <strong>Mann-Whitney U non-parametric hypothesis test</strong>:
                a period-vs-period comparison via a two-sample
                non-parametric test. Chosen over Student&apos;s t-test because it
                assumes nothing about the shape of the distribution — which matters
                here, since the cycle distribution is a bounded plateau rather than a
                bell curve (see 3.4.1). Note it is <em>not</em> chosen because the data
                is skewed: measured skew is approximately zero (+0.02). The reason is
                the flat, bounded shape and the absence of a normal tail, not asymmetry.
              </li>
              <li>
                <strong>Rank-biserial correlation effect size</strong>:
                complementary to the U statistic; interpreted via Cohen&apos;s
                conventions (small ≈ 0.1, medium ≈ 0.3, large ≈ 0.5).
              </li>
            </ol>
            <p>
              The supplier roster surfaces three per-supplier flags:{" "}
              <strong>Has long-cycle POs</strong> (at least one order in the
              longest-cycle cut described in 3.4.1);{" "}
              <strong>Inconsistent</strong> — a supplier whose
              typical range (IQR) exceeds 1.5× the median of all suppliers&apos;
              IQRs, the Tukey convention for unusually wide spread; and{" "}
              <strong>Stage-dominated POs</strong>{" "}
              (at least one PO where a single procure-to-pay stage exceeds 60% of
              that PO&apos;s total cycle).
            </p>
            <h4 className="pt-2 text-sm font-semibold text-foreground">
              3.4.1 The longest-cycle cut is descriptive, not an outlier test
            </h4>
            <p>
              <strong className="text-foreground">
                What the rule is:
              </strong>{" "}
              an order is listed when its total cycle sits more than two standard
              deviations above the mean of the selected window. In practice that is a
              top-percentile cut — it selects roughly the slowest 1% of orders (6 of
              647 across the full range; 3, 1 and 2 in 2024, 2025 and 2026).
            </p>
            <p>
              <strong className="text-foreground">
                What it is not: a normality-based outlier test.
              </strong>{" "}
              Describing this as &ldquo;2σ&rdquo; or &ldquo;z-score anomaly
              detection&rdquo; would assert a distributional basis this data does not
              have. Total cycle time here is a bounded plateau, not a bell curve:
              excess kurtosis is <strong>−1.19</strong> pooled (−1.23 / −1.27 / −0.98
              by year), skew is essentially zero, and Shapiro-Wilk rejects normality
              outright (p ≈ 4 × 10⁻¹²). The practical consequence is decisive — the
              largest z-score anywhere in the data is only <strong>2.30</strong>, and{" "}
              <strong>
                every genuine spread-based detector flags nothing at all
              </strong>
              : Tukey 1.5×, Tukey 3×, MAD-z &gt; 3.5 and z &gt; 3 each return zero
              orders in every window. Nothing in this dataset is an outlier in any
              standard sense. The list is useful as &ldquo;show me the slowest
              orders&rdquo;; it is not evidence that anything is anomalous.
            </p>
            <p>
              <strong className="text-foreground">
                The flagged set skews to long-lead-time buying methods.
              </strong>{" "}
              Cycle time is near-deterministic in buying method, and the threshold sits
              around 160 days — above the <em>maximum</em> cycle of every method except
              one. Spot buys top out at 68 days, call-offs at 109, RFQs and tenders at
              149; only direct awards (max 171) can reach it at all. Every flagged order
              in the current data is a direct award. So the flag is, in effect, a proxy
              for &ldquo;this was a direct purchase&rdquo; — which is why the buying
              method is shown next to each listed order. A long cycle on a direct award
              is the expected shape of that channel, not a process failure.
            </p>
            <p>
              This section follows the same principle as Section 9.5: a measure that
              cannot support the claim its name implies is documented rather than quietly
              relabelled. The rule is unchanged and the numbers are unchanged — only the
              description has been corrected to match what is actually computed.
            </p>

            <p>
              Period comparison is a <strong>midpoint split of the currently
              selected period</strong> — its first half against its second — so it
              measures drift <em>within</em> the period, not year over year. The
              analysis also reports cycle-time descriptives and 3-way match pass
              rates per Kraljic quadrant.
            </p>
            <p className="text-xs">
              Reference: Mann &amp; Whitney (1947); Cohen (1988).
            </p>
          </section>
        </CardContent>
      </Card>

      {/* 4. Supplier Scorecard Methodology */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>4. Supplier Scorecard Methodology</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <p>
            Each supplier carries a 0–100 <strong>composite performance score</strong>,
            built from four sub-scores that are <strong>derived in code from raw
            operational data</strong> (deliveries, three-way-match results, and per-PO
            quality records — defect and complaint counts). Every sub-score is normalized
            to 0–100 against <strong>fixed industry bounds</strong>, so a supplier is
            measured against absolute standards — not against whoever else happens to be
            in the dataset. The source data contains <strong>operational measurements
            only</strong>; all scorecard values are computed in code (
            <code>python/scores.py</code>) at import, so every stored score is
            reproducible from the underlying records.
          </p>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">4.1 Sub-scores</h3>
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
                concentration (see 4.3).
              </li>
            </ul>
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
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              4.2 Performance score
            </h3>
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
                Every drop-one, in every window and on both risk scores, stays at or
                above 0.72.
              </strong>{" "}
              (Quality is least influential at every grain; per Section 10.2 the figures
              are grain-dependent. This is a different test from the delivery-score
              half-weighting drop-one in Section 9.5, ρ = +0.727 / +0.794, which probes
              the two inputs <em>inside</em> one sub-score.)
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
              depending on the window and the component.
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
              <strong className="text-foreground">Why the two disagree.</strong> Every
              decision surface here is a <strong>median split</strong> — the Kraljic
              quadrant on the supply-risk median, the performance zone on the composite
              median. A supplier sitting near the line changes its label on a small score
              shift, even when the overall ordering barely moves. This is a mathematical
              consequence of the cut-point choice, not a defect in the scores.
            </p>
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
            <p className="text-xs">
              For reference, AHP derives weights from pairwise comparisons of the
              dimensions on a 9-point scale — the weights are the priority (eigenvector)
              of the comparison matrix, accepted when its consistency ratio is below 0.1.
              That matrix needs an expert panel to fill it, which is the input this
              project does not have.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">4.3 Risk score</h3>
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
              (Section 4.2), dropping <code>country_distance</code> collapses the
              risk_score ranking to Spearman <strong>0.56–0.61</strong> and flips{" "}
              <strong>22–27% of performance zones</strong>; dropping{" "}
              <code>roster_concentration</code> leaves ρ ≈ 0.89 and moves ≤8% of zones.{" "}
              <code>country_distance</code> alone carries the sub-score.
            </p>
            <p>
              By contrast the <strong>Kraljic supply-risk score</strong> (Section 3.2)
              adds one <em>computed</em> component, <code>cost_premium</code>,
              benchmarked from actual purchase prices — and it shows: the distinct
              supply_risk_score values per period (<strong>32 / 33 / 27</strong>)
              outnumber the distinct (category, country) pairs (<strong>29</strong>), so
              the Kraljic score does discriminate between two suppliers in the same
              category and country. The composite Risk sub-score, built only from lookups,
              cannot.
            </p>
            <p className="text-xs">
              Note: this composite <strong>Risk sub-score</strong> is distinct from the{" "}
              <strong>Kraljic supply-risk score</strong> (Section 3.2) — same word,
              different metric, opposite polarity by design (here higher = safer; on the
              Kraljic axis higher = riskier). The old complaint and binary single-source
              terms were dropped: complaints now live only in Quality (avoiding
              double-counting), and the single-source flag was replaced by the continuous
              roster-concentration measure the two scores share.
            </p>
          </section>

        </CardContent>
      </Card>

      {/* 5. Supplier Classification (Combined View) */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>5. Supplier Classification Methodology</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <p>
            The <strong>Supplier Classification</strong> page brings the Kraljic
            matrix (3.2) and the Performance-vs-Spend diagnostic (3.3) together on
            one screen, because they answer complementary questions:{" "}
            <strong>Kraljic</strong> describes how much leverage and supply risk a
            relationship carries, while <strong>Performance vs Spend</strong>{" "}
            describes how well the supplier actually performs for the money spent.
            Reading them side by side turns two separate portfolios into a single
            prioritised view. The performance axis uses the same 0–100 composite
            score defined in <strong>Section 4</strong>.
          </p>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              5.1 Cross-classification synthesis
            </h3>
            <p>
              Four synthesis buckets combine each supplier&apos;s Kraljic quadrant
              with the <strong>period performance median</strong> — the same median
              line the Performance-vs-Spend scatter uses, so the cards and the chart
              are always internally consistent. &ldquo;Below&rdquo; means a composite
              at or below the period median; &ldquo;above&rdquo; means strictly above it:
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Strategic underperformers</strong> — Strategic quadrant{" "}
                <em>and</em> below the median: high-spend, hard-to-replace suppliers
                that are not performing — the highest-priority engagement targets.
              </li>
              <li>
                <strong>Bottleneck critical issues</strong> — Bottleneck quadrant{" "}
                <em>and</em> below the median: small dollars but real supply risk if
                they fail.
              </li>
              <li>
                <strong>Workhorse leverage</strong> — Leverage quadrant <em>and</em>{" "}
                above the median: dependable, competitive-category volume to
                consolidate around.
              </li>
              <li>
                <strong>Routine quality risks</strong> — Routine quadrant{" "}
                <em>and</em> below the median: candidates to rationalize or move to
                catalog buys.
              </li>
            </ul>
            <p>
              The buckets are presented as clickable cards that filter the combined
              supplier table. Everything on the page is{" "}
              <strong>period-scoped</strong> — single-year or range — consistent with
              the rest of the dashboard.
            </p>
          </section>
        </CardContent>
      </Card>

      {/* 6. Action Recommendations Synthesis */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>6. Action Recommendations Synthesis</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            <strong>Action Priorities</strong> synthesizes findings from the four
            analyses into ranked, specific actions, organized into three groups
            that mirror the diagnostic analyses:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Spend</strong> — Concentration, Critical Spend, and Tail
              Spend.
            </li>
            <li>
              <strong>Suppliers</strong> — Critical Issues Engagement, Hidden Gems
              Promotion, and Bottleneck Risk Mitigation.
            </li>
            <li>
              <strong>Process</strong> — Process Improvement and Slowest Stage.
            </li>
          </ul>
          <p>
            Each recommendation is ranked by an impact score (normalized to
            0–100) combining spend exposure, risk magnitude, or process
            severity. Recommendations include specific data backing and
            suggested action language.
          </p>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">
              Impact Score Calculation
            </h4>
            <p>
              Every recommendation carries an impact score (0–100) used to rank
              actions globally across categories. Each category is normalized to
              the same 0–100 scale so an engagement and a process fix are
              comparable. All categories share a spend term:
            </p>
            <p className="rounded-md bg-muted/50 p-2 text-xs">
              <code>
                spend_normalized = log(1 + total_spend) ÷ max(log(1 +
                total_spend)) × 100
              </code>
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Critical Issues Engagement</strong> —{" "}
                <code>0.7 × spend_normalized + 0.3 × performance_gap</code>{" "}
                (gap below the performance median, scaled to 0–100). High-spend
                underperformers rank highest.
              </li>
              <li>
                <strong>Hidden Gems Promotion</strong> —{" "}
                <code>(performance − median) ÷ (100 − median) × 100</code>.
                Performance above the median, scaled to 0–100.
              </li>
              <li>
                <strong>Bottleneck Risk Mitigation</strong> — the supplier&apos;s{" "}
                <code>supply_risk_score</code> (already 0–100). Direct
                risk-based ranking.
              </li>
              <li>
                <strong>Process Improvement</strong> — the worst quadrant&apos;s
                three-way-match <code>fail_rate_pct</code> (compliance only).
              </li>
              <li>
                <strong>Slowest Stage</strong> — a slow internal process stage&apos;s{" "}
                <code>mean_days ÷ 18 × 100</code>, normalized against a ~18-day
                reference. PO-to-delivery (physical supplier lead time) is excluded.
              </li>
              <li>
                <strong>Concentration</strong> — a category&apos;s{" "}
                <code>share × 100</code> (its % of total spend).
              </li>
              <li>
                <strong>Critical Spend</strong> — an A-tier supplier&apos;s{" "}
                <code>share_pct</code> (its % of total spend).
              </li>
              <li>
                <strong>Tail Spend</strong> — <code>tail_supplier_pct</code>, the
                share of the supplier count made up of sub-1%-of-spend suppliers.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">
              Cross-analysis anomalies
            </h4>
            <p>
              Alongside the ranked actions, Action Priorities surfaces a{" "}
              <strong>cross-analysis anomaly hub</strong> — suppliers that stand out
              when the analyses are read against one another, grouped into three
              families:
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Process</strong> — the three per-supplier cycle-time flags
                from Section 3.4 (has outlier POs, inconsistent spread, and
                stage-dominated POs).
              </li>
              <li>
                <strong>Lens disagreement</strong> — a supplier whose{" "}
                <em>percentile ranks</em> on spend, performance, and supply risk
                spread by <strong>80 points or more</strong>: it ranks very
                differently depending on which lens you read it through.
              </li>
              <li>
                <strong>Changed over time</strong> — a supplier with a sharp
                year-over-year move: a spend fold of <strong>≥ 2.5×</strong>, a
                Kraljic quadrant jump, or a composite-score swing of{" "}
                <strong>≥ 18 points</strong>. A partial trailing year (under half the
                prior year&apos;s spend) is set aside rather than compared, so a stub
                year is not read as a collapse.
              </li>
            </ul>
            <p>
              At the hub level, <strong>distinct flagged</strong> is the set-union
              across the three families — a supplier is counted once even if it trips
              several; <strong>Important</strong> means flagged <em>and</em> either
              ABC Class A or Kraljic Strategic; and <strong>compound</strong> means
              flagged by two or more families.
            </p>
          </section>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">Reports</h4>
            <p>
              The <strong>Reports</strong> view composes the four analyses and their
              recommendations into a decision-first document — headline finding →
              situation → ranked findings → an action table — rather than a dump of
              every table. It offers three tone registers (executive, operational,
              analytical), an optional single-supplier brief or single-category
              deep-dive, and native browser print-to-PDF. The report renders its own
              methodology section, so this note is only a pointer.
            </p>
          </section>
        </CardContent>
      </Card>

      {/* 7. Reporting Periods */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>7. Reporting Periods</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Periods are <strong>auto-detected</strong> from the data — one period
              per distinct year found in the <code>payment_date</code> values (with a{" "}
              <code>pr_date</code> fallback for any record missing a payment). This
              payment-date basis is what surfaces the 2026 period.
            </li>
            <li>
              <strong>Single Year</strong> mode shows the analyses for one year,
              read from a pre-computed cache (instant).
            </li>
            <li>
              <strong>Range</strong> mode shows the analyses across multiple years,
              computed on-the-fly over the combined date span.
            </li>
            <li>
              Range computes take roughly <strong>5 seconds</strong> because they
              invoke the Python analysis script live rather than reading the cache.
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* 8. Assumptions and Limitations */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>8. Assumptions and Limitations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <p>
            The methodology is fixed, deterministic, and reproducible. This section
            names what it can and cannot see. A page that lists only its formulas is
            a spec; one that names its own blind spots is a defence — so the
            limitations below are stated plainly, as properties we own rather than
            flaws we hide.
          </p>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              8.1 Two departures from the Kraljic textbook
            </h3>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Our profit-impact axis is spend, not profit impact.</strong>{" "}
                Kraljic&apos;s X-axis is meant to be profit impact — margin,
                criticality to production, substitutability. None of that lives in a
                purchase order, so we use annual spend, the standard practical proxy.
                It is directionally sound, but it will misplace a cheap,
                production-critical component that a plant cannot run without.
              </li>
              <li>
                <strong>
                  Supply risk is three measurable proxies for a qualitative
                  judgment.
                </strong>{" "}
                Kraljic&apos;s supply-risk axis is a qualitative assessment across
                roughly eight factors. We operationalise it with three we can measure
                from transaction data — competitor count (supply concentration),
                pricing power (cost premium), and import friction. We deliberately
                omit substitutability, storage and perishability risk, make-or-buy
                potential, and competing demand from other buyers: those need domain
                knowledge and market intelligence, not purchase orders. What we
                compute is reproducible; what we omit is real.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              8.2 Two opposite &ldquo;risks&rdquo;
            </h3>
            <p>
              The word <em>risk</em> means two opposite things in this dashboard, and
              it is the single most likely thing to trip a reader. The{" "}
              <strong>Kraljic supply-risk score</strong> (Section 3.2) runs{" "}
              <strong>higher = riskier</strong>{" "}
              — it is the exposure axis of the matrix. The composite&apos;s <strong>Risk sub-score</strong> (Section
              4.3) runs <strong>higher = safer</strong> — it is a structural safety
              modifier on the performance score. Same word, opposite polarity, by
              design. They also share an input — the roster-concentration term — as
              the same step curve scaled: the composite carries exactly{" "}
              <strong>twice</strong> the Kraljic points (0 alternatives → 50 on the
              Kraljic axis, 100 on the composite; ≥5 → 0 on both). Read the axis
              label, not just the word.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              8.3 What the model can&apos;t see on this dataset
            </h3>
            <p>
              Several branches of the scoring machinery never engage on the current
              data. We surface them so nobody mistakes an unused rung for a validated
              one.
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Two country tiers never fire.</strong> The composite&apos;s{" "}
                <code>country_distance</code> has an ASEAN tier (30) and{" "}
                <code>import_friction</code> an ASEAN tier (8), both meant for
                regional-but-foreign origins. This roster has none — every supplier
                is Indonesian or far-international — so those tiers never engage.
                Because <code>country_distance</code>{" "}
                drives 60% of the structural Risk sub-score, on this data that
                sub-score is effectively
                &ldquo;Indonesia vs the rest of the world&rdquo;.
              </li>
              <li>
                <strong>Two concentration rungs are unreachable.</strong> Both
                supply-concentration curves reserve their top rung for a true
                single-source category (one supplier, no alternatives). On this
                roster the smallest category has two suppliers, so that rung never
                fires — the advertised ceilings (50 on the Kraljic axis, 100 on the
                composite) cannot be reached. The real maxima on this data are{" "}
                <strong>35 and 70</strong>. (A finding from the current roster; it
                would change if a sole-source category appeared.)
              </li>
              <li>
                <strong>
                  Cost premium is a light tie-breaker, not a co-equal third.
                </strong>{" "}
                It is capped at 25 of the 100-point Kraljic axis, but on this roster
                it registers for only 24 of 55 suppliers, and in a data audit every
                quadrant boundary it moved was a low-spend Bottleneck↔Routine flip —
                on this dataset it has never moved a high-spend Strategic↔Leverage
                supplier. Read it as a nudge, not a driver.
              </li>
              <li>
                <strong>The &ldquo;Inconsistent&rdquo; flag is rare.</strong> The
                cycle-consistency flag (Section 3.4) is a genuine outlier detector,
                not a common state — on this data it fires for 2 of 55 suppliers.
              </li>
              <li>
                <strong>
                  The &ldquo;Slowest stage&rdquo; recommendation is often silent.
                </strong>{" "}
                It fires only when an internal process stage averages over 8 days. On
                this data it fires in 2024 but not in 2025 or 2026 — no internal stage
                clears the threshold in those years.
              </li>
              <li>
                <strong>Two recommendations always fire; Concentration is
                conditional.</strong> Process Improvement and Tail Spend always
                produce output — they are structural summaries of the portfolio,
                not conditional detections. Read them as &ldquo;here is the shape of
                your spend and process&rdquo;, not as &ldquo;a problem was
                found&rdquo;. Concentration, by contrast, is{" "}
                <strong>threshold-gated</strong> — it fires only when a single
                category exceeds 30% of total spend, so a well-diversified portfolio
                produces none.
              </li>
            </ul>
            <div>
              <h4 className="text-sm font-semibold text-foreground">
                Two country scales, by design
              </h4>
              <p className="mt-1">
                The two country-based scores measure different things, so a country
                can sit in a different tier on each — this is deliberate, not an
                inconsistency. <code>country_distance</code>{" "}
                (the composite&apos;s Risk sub-score) is <em>geographic proximity</em>:
                Indonesia 0 / ASEAN 30 /
                Asia-Pacific 60 / other 100. <code>import_friction</code> (the Kraljic
                supply-risk axis) is <em>trade-agreement coverage</em> — how cheaply an
                origin can be imported from: Indonesia 0 / AFTA 8 / RCEP-non-ASEAN 16 /
                other 25. India, for instance, is geographically Asia-Pacific (60 on
                distance) yet sits outside the RCEP trade bloc it left in 2019 (25 on
                friction) — correctly different on the two scales. Both scales now
                cover every ASEAN and Asia-Pacific origin.
              </p>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              8.4 Statistical and scoring caveats
            </h3>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>No significance threshold gates any decision.</strong> The
                Mann-Whitney U test reports a p-value and an effect size, but nothing
                in the dashboard acts on a fixed α, and the comparison is{" "}
                <em>intra-period</em> — the selected period split at its midpoint, not
                year over year. Choosing an α would be inventing a decision rule
                nobody agreed to; we show the evidence and leave the judgment to a
                human.
              </li>
              <li>
                <strong>Most of the composite is period-sensitive.</strong> Quality,
                Delivery and Process — 82% of the composite — re-aggregate over
                whatever POs fall in the selected window. Only the structural Risk
                sub-score (18%) is period-independent. A performance number is a
                statement about a window, not a fixed rating; compare like windows.
              </li>
              <li>
                <strong>Cost premium measures overpricing, not cheapness.</strong> It
                penalises measured overpricing only — below-market, at-market, and
                un-benchmarked suppliers all score 0, so it never rewards a cheap
                supplier. And the benchmark is <em>our own</em> spend-weighted average
                price per item, not an external market rate: it catches a supplier out
                of line with our roster, not with the world.
              </li>
              <li>
                <strong>Two sub-score halves are throttled by their bounds.</strong>{" "}
                Complaint rate is scored 0–100% but real rates top out near 33%, so
                that half only occupies 66.7–100 — the defect half does roughly 2.3×
                the work inside Quality. Lead time is scored 0–60 days but real leads
                run 8–26.5 days, so that half only occupies 55.8–86.7 — on-time
                delivery carries most of Delivery. The bounds are honest industry
                ceilings; they simply leave headroom this dataset never reaches.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              8.5 Baseline assumptions
            </h3>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                The data is <strong>synthetic</strong> — calibrated to industry
                benchmarks for realism, but not a record of real operations.
              </li>
              <li>
                Scope is a <strong>single organization</strong>; there are no
                cross-entity comparisons.
              </li>
              <li>
                Currency is normalized to USD using <strong>period averages</strong>;
                a real system would apply daily FX rates.
              </li>
              <li>
                The methodology is <strong>fixed and not user-adjustable</strong> —
                ABC at 80% / 95%, median splits on both classification matrices, the
                longest-cycle cut, the 8-day slow-stage flag, and the Mann-Whitney U
                comparison are all constants. There are no parameter sliders.
              </li>
              <li>
                The process structure reflects Indonesian government procurement
                regulation (<strong>Perpres 12/2021</strong>).
              </li>
            </ul>
          </section>
        </CardContent>
      </Card>

      {/* 9. Competitive sourcing coverage */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>9. Competitive Sourcing Coverage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5 text-sm leading-relaxed text-muted-foreground">
          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              9.1 Three buckets, not two
            </h3>
            <p>
              Every purchase order carries a <strong>buying method</strong>, one of five
              values. Coverage groups them into three mutually exclusive buckets by
              spend: <strong>competed</strong> (RFQ, tender — the order ran its own
              sourcing event with bids and an award), <strong>under framework</strong>{" "}
              (call-off against a standing agreement), and <strong>uncompeted</strong>{" "}
              (direct award, spot buy — no sourcing event).
            </p>
            <p>
              <strong className="text-foreground">
                The framework bucket is permanent and is never folded into either side.
              </strong>{" "}
              A call-off draws on an agreement that in real procurement was competed
              once, at framework award. This schema records no sourcing linkage on the
              framework — no awarding event, no responses — so the data cannot establish
              whether any given framework was competitively awarded. Folding call-offs
              into &ldquo;competed&rdquo; would overstate competitive coverage by the
              whole framework share; folding them into &ldquo;uncompeted&rdquo; would
              overstate that side by the same amount. Reporting a single
              &ldquo;competitive %&rdquo; is therefore not possible without introducing
              an error equal to the largest bucket in the portfolio.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              9.2 The measurement gap, stated as a finding
            </h3>
            <p>
              The share of spend whose competitive basis{" "}
              <strong>cannot be verified</strong> is emitted as a number rather than a
              footnote, because it names a concrete and achievable improvement: add a
              nullable reference from <strong>Framework</strong> to the sourcing event
              that awarded it. That one field would convert the largest single bucket of
              spend from unverifiable to measurable, without altering any existing
              measure. No coverage percentage on the dashboard is as actionable as
              closing that gap.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              9.3 Mix versus behaviour
            </h3>
            <p>
              Competitive coverage is strongly <em>associated</em> with category —
              proprietary OEM parts are bought direct because they cannot be competed,
              not because anyone declined to compete them — so part of any year-over-year
              move is simply a change in what was bought. Coverage is therefore
              decomposed by category using <strong>shift-share</strong>. For each bucket,
              with <code>w</code> = a category&rsquo;s share of period spend and{" "}
              <code>r</code> = the bucket&rsquo;s share of that category&rsquo;s spend:
            </p>
            <div className="rounded-md bg-muted/50 p-3 font-mono text-xs text-foreground">
              pooled = Σ w · r
              <br />
              mix = Σ (w₂ − w₁) · r₁ — what was bought changed
              <br />
              within = Σ w₂ · (r₂ − r₁) — how it was bought changed
              <br />
              mix + within = pooled₂ − pooled₁ (exact, by construction)
            </div>
            <p>
              <strong className="text-foreground">
                The split must be read, never assumed.
              </strong>{" "}
              On the current dataset competed coverage fell 9.89 points in 2025, of which{" "}
              <strong>−3.51 was mix and −6.37 within</strong> — about two thirds of it a
              genuine change in how the same categories were bought. The 2026 recovery
              (+7.43) is almost entirely within-category. An earlier draft of the
              emitter&rsquo;s own documentation asserted the opposite, that the move was
              mostly a mix shift, and the decomposition disproved it. The dashboard and
              the report share one classifier so they cannot disagree about which it was.
            </p>
            <p>
              This is an arithmetic identity with no distributional assumptions. There
              are deliberately no p-values on it, and nothing in it may be read as
              inference. The decomposition runs over the whole dataset, so a transition
              reads the same on every period selection.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              9.4 What coverage does not claim
            </h3>
            <p>
              Coverage is <strong>descriptive</strong>. High-value spend concentrates in
              the sole-source and framework channels — median order value runs roughly
              $58K for spot buys, $608K for RFQs, $1.2M for tenders, $2.1M for direct
              awards and $2.4M for call-offs. That is a fact about the shape of the
              portfolio, <em>not</em> a finding about buyer discipline: every direct
              award in this data carries a proprietary/OEM sole-source justification, and
              an OEM component has no substitutable competing supply. There is
              consequently no coverage score, no ranking of categories or suppliers by
              coverage, and no recommendation derived from it.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              9.5 Measured but NOT shown, and why
            </h3>
            <p>
              Several standard-looking metrics are computable from this data and are
              deliberately not displayed, because on this dataset they are{" "}
              <strong>degenerate</strong>: they return the same answer for every input,
              or they measure an artifact rather than the thing they name. Each was
              tested before the decision was taken, not assumed. The first eight concern
              competitive sourcing; the ninth (payment discipline), tenth (delivery slip
              magnitude) and eleventh (requisition estimate accuracy) are recorded here
              because they are the same failure mode and belong in one catalogue.
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Awarded the cheapest bid?</strong> 226 of 226 awards went to the
                lowest quote — price rank 1 in every event without exception. A universal
                pass communicates nothing.
              </li>
              <li>
                <strong>Single-bid exposure.</strong> The minimum bid count per event is
                2 (31 events drew 2 bids, 165 drew 3, 30 drew 4). There are no single-bid
                events at all, so the measure is permanently zero.
              </li>
              <li>
                <strong>Bid response rate.</strong> Suppliers invited always equals
                responses received — 2→2, 3→3, 4→4 in every event. A constant 100%.
              </li>
              <li>
                <strong>Quote spread by category, supplier or period.</strong> Spread is
                an order statistic of the number of bids: 9.22% at 2 bids, 12.80% at 3,
                13.06% at 4. Holding bid count fixed at 3, the between-category range
                (11.15–13.44) is under half a single within-category standard deviation
                (3.2–4.4), and the period cut is flat at 12.85 / 12.71 / 12.84. Any
                breakdown would report the bid-count mix wearing a category label —
                &ldquo;Conveyor &amp; Belt has the tightest bidding&rdquo; is false; all
                its events simply have two bidders. The <em>portfolio</em> figure
                (12.35%) is shown; no cut of it is.
              </li>
              <li>
                <strong>Savings versus the field.</strong> Because the award is always
                the minimum quote, this is a deterministic re-expression of the spread
                and carries no independent information. It also has a scoping trap: a bid
                quotes ONE unit price matching ONE order line, and that line averages{" "}
                <strong>64.66%</strong> of the order&rsquo;s value. The measured
                advantage of $7.36M sits against $113.3M of awarded-line value — it must
                never be scaled onto the $177.7M of competed spend, which would overstate
                it by roughly half.
              </li>
              <li>
                <strong>Do we pay more when we don&rsquo;t compete?</strong> Computable
                on the 26 items bought both ways, and pure noise: mean +4.58%, median
                −6.98%, standard deviation <strong>61.96%</strong>, with{" "}
                <strong>14 of the 26 items CHEAPER</strong> when uncompeted against only
                12 dearer. The scatter is roughly thirteen times the effect, and a
                majority-cheaper split makes the exclusion stronger, not weaker: the sign
                of the &ldquo;premium&rdquo; is decided by which items happen to be
                picked. A headline built on this would be fabricated.
              </li>
              <li>
                <strong>Challengeable sole-source awards.</strong> Every direct award
                carries a proprietary/OEM justification. Counting alternatives from the
                category roster suggests some are challengeable, but the roster is far
                too coarse a proxy for item-level substitutability — the eight suppliers
                in &ldquo;Heavy Equipment OEM&rdquo; are eight different OEMs, and a
                Volvo part is not a Liebherr part.
              </li>
              <li>
                <strong>Purchase orders dated before bid close.</strong> A genuine audit
                red flag in practice, and it fires on 51 of 226 events. On inspection the
                sourcing dates are drawn independently — close-to-order spans −8 to +15
                days — so flagging a quarter of all competitive events would manufacture
                an accusation out of noise.
              </li>
              <li>
                <strong>Payment discipline against contractual terms.</strong> The
                most convincing dead metric of the set, because unlike a percentile
                threshold it has a real contractual benchmark:{" "}
                <code>paymentTerms</code> carries Net 14 / Net 30 / Net 45, so
                &ldquo;days paid past terms&rdquo; looks rigorous and needs no
                distributional assumption. Measured, it is a{" "}
                <strong>uniform random draw</strong>. Days late is an integer on
                exactly [0, 15] with χ² <em>p</em> = 0.336 against Uniform{"{"}0..15{"}"},
                an observed mean of <strong>7.27</strong> against the theoretical
                7.50 and sd 4.54 against 4.61. Nothing explains any of its variance —
                supplier <em>p</em> = 0.92, category 0.96, period 0.64, buying method
                0.55, term bucket 0.49. A permutation test settles it: the observed
                spread of supplier means (1.59) is <em>below</em> what random
                reassignment produces (1.72), <em>p</em> = 0.747 — supplier
                differences are not weak signal, they are less varied than chance.
                Zero of 22 large suppliers reject uniformity on a test of their full
                distribution shape (≈1.1 expected by chance), and no supplier reaches
                |z| &gt; 2 against the grand mean. ⚠️ The observation that the
                organisation &ldquo;pays about 7 days late and never early&rdquo; is
                arithmetically correct but describes the generator&rsquo;s
                non-negative lower bound, not payment discipline: a draw from [0, 15]
                has no early tail by construction. A worst-payers league table built
                on this would render beautifully and name innocent suppliers.
              </li>
              <li>
                <strong>Delivery slip magnitude.</strong> Delivery is recorded as a
                boolean (on time against the promised date). The obvious refinement is
                to measure <em>how late</em> — 483 of 647 orders (74.7%) are late,
                averaging +7.9 days and reaching +33. Unlike payment lag this is not a
                simple uniform draw (χ² rejects Uniform at <em>p</em> = 1.3 × 10⁻⁴⁷,
                early deliveries exist at 21.0%), but it carries{" "}
                <strong>no supplier information</strong>. Slip magnitude given the
                order was late has ρ = −0.196, <em>p</em> = 0.207 against supplier
                on-time rate — it adds nothing the boolean does not already say — and a
                permutation test on the spread of supplier mean slip gives{" "}
                <em>p</em> = 0.471, dead on the null. ⚠️{" "}
                <strong>
                  The on-time boolean is itself indistinguishable from a coin flip
                </strong>{" "}
                at the global rate: at supplier-period grain the binomial dispersion is
                χ²/df = 1.03 (<em>p</em> = 0.411) — exactly binomial — and an exact
                label permutation gives <em>p</em> = 0.955. There is no supplier signal
                to refine. Lead time, meanwhile, is <strong>73–86% determined by
                buying method</strong> (73.0% of order-level variance; method mix
                explains 86.4% of between-supplier variance), with no residual supplier
                effect (<em>p</em> = 0.266) and <strong>zero cross-channel
                consistency</strong> — across 32 suppliers using two or more methods, a
                supplier&rsquo;s lead residual in one channel does not predict its
                residual in another (<em>r</em> = −0.015, <em>p</em> = 0.933). See
                Section 10.3 for what this does and does not imply.
                <br />
                ⚠️ <strong>Corrected reading of delivery_score&rsquo;s two halves.</strong>{" "}
                An earlier pass reported that the lead-time half &ldquo;drives&rdquo; the
                score, from correlations of +0.880 (lead) against +0.555 (on-time). That
                was an artifact: both halves are components of their own sum, so both
                correlate positively with it by construction, and a raw standard
                deviation is not a variance share. Under the same covariance
                decomposition used elsewhere here, the two halves contribute{" "}
                <strong>almost equally — on-time 48.6%, lead 51.4%</strong>; a drop-one
                rank test agrees (Spearman +0.727 dropping the lead half, +0.794
                dropping the on-time half). delivery_score is therefore roughly half
                coin-flip and half channel proxy, not lead-dominated. The
                &ldquo;+0.880 vs +0.555&rdquo; reading is recorded here so it is not
                revived.
              </li>
              <li>
                <strong>Requisition estimate accuracy.</strong>{" "}
                <code>Requisition.estimatedValueUsd</code> against the value of the order
                it became looks like the one place this dataset records a human judgement
                — a budget owner&rsquo;s guess, made before the market answered. It is
                not a judgement. The generator is{" "}
                <strong>
                  identified, not merely consistent with:{" "}
                  <code>estimatedValueUsd = totalValueUsd × (1 + v)</code>, with{" "}
                  <em>v</em> drawn from Uniform(−0.10, +0.15)
                </strong>
                . Tested with those parameters <em>fixed and unfitted</em>, so the fit
                had nothing to tune: Kolmogorov–Smirnov <em>D</em> = 0.0200,{" "}
                <em>p</em> = 0.953, and χ² is null at every resolution tried — 10, 20, 25
                and 50 equal bins give <em>p</em> = 0.651, 0.655, 0.867, 0.452. The
                moments land on the window to four decimals (mean 0.0251840 against
                0.0250000; sd 0.0723471 against 0.0721688; excess kurtosis −1.2197
                against −1.2000). The observed support is [−0.0998566, +0.1499267]
                against the order statistics expected of 647 draws, −0.0996142 and
                +0.1496142, with <strong>no value outside the window at all</strong>.
                Every competing shape rejects hard: Normal <em>p</em> = 5.2 × 10⁻³,
                Shapiro–Wilk 2.0 × 10⁻¹³, a symmetric uniform 2.9 × 10⁻¹⁶, triangular
                9.8 × 10⁻¹¹.
                <br />
                ⚠️{" "}
                <strong className="text-foreground">
                  The Jensen effect — why this one is the most deceptive entry in the
                  catalogue.
                </strong>{" "}
                Read the natural way, as{" "}
                <code>(actual − estimate) / estimate</code>, the field yields a mean
                absolute error of <strong>6.27%</strong> and an under-estimation bias of{" "}
                <strong>−1.97%</strong> that is significant at{" "}
                <em>t</em> = −7.20, <em>p</em> &lt; 10⁻¹¹. Both are pure algebra. That
                expression is <code>1/(1 + v) − 1</code>, a{" "}
                <em>nonlinear</em> transform of the window, and a nonlinear transform of
                a distribution symmetric about a non-zero mean does not stay centred:
                E[|1/(1+<em>v</em>)−1|] = <strong>6.2394%</strong> against the observed
                6.2687%, and E[1/(1+<em>v</em>)−1] = <strong>−1.9510%</strong> against
                the observed −1.9674%. The share of orders coming in under estimate is
                likewise fixed by the window at 0.10/0.25 = 40.00%, observed 41.58%
                (binomial <em>p</em> = 0.42).{" "}
                <strong>
                  A <em>p</em>-value below 10⁻¹¹ is not evidence of behaviour when the
                  quantity being tested is a nonlinear transform of a fixed window.
                </strong>{" "}
                What that <em>p</em> measures is the precision with which the constant
                −1.9510% has been estimated from 647 samples — nothing about anyone&rsquo;s
                estimating. Significance answers &ldquo;is this reliably non-zero&rdquo;,
                never &ldquo;does this mean anything&rdquo;, and the gap between those two
                questions is widest exactly here.
                <br />
                Nothing explains the residual variance. Buying method is the{" "}
                <em>weakest</em> dimension of all — η² = 0.00087, ANOVA{" "}
                <em>p</em> = 0.968, and a permutation test on the spread of method means
                gives <em>p</em> = 0.956, the observed spread (0.0027) sitting{" "}
                <em>below</em> the null (0.0063), the same less-varied-than-chance
                signature payment discipline showed. Category η² = 0.018 (
                <em>p</em> = 0.58), department 0.012 (<em>p</em> = 0.37), supplier 0.086
                (<em>p</em> = 0.39). No correlate is real: against order value{" "}
                <em>r</em> = +0.028, line count −0.012, promised lead −0.015, total cycle
                −0.012; absolute error by three-way-match outcome is 6.21% against 6.65%
                (<em>p</em> = 0.29) and by on-time outcome 6.23% against 6.28% (
                <em>p</em> = 0.86).
                <br />
                ⚠️{" "}
                <strong className="text-foreground">
                  One signal cleared Bonferroni and was still refused.
                </strong>{" "}
                Recorded because it is reachable by anyone who re-runs this analysis and
                looks convincing when found. A max-statistic permutation across the twelve
                requesters — the multiplicity-exact test — returns{" "}
                <em>p</em> = 0.0083: one requester&rsquo;s 46 orders sit{" "}
                <strong>3.3 points below the window mean</strong> (−0.0076 against
                +0.0250), which survives a Bonferroni correction and is worth $1.5M
                against their $46.5M of spend. It is refused on three grounds, the first
                of which is sufficient alone.{" "}
                <strong>
                  The estimate is computed <em>from</em> the actual value, so causality
                  runs backwards
                </strong>{" "}
                — a requisition estimate that is a jittered copy of the eventual order
                value cannot evidence how anyone estimates, because it was never a
                forecast. There is no mechanism for the finding to be about. Second,
                drop-one collapses the entire family: remove that one requester and the
                same test returns <em>p</em> = 0.747, so what looks like a dimension with
                structure is one person. Third, the permutation on the spread of requester
                means — the test that settled both payment discipline and delivery slip —
                does not reject (<em>p</em> = 0.083); and the shape is a pure location
                shift, since recentring their draws on the window mean restores
                uniformity (<em>p</em> = 0.176). A per-requester estimating scorecard is
                therefore not a weak finding to be shored up with more data. It is
                unavailable in principle from a field built this way.
                <br />
                The portfolio aggregate is a constant for the same reason. Summed
                estimates of $726,480,991.35 against actuals of $707,687,316.20 give a
                $18.79M, +2.66% apparent over-budgeting — which is E[<em>v</em>] = +2.5%
                and moves only with sampling noise. It would read as a systematic
                planning finding and is a property of the window.
              </li>
            </ul>
            <p>
              The bidding descriptives that <em>are</em> shown — bid depth (2–4 bidders,
              averaging 3.0) and the portfolio quote spread (12.35%) — describe how the
              competitive processes ran, with no breakdown and no inference.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              9.6 Framework discipline
            </h3>
            <p>
              Of 129 call-offs, all reference a framework belonging to the ordering
              supplier and none reference an inactive framework.{" "}
              <strong>
                15 orders ($36.9M) fall outside their framework&rsquo;s validity window
              </strong>{" "}
              — the one genuine exception the sourcing records contain, all of them in
              2026. The validity window is deliberately not enforced when an order is
              written, so this is a live check reporting a known property of the current
              data rather than a newly detected breach.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              9.7 Reproducibility note
            </h3>
            <p>
              Coverage results are cached per period and per date range. The cache column
              is Postgres <code>jsonb</code>, which{" "}
              <strong>normalises object key order</strong> — so comparing a cached
              payload against a freshly computed one with a plain string comparison
              reports every analysis as changed even when no value moved. Such
              comparisons must be done canonically (key-sorted). The coverage payload
              itself carries no wall-clock field, so the same data computes to the same
              result on every run.
            </p>
          </section>
        </CardContent>
      </Card>

      {/* 10. Reading the composite */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>10. Reading the Composite and the Classification Lenses</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5 text-sm leading-relaxed text-muted-foreground">
          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              10.1 The composite becomes more structural the more you aggregate
            </h3>
            <p>
              The composite is 30% Quality, 30% Delivery, 22% Process and 18% Risk. Those
              are the <em>weights</em>. How much each component actually{" "}
              <em>moves</em> the score is a different question, and the answer depends on
              how much the window aggregates.
            </p>
            <p>
              <strong className="text-foreground">
                Risk is the only component that never varies within a supplier across
                periods
              </strong>{" "}
              — it is structural (country distance × roster concentration), so it is
              identical for a given supplier in every year: it varies for{" "}
              <strong>0 of 55</strong> suppliers, against 49 of 55 for Delivery, 36 for
              Process and 23 for Quality. Aggregating several years into one window
              averages away within-supplier variation in the three behavioural
              components while leaving Risk untouched:
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-foreground">
                    <th className="py-1.5 pr-3 font-medium">Component</th>
                    <th className="py-1.5 pr-3 text-right font-medium">sd, per supplier-period</th>
                    <th className="py-1.5 pr-3 text-right font-medium">sd, all-years window</th>
                    <th className="py-1.5 text-right font-medium">Varies across periods</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b"><td className="py-1.5 pr-3">Quality</td><td className="py-1.5 pr-3 text-right tabular-nums">6.91</td><td className="py-1.5 pr-3 text-right tabular-nums">5.79</td><td className="py-1.5 text-right tabular-nums">23 of 55</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">Delivery</td><td className="py-1.5 pr-3 text-right tabular-nums">20.46</td><td className="py-1.5 pr-3 text-right tabular-nums">14.99</td><td className="py-1.5 text-right tabular-nums">49 of 55</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-3">Process</td><td className="py-1.5 pr-3 text-right tabular-nums">18.91</td><td className="py-1.5 pr-3 text-right tabular-nums">12.49</td><td className="py-1.5 text-right tabular-nums">36 of 55</td></tr>
                  <tr><td className="py-1.5 pr-3 font-medium text-foreground">Risk</td><td className="py-1.5 pr-3 text-right tabular-nums">31.10</td><td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">31.22</td><td className="py-1.5 text-right font-medium tabular-nums text-foreground">0 of 55</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              Risk&rsquo;s spread is the only one that does not fall. Its correlation
              with the composite rises from +0.689 to +0.831 as a direct result. This is
              a real property of the model, not an artifact of any one calculation: the
              longer the window, the more a supplier&rsquo;s composite reflects{" "}
              <em>where it is and what category it sells into</em> rather than how it
              has performed.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              10.2 Variance shares are grain-dependent — always state the grain
            </h3>
            <p>
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
              in 10.1 but corresponds to <em>no view any user sees</em>, and should not
              be quoted as a description of the dashboard.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              10.3 These are findings about the dataset, not defects in the model
            </h3>
            <p>
              <strong className="text-foreground">
                This distinction is the most important thing in this section.
              </strong>{" "}
              Tested on this synthetic data, none of the four components shows a
              statistically detectable between-supplier <em>behavioural</em> signal:
              Quality is flat (defect rate across suppliers <em>p</em> = 0.380,
              complaints <em>p</em> = 0.467); Process is indistinguishable from chance
              under an exact permutation (<em>p</em> = 0.367); Delivery is a coin flip
              plus a channel proxy (Section 9.5, entry 10); and Risk is structural by
              design and never claimed to be behavioural.
            </p>
            <p>
              That is a property of <strong>the data generator</strong>, which draws
              per-order outcomes independently of supplier identity. It is{" "}
              <strong className="text-foreground">
                not evidence that the scoring model is wrong
              </strong>
              , and no change to the locked formulas is warranted on the strength of it.
              Real procurement data would plausibly show a genuine supplier lead-time
              effect — and, importantly, causation running the other way as well:{" "}
              <em>
                buying method is chosen partly because of supplier capability
              </em>
              . Nobody runs an RFQ for a six-day emergency purchase. On real data a
              short lead time on spot buys may be a real supplier property rather than a
              channel artifact, and this dataset cannot distinguish the two — the
              cross-channel test that would settle it returns exactly zero here
              (<em>r</em> = −0.015), which is the generator&rsquo;s signature.
            </p>
            <p>
              This is the same shape as the Quality finding recorded in 8.3: a component
              that is inert on synthetic data and would be expected to discriminate on
              real data. The honest summary is that{" "}
              <strong className="text-foreground">
                these components cannot be validated on this dataset
              </strong>{" "}
              — not that the composite fails to measure supplier behaviour in general.
              The stronger claim is not supported and should not be written.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              10.4 The analyses are not independent readings of a supplier
            </h3>
            <p>
              Spend Overview and Supplier Classification present what looks like several
              perspectives on the same supplier: an ABC class, a Kraljic quadrant, a
              performance zone, a composite score. Three of the relationships between
              them are <em>mechanical</em>. Knowing which is which changes how much
              corroboration two agreeing views are worth — because two lenses that share
              an axis will agree on that axis whatever the data says.
            </p>

            <h4 className="pt-1 font-medium text-foreground">
              (a) The composite&rsquo;s Risk term and Kraljic&rsquo;s risk axis are one signal
            </h4>
            <p>
              The composite&rsquo;s <code>risk_score</code> and Kraljic&rsquo;s{" "}
              <code>supply_risk_score</code> correlate at <strong>r = −0.852</strong>. The
              sign is negative by design — composite Risk is oriented so that higher is{" "}
              <em>safer</em>, Kraljic supply risk so that higher is <em>riskier</em> — and
              the magnitude is high because both are built on the same structural
              roster-concentration measure (Sections 4.3 and 3.2). They are two
              presentations of one quantity, not two readings of a supplier. So wherever
              Risk leads the composite&rsquo;s variance, the composite&rsquo;s largest
              single contributor is a number already plotted as the vertical axis of the
              Classification page.
            </p>
            <p>
              ⚠️{" "}
              <strong className="text-foreground">
                This one carries a grain label, and the magnitude moves with it.
              </strong>{" "}
              Risk leads at <strong>56.4%</strong> of composite variance on the all-years
              default (55 suppliers), but on 2024 it is 32.8% against Delivery&rsquo;s
              44.0%, and on 2026 it is 37.3% against Delivery&rsquo;s 46.4% — Delivery
              leads on both. Per 10.2,{" "}
              <strong className="text-foreground">
                &ldquo;Risk is the dominant term&rdquo; must never be written unqualified
              </strong>
              . What is stable across grains is the weaker, more useful statement: when
              Risk does lead, it leads with a chart the reader has already seen.
            </p>

            <h4 className="pt-1 font-medium text-foreground">
              (b) Kraljic and Performance-vs-Spend share an entire axis
            </h4>
            <p>
              Both matrices split on <em>the same</em> log-spend median — 15.2464 — so
              their horizontal axes are not merely similar but identical. The consequence
              is visible in the cross-tab: the quadrant × zone table has{" "}
              <strong>zero off-diagonal cells on the spend split</strong>. Strategic and
              Leverage suppliers map only into Stars and Critical Issues; Bottleneck and
              Routine map only into Hidden Gems and Long Tail. That is not an empirical
              near-miss to be explained; it is one median applied twice. The two analyses
              differ only in their <em>second</em> axis — supply risk against performance.
            </p>
            <p>
              ABC collapses further still: its cutpoints are taken on cumulative spend, so
              class membership is spend rank by construction and correlates with the
              supplier ranking at approximately 1.0. Taken together, the
              supplier-classification trio is{" "}
              <strong className="text-foreground">
                spend, supply risk and delivery-driven performance replotted three ways
              </strong>{" "}
              — three views, not three independent analyses.
            </p>
            <p>
              ⚠️ Unlike (a), this is <strong>structural rather than data-dependent</strong>.
              Any dataset would produce the shared axis, because both frameworks are
              anchored on spend deliberately: Kraljic&rsquo;s horizontal axis <em>is</em>{" "}
              profit impact proxied by spend, and ABC <em>is</em> a spend-ranking method. A
              different concentration profile would move which suppliers land in which
              cell; it would never make the axis stop being shared.
            </p>

            <h4 className="pt-1 font-medium text-foreground">
              (c) Even quadrant and zone populations are forced by the median split
            </h4>
            <p>
              Performance zones divide <strong>14 / 13 / 13 / 15</strong> across the
              all-years window, and Kraljic quadrants <strong>14 / 11 / 12 / 14</strong> in
              2025. Both are approximately quartiles, and both are approximately quartiles{" "}
              <strong className="text-foreground">by construction</strong>: a median puts
              half the population on each side of it, so crossing two medians yields four
              cells near <em>n</em>/4 unless the two axes are strongly correlated.
            </p>
            <p>
              ⚠️ Therefore{" "}
              <strong className="text-foreground">
                &ldquo;the quadrants are balanced&rdquo; and &ldquo;no zone is
                empty&rdquo; are not findings about the supplier base
              </strong>{" "}
              — they are arithmetic, and they would hold on almost any input. Neither
              should be read as evidence of a healthy or well-diversified portfolio. The
              genuinely informative case is the opposite one: a <em>strongly skewed</em>{" "}
              cross-tab would indicate the two axes are correlated, which is exactly what
              the shared spend axis in (b) produces. This point is purely methodological —
              it is a property of median-split matrices generally, not of this dataset.
            </p>

            <p>
              <strong className="text-foreground">
                None of the three is a defect, and none warrants a change.
              </strong>{" "}
              Kraljic and ABC are standard frameworks applied here as specified, and their
              overlap follows from both being anchored on spend — which is what they are
              designed to do. The redundancy is the price of using two spend-anchored
              frameworks together, and it is a price worth paying, because the second axes
              genuinely differ and that is where each view earns its place. The three
              findings differ in kind, and the distinction matters when quoting them: (a)
              is a magnitude that moves with the grain, (b) is structural and would hold on
              any data, (c) is methodological and would hold for any median split. What all
              three rule out is the same habit — treating agreement between two of these
              views as independent confirmation.
            </p>
          </section>
        </CardContent>
      </Card>

      {/* 11. References */}
      <Card className={cardElevation}>
        <CardHeader>
          <CardTitle>11. References</CardTitle>
        </CardHeader>
        <CardContent className="text-sm leading-relaxed text-muted-foreground">
          <ul className="list-disc space-y-1 pl-5">
            <li>CIPS Knowledge Hub — Chartered Institute of Procurement &amp; Supply.</li>
            <li>APQC Open Standards Benchmarking — P2P process metrics.</li>
            <li>Hackett Group — P2P Automation Benefits Research.</li>
            <li>MOPS Singapore — Mean of Platts Singapore (fuel benchmarks).</li>
            <li>AME Group — Mining cost reports.</li>
            <li>Juran, J. M. (1951) — Quality Control Handbook (Pareto principle).</li>
            <li>Mann, H. B. &amp; Whitney, D. R. (1947) — Mann-Whitney U test.</li>
            <li>Perpres 12/2021 — Indonesian government procurement regulation.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
