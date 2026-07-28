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
import { getLookupCoverageInputs } from "@/lib/risk-model-coverage";
import { readSensitivity } from "@/lib/sensitivity-server";
import { sensitivityView } from "@/lib/sensitivity";
import { configFingerprint } from "@/lib/risk-model";
import { RiskModelSettings } from "@/components/Methodology/RiskModelSettings";
import { SensitivityTables } from "@/components/Methodology/SensitivityTables";

// ONE source of truth for section identity: number (shown in the heading and in a
// print-only suffix on every in-prose reference), title, and anchor id. In-prose
// references are NAMED anchors, never numeric strings — a hardcoded numeric cross-ref
// reads true today and silently goes stale after a renumber, so the number lives here,
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
  "kraljic-departures": { n: "6.1", title: "Two departures from the Kraljic textbook" },
  "model-cant-see": { n: "6.2", title: "What the model can't see on this dataset" },
  "stat-caveats": { n: "6.3", title: "Statistical and scoring caveats" },
  baseline: { n: "6.4", title: "Baseline assumptions" },
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

// One row of the identical seven-field per-analysis template: (a) question, (b) inputs,
// (c) formula, (d) unit, (e) cut-points, (f) provenance, (g) what it cannot say. Rendered
// the same way for every analysis so the seven read as one comparable form.
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p>
      <strong className="text-foreground">{label}.</strong> {children}
    </p>
  );
}

export default async function MethodologyPage() {
  if (!SHOW_METHODOLOGY) notFound();

  await requireAuth();
  const [riskModel, coverageInputs, storedSensitivity] = await Promise.all([
    readRiskModel(),
    getLookupCoverageInputs(),
    readSensitivity(),
  ]);
  const sensitivity = sensitivityView(
    storedSensitivity,
    configFingerprint(riskModel.composites, riskModel.lookupTables, riskModel.variables ?? {}),
  );

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
            <p>
              <strong className="text-foreground">What is configurable, and what is not.</strong>{" "}
              The scoring model exposes real knobs — component weights, each component&apos;s
              enable/disable, the lookup-table values, the risk components&apos; formulas, their
              normalization bounds, and the cost-premium partition parameters are all editable in
              the settings panel and take effect through the recompute. The variable{" "}
              <em>catalogue</em> is deliberately NOT: adding a variable requires code, because a
              picker that offered an unvetted field would legitimise using it. So a screen that
              looks fully open is bounded — you recombine the curated inputs, you do not invent one.
            </p>
            <p>
              <strong className="text-foreground">One evaluator, by design.</strong> Formulas are
              evaluated by a single whitelisted Python evaluator; the editor&apos;s live preview
              calls that same evaluator through the API rather than re-implementing it. A second
              TypeScript evaluator would disagree with Python on rounding (banker&apos;s rounding
              versus JavaScript half-up), so the preview would quietly misrepresent what a saved
              report will show. This is a correctness constraint, not an implementation detail.
            </p>
            <p>
              <strong className="text-foreground">Fingerprint scope has a history.</strong> The
              whole-config fingerprint covers the compute-affecting fields only, and what counts as
              compute-affecting has widened as more became editable: schema 2.1.0 brought in
              lookup-table values, 2.2.0 formulas, bounds and referenced-variable specs, 2.3.0 the
              aggregate variables&apos; source and aggregation, and 2.4.0 the cost-premium partition
              parameters. A fingerprint is comparable only within one schema version — the version
              records what the fingerprint <em>covers</em> — which is why the report footer carries
              both. An older printout stays interpretable, not merely mismatched.
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
              Every sub-score is guaranteed to land in 0–100{" "}
              <strong>by construction</strong>, via per-component normalization bounds — the
              [lo, hi] window a raw value maps onto 0–100. Those bounds are an{" "}
              <strong>organisational calibration</strong> (configurable in the settings
              panel), not an industry standard, and not the population min/max, so a score
              does not move just because the rest of the roster did. It is the same division
              of labour the composite makes with its{" "}
              <Ref to="weight-config">weights</Ref>: CIPS names the dimensions and instructs
              the organisation to assign the weighting itself, and prescribes no bounds
              either — the ceilings here are ours to set, defensibly, not a published
              standard.
            </p>
            <p className="rounded-md bg-muted/50 p-2 text-xs">
              <code>
                norm_high(v, lo, hi) = clamp((v−lo)/(hi−lo), 0, 1) × 100 · norm_low(v,
                lo, hi) = clamp((hi−v)/(hi−lo), 0, 1) × 100
              </code>
            </p>
            <p className="text-xs">
              The shipped bounds reflect procurement conventions: near-zero-defect quality
              and a 60-day lead-time ceiling; percentages are 0–100 by definition. Clamping
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
              of Delivery. The shipped bounds simply leave headroom this dataset never
              reaches.
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
              missing <strong>cost premium</strong> is handled at two distinct levels. An
              individual item with no comparator — a single-source item, or one the supplier
              bought only once — is <strong>excluded</strong> from that supplier&apos;s
              spend-weighted average, dropped from both its numerator and denominator: an
              item that was never measured carries no information, so it carries no weight,
              rather than being diluted to 0 (which would assert the supplier is at market on
              an item never priced). Only when a supplier has <em>no</em> qualifying item at
              all does the component fall back to <strong>0</strong> — treated as
              &ldquo;no evidence of overpricing&rdquo;, not a penalty, the same value an
              at-or-below-market supplier scores. An{" "}
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
            <p>
              <strong className="text-foreground">
                The one sanctioned snapshot: weight-sensitivity.
              </strong>{" "}
              Recompute-on-read admits exactly one exception. The drop-one{" "}
              <Ref to="sensitivity">weight-sensitivity analysis</Ref> costs about a minute and runs
              N+1 full recomputes — too slow to redo per request — so it is persisted: recomputed
              when a configuration is saved and STAMPED with the config fingerprint that produced
              it. If the live fingerprint later differs, the tables are marked stale rather than
              shown as current, so a snapshot can never silently misdescribe a configuration it was
              not computed under.
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
            to 0–100 against configurable calibration bounds (
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
            <RiskModelSettings initialModel={riskModel} coverageInputs={coverageInputs} />
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
              Spearman-correlating each drop-one supplier ranking against the original, no
              single weight reorders the portfolio materially — the correlations are in the
              first table below. The performance-risk sub-score&apos;s own two internals are
              the one exception, treated in <Ref to="risk-score">the Risk sub-score</Ref>.
              (Per <Ref to="hazards">the grain-dependence hazard</Ref> these figures are
              grain-dependent, so each window is shown separately. This is a different test
              from the delivery-score half-weighting drop-one in the{" "}
              <Ref to="dead-metrics">dead-metrics catalogue</Ref>, ρ = +0.727 / +0.794, which
              probes the two inputs <em>inside</em> one sub-score.)
            </p>
            <p>
              <strong className="text-foreground">Classification is not robust.</strong>{" "}
              The same perturbation moves a large share of suppliers across a decision
              boundary — the second table gives the per-window figures. Why the ranking and
              the labels disagree — a small score shift flips a label near a median line while
              barely moving the overall ordering — is the median-split churn hazard (
              <Ref to="hazards">cross-cutting inference hazards</Ref>).
            </p>
            <SensitivityTables view={sensitivity} />
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

      {/* 4. Per-Analysis Methods */}
      <Card id="per-analysis" className={cardElevation}>
        <CardHeader>
          <H2 id="per-analysis" />
        </CardHeader>
        <CardContent className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <p>
            The dashboard computes <strong>seven analysis types</strong>. Each is
            documented below in an identical seven-field form so the seven can be
            compared field for field: <strong>(a)</strong> the question it answers,{" "}
            <strong>(b)</strong> its inputs, <strong>(c)</strong> its formula,{" "}
            <strong>(d)</strong> its unit of analysis, <strong>(e)</strong> its
            cut-points, <strong>(f)</strong> the provenance of each component
            (computed from transactions vs a fixed lookup), and <strong>(g)</strong> what
            it cannot say. The last field is the most important, and where a claim is
            genuinely unavailable from this data it is stated as such rather than softened.
          </p>
          <section id="spend-overview" className="space-y-2">
            <H3 id="spend-overview" />
            <Field label="(a) Question">
              What is the shape of spend — how much, with whom, in which categories, and
              how does it move over time? This is the descriptive base the other analyses
              draw on, not a score.
            </Field>
            <Field label="(b) Inputs">
              The <code>EnrichedPurchase</code> PO-grain view — order total value,
              supplier, category, and order date — filtered to the selected window.
            </Field>
            <Field label="(c) Formula">
              Sums and shares only: total spend, spend by category, the top suppliers by
              spend, and a monthly spend trend. Nothing is normalized or weighted.
            </Field>
            <Field label="(d) Unit of analysis">
              Portfolio, category, and supplier (all three cuts of the same posted totals).
            </Field>
            <Field label="(e) Cut-points">
              None — the view is descriptive. The category donut caps at the top eight
              categories with the remainder rolled into &ldquo;Other&rdquo;; that is a
              display cap for legibility, not an analytical threshold, and the real
              category count (14) is reported separately.
            </Field>
            <Field label="(f) Provenance">
              Entirely <em>computed</em> — every figure is a sum of the posted PO totals.
            </Field>
            <Field label="(g) What it cannot say">
              It ranks nothing by quality, risk, or performance; it only measures dollars.
              Spend is the order total as posted, not recomputed as quantity × price (
              <Ref to="definitions">key definitions</Ref>), so it reflects what was
              recorded, not an independent price reconciliation.
            </Field>
          </section>

          <section id="abc" className="space-y-2">
            <H3 id="abc" />
            <Field label="(a) Question">
              Which suppliers make up the bulk of spend — the vital few against the
              trivial many? Classifies suppliers by their cumulative contribution to total
              spend.
            </Field>
            <Field label="(b) Inputs">
              Each supplier&apos;s total spend over the selected window, from{" "}
              <code>EnrichedPurchase</code>.
            </Field>
            <Field label="(c) Formula">
              Suppliers are ranked from highest to lowest spend; the running cumulative
              percentage of total spend determines each supplier&apos;s class. Output
              includes each supplier&apos;s rank, % of spend, cumulative %, and ABC class.
            </Field>
            <Field label="(d) Unit of analysis">Supplier.</Field>
            <Field label="(e) Cut-points">
              <strong>Fixed at 80% / 95%</strong> of cumulative spend, never adjustable:
            </Field>
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
            <Field label="(f) Provenance">
              <em>Computed</em> — cumulative sums of posted spend.
            </Field>
            <Field label="(g) What it cannot say">
              Class membership is spend rank by construction — the cutpoints are taken on
              cumulative spend, so ABC correlates with the supplier spend ranking at
              approximately 1.0 and is not an independent reading of a supplier (
              <Ref to="reading-lenses">the analyses are not independent</Ref>). It says
              nothing about quality, delivery, or risk. On this spend base the vital-few
              interpretation is weaker than usual: spend is not sharply Pareto-distributed
              here, so Class A is a large share of the roster rather than a short list.
            </Field>
            <p className="text-xs">
              Reference: Juran&apos;s Pareto principle (1951); CIPS spend-analysis
              methodology.
            </p>
          </section>

          <section id="kraljic" className="space-y-2">
            <H3 id="kraljic" />
            <Field label="(a) Question">
              How much leverage and supply risk does each supplier relationship carry? A
              deterministic, two-axis segmentation that maps each supplier onto the classic
              Kraljic purchasing portfolio matrix.
            </Field>
            <Field label="(b) Inputs">
              Two axes, window-scoped. <strong>Profit Impact</strong> (X-axis) is supplier
              share of total spend (%), shown on a log scale so suppliers spread readably.{" "}
              <strong>Supply Risk</strong> (Y-axis) is a 0–100 composite of three capped
              components:
            </Field>
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
                (n=1 excluded as noise) and the item has ≥2 suppliers. A single-source
                item — one no other supplier sells — has no peer to price against, so by
                default it is <strong>excluded</strong> from the average, dropped from both
                the numerator and the denominator, rather than scored 0: an item that was
                never measured carries no information, so it carries no weight. The
                supplier&apos;s overall premium is the spend-weighted average of its
                qualifying item premiums; points ={" "}
                <code>clip(premium × 62.5, 0, 25)</code> — so +8% → 5, +20% → 12.5,
                +40%+ → 25; at or below market → <code>0</code> (never negative). A supplier
                with <em>no</em> qualifying item at all falls back to <code>0</code> on the
                component — a supplier-level default meaning &ldquo;not measured&rdquo;,
                distinct from the measured <code>0</code> of an at-or-below-market supplier.
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
            <Field label="(c) Formula">
              The three components are summed and clipped to 100 (the clip is a no-op given
              the ceilings). A <strong>median split</strong> on each axis divides the
              supplier set into four quadrants, each mapping to a distinct management
              approach:
            </Field>
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
              ⚠️ <strong className="text-foreground">Two scales, one number.</strong>{" "}
              The point values above (concentration ≤50, cost premium{" "}
              <code>clip(premium × 62.5, 0, 25)</code>) are what the score{" "}
              <em>emits</em> — the values plotted on the scatter and shown in the detail
              panels. The components are computed internally on a normalized 0–100 scale
              and multiplied by an explicit weight (concentration{" "}
              <code>{"{0:100, 1:70, 2:44, 3:24, 4:10, ≥5:0}"}</code> × 0.50; cost premium{" "}
              <code>clip(premium × 250, 0, 100)</code> × 0.25). The emitted contribution is
              unchanged and <strong>byte-identical</strong>: 0.25 ×{" "}
              <code>clip(premium × 250, 0, 100)</code> is identically{" "}
              <code>clip(premium × 62.5, 0, 25)</code>, and 0.50 × the normalized rungs
              gives back 50 / 35 / 22 / 12 / 5 / 0. The two formulas describe the same
              value on different scales; the emitted parts are rounded then summed so the
              scatter dot reconciles with the panel bars (
              <Ref to="aggregation">aggregation of rounded components</Ref>).
            </p>
            <Field label="(d) Unit of analysis">
              Supplier — a deliberate simplification of Kraljic&apos;s original
              item/category unit (<Ref to="unit">unit of analysis</Ref>).
            </Field>
            <Field label="(e) Cut-points">
              A <strong>median split</strong> on each axis — strict <code>&gt;</code> on
              log-spend, <code>&gt;=</code> on the tie-heavy supply-risk score (
              <Ref to="median-split">median-split classification</Ref>). The component
              ceilings (50 / 25 / 25) are fixed; the cost-premium ≥2-PO / ≥2-supplier
              gates keep single observations and single-source items out of the benchmark.
            </Field>
            <Field label="(f) Provenance">
              Mixed — this is the one classification with a <em>computed</em> component.
              Supply concentration is a <em>lookup</em> on the category roster and import
              friction a <em>lookup</em> on the country; cost premium is{" "}
              <em>computed</em> from actual purchase prices, and it is what lets the score
              tell apart two suppliers of the same category and country (
              <Ref to="risk-score">the Risk sub-score</Ref>).
            </Field>
            <Field label="(g) What it cannot say">
              The X-axis is spend, not true profit impact, and the Y-axis is three
              measurable proxies for a qualitative eight-factor judgement — it omits
              substitutability, storage/perishability, make-or-buy, and competing demand (
              <Ref to="assumptions">assumptions and limitations</Ref>). Several rungs never
              fire on this roster (two country tiers, the true-single-source concentration
              rung), and cost premium is a light tie-breaker rather than a co-equal third
              (<Ref to="assumptions">assumptions and limitations</Ref>). Its spend axis is
              shared with ABC and performance-vs-spend, so agreement across those lenses is
              not independent confirmation (<Ref to="reading-lenses">the analyses are not
              independent</Ref>).
            </Field>
            <p className="text-xs">
              The dataset is synthetic; prices, origins, and category structure are
              patterned on Indonesian mining procurement — informed by benchmarks, not
              verified against them (<Ref to="calibration">calibration benchmarks</Ref>).
              Reference: Kraljic, P. (1983). &ldquo;Purchasing must become supply
              management.&rdquo; Harvard Business Review.
            </p>
          </section>

          <section id="performance-spend" className="space-y-2">
            <H3 id="performance-spend" />
            <Field label="(a) Question">
              How well does a supplier perform for the money spent on it? A two-axis
              diagnostic crossing spend volume with the supplier performance score.
            </Field>
            <Field label="(b) Inputs">
              Per-supplier log-spend and the 0–100 composite performance score (
              <Ref to="composite">the performance composite</Ref>), window-scoped.
            </Field>
            <Field label="(c) Formula">
              Suppliers are split into 4 zones via median lines on the two axes:
            </Field>
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
              delivery 30%, process 22%, risk 18% — see{" "}
              <Ref to="composite-score">the composite score</Ref>, where the weights
              are an organisational calibration choice, not a CIPS prescription).
            </p>
            <p className="pt-1 font-medium text-foreground">Cross-classification synthesis</p>
            <p>
              On the Supplier Classification page this diagnostic is read side by side with
              the Kraljic matrix, because they answer complementary questions: Kraljic
              describes how much leverage and supply risk a relationship carries, while
              performance vs spend describes how well the supplier actually performs.
              Four synthesis buckets combine each supplier&apos;s Kraljic quadrant with the{" "}
              <strong>period performance median</strong> — the same median line the scatter
              uses, so the cards and the chart are always internally consistent.
              &ldquo;Below&rdquo; means a composite at or below the period median;
              &ldquo;above&rdquo; means strictly above it:
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
              supplier table. Everything is <strong>period-scoped</strong> — single-year
              or range — consistent with the rest of the dashboard.
            </p>
            <Field label="(d) Unit of analysis">Supplier.</Field>
            <Field label="(e) Cut-points">
              A <strong>median split</strong> on both axes — log-spend and the composite
              performance median (<Ref to="median-split">median-split classification</Ref>).
            </Field>
            <Field label="(f) Provenance">
              Spend is <em>computed</em>; performance is the composite, mostly computed
              from transactions with a structural Risk lookup (
              <Ref to="composite">the performance composite</Ref>).
            </Field>
            <Field label="(g) What it cannot say">
              The zone labels are median-split-sensitive — a small score shift near a line
              flips a label (<Ref to="hazards">median-split churn</Ref>). Its spend axis is
              identical to Kraljic&apos;s, so &ldquo;a Star is also Strategic&rdquo; is
              forced, not corroborating (<Ref to="reading-lenses">the analyses are not
              independent</Ref>). And on this synthetic data none of the four performance
              components shows a detectable between-supplier behavioural signal (
              <Ref to="reading-findings">findings about the dataset, not defects</Ref>), so
              a low zone is not proof of poor conduct.
            </Field>
            <p className="text-xs">
              Reference: CIPS supplier scorecard methodology (dimension selection);
              cross-tabulation diagnostic pattern from strategic sourcing practice.
            </p>
          </section>

          <section id="cycle-time" className="space-y-2">
            <H3 id="cycle-time" />
            <Field label="(a) Question">
              How long does the procure-to-pay lifecycle take, and is the process healthy?
              The Cycle Time page monitors total procure-to-pay duration as an ongoing
              process-health signal rather than a one-time before/after event.
            </Field>
            <Field label="(b) Inputs">
              Per-PO total cycle days and the four subprocess durations (PR→PO,
              PO→delivery, delivery→invoice, invoice→payment), window-scoped.
            </Field>
            <Field label="(c) Formula">It applies six statistical methods:</Field>
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
                orders furthest above the window&apos;s mean total cycle. See the note
                below for what this is and — importantly — what it is not.
              </li>
              <li>
                <strong>Mann-Whitney U non-parametric hypothesis test</strong>:
                a period-vs-period comparison via a two-sample
                non-parametric test. Chosen over Student&apos;s t-test because it
                assumes nothing about the shape of the distribution — which matters
                here, since the cycle distribution is a bounded plateau rather than a
                bell curve (see the note below). Note it is <em>not</em> chosen because the data
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
              Period comparison is a <strong>midpoint split of the currently
              selected period</strong> — its first half against its second — so it
              measures drift <em>within</em> the period, not year over year. The
              analysis also reports cycle-time descriptives and 3-way match pass
              rates per Kraljic quadrant.
            </p>
            <Field label="(d) Unit of analysis">
              PO, with three per-supplier roster flags:{" "}
              <strong>Has long-cycle POs</strong> (at least one order in the
              longest-cycle cut described below);{" "}
              <strong>Inconsistent</strong> — a supplier whose
              typical range (IQR) exceeds 1.5× the median of all suppliers&apos;
              IQRs, the Tukey convention for unusually wide spread; and{" "}
              <strong>Stage-dominated POs</strong>{" "}
              (at least one PO where a single procure-to-pay stage exceeds 60% of
              that PO&apos;s total cycle).
            </Field>
            <Field label="(e) Cut-points">
              The longest-cycle cut (two standard deviations above the window mean, in
              practice the slowest ~1%), the inconsistency fence (IQR &gt; 1.5× the median
              of supplier IQRs), and the stage-dominated threshold (a stage &gt; 60% of a
              PO&apos;s cycle). None is a normality-based outlier test — see the note.
            </Field>
            <div className="space-y-2 rounded-md bg-muted/30 p-3">
              <h4 className="text-sm font-semibold text-foreground">
                The longest-cycle cut is descriptive, not an outlier test
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
                This follows the same principle as the{" "}
                <Ref to="dead-metrics">dead-metrics catalogue</Ref>: a measure that
                cannot support the claim its name implies is documented rather than quietly
                relabelled. The rule is unchanged and the numbers are unchanged — only the
                description has been corrected to match what is actually computed.
              </p>
            </div>
            <Field label="(f) Provenance">
              Entirely <em>computed</em> — every duration is a difference of recorded dates.
            </Field>
            <Field label="(g) What it cannot say">
              The longest-cycle cut is not evidence that anything is anomalous, and the
              flags are near-proxies for the buying method rather than for supplier conduct
              (see the note above). No fixed significance threshold gates any decision — the
              Mann-Whitney comparison reports a p-value and effect size, but the dashboard
              acts on neither (<Ref to="assumptions">assumptions and limitations</Ref>).
            </Field>
            <p className="text-xs">
              Reference: Mann &amp; Whitney (1947); Cohen (1988); Tukey (1977).
            </p>
          </section>

          <section id="recommendations" className="space-y-2">
            <H3 id="recommendations" />
            <Field label="(a) Question">
              What should be done about the findings? Action Priorities synthesizes the
              four diagnostic analyses into ranked, specific actions, organized into three
              groups that mirror the analyses: <strong>Spend</strong> (Concentration,
              Critical Spend, Tail Spend), <strong>Suppliers</strong> (Critical Issues
              Engagement, Hidden Gems Promotion, Bottleneck Risk Mitigation), and{" "}
              <strong>Process</strong> (Process Improvement, Slowest Stage).
            </Field>
            <Field label="(b) Inputs">
              The outputs of the other analyses — ABC class, Kraljic quadrant, performance
              zone, cycle-time flags — re-read against one another. No new measurement.
            </Field>
            <Field label="(c) Formula">
              Every recommendation carries an impact score (0–100) used to rank actions
              globally across categories. Each category is normalized to the same 0–100
              scale so an engagement and a process fix are comparable. All categories share
              a spend term:
            </Field>
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
            <p>
              Alongside the ranked actions, Action Priorities surfaces a{" "}
              <strong>cross-analysis anomaly hub</strong> — suppliers that stand out
              when the analyses are read against one another, grouped into three
              families:
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Process</strong> — the three per-supplier cycle-time flags
                from <Ref to="cycle-time">cycle time</Ref> (has outlier POs, inconsistent
                spread, and stage-dominated POs).
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
            <Field label="(d) Unit of analysis">
              Supplier, category, or process stage, depending on the recommendation type.
            </Field>
            <Field label="(e) Cut-points">
              The anomaly-hub thresholds (lens-disagreement ≥ 80 percentile points, spend
              fold ≥ 2.5×, score swing ≥ 18 points; the partial-year guard at half the
              prior year&apos;s spend), the Concentration gate (a category &gt; 30% of
              total spend), and the Slowest-Stage flag (an internal stage averaging &gt; 8
              days). All are fixed.
            </Field>
            <Field label="(f) Provenance">
              <em>Computed</em> — every term is derived from the other analyses&apos;
              outputs; nothing new is measured.
            </Field>
            <Field label="(g) What it cannot say">
              It is a re-expression of the four diagnostics, not an independent reading, so
              its rankings inherit their overlaps (<Ref to="reading-lenses">the analyses
              are not independent</Ref>). Two of its categories (Process Improvement, Tail
              Spend) always produce output — they are structural summaries of the portfolio,
              not conditional detections — so they should be read as &ldquo;here is the
              shape of your spend and process&rdquo;, not as &ldquo;a problem was found&rdquo;
              (<Ref to="assumptions">assumptions and limitations</Ref>).
            </Field>
            <p className="text-xs">
              The <strong>Reports</strong> view composes these analyses and recommendations
              into a decision-first document — headline finding → situation → ranked
              findings → an action table — with three tone registers, an optional
              single-supplier brief or single-category deep-dive, and native browser
              print-to-PDF. The report renders its own methodology section, so this is only
              a pointer.
            </p>
          </section>

          <section id="sourcing" className="space-y-2">
            <H3 id="sourcing" />
            <Field label="(a) Question">
              How did spend reach the market — competed, under a standing framework, or
              not competed at all? Coverage measures how spend was sourced, from columns
              that already exist.
            </Field>
            <Field label="(b) Inputs">
              Every purchase order&apos;s <strong>buying method</strong> (one of five
              values) and its spend, plus the sourcing bid graph (events, responses,
              awards). The bucket totals are window-scoped; the shift-share decomposition
              runs over the whole dataset so a transition reads the same on every period
              selection.
            </Field>
            <Field label="(c) Formula">
              Coverage groups the five methods into three mutually exclusive buckets by
              spend: <strong>competed</strong> (RFQ, tender — the order ran its own
              sourcing event with bids and an award), <strong>under framework</strong>{" "}
              (call-off against a standing agreement), and <strong>uncompeted</strong>{" "}
              (direct award, spot buy — no sourcing event). Year-over-year moves are
              decomposed by category with <strong>shift-share</strong>. For each bucket,
              with <code>w</code> = a category&rsquo;s share of period spend and{" "}
              <code>r</code> = the bucket&rsquo;s share of that category&rsquo;s spend:
            </Field>
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
              This is an arithmetic identity with no distributional assumptions; there are
              deliberately no p-values on it.
            </p>
            <Field label="(d) Unit of analysis">Category (and the portfolio total).</Field>
            <Field label="(e) Cut-points">
              None — coverage is a partition, not a threshold. The only fixed rule is the
              three-bucket definition and the permanence of the framework bucket above.
            </Field>
            <Field label="(f) Provenance">
              <em>Computed</em> — buying method and spend are recorded fields; the buckets
              and the shift-share are pure aggregation.
            </Field>
            <Field label="(g) What it cannot say">
              The share of spend whose competitive basis <strong>cannot be verified</strong>{" "}
              is emitted as a number rather than a footnote, because it names a concrete and
              achievable improvement: add a nullable reference from <strong>Framework</strong>{" "}
              to the sourcing event that awarded it. That one field would convert the largest
              single bucket of spend from unverifiable to measurable, without altering any
              existing measure. No coverage percentage on the dashboard is as actionable as
              closing that gap.
            </Field>
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

            <div className="space-y-2 rounded-md bg-muted/30 p-3">
              <h4 className="text-sm font-semibold text-foreground">
                Measured but NOT shown — the sourcing metrics
              </h4>
              <p>
                Several standard-looking sourcing metrics are computable from this data and
                are deliberately not displayed, because on this dataset they are{" "}
                <strong>degenerate</strong>: they return the same answer for every input,
                or they measure an artifact rather than the thing they name. Each was
                tested before the decision was taken, not assumed. These eight are specific
                to competitive sourcing; three further degenerate metrics that share the
                same failure mode but are not sourcing-specific — payment discipline,
                delivery slip, requisition estimate — live in the{" "}
                <Ref to="dead-metrics">dead-metrics catalogue</Ref>.
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
              </ul>
              <p>
                The bidding descriptives that <em>are</em> shown — bid depth (2–4 bidders,
                averaging 3.0) and the portfolio quote spread (12.35%) — describe how the
                competitive processes ran, with no breakdown and no inference.
              </p>
            </div>

            <p>
              <strong className="text-foreground">Framework discipline.</strong> Of 129
              call-offs, all reference a framework belonging to the ordering supplier and
              none reference an inactive framework.{" "}
              <strong>
                15 orders ($36.9M) fall outside their framework&rsquo;s validity window
              </strong>{" "}
              — the one genuine exception the sourcing records contain, all of them in
              2026. The validity window is deliberately not enforced when an order is
              written, so this is a live check reporting a known property of the current
              data rather than a newly detected breach.
            </p>
            <p className="text-xs">
              <strong className="text-foreground">Reproducibility.</strong> Coverage
              results are cached per period and per date range. The cache column is Postgres{" "}
              <code>jsonb</code>, which <strong>normalises object key order</strong> — so
              comparing a cached payload against a freshly computed one with a plain string
              comparison reports every analysis as changed even when no value moved. Such
              comparisons must be done canonically (key-sorted). The coverage payload itself
              carries no wall-clock field, so the same data computes to the same result on
              every run.
            </p>
          </section>
        </CardContent>
      </Card>

      {/* 5. Reading the Composite and the Classification Lenses */}
      <Card id="reading" className={cardElevation}>
        <CardHeader>
          <H2 id="reading" />
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section id="reading-structural" className="space-y-2">
            <H3 id="reading-structural" />
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
              has performed. The variance shares that make this precise, and the standing
              rule that a share is unusable without its grain, are in{" "}
              <Ref to="hazards">the grain-dependence hazard</Ref>.
            </p>
          </section>

          <section id="reading-findings" className="space-y-2">
            <H3 id="reading-findings" />
            <p>
              <strong className="text-foreground">
                This distinction is the most important thing in this section.
              </strong>{" "}
              Tested on this synthetic data, none of the four components shows a
              statistically detectable between-supplier <em>behavioural</em> signal:
              Quality is flat (defect rate across suppliers <em>p</em> = 0.380,
              complaints <em>p</em> = 0.467); Process is indistinguishable from chance
              under an exact permutation (<em>p</em> = 0.367); Delivery is a coin flip
              plus a channel proxy (<Ref to="dead-metrics">dead-metrics catalogue</Ref>,
              delivery-slip entry); and Risk is structural by design and never claimed to
              be behavioural.
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
              This is the same shape as the Quality finding recorded under{" "}
              <Ref to="assumptions">what the model can&rsquo;t see</Ref>: a component
              that is inert on synthetic data and would be expected to discriminate on
              real data. The honest summary is that{" "}
              <strong className="text-foreground">
                these components cannot be validated on this dataset
              </strong>{" "}
              — not that the composite fails to measure supplier behaviour in general.
              The stronger claim is not supported and should not be written.
            </p>
          </section>

          <section id="reading-lenses" className="space-y-2">
            <H3 id="reading-lenses" />
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
              roster-concentration measure (<Ref to="risk-score">the Risk sub-score</Ref>{" "}
              and <Ref to="kraljic">the Kraljic analysis</Ref>). They are two
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
              leads on both. Per <Ref to="hazards">the grain-dependence hazard</Ref>,{" "}
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

      {/* 6. Assumptions and Limitations */}
      <Card id="assumptions" className={cardElevation}>
        <CardHeader>
          <H2 id="assumptions" />
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <p>
            The methodology is fixed, deterministic, and reproducible. This section
            names what it can and cannot see. A page that lists only its formulas is
            a spec; one that names its own blind spots is a defence — so the
            limitations below are stated plainly, as properties we own rather than
            flaws we hide.
          </p>

          <section id="kraljic-departures" className="space-y-2">
            <H3 id="kraljic-departures" />
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

          <section id="model-cant-see" className="space-y-2">
            <H3 id="model-cant-see" />
            <p>
              Several branches of the scoring machinery never engage on the current
              data. We surface them so nobody mistakes an unused rung for a validated
              one.
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Four lookup rows never fire — two country tiers.</strong> The
                composite&apos;s <code>country_distance</code> has an ASEAN tier (30) and{" "}
                <code>import_friction</code> an AFTA tier (32), both meant for
                regional-but-foreign origins. This roster has none — every supplier is
                Indonesian or far-international (Japan, Australia, and the West) — so those
                two rows never engage. Because <code>country_distance</code> drives 60% of
                the structural Risk sub-score, on this data that sub-score is effectively
                &ldquo;Indonesia vs the rest of the world&rdquo;.
              </li>
              <li>
                <strong>… and two rows of the shared concentration table.</strong> There is
                now ONE <code>concentration_curve</code> table with two consumers —{" "}
                <code>supplyRisk.supply_concentration</code> and{" "}
                <code>performanceRisk.roster_concentration</code> — keyed by the number of
                OTHER suppliers in a category. Across the 14 categories that count is 1, 2,
                4, 6 or 7, so the <strong>0-other</strong> row (a true single-source
                category, value 100) and the <strong>3-other</strong> row (value 24) never
                fire: the reachable rung values are 70, 44, 10 and 0. Editing the
                single-source rung changes no score on this data — it would if a sole-source
                category appeared. (Because the table is shared, both consumers inherit the
                same unreachable rows.)
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
                cycle-consistency flag (<Ref to="cycle-time">cycle time</Ref>) is a
                genuine outlier detector, not a common state — on this data it fires
                for 2 of 55 suppliers.
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

          <section id="stat-caveats" className="space-y-2">
            <H3 id="stat-caveats" />
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
                supplier. By default the benchmark is <em>our own</em> spend-weighted
                average price per item, so it catches a supplier out of line with our
                roster, not with the world. An <strong>external</strong> (or hybrid)
                benchmark mode closes that gap: uploading a per-item market reference list
                makes cost premium measure a supplier against the market rather than merely
                against our own average. The reference prices are DATA, not config, so they
                do not enter the fingerprint — under external or hybrid mode the fingerprint
                pins the <em>mode</em> but not the uploaded price list, so a printed report
                is reproducible only if that list is also unchanged.
              </li>
              <li>
                <strong>Two sub-score halves are throttled by their bounds.</strong>{" "}
                Complaint rate is scored 0–100% but real rates top out near 33%, so
                that half only occupies 66.7–100 — the defect half does roughly 2.3×
                the work inside Quality. Lead time is scored 0–60 days but real leads
                run 8–26.5 days, so that half only occupies 55.8–86.7 — on-time
                delivery carries most of Delivery. The shipped bounds simply leave
                headroom this dataset never reaches. (Also stated under{" "}
                <Ref to="normalization">fixed-bound normalization</Ref>.)
              </li>
            </ul>
          </section>

          <section id="baseline" className="space-y-2">
            <H3 id="baseline" />
            <ul className="list-disc space-y-2 pl-5">
              <li>
                The data is <strong>synthetic</strong> — its generator was informed by
                industry benchmarks but not verified against them (
                <Ref to="calibration">calibration benchmarks</Ref>), and it is not a
                record of real operations.
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
                The <em>analytical thresholds</em> are{" "}
                <strong>fixed and not user-adjustable</strong> — ABC at 80% / 95%, the
                median splits on both classification matrices, the longest-cycle cut,
                the 8-day slow-stage flag, and the Mann-Whitney U comparison are all
                constants. The <em>risk-model weights</em> are the one exception: the
                performance-composite blend weights (quality / delivery / process /
                risk), the supply-risk and performance-risk component weights, and each
                component&apos;s enable/disable, are configurable (
                <Ref to="weight-config">weight configuration</Ref>). No other parameter
                is adjustable.
              </li>
              <li>
                The process structure reflects Indonesian government procurement
                regulation (<strong>Perpres 12/2021</strong>).
              </li>
            </ul>
          </section>
        </CardContent>
      </Card>

      {/* 7. Dead Metrics */}
      <Card id="dead-metrics" className={cardElevation}>
        <CardHeader>
          <H2 id="dead-metrics" />
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            Several standard-looking supplier metrics are computable from this data and
            are deliberately not displayed, because on this dataset they are{" "}
            <strong>degenerate</strong>: they return the same answer for every input, or
            they measure an artifact rather than the thing they name. Each was tested
            before the decision was taken, not assumed. The eight metrics specific to
            competitive sourcing are kept with{" "}
            <Ref to="sourcing">that analysis</Ref>; the entries here are the ones whose
            failure mode is general rather than sourcing-specific — payment discipline,
            delivery slip, requisition estimate, and three candidate behavioural signals
            tested and rejected. The recurring inference shape behind the requisition and
            delivery-CV entries — a significant number that is still meaningless — is set
            out under <Ref to="hazards">artifact significance</Ref>.
          </p>
          <p>
            <strong className="text-foreground">How this shows up in the formula editor.</strong>{" "}
            The curated variable catalogue the formula editor offers reflects these findings
            directly. The dead fields here — payment days-past-terms, the requisition estimate,
            cycle-time variability, delivery variability, and payment date (outside the order-year
            window) — appear in the variable picker <strong>locked</strong>, with the reason
            visible, not hidden: showing why a field is unusable teaches the hazard, where hiding it
            would invite someone to rebuild it by hand. Separately, a field that is an INPUT to a
            builtin sub-score — on-time rate and lead time (Delivery), three-way-match rate
            (Process), defect and complaint rate (Quality) — is <strong>blocked</strong> in the
            performance-risk composite: because that composite feeds the performance score through
            its Risk sub-score, placing such a field there would enter the composite twice, at two
            different weights, multiplying rather than adding. The block is structural — the save is
            rejected — and derived from the dependency graph, not a warning to be clicked past. The
            same field is allowed on the standalone Kraljic supply-risk axis, which never feeds the
            performance score, with a note that a behavioural field there is a departure from the
            framework.
          </p>
          <ul className="list-disc space-y-2 pl-5">
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
              residual in another (<em>r</em> = −0.015, <em>p</em> = 0.933). See{" "}
              <Ref to="reading-findings">findings about the dataset</Ref> for what
              this does and does not imply.
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
            <li>
              <strong>Delivery-timing variability — measured, no forward signal.</strong>{" "}
              Beyond the on-time boolean and slip magnitude, the obvious refinement is to
              measure how <em>erratic</em> a supplier&rsquo;s delivery timing is — the
              standard deviation or coefficient of variation of its days-late. It carries
              no information about what the supplier does next. The stable estimator (the
              sd of days-late) predicts next-period lateness at ρ = +0.004, permutation{" "}
              <em>p</em> = 0.97 — dead. The coefficient-of-variation form returns a
              nominal <em>p</em> = 0.033, which is the{" "}
              <Ref to="hazards">artifact-significance</Ref> hazard exactly: the CV is
              −0.56 correlated with the mean level, so it is the level re-expressed
              through a denominator rather than a spread; it is one hit in four tests
              (Bonferroni 0.133); and it is significant in only one of the two year
              transitions (0.044 against 0.22). The outcome it would forecast has no
              robust autocorrelation to forecast (per-transition −0.22 / −0.36, both
              non-significant), so no predictor could honestly pass. Variability adds
              nothing the boolean and slip magnitude have not already failed to say.
            </li>
            <li>
              <strong>Cycle-time consistency — measured, ~93% category.</strong> The
              coefficient of variation of a supplier&rsquo;s total cycle looks like a
              process-discipline trait. It is category wearing a behavioural label: its
              between-supplier variation is <strong>η² = 0.931 against category</strong>{" "}
              (0.280 against country). Cycle time is 73–86% determined by buying method
              and method is bound to category, so cycle-CV re-reports the purchasing mix
              — the same failure the standing &ldquo;cross-tabulate against buying method
              first&rdquo; check is there to catch. It also carries no forward signal:
              next-period lateness <em>p</em> = 0.60, next-period three-way-match failure{" "}
              <em>p</em> = 0.76. It fails both the independence bar (η² far above the 0.10
              threshold a genuine behavioural signal must clear) and the
              forward-prediction test.
            </li>
            <li>
              <strong>Correction rate — not yet measurable.</strong> Correction rows per
              PO per supplier — how often a supplier&rsquo;s orders need a posted
              correction (a quantity, price, or defect fix). Alone among these candidates,
              this one is <strong>guaranteed to carry genuine behavioural signal on real
              data</strong>, precisely because corrections are authored by people through
              the UI and are <em>never</em> drawn by the generator — so the per-order
              independence that kills the others says nothing about it. It cannot be
              measured on this dataset only because the seeded data contains{" "}
              <strong>zero corrections</strong>: the correction table and every correction
              line are empty, so the metric is identically 0 for all 55 suppliers, with no
              variance to test. This is an absence of data, not a degenerate result — on
              production data with real correction activity it should be re-measured, and
              is the candidate most likely to discriminate.
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* 8. Reporting Periods */}
      <Card id="periods" className={cardElevation}>
        <CardHeader>
          <H2 id="periods" />
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Periods are <strong>auto-detected</strong> from the data — one period per
              distinct <strong>order year</strong> present in the purchase orders. This
              is the same <code>poDate</code> order-year basis a PO is tagged and
              filtered by (<Ref to="population">population and scope</Ref>): period
              discovery and period assignment use the one basis, so an order never lands
              in a window it was not counted in. (The earlier payment-date basis predates
              the normalized-data migration.) The 2026 order year is what surfaces the
              2026 period.
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

      {/* 9. Calibration Benchmarks */}
      <Card id="calibration" className={cardElevation}>
        <CardHeader>
          <H2 id="calibration" />
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            The generator&apos;s parameters were <strong>informed by</strong> five
            published sources. Each shaped a specific part of the synthetic data:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>APQC Open Standards Benchmarking</strong> — procure-to-pay cycle
              times (the stage durations from requisition to payment).
            </li>
            <li>
              <strong>Hackett Group P2P automation research</strong> — the magnitude of
              automation&apos;s impact on process metrics.
            </li>
            <li>
              <strong>CIPS Knowledge Hub supplier scorecard methodology</strong> — the
              supplier-KPI categories the composite scores (quality, delivery, risk).
              CIPS names the categories and <strong>prescribes no weights</strong>; the
              weighting is an organisational calibration (
              <Ref to="composite-score">the composite score</Ref>).
            </li>
            <li>
              <strong>MOPS Singapore</strong> (Mean of Platts Singapore) — fuel
              unit-pricing.
            </li>
            <li>
              <strong>AME mining cost reports</strong> — commodity and mining-equipment
              price references.
            </li>
          </ul>
          <p>
            <strong className="text-foreground">
              The generated distributions have not been tested for conformance to these
              benchmarks.
            </strong>{" "}
            Naming a source is not the same as demonstrating the generated data matches
            it. Empirical inspection found generator signatures inconsistent with
            realistic operational behaviour: <strong>payment discipline</strong> drawn
            from a uniform distribution over 0–15 days (integer),{" "}
            <strong>delivery slip</strong> modelled as a coin-flip at a single global
            rate rather than per supplier, and{" "}
            <strong>requisition estimate error</strong> drawn from Uniform(−0.10, +0.15).
            Calibration is therefore <strong>partial and directional, not verified</strong>.
          </p>
        </CardContent>
      </Card>

      {/* 10. References */}
      <Card id="references" className={cardElevation}>
        <CardHeader>
          <H2 id="references" />
        </CardHeader>
        <CardContent className="text-sm leading-relaxed text-muted-foreground">
          <ul className="list-disc space-y-1 pl-5">
            <li>CIPS Knowledge Hub — Chartered Institute of Procurement &amp; Supply.</li>
            <li>APQC Open Standards Benchmarking — P2P process metrics.</li>
            <li>Hackett Group — P2P Automation Benefits Research.</li>
            <li>MOPS Singapore — Mean of Platts Singapore (fuel benchmarks).</li>
            <li>AME Group — Mining cost reports.</li>
            <li>
              Kraljic, P. (1983) — &ldquo;Purchasing must become supply
              management,&rdquo; Harvard Business Review (the Kraljic matrix).
            </li>
            <li>
              Saaty, T. L. (1980) — The Analytic Hierarchy Process (AHP weight
              elicitation).
            </li>
            <li>Juran, J. M. (1951) — Quality Control Handbook (Pareto principle).</li>
            <li>Mann, H. B. &amp; Whitney, D. R. (1947) — Mann-Whitney U test.</li>
            <li>
              Cohen, J. (1988) — Statistical Power Analysis for the Behavioral Sciences
              (effect-size interpretation).
            </li>
            <li>
              Tukey, J. W. (1977) — Exploratory Data Analysis (the 1.5× IQR outlier
              fence).
            </li>
            <li>Perpres 12/2021 — Indonesian government procurement regulation.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
