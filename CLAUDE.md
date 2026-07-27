# Project: Procurement Analytics Web App

A full-stack Next.js web app for presenting mining procurement analytics from synthetic 
data. Multi-user with auth, single organization, fixed analyses (no parameter tweaking).

## CURRENT ARCHITECTURE (2026-07-20) — READ THIS FIRST

> ⚠️ **This block supersedes everything below it.** The sections after "Current Work"
> are dated SESSION HISTORY from the pre-migration flat-`Purchase` era and describe a
> data model that NO LONGER EXISTS. They are kept as history. For current state, this
> block + `git log` are the source of truth.

**Data model = NORMALIZED, 12 tables.** The flat `Purchase` table is GONE. The document
graph is Supplier / Framework / Requisition / SourcingEvent / Response / PurchaseOrder /
PoLine / GoodsReceipt / GrnLine / Invoice / InvoiceLine / Payment.

- **`EnrichedPurchase` is a plain Postgres VIEW** reconstructing a PO-grain row whose
  column names are BYTE-IDENTICAL to the old flat `Purchase` (spend = `totalValueUsd`,
  supplier = `supplierExternalId`, camelCase dates, `*Days`, `onTimeDelivery`,
  `threeWayMatchPass`, `defectCount`). Both Python `load_frames` and the TS read routes
  consume it, so the analyses needed no rename. **Item-level detail is NOT on the view**
  (it is PO grain) — line consumers read `PoLine` via `lib/po-lines.ts`.
- **Period = ORDER YEAR.** `PurchaseOrder.period` and the compute date filter are both
  `poDate` (was payment-year in the flat era — the one deliberate plumbing change).
- **Analytics math is UNCHANGED** by the migration: composite 0.30Q/0.30D/0.22P/0.18R,
  supply-risk = concentration + cost premium + import friction, ABC 80/95, cycle z>2.
- **three-way match** tests INVOICE vs PO+receipt (no overpay), NOT that everything
  ordered arrived: per line, billed == accepted (accepted = received − rejected) AND
  invoice price == PO price. A correctly-billed partial delivery PASSES.

**Write paths are RESTORED (Phases 1-6, 2026-07-20).** They were 501-stubbed during the
migration; all are live again:
- **Recompute** — `lib/recompute.ts` -> `python/seed_compute.py --json`. THE single
  sanctioned path after ANY data change. Full recompute (~6s): rewrites SupplierMetric,
  runs `compute_analyses` per period, clears the range cache. Serialized via a promise
  chain (concurrent recomputes would interleave writes). Incremental is NOT possible —
  roster concentration is global and the ABC/Kraljic/zone splits are population medians.
- **Supplier CRUD** — add / edit / deactivate. Master data uses an append-only
  **history log** (`SupplierChangeLog`: who / when / field / before -> after). Suppliers
  are never deleted (5 RESTRICT FKs); retirement is `status` active <-> inactive.
  ⚠️ Status is master-data ONLY — the compute layer never filters on it and counts
  inactive suppliers deliberately, so deactivating changes NO analytics number.
- **Dataset import** — three modes: replace-all, append suppliers (upsert), append
  transactions (insert-only complete chains), plus a generated template download.
  See "Data flow for imports".
- **Transaction create** — records a COMPLETE document chain (PR -> PO + lines -> ONE OR
  MORE GRNs + lines -> invoice + lines -> payment) in one atomic transaction. ⚠️ **No
  open POs, by design**: the view COALESCEs a PO with no invoice lines to
  `threeWayMatchPass = TRUE`, so an open PO would count as a match PASS while
  contributing to no other rate denominator. Supporting them would require changing a
  rate denominator. See "RECORD-PURCHASE FORM" below for the request shape.
- **Corrections** — posted transactional records are IMMUTABLE (Postgres BEFORE UPDATE
  triggers on the 10 document tables reject any edit). A mistake is fixed by APPENDING a
  signed correction line linked via `correctsLineId`, with a `Correction` audit header.
  Three kinds: quantity, price (credit + re-bill), defect. See "POST-CORRECTION FORM v2"
  below for the dialog.
  - ⚠️ The triggers block **UPDATE only**. DELETE stays open for the importer, and
    `SET LOCAL app.bulk_import = 'on'` is the sanctioned escape hatch — load-bearing,
    because the correction FKs use `ON DELETE SET NULL` and referential actions fire
    triggers. Set by both the importer transaction and the seed.
  - ⚠️ **Corrections FOLD into the corrected item** in every line-level read
    (`lib/po-lines.ts`, Python `load_po_lines`) so no breakdown shows a phantom
    negative-quantity item.

**BUYING METHODS — FIVE, two of them competitively sourced** (`BUYING_METHODS`,
`lib/transaction-create.ts`): `rfq | tender | spot_buy | call_off | direct`.
- **rfq and tender are PEER competitive methods** — each order carries its OWN
  `SourcingEvent` + `Response` rows + award. They are two methods, NOT one method
  with a type: tender differs in scope, sealed bids, public bid opening and
  formality. `spot_buy` / `call_off` / `direct` carry NO sourcing.
- ⚠️ **`SOURCED_METHODS = ["rfq","tender"]` + `isSourcedMethod()` is THE single
  definition** of "does this order have sourcing". SIX sites once tested
  `method === "rfq"` for it (the chain's sourcing gate, three append-validator rules,
  two form conditionals); missing one yields a form that renders fine but posts an
  incomplete payload, or a validator that rejects a legitimate tender. **Never
  re-inline the literal — ask the predicate.**
- **Sourcing-event ids are prefixed per method** (`SOURCING_ID_PREFIX`):
  `RFQ-<year>-0001` / `TND-<year>-0001`, on INDEPENDENT per-year sequences. Response
  ids derive from the event id (`<eventId>-Q01`), so they inherit the prefix.
- **Both import paths validate the vocabulary** — replace-all and append each reject
  an unknown OR blank `buying_method` (a blank would be neither sourced nor
  non-sourced and would satisfy no conditional).
- ⚠️ **`solicitation_type` NO LONGER EXISTS.** Tender was first modelled the SAP MM /
  D365 way — ONE sourcing document carrying a type — as `SourcingEvent.solicitationType`
  (migration `20260720160000_add_solicitation_type`), then REVERSED and dropped
  (`20260720170000_drop_solicitation_type`) when tender was promoted to a full buying
  method. Both migrations stay in history (forward-only, so an already-migrated DB
  stays consistent); the column is gone. Commits `7468c51`→`af95e35` are that arc.
- **Dataset:** 75 tender POs — the former TOP-VALUE rfq POs (avg $1.21M vs rfq's
  $0.57M) — on `TND-` events, 2024×28 / 2025×24 / 2026×23. Distribution: rfq 151 ·
  tender 75 · spot_buy 194 · call_off 129 · direct 98 = 647.
  ⚠️ **The conversion left the BASELINE byte-identical** (no PO added, no line value
  changed). ⚠️ **The "analytics reads NEITHER `buying_method` NOR the sourcing
  documents" claim that stood here is SUPERSEDED** — `cycle_time` reads the method
  (`fa9f83c`) and `sourcing_coverage` reads the method AND the bid graph (`35dfd50`).
  The baseline is still byte-identical; both are purely additive.

**SOURCING COVERAGE — the 7th analysis (`sourcing_coverage`).** 2026-07-23, commits
`35dfd50` → `be89782` → `bc74109` → `b934e53`. Measures how spend reached the market
from existing columns. No schema change, no migration, no locked-formula change.

- ⚠️ **THREE BUCKETS, and `framework` is PERMANENT — never fold it into either side.**
  `Framework` carries NO sourcing linkage (no awarding event, no responses), so the
  data cannot say whether a call-off's agreement was competed. A binary would be wrong
  by the whole call-off share **whichever way it fell**. Competed (rfq+tender)
  **25.11% / $177,714,190.31** · framework (call_off) **44.78% / $316,883,132.56** ·
  uncompeted (direct+spot_buy) **30.11% / $213,089,993.33**. `COVERAGE_BUCKETS` in
  `compute_analyses.py` is the single definition — never re-inline a method literal.
- **That inability to verify is emitted as a FINDING** (`unverifiable_share`), not a
  footnote: it names a concrete schema fix (link Framework → its awarding event),
  which is more actionable than any coverage percentage.
- **Surfaces:** a `CompetitiveCoverageCard` on Spend Overview between the category
  donut and `AbcParetoCard`, two `InsightsPanel` glance paragraphs, and a 7th report
  appendix toggle (`sourcingCoverage`). **Appendix EVIDENCE only — it contributes no
  ranked finding to the report argument**, and there is deliberately NO Action
  Priorities recommendation (one would have to rest on a dead metric — see below).

⚠️ **EIGHT DEGENERATE METRICS — MEASURED, THEN DELIBERATELY NOT BUILT. Read this
before "adding the obvious missing KPI"; every one of these looks like a free win and
is dead on this data:**
1. **Award-to-cheapest** — 226/226 awards at price rank 1. Universal pass.
2. **Single-bid exposure** — minimum bid count is **2** (31 events at 2, 165 at 3, 30
   at 4). Zero single-bid events, so it is permanently $0.
3. **Bid response rate** — `numSuppliersInvited` always equals the response count
   (2→2, 3→3, 4→4). A constant 100%.
4. ⚠️ **Quote-spread BREAKDOWNS** — spread is an ORDER STATISTIC OF THE BID COUNT:
   9.22% at 2 bids, 12.80% at 3, 13.06% at 4. Hold bid count at 3 and every other cut
   goes flat — category 11.15–13.44 against a *within*-category sd of 3.2–4.4 (the
   between-category range is under half one within-category sd), period 12.85/12.71/
   12.84, supplier within sampling noise. **The PORTFOLIO number (12.35%) is fine; ANY
   cut of it reports the bid-count mix wearing a category label.** "Conveyor & Belt has
   the tightest bidding" is false — all its events simply have two bidders.
5. **Savings-vs-field cuts** — the award is always the minimum, so this is a
   deterministic re-expression of #4. ⚠️ Plus a scoping trap: a `Response` carries ONE
   quoted price matching ONE PO line, and that line averages **64.66% of PO value**, so
   the **$7.36M** advantage (against $113.3M of awarded-line value) **must NEVER be
   scaled onto the $177.7M of competed spend** — it would overstate by ~1.5×.
6. **Competed-vs-uncompeted price premium** — the most dangerous one, because it is
   computable on the 26 items bought both ways and looks like the flagship finding.
   It is noise: mean **+4.58%**, median **−6.98%**, sd **61.96%**, with **14 of 26
   items CHEAPER uncompeted** against 12 dearer. Scatter ~13× the effect; the sign is
   decided by which items you pick.
7. **Sole-source challengeability** — every direct PO carries a proprietary/OEM
   justification. The category-roster count is far too coarse a proxy for item
   substitutability: the 8 suppliers in Heavy Equipment OEM are 8 different OEMs, and
   a Volvo part is not a Liebherr part.
8. **Pre-close PO dates** — fires on 51 of 226 events, but close→PO spans **−8 to +15
   days** (independent draws). Flagging a quarter of all competitive events would
   manufacture an accusation from noise.

⚠️ **THE D/E ASYMMETRY — the two readings are NOT interchangeable, and the code
encodes which is which:**
- **D (year-over-year coverage) is BEHAVIOURAL.** Competed coverage fell **9.89 points**
  in 2025 — **−6.37 within vs −3.51 mix**, i.e. ~2/3 is the same categories bought less
  competitively. 2026 recovered +7.43, almost all within. This is the ONLY behavioural
  signal in the feature. ⚠️ **Never hardcode which side dominates** — an early draft of
  the emitter's docstring asserted "mostly a purchasing-mix shift" and the emitter it
  documented disproved it. `_coverage_mix_shift` decomposes by CATEGORY
  (`mix + within == pooled_change`, exact); a mix-dominated window carries
  `reason: "mix_dominated"` and the copy must flip.
- **E (value-vs-method) is STRUCTURAL ONLY.** Median PO value spot_buy $57.8K → rfq
  $608.5K → tender $1.21M → direct $2.08M → call_off $2.37M. **All 98 direct POs carry
  OEM/proprietary sole-source justification**, so an OEM part cannot be competed by
  definition — describe the shape, NEVER attribute it to buyer discipline.
- ⚠️ **`lib/coverage-copy.ts` holds the SHARED classifier** (`classifyCoverageMove` /
  `visibleCoverageMoves`) consumed by BOTH the card and the report appendix, so a
  generated report cannot silently contradict the page it came from. Each surface
  picks its own words; only the verdict is shared. The card is a REGRESSION SURFACE
  for any change here. The constraints are also written into the TS types
  (`CoverageBucket`, `CoverageBidding`, `CoverageMixTransition`).

⚠️⚠️ **STANDING CHECK — BEFORE BUILDING ANY BREAKDOWN, TEST WHETHER
`buying_method` DETERMINES IT.** This has now bitten FOUR times, and each time the
proposed cut turned out to be buying method wearing a different label:
1. **Pooled cycle time is a five-population MIXTURE** (spot_buy ~44d → direct ~130d),
   so a shift in method mix moves the pooled number while every method individually
   goes the other way. Fixed with the mix-adjusted decomposition (`fa9f83c`).
2. **The cycle-time anomaly threshold is reachable only by `direct`.** It sits near
   160 days, above the MAXIMUM cycle of every other method (spot_buy 68, call_off
   109, rfq/tender 149; direct 171). All flagged orders are direct — the "anomaly"
   flag is a proxy for the channel (`778f9c4`).
3. **`paymentTerms` is near-deterministic in method** — spot_buy→Net 14 (194/194),
   rfq→Net 30 (151/151), tender→Net 30 (75/75), direct→Net 45 (98/98); only
   `call_off` splits (Net 30 63 / Net 45 66). Four of five methods carry exactly ONE
   term, so a per-term cut is a per-method cut.
4. **LEAD TIME is 73-86% method-determined** — 73.0% of order-level variance; method
   MIX explains 86.4% of between-supplier variance. There is NO residual supplier
   effect (p = 0.266) and ZERO cross-channel consistency: across 32 suppliers using
   two or more methods, a supplier's lead residual in one channel does not predict its
   residual in another (r = -0.015, p = 0.933). Promised lead by method: spot_buy 6.4d,
   call_off 12.5d, rfq 45.4d, tender 47.0d, direct 54.2d. ⚠️ This one reaches a LOCKED
   INPUT — `delivery_score` carries 0.30 of the composite. See Methodology 10.3: it is
   a DATASET property, not a model defect, and NO formula change is warranted.

**The check is cheap: cross-tabulate the proposed dimension against `buying_method`
before building anything.** If most methods map to one value of it, the breakdown
will re-report method under another name — and because cycle time, order value and
payment terms are all near-deterministic in method on this data, that is the DEFAULT
outcome, not an edge case. Say so in the plan rather than shipping the cut.

⚠️ **IT HAS NOW RUN FIVE TIMES AND CLEARED ONCE — the check is DISCRIMINATING, not a
rubber stamp.** Requisition estimate accuracy (2026-07-24) is the first NEGATIVE:
method is the WEAKEST dimension of every one tested — η² = 0.00087, ANOVA p = 0.968,
and the permutation on the spread of method means gives p = 0.956 with the observed
spread (0.0027) sitting BELOW the null (0.0063). That cut genuinely was not method.
**The field was still dead, for an unrelated reason** (dead metric #11 below).
**A clear on this check buys you one surviving hypothesis, never a build.**

⚠️ **PAYMENT DISCIPLINE IS DEAD — measured 2026-07-23, NOT built.** Days paid past
terms is a uniform random draw on {0..15}: χ² p = 0.336 against Uniform, mean 7.27 vs
theoretical 7.50, sd 4.54 vs 4.61, and NOTHING explains its variance (supplier
p = 0.92, category 0.96, period 0.64, method 0.55, term 0.49). The permutation test is
decisive — the spread of supplier means (1.59) is BELOW what random reassignment gives
(1.72), p = 0.747, i.e. less varied than chance; 0 of 22 large suppliers reject
uniformity on shape. "Pays ~7 days late and never early" is the generator's
non-negative lower bound, not discipline. Full evidence in Methodology 9.5 entry 9.
⚠️ **`paymentTerms` is NOT on the `EnrichedPurchase` view.** Any future build must
read it from `PurchaseOrder` keyed by `poId` and INTERSECT against the view-derived
frame — never re-spell `NOT EXISTS "PurchaseOrderVoid"`. The site count stays at FOUR.
`lib/cycle-breakdown.ts` already does exactly this for the one salvaged finding below.

⚠️ **DELIVERY SLIP MAGNITUDE IS DEAD — measured 2026-07-23, NOT built.** Slip adds
nothing to the existing boolean (slip-given-late vs supplier on-time rate ρ = -0.196,
p = 0.207; permutation on supplier mean slip p = 0.471). ⚠️ **The on-time BOOLEAN is
itself a coin flip** at the global rate — exactly binomial at supplier-period grain
(χ²/df = 1.03, p = 0.411), exact label permutation p = 0.955. There is no supplier
signal to refine. ⚠️ **CORRECTED — `delivery_score`'s two halves contribute ~EQUALLY**
(on-time 48.6% / lead 51.4% by covariance share; drop-one Spearman +0.727 / +0.794).
An earlier reading called it lead-dominated from correlations of +0.880 vs +0.555 —
that was a by-construction artifact (both halves correlate with their own sum). Do not
revive it. Methodology 9.5 entry 10 carries the full evidence.
⚠️ **`promisedDeliveryDate` is NOT on the `EnrichedPurchase` view** (same as
`paymentTerms`). Any future build must read it from `PurchaseOrder` keyed by `poId`
and INTERSECT against the view-derived frame — never re-spell `NOT EXISTS
"PurchaseOrderVoid"`. The site count stays at FOUR.

⚠️ **REQUISITION ESTIMATE ACCURACY IS DEAD — measured 2026-07-24, NOT built. Dead
metric #11, and the most DECEPTIVE of the eleven.** `Requisition.estimatedValueUsd`
looks like the one human judgement in the dataset — a budget owner's guess made
before the market answered. It is a jittered copy of the order it became:
**`estimatedValueUsd = totalValueUsd × (1 + v)`, `v ~ Uniform(−0.10, +0.15)`** —
IDENTIFIED, not merely "consistent with", because the parameters were held FIXED and
UNFITTED so the fit had nothing to tune: KS D = 0.0200 **p = 0.953**; χ² null at every
resolution (10/20/25/50 equal bins → p = 0.651 / 0.655 / 0.867 / 0.452); moments land
to four decimals (mean 0.0251840 vs 0.0250000, sd 0.0723471 vs 0.0721688, excess
kurtosis −1.2197 vs −1.2000); support [−0.0998566, +0.1499267] against the order
statistics expected of 647 draws (−0.0996142 / +0.1496142), with **ZERO values outside
the window**. Every competing shape rejects hard: Normal p = 5.2e-03, Shapiro–Wilk
2.0e-13, symmetric uniform 2.9e-16, triangular 9.8e-11.
- ⚠️ **THE JENSEN TRAP — a p-value below 1e-11 that means NOTHING. This is why the
  entry is here.** Read the natural way, as `(actual − estimate) / estimate`, the field
  yields MAE **6.27%** and an under-estimation bias of **−1.97%** significant at
  t = −7.20, **p < 1e-11**. Both are pure algebra. That expression is `1/(1+v) − 1`, a
  NONLINEAR transform of the window, and a nonlinear transform of a distribution
  symmetric about a non-zero mean does not stay centred: E[|1/(1+v)−1|] = 6.2394%
  (observed 6.2687%), E[1/(1+v)−1] = −1.9510% (observed −1.9674%), P(under estimate)
  = 0.10/0.25 = 40.00% (observed 41.58%, binomial p = 0.42). **The p-value measures how
  precisely the CONSTANT −1.9510% was pinned down by 647 samples — nothing about
  anyone's estimating. Significance answers "is this reliably non-zero", never "does
  this mean anything".**
- **Nothing explains the residual.** Category η² = 0.018 (p = 0.58), department 0.012
  (p = 0.37), supplier 0.086 (p = 0.39), method 0.00087 (p = 0.968 — see the standing
  check above, this is its first negative). No correlate is real: order value r = +0.028,
  line count −0.012, promised lead −0.015, total cycle −0.012; |err| by three-way-match
  outcome 6.21% vs 6.65% (p = 0.29), by on-time outcome 6.23% vs 6.28% (p = 0.86).
- ⚠️ **ONE SIGNAL CLEARS BONFERRONI AND IS STILL REFUSED** — recorded because anyone
  re-running this will find it and it looks convincing. A max-statistic permutation
  across the 12 requesters (the multiplicity-exact test) returns **p = 0.0083**: one
  requester's 46 orders sit **3.3 points below the window mean** (−0.0076 vs +0.0250),
  worth $1.5M against their $46.5M of spend. **Refused because the estimate is computed
  FROM the actual, so causality runs BACKWARDS** — a jittered copy of the eventual order
  value was never a forecast and cannot evidence how anyone forecasts. There is no
  mechanism for the finding to be about. Drop-one confirms the whole family is one
  person (p = 0.747 without them); the spread-of-requester-means permutation — the test
  that settled #9 and #10 — does not reject (p = 0.083); and recentring their draws on
  the window mean restores uniformity (p = 0.176), so it is a location shift, not a
  different shape. **A per-requester estimating scorecard is not a weak finding needing
  more data; it is unavailable in principle from a field built this way.**
- **The portfolio aggregate is a constant for the same reason.** Summed estimates
  $726,480,991.35 vs actuals $707,687,316.20 = **+$18.79M / +2.66%**, which is
  E[v] = +2.5% and moves only with sampling noise. It would read as a systematic
  planning finding.
- ✅ **FABRICATED-ESTIMATE BUG — FIXED 2026-07-24 (route a: collect it).**
  `lib/transaction-create.ts` used to set `estimatedValueUsd: totalValueUsd`, so every
  UI-recorded transaction got a **mathematically perfect estimate** — any accuracy metric
  on this field would have scored hand-entered orders at 0% error forever, measuring
  **PROVENANCE (seeded vs hand-entered), not accuracy**. Now the record-purchase form
  COLLECTS the estimate (`estimated_value_usd` on `RecordPurchaseCard`, in the requisition
  group beside requester/department) and `createTransactionChain` writes the SUBMITTED
  value. Made **REQUIRED** in `CreateTransactionBody` (positive, finite, ≤ $1B), not
  optional, because the column is `NOT NULL` and any fallback on a blank field would
  fabricate it again — the same failure in a new place. ⚠️ **Deliberately NOT constrained
  relative to the order total** (over- and under-estimates are both legitimate; coupling
  it would re-introduce the very synthetic relationship the dead-metric analysis exposed).
  Verified with a rolled-back write: order total 10,000, submitted estimate 7,777,
  persisted 7,777 — uses the submitted value, no fabrication; the 647 seeded rows are
  untouched (their estimates are pre-existing, still the `× (1+v)` jitter). **The
  provenance hazard is closed for NEW rows**; the historical dataset is unchanged, so the
  metric stays dead (this fix does not resurrect it — it just stops manufacturing perfect
  estimates on new orders).
- ⚠️ **`estimatedValueUsd` is NOT on the `EnrichedPurchase` view — but it DIFFERS from
  `paymentTerms` / `promisedDeliveryDate`.** The view ALREADY carries
  `JOIN "Requisition" r ON r.id = po."prId"` (it sources `prDate` from there), so the
  column could be appended to the END of the select list purely additively — the exact
  `buyingMethod` precedent (`20260723130000`) — and would inherit the void filter for
  free. **Use the view; never read `Requisition` directly in TS or Python**, which is
  the only path that would need the poId-intersect. Either way **the site count stays at
  FOUR**.
- Full evidence in Methodology 9.5 entry 11.

⚠️ **RELATIVE CHANGE HAS NO CANONICAL DENOMINATOR — STATE IT OR DON'T SHIP IT.** Same
class of hazard as the grain-dependence below: a number that is UNUSABLE without its
convention attached. On the estimate field the choice **flips the sign of the
headline**: `(actual − est)/est` = **−1.97%** ("buyers under-run their estimates")
against `(est − actual)/actual` = **+2.52%** ("buyers over-estimate"), with MAE 6.2687%
vs 6.5357% — same 647 rows, opposite conclusions, on nothing but a denominator choice.
✅ **Both shipped ratio surfaces already comply (checked 2026-07-24):** the cycle-time
year-over-year transition table states it in its own subhead — "Percentages are of the
earlier year's pooled mean" (`components/CycleTimeView.tsx`) — and the coverage surfaces
sidestep it entirely by reporting percentage POINTS and absolute levels, never a
relative change (`changePts` is typed "in percentage points"; `pointsLabel` renders the
unit into the sentence; the card says "25.11% to 15.22%"). **Any NEW ratio surface must
do one of those two things.**

⚠️ **COMPOSITE VARIANCE SHARES ARE GRAIN-DEPENDENT — a share without its grain is
UNUSABLE.** Risk is the only component that never varies within a supplier across
periods (0 of 55, vs Delivery 49 / Process 36 / Quality 23), so aggregating years
averages away the behavioural components while Risk's spread cannot move
(sd 31.10 → 31.22). Shares by grain: **all-years default (55 suppliers) Q -1.0 /
D 35.5 / P 9.1 / R 56.4** · 2024 (50) -0.7 / 44.0 / 23.8 / 32.8 · 2025 (51) +8.5 /
32.9 / 12.9 / 45.7 · 2026 (50) +0.8 / 46.4 / 15.5 / 37.3. **"Risk is the dominant
term" UNQUALIFIED IS NOT QUOTABLE** — true on the all-years view, false on 2024 and
2026. Only "Quality contributes ~nothing" is stable at every grain. The pooled
151-supplier-period population (Q +2.4 / D +42.6 / P +17.5 / R +37.5) is arithmetically
fine but corresponds to NO view a user sees — do not quote it as a description of the
dashboard. Full treatment in Methodology 10.

⚠️ **THE ONE REAL FINDING IT PRODUCED — 80% of Invoice→Payment is CONTRACTUAL.** The
stage averages 36.3 days and is flagged as the slowest, which reads as ~36 days of
addressable process delay. It is not: 29.0 days is the spend-weighted mean payment
term the organisation AGREED to, leaving ~7.3 days discretionary (stable at 80.2 /
79.7 / 80.0% across 2024/2025/2026). Surfaced on the Process Health glance, the
Action Priorities "Slowest stage" panel and the report cycle prose, so a reader is not
pointed at a target 5x bigger than what can be acted on. ⚠️ Computed in
`lib/cycle-breakdown.ts` (`paymentTermsSplit`) — TS-only, NOT an AnalysisResult
payload, so no md5 moves. **PORTFOLIO-LEVEL ONLY: never cut it by supplier, category
or period** — that is the dead metric above.

⚠️ **FOUR TRAPS THIS FEATURE HAD TO CLEAR — they generalize to any new analysis:**
- **VOID INHERITANCE — the site count stays FOUR, not five.** `load_sourcing_events` /
  `load_calloff_frameworks` carry NO `NOT EXISTS "PurchaseOrderVoid"`; they are keyed
  by poId and INTERSECTED against the window frame, which comes from the view and is
  already void-excluded. Re-spelling the filter would have created a fifth site — the
  trap CLAUDE.md flags on `load_po_lines`. Verified: removing one PO from the frame
  removes exactly one bidding event.
- **Mode A's gate is `succeeded == len(all_types)`**, so a new emitter that THROWS on a
  thin window turns EVERY recompute (supplier CRUD, imports, corrections, voids) into
  exit 1. `sourcing_coverage` returns a structurally complete zero payload instead
  (`_empty_coverage`), and an unknown buying method is COUNTED in `unclassified` rather
  than absorbed into a bucket, so a vocabulary regression stays visible.
- **`RANGE_TYPES` must list EVERY emitted type.** It governs both halves of the range
  cache, so if it lags Python a cache MISS returns the full output while a cache HIT
  returns the shorter cached set — the same span yielding different key sets depending
  only on whether it was computed before. Self-healing on addition: existing cached
  spans fail the completeness check and recompute.
- ⚠️ **THE `jsonb` KEY-ORDER TRAP.** `AnalysisResult.resultJson` is `jsonb`, which
  NORMALISES object key order. A cached-vs-fresh comparison by plain `JSON.stringify`
  reports **every** analysis as changed — all six pre-existing ones included — when no
  value moved. **Compare canonically (key-sorted) or the check is meaningless.** Cost a
  false alarm before being pinned down.

- **Methodology §9** documents the split, the shift-share identity, and all eight
  exclusions with their numbers. ⚠️ **`SHOW_METHODOLOGY` is now `true` (flipped
  false→true in `5427c2c`, 2026-07-24), so `/methodology` — and §9 — IS reachable.**
  A condensed tone-aware exclusions paragraph is ALSO carried in the report appendix (a
  surface the flag never affected). **Keep the two in sync** — both are live. *(This line
  previously read "gated behind SHOW_METHODOLOGY = false, so §9 is UNREACHABLE"; that was
  stale after the 2026-07-24 flip and misled a later session into a wrong report — always
  verify a flag's LIVE value, never trust this doc for it.)*
- **⚠️ VERIFIED (2026-07-23).** Baseline byte-identical at every stage and all SIX
  pre-existing analyses byte-identical across 2024/2025/2026/range in BOTH modes (Mode
  A 18 stored payloads, Mode B 24 comparisons) — the control proving the type is purely
  additive. Every displayed figure independently recomputed in SQL; the shift-share
  identity holds to full float precision on all 6 transitions × 3 buckets; 13 edge
  tests; determinism (5 identical runs, row-order independent, no wall-clock field).
  Adversarially reviewed across 7 dimensions. tsc + ESLint clean.

**RECORD-PURCHASE FORM (`RecordPurchaseCard` + `CreateTransactionBody`).** Group A,
2026-07-20. Form paths only — no analytics, compute, schema or migration change.

- ⚠️ **RECEIVING IS PER RECEIPT, not per PO.** `site` / `received_by` / `receipt_date`
  are NOT top-level: the request carries a **`receipts[]`** array, each entry with its
  own date, site, receiver and the subset of order lines it delivered
  (`{line_index, quantity_received, quantity_rejected, defect_count}`). `lines[]` keeps
  ordering + BILLING only (`quantity_billed`, `invoice_unit_price_usd`), which stay
  PO-level because there is one invoice. Matches the data: 28% of orders have two
  receipts, 136 of those at DIFFERENT sites, 315/322 lines split by partial quantity.
  GRN sequences are allocated **per year**, so a delivery straddling a year boundary
  still gets a correct id. Billed defaults to accepted summed ACROSS receipts.
  - Validation: ≥1 receipt · every order line covered by ≥1 receipt · no receipt before
    `po_date` · none after `invoice_date` (it IS the view's `deliveryDate`) · received
    across receipts ≤ ordered · rejected ≤ received. **Under-receipt stays legal** — a
    correctly-billed partial delivery passes the three-way match by design.
  - ⚠️ **Blank-quantity convention differs by mode:** with ONE receipt a blank quantity
    means the WHOLE line arrived (preserves the earlier ergonomics); with SEVERAL it
    means ZERO, because "the rest" is ambiguous once split.
- ⚠️ **GRN STATUS = CUMULATIVE ARRIVAL.** A receipt is `complete` once everything
  received up to and INCLUDING it has reached the ordered quantity on every line, else
  `partial`. Verified against all 829 seeded receipts — 647/182 separate PERFECTLY on
  that rule, and a two-receipt order reads partial then complete. **Rejections do NOT
  make a receipt partial** (25 seeded `complete` receipts carry rejected quantity); the
  old single-receipt code additionally required zero rejections, which was WRONG and is
  corrected. Inert: `GoodsReceipt.status` is read by neither the view nor `python/`.
- **Name validators** (`personName` / `orgName` in `lib/transaction-create.ts`; zod is
  authoritative, mirrored client-side by the shared `nameError` helper). `min(1)` alone
  let "12" and "da12" become the requester of a posted, immutable document.
  **requester + received_by → `personName`** (a PERSON: ANY digit rejected — no seeded
  value has one). **department + site → `orgName`** (a place/function: only digit-ONLY
  rejected, so "Warehouse 2" passes; "HSE" and "Drill & Blast" pass — no min-length, no
  two-word rule). Both require a letter; letters match `\p{L}`, so a non-ASCII name is
  not rejected for being non-English.
- **Framework picker (call-off).** ⚠️ The supplier filter is CORRECT domain logic, not a
  bug — every call-off references a framework owned by its own supplier. Only 21 of 55
  suppliers HAVE one, so an empty list is the common legitimate case: the field is
  `disabled` until a supplier is chosen, the empty message NAMES the supplier and the
  reason, and the condition is surfaced on the Call-off button so the dead end is
  visible BEFORE selection. ⚠️ The framework DATE WINDOW is deliberately NOT enforced —
  15 existing call-offs fall outside theirs. ⚠️ Known: the picker filters
  `status: "active"`, so an EXPIRED framework would vanish silently.
- **Item field** is a per-supplier creatable dropdown (each supplier has 2-5 items).
  Picking a known item AUTO-FILLS category + unit — both are strictly 1:1 with the item
  (0 items span two categories, 0 span two units). **Category is
  DERIVED-WITH-OVERRIDE, not read-only**, so a new item in a new category is possible; a
  created name matches nothing, so category/unit stay as typed.

**POST-CORRECTION FORM v2 (`CorrectionCard`).** 2026-07-21, commits `dfa6638` →
`49e2185` → `ef9b37c`. Filter card → Select PO → a form that MIRRORS record-purchase.
No schema change, no migration, no analytics-formula change.

- **Find the order:** typeable supplier (`TypeableCombobox`) + a classic match
  pass/fail `<select>` + **period year buttons** + a **SEPARATE poDate date-range**.
  ⚠️ **Period and PO-date are DIFFERENT AXES and must stay labelled apart** — period
  is the order YEAR (a grouping); the range finds orders placed in a window, which
  may sit inside one year or straddle several. Verified: a 2024-11→2025-02 range
  returns 54 orders (no period value can express that), and period=2024 on top
  narrows it to 26.
- **The form is a PARALLEL component — `RecordPurchaseCard` is NOT refactored.** It
  reuses the LOOK, never the 845-line state (index-aligned lines/receipts, blank-qty
  conventions, name validators). Mirroring does not change that decision; it
  strengthens it.
- **Editable (amber): line quantity · `invoice_unit_price_usd` · defects.**
  Everything else is a disabled input — supplier, buying method, requester,
  department, payment terms, invoice no., all dates, goods-receipt fields,
  complaints, and ⚠️ **`unit_price_usd` (the PO price — only a VOID fixes that)**.
  The line carries BOTH prices and they are easy to confuse: a correction adjusts
  what was BILLED.
  - ⚠️ **DEFECTS SIT ON THE ORDER LINE**, not in the receipt cards where
    record-purchase puts them — a defect correction is per PO LINE, aggregated
    across every GRN. A deliberate divergence from the mirror.
  - ⚠️ **Locked fields are MUTED, not red.** With 23 locked against 6 editable,
    literal red inverts the hierarchy and makes the un-editable majority shout.
- **Fields hold ABSOLUTE values** like record-purchase; the signed deltas are derived
  on submit, and a field is only sent when it actually differs. A running summary
  lists what will be written before it is written.
- **MULTI-FIELD: one submit → one `Correction` header PER CHANGED FIELD** (N calls to
  `postCorrection` in ONE `$transaction`, ONE recompute after). The existing schema
  carries one `kind` per header, so N fields simply means N headers — the ledger
  gains one traceable entry per field instead of one opaque entry per submit.
  ⚠️ **Apply order is enforced server-side: quantity → defect → price** (see below).
  Guards: ≤1 correction per (line, kind) per post, ≥1 item, reason `min(3)`.
- ⚠️ **THE PRICE-BRANCH FIX — a PRE-EXISTING bug, not one this feature introduced.**
  The price branch credited the ORIGINAL billed quantity and re-billed it at the new
  price. But a quantity correction adds its own signed invoice row, so the original
  quantity is no longer what stands billed: the delta kept the OLD rate and the
  view's value-weighted price landed between the two. Measured on PO-2024-00003-010
  (68 @ 1445): qty −20 + price →1444 gave **1443.5833 instead of 1444**, the gap
  being exactly the 20 corrected-away units never re-priced. **It fired across TWO
  SEQUENTIAL single-field posts too**, so it was reachable before multi-field existed.
  **Fix (Option A): credit + re-bill the NET billed quantity at the current effective
  price.** ⚠️ **Inert by CONSTRUCTION** — with no prior correction on the line the
  code takes an explicit branch using the original figures, so the rows are
  byte-identical and cannot drift on a float division (verified: a lone price
  correction still writes 68 @ 1445 and reports "billed price 1445 → 1444 on 68
  units"). ⚠️ Order matters *because* of this fix: price must run after quantity.
- **Locked fields offer the VOID route on hover** — "Want to void this purchase
  instead?" on all 23. Clicking closes the dialog and navigates to
  **`/import?focusPo=<poId>`**, which expands `purchase_orders` in Master data,
  narrows to that order, scrolls to it and paints the row `--warning` at 18%. The
  highlight is **spent on first hover** (it only had to say WHICH row).
  ⚠️ The focus filter **REPLACES** the ordinary filters rather than composing — a
  leftover supplier/period filter could otherwise hide the very row the user was
  sent to see. A banner explains it and clears it.
- **⚠️ VERIFIED (2026-07-21).** Multi-field on a 2-line order: qty 3,661→3,600,
  billed price 179→175, defects 0→2 posted as **THREE headers sharing one reason**,
  landing on effective price exactly **175.0** and defects **2**; the toast read
  "billed price 179 → 175 on **3600** units" — the NET, proving the fix live. 23
  locked / 6 editable. Baseline byte-identical after cleanup at every stage.
  tsc + ESLint clean.

**MASTER DATA (`MasterDataSection`).** 2026-07-21. ONE section — Add supplier + all
12 dataset tables — sitting AFTER the Correction ledger and BEFORE the audit trail.
⚠️ **There is no "Browse data" section and no table picker any more**; `DataBrowserCard`
was renamed `MasterDataSection` and `SupplierAdminPanel` was DELETED.

- ⚠️ **CONFIG-DRIVEN, NOT 12 BESPOKE TABLES.** Every table does the same three things
  — show rows, filter by supplier + period, paginate — so there is ONE generic
  component, ONE config list (`lib/data-browser-config.ts`) and ONE route
  (`app/api/data-browser/[table]/route.ts`). **Adding a table = a config entry + a
  query branch. Never a new component.**
- **Rendered as lightweight COLLAPSIBLE TEXT ROWS, not cards** — a chevron, label and
  count with a divider between rows; the expanded table sits directly beneath.
- ⚠️ **DEFAULT COLLAPSED, LAZY, THEN STAY-MOUNTED.** A collapsed table is never
  mounted so it never fetches (**verified: ZERO data-browser requests on page load**).
  After first expand it stays mounted and is merely hidden when re-collapsed, so
  re-opening costs no second fetch and keeps the filters and page already set.
  ⚠️ `CollapsibleTable` **seeds its open state FROM `forceOpen`**, not `false` — the
  render-time transition only fires on a CHANGE, so a deep link already carrying
  `?focusPo=` would otherwise leave the table shut on exactly the link that asked
  for it open. (Caught in testing: worked from the dialog, failed on reload.)
- ⚠️ **`suppliers` IS THE EDITABLE ROSTER, not a read-only copy** — it carries its
  four text filters and Deactivate/Reactivate, exactly as `purchase_orders` carries
  Void. It is fed by a SERVER PROP, so expanding it makes **no API call at all**.
  Rendering a read-only suppliers table beside a separate editable one would show
  the same rows twice and invite edits in the copy that does nothing.
- **Order = the CIPS procure-to-pay flow** (= `SHEET_NAMES`): suppliers, frameworks,
  then requisitions → sourcing_events → responses → purchase_orders → po_lines →
  goods_receipts → grn_lines → invoices → invoice_lines → payments. **Do not
  re-sort** — the sequence is why the list reads as a chain.
- **PER-TABLE INDEPENDENCE IS STRUCTURAL:** rows, filters, page and expanded-ness
  live in each section, not the parent, so filtering or paging one cannot disturb
  another. Only the void dialog is shared. Verified under compound use — one table
  filtered to 240 while another sat on page 4 of 61 and a third held page 1,
  including across a void.
- **The row contract** is what lets one component serve twelve: every table returns
  `{id, cells, _supplierId, _supplierName, _period}` (+ `_voided` on voidable ones),
  the underscore fields resolved SERVER-side.
- **FILTER-JOIN MAP — period is ALWAYS `PurchaseOrder.period` (order year).**
  ⚠️ **ABSENT (not disabled) on `suppliers` and `frameworks`**: a supplier is
  period-free master data, and a framework's multi-year validity window is not a
  reporting period. Supplier resolution: DIRECT on `frameworks` / `responses` /
  `purchase_orders` / `invoices`; via **PO** on `po_lines` / `goods_receipts`; via
  **GRN→PO** on `grn_lines`; via **Invoice→PO** on `invoice_lines` / `payments`; via
  their **1:1 PO** on `requisitions` (647↔647) and `sourcing_events` (226↔226).
- ⚠️ **TWO COLUMNS DELIBERATELY BEYOND THE SHEET SCHEMA:**
  - **`corrects_line_id` on `po_lines` / `grn_lines` / `invoice_lines`.** A correction
    IS a real signed row there; without it it renders as an inexplicable
    negative-quantity duplicate. **Do not "tidy" it away.**
  - **`responses.supplier_id` is labelled "(bidder)"** — the supplier that SUBMITTED
    the quote, losing bids included, NOT the winner. Proven distinct: 28 bids vs 31
    POs for the same supplier.
- ⚠️ **DRIFT GUARD — the config CANNOT import `REQUIRED_COLUMNS`** (`lib/dataset-import.ts`
  pulls in `xlsx`, which must not reach the client bundle), so the **ROUTE asserts on
  every request** that the config covers every required column for that sheet.
- **PAGINATION IS CLIENT-SIDE**, 25/page, reusing `usePagination` + `PaginationFooter`;
  the route returns the whole table (largest `grn_lines` 1,508). ⚠️ **Switch to
  server-side `skip`/`take` once any SINGLE table passes ~10k rows** — contained to
  the route + hook; the row contract and all 12 configs are unaffected.
- **⚠️ VERIFIED (2026-07-21).** All 12 render exact counts — 55 · 21 · 647 · 226 ·
  677 · 647 · 1193 · 829 · 1508 · 647 · 1193 · 647 — each independently recomputed in
  SQL for period distribution and supplier-filter count. Drift guard passed for all 12.
  - ⚠️ **TEST-HARNESS GOTCHAS (not bugs):** programmatic `.focus()` does NOT open a
    `TypeableCombobox` (React delegates `onFocus` via native **`focusin`**), and
    synthetic `mouseover` does NOT reach React's enter/leave plugin, so `onMouseEnter`
    must be invoked directly in a DOM-driven test. ⚠️ **A hidden preview tab FREEZES
    CSS transitions** — `getComputedStyle` then reports a mid-flight value and reads
    as a broken fade. **Disable the transition and measure the end state** (cost a
    false negative twice). It also throttles `setTimeout` to ~1s, so a chain of short
    sleeps blows the 30s tool timeout — split UI checks into separate calls.

**VOID A PURCHASE ORDER (`PurchaseOrderVoid`).** 2026-07-21. Marks an order as entered
in ERROR — wrong supplier, wrong buying method, any posted field a CORRECTION cannot
reach. The order and its whole chain (PR → sourcing → PO → GRN → invoice → payment)
drop out of EVERY analytic; nothing is deleted and the rows stay browsable. The user
then re-records a correct order via the record-purchase dialog.

- ⚠️ **APPEND, NEVER MUTATE — the PO row is NOT touched.** Voiding inserts a
  `PurchaseOrderVoid` row `{poId PK/FK, reason, voidedBy, voidedAt}`. **The
  immutability triggers are UNTOUCHED and there is NO bypass flag** — verified after
  shipping: all 10 triggers present, a `PurchaseOrder` status UPDATE still rejected,
  and all 647 statuses still read `closed`. ⚠️ **`PurchaseOrder.status` is NOT the void
  mechanism** — an earlier design flipped it to `'voided'`, which was rejected because
  it would have required weakening `block_posted_update()`. Same discipline as
  corrections: posted documents are never edited, only appended to.
- **The void row IS the audit record** (who / when / why) — there is no separate log
  table, and the restore dialog surfaces the original reason. **Un-void = a plain
  DELETE of that row** (no trigger blocks DELETE). Both directions recompute all periods.
- ⚠️ **VOIDED-NESS = `NOT EXISTS (SELECT 1 FROM "PurchaseOrderVoid" v WHERE v."poId" =
  po.id)`. FOUR SITES CARRY IT. Miss one and a voided order still counts:**
  1. **The `EnrichedPurchase` view's `FROM "PurchaseOrder"`** — the primary chokepoint,
     covering NINE consumers: `seed_compute` (every SupplierMetric), `compute_analyses`
     `load_frames` (**all seven analyses**), `getEnrichedPurchases` + its 4 callers
     (cycle-breakdown, stage-occupancy, cycle supplier-detail, spend-detail), and the
     two raw spend queries (`spend-overview`, `spend-detail` rank).
  2. ⚠️ **`python/compute_analyses.py` `load_po_lines`** — raw `PoLine JOIN
     PurchaseOrder`, feeds Kraljic **`cost_premium`**. **THE EASY ONE TO MISS**: inside
     Python, raw SQL, bypasses the view. A miss leaves a voided order still moving
     supply risk and quadrant assignment while absent from every other number.
  3. **`lib/po-lines.ts` `getPoLines`** — seeded UNCONDITIONALLY into `conds` so it
     survives every filter combination. Feeds spend-by-item, evolution product-mix,
     report supplier brief.
  4. **`lib/suppliers.ts` `getSupplierDirectory`** — `purchaseOrder.groupBy` all-time
     `num_pos` (`where: { voidRecord: { is: null } }`).
- **What deliberately does NOT filter:** the **Master-data tables** (all 12 branches) and the
  **import-page header + picker counts**. A voided order MUST stay visible — that is the
  point of voiding rather than deleting. `purchase_orders` rows carry `_voided` and
  render muted + a `voided` chip with the action flipped to Un-void.
- ⚠️ **FK is `ON DELETE CASCADE`, deliberately.** A replace-all wipes `PurchaseOrder`
  wholesale; **RESTRICT would make ANY replace-all FAIL while a void existed**. A void
  refers to one specific posted order, so once wiped it cannot be reattached (the same
  reasoning the importer applies to corrections). The importer counts them BEFORE the
  wipe and returns **`audit.voidsDropped`**, so the loss is named, not silent.
- **Two guards:** `/api/corrections/lines` refuses a voided PO (**409**, "restore it
  first") — the picker already omits it via the view, this catches a stale client; and
  the **record-purchase vocabularies** (categories/units/sites/receivers/departments/
  requesters/items) exclude voided orders, since a void usually means the values were
  typed wrong and should not be suggested again.
- **⚠️ EDGE CASE — the single-PO-supplier ranking gap does NOT fire on a void.** Voiding
  a supplier's ONLY order drops its `SupplierMetric` row (151→150) with no error. The
  known gap ("supplier has POs but no metric row → dropped from the ranking while the
  KPI still counts its spend") needs the two sides to DISAGREE; a void removes the
  supplier from BOTH together. Measured: KPI == ranking sum, difference **0**, all four
  analytics pages 200. *(The gap still fires via its original trigger — a manually added
  supplier — unchanged.)* ⚠️ **The period-drop case** (void a period's last PO →
  `seed_compute` drops the period) is DOCUMENTED, NOT TESTED — it needs 157-240 voids.
- **⚠️ VERIFIED (2026-07-21).** **Inertness first**: with ZERO voids a full recompute is
  byte-identical — all 18 per-period analyses, SupplierMetric md5, every figure. Then
  voiding PO-2024-00149 ($51,842.00, 2024, match fail) moved spend to exactly
  **$707,635,474.20**, count 647→646, 2024 240→239, match failures 81→80 (passes
  untouched), and changed **all six 2024 analyses** while leaving all twelve 2025/2026
  ones identical — Kraljic moving is the specific proof site 2 works. Raw
  `PurchaseOrder` rows stayed 647 throughout. Un-void restored everything
  byte-identically. tsc + ESLint clean.
- ⚠️ **GOTCHA — RESTART THE DEV SERVER AFTER `prisma generate`.** Adding the model
  mid-session left the RUNNING server holding a STALE Prisma client, so the first void
  returned an **empty 500** (`Unknown field voidRecord`). `tsc` passed the whole time —
  it reads the regenerated types from disk, while only the running process was stale.
  Restart one server (never two — that tears `.next`).

⚠️ **TWO GATED VIEW FIXES** — the only change touching a locked-formula input, accepted
because proven byte-identical on existing data AND semantically required under
corrections: `dom_cat` now aggregates per category then takes the argmax (a reversed line
used to still sort as the highest single row, so a PO could report a category with zero
net spend); `line_bill` uses the value-weighted effective billed price instead of
`MAX(unitPrice)` (which returned the pre-correction price, so a correctly-credited
invoice still failed the match). Verified inert across the whole view, dom_cat for every
PO, every processScore, all AnalysisResult payloads and zones before shipping.

**BASELINE — verify any change against this:** $707,687,316.20 · 647 POs (240/250/157) ·
55 suppliers · 14 categories · 566 three-way-match pass / 81 fail · $82,253,733.40
control exposure · SupplierMetric 151 rows · processScore min 0 / max 100 / avg 87.67.

**Restore recipe:** `npx prisma db seed`, then
`cd python && .venv/Scripts/python seed_compute.py`.

**Removed 2026-07-20 as dead:** `ImportForm`, `AddPurchaseCard`, `RemoveSupplierCard`,
`RemovePurchaseCard`, `PurchaseRosterTable`, `lib/purchase-import.ts`,
`python/import_compute.py` (+ its test), `runImportCompute`, `/api/sample-data`, and the
three write-only `SupplierMetric` kraljic columns (`categoryCompetition` /
`kraljicQuadrant` / `supplyRiskScore`) — the latter were rewritten on every recompute,
read by nothing, and the sole source of a cross-run non-determinism.

## Current Work

> **Current state of record = `git log`.** This file holds DURABLE architecture +
> decisions, NOT commit-by-commit progress. For "where are we", read the commits —
> do not trust this section for the latest state. **Last doc update: 2026-07-14.
> ⚠️ NEWEST: three data-integrity fixes + a Methodology honesty rewrite — the outlier
> cap removed (`263d9f3`, PH Range now **14/2/35** not 11/2/35), `country_distance`
> holes fixed (`e53eb6f`), `single_source_risk` dead code removed (`4e87ad0`), and the
> Methodology page's HONEST-LIMITATIONS rewrite (`22b6b18`); see the ⚠️ OUTLIER-CAP +
> DATA-INTEGRITY notes right below. Just before those, the REPORT SETTINGS PANEL was
> rebuilt around FOUR QUESTIONS (Focus / Period /
> Length / Attach evidence + a demoted Draft voice), and a Focus → one supplier now
> renders a SUPPLIER BRIEF (+ Focus → one category a deep-dive) — see the new "REPORT
> SETTINGS PANEL REBUILT" block below. The old ~30-control panel that configured a
> table dump is GONE (dead recommendation/category filters + scope + Quick-View pills
> + Saved views all removed; −614 lines in stage 1 alone). ⚠️ **Two standing rules
> came out of it — see "REPORT SETTINGS PANEL REBUILT": (a) the PARTIAL-YEAR TRAP is
> now a NAMED recurring trap (3rd sighting), and (b) the supplier brief / category
> deep-dive are PRINT-SAFE BY CONSTRUCTION (no charts/canvas).** Before this: (1)
> REPORTS REWRITTEN decision-first (`lib/report-narrative.ts` argument model;
> `generateExecutiveSummary` dropped); (2) PDF = native `window.print()` + `@media
> print`; (3) app copy DE-BRANDED, logins admin@mail.com / viewer@mail.com. Plus the
> 2026-07-13 CRUD rework, Action Priorities redesign, temporal period-awareness,
> Supplier Selection removal. ⚠️ **See "KNOWN OPEN ITEMS (handoff — 2026-07-14)"** —
> the panel is DONE; still open: the now-orphaned `ReportPreset` model/table + the
> `recommendations.generated_at` reproducibility gap. Run `git log` for the latest.**

> ⚠️ **OUTLIER-CAP FIX (2026-07-14, `263d9f3`) — the Range Process Health baseline is
> now `14/2/35`, NOT `11/2/35`.** The `.head(15)` cap in `compute_analyses.py`'s
> `cycle_time` emitter was REMOVED — it silently truncated the z>2 outlier list to
> the top 15 POs, so the Range showed 15 POs / **11** outlier suppliers when **24
> POs / 14 suppliers** actually exceed 2σ. The count + flagged-supplier set derive
> from `cycle_time.anomalies` (via `lib/cycle-flags`), so removing the cap made
> Process Health (Range) read **14/2/35** and the outlier PO count 15→24. ⚠️
> **The AP hub `46/36/11/18` is UNCHANGED** — the 3 newly-surfaced outlier suppliers
> were already stage-dominated (already in the 36-process union), so the union total
> stays 36 and the hub total stays 46; only the process-family by-signal descriptor
> moved (**Outlier 11 → Outlier 14**). Per-period counts unchanged (all were already
> ≤15: 2024 12/10, 2025 13/10, 2026 0/0). Reports show Outlier 14 too. Recomputed via
> the SAFE recipe (`compute_analyses.py --period-id` ×3 + clear the range cache).
> **Historical `11/2/35` / "Outlier 11" mentions below predate this fix.**

> ⚠️ **TWO MORE DATA-INTEGRITY FIXES + METHODOLOGY HONESTY (2026-07-14).** (a)
> `country_distance_score` list holes FIXED (`e53eb6f`) — BN/MM/LA/KH → ASEAN(30),
> NZ → Asia-Pacific(60); **byte-identical** (none of those countries are in the data).
> (b) `single_source_risk` dead code removed (`4e87ad0`) — it was already gone from the
> runtime (Prisma column dropped, import path clean, scores ignore it); only a BROKEN
> offline log in `transform_dataset.py` remained. (c) The **METHODOLOGY page got an
> HONEST-LIMITATIONS rewrite** (`22b6b18`): §8 now names the model's own weak spots —
> the two Kraljic departures (spend≠profit-impact; 3 measurable proxies for a
> qualitative axis), the two opposite "risks", the ghosts that don't fire on this data,
> the no-α-gate caveat, 82% filter sensitivity, and the throttled sub-score halves — a
> DEFENSE, not a spec. The outlier-truncation + country-holes limitation paragraphs were
> then removed/reframed as those got fixed (Fix 1/2). All three fixes are ✅ in KNOWN
> OPEN ITEMS below.

> ⚠️ **PERFORMANCE-ZONE BASELINE CORRECTED (2026-07-14) — the app was RIGHT, the doc
> had lagged.** An adversarial audit found the performance-zone "VERIFIED numbers"
> recorded below (in the FILTER-LIVE COMPOSITE / post-Stage-3 blocks) were frozen at
> commit `5b8ede2` and never updated for the **very next commit `aca864c`** (per-PO
> quality + Service dimension dropped + reweight to 0.30/0.30/0.22/0.18), which MOVED the
> composite. The app computes the current zones correctly (cache == a fresh Mode-B
> recompute, 0 diffs); only the doc numbers were stale. **⚠️ THE 2026-07-14 VALUES THAT
> STOOD HERE ARE THEMSELVES SUPERSEDED — see the re-record immediately below.**

> ⚠️⚠️ **PER-PERIOD BASELINES RE-RECORDED (2026-07-24) — EVERY per-period number in the
> block above was stale, not just the zones.** The values there were measured 2026-07-14,
> BEFORE the normalized-data migration (2026-07-20) moved period tagging from PAYMENT year
> to ORDER year. That re-sorted which POs fall in which window, so every per-period figure
> moved — **including the ones the block called composite-INDEPENDENT and named as the
> trustworthy regression gates.** Read below straight from the stored `AnalysisResult`
> payloads; no recompute was run.
>
> **Zones (Stars / Critical Issues / Hidden Gems / Long Tail) + perf_median:**
> - **Range 2024–2026: `14 / 13 / 13 / 15`** — perf_median **70.83** (was doc'd 15/12/12/16, 78.11)
> - **2024: `12 / 13 / 13 / 12`** — perf_median **68.585** (was 16/10/10/17)
> - **2025: `12 / 13 / 13 / 13`** — perf_median **70.17** (was 16/9/9/16, 81.185)
> - **2026: `14 / 11 / 11 / 14`** — perf_median **69.495** (was 6/4/4/6; that window held 20
>   suppliers under payment-year tagging and holds **50** under order-year — the clearest
>   single illustration that the migration changed the POPULATION, not just the scores)
>
> **Kraljic (Strategic / Leverage / Bottleneck / Routine) + risk_median:** Range
> **`15 / 12 / 13 / 15`** (25.718) · 2024 **`15 / 10 / 10 / 15`** (27.0417) · 2025
> **`14 / 11 / 12 / 14`** (27.2499 — was doc'd 10/15/15/10) · 2026 **`12 / 13 / 13 / 12`** (29.2601).
>
> **ABC (A/B/C):** Range **30/14/11** · 2024 **26/14/10** · 2025 **24/14/13** (was 10/9/31) ·
> 2026 **24/13/13**. ⚠️ The A-tier is now ~55% of the roster — see §10.4 of Methodology and
> the spend-concentration note: this spend base is not Pareto-distributed (top fifth hold
> 40.4%), so ABC does not isolate a short list here.
>
> **Spend / POs / active suppliers:** Range **$707,687,316.20 / 647 / 55** · 2024
> **$248,990,387.96 / 240 / 50** · 2025 **$277,331,133.43 / 250 / 51** (was $283,596,813.69 /
> 313 / 50) · 2026 **$181,365,794.81 / 157 / 50**. All four windows carry **14** categories.
>
> **Control exposure (3-way-match failures):** Range **$82,253,733.40** (81 POs, 11.62%) ·
> 2024 **$38,135,183.43** (35) · 2025 **$28,297,257.41** (27 — was $42.47M) · 2026
> **$15,821,292.56** (19). ⚠️ The RANGE figure is the ONE number in this block that did not
> move, and for a reason worth internalising: an all-years total does not care how POs are
> split across periods. **Whole-window aggregates survived the migration; every per-period
> cut did not.** That is the fault line to check first, next time.
>
> ✅ **NOW LIVE-MEASURED (2026-07-24) — these two are NOT in any stored payload, so
> they were measured by running the PRODUCTION LIBS against the live DB**, not derived
> from `AnalysisResult`. Harness ran `computeCycleBreakdown` + `deriveCycleFlags` (the
> Process Health path, `lib/cycle-flags.ts`) and `buildAnomalyHub` +
> `loadTemporalMatrix` + `buildTemporalAnomalies` (the Action Priorities path,
> `ActionDashboardView`) — the exact modules the pages execute at request time — with
> every prisma write method overridden to throw as an abort guard. Read-only confirmed:
> `AnalysisResult` row count and newest `computedAt` byte-identical before and after.
> **⚠️ These are the ONE class of baseline that cannot be checked from the payloads — a
> future session must re-run the libs (or the live pages) to re-verify, never `grep` a
> payload.**
>
> **Process Health flag triple (outlier / inconsistent / stage-dominated SUPPLIERS):**
> - **Range: `5 / 19 / 37`** (was doc'd `14 / 2 / 35`; PO-level outlier 6 / stage-dom 116, iqrCutoff 46.5)
> - **2024: `3 / 15 / 26`** (iqrCutoff 31.875) · **2025: `1 / 20 / 25`** (iqrCutoff 24.75) ·
>   **2026: `2 / 17 / 19`** (iqrCutoff 19.5)
> - ⚠️ **The pre-migration `14/2/35` was WILDLY off on the middle term** — inconsistent
>   went **2 → 19** on the Range. The Tukey `1.5×median(IQR)` cutoff is population-relative,
>   so re-sorting POs into order-year windows reshaped the IQR distribution and far more
>   suppliers now clear it. The outlier term fell the other way (14 → 5). **Only the
>   whole-window baseline at the top of this file survives the migration; every derived
>   count moved.**
> - ⚠️ **RECONCILIATION — the value a reader sees depends entirely on the selected
>   window.** A screen showing **inconsistent = 20 with a 51-supplier roster is the 2025
>   view**, not the Range default (Range is 19 on 55). Always pair this number with its
>   window before quoting it.
>
> **AP hub (distinct / process / classification / temporal · compound · important):**
> - **Range: `49 / 43 / 8 / 25` · compound 24 · important 29** (was doc'd `46/36/11/18`, 19 compound, 17 important)
> - **2024: `33 / 32 / 8 / 0` · 7 · 22** (temporal `no-prior` — earliest year) ·
>   **2025: `44 / 33 / 12 / 25` · 21 · 20** · **2026: `43 / 31 / 8 / 25` · 17 · 22**
> - ⚠️ `distinct` is the UNION across the three families (process ∪ classification ∪
>   temporal), so it is < their sum. The temporal family now fires at **25** on Range
>   because 2026 is no longer a partial year under order-year tagging (157 POs / $181M is
>   65% of 2025, above the 0.5 partial-year guard), so the range comparison is 2025→2026,
>   not the old 2024→2025 that gave 18.
>
> **⚠️ Every `14/2/35` and `46/36/11/18` ELSEWHERE in this file is PRE-MIGRATION** — the
> values here supersede them.
>
> ⚠️⚠️ **STANDING RULE — now with a DOCUMENTED FAILURE CASE, which is why it is worded
> more broadly than it used to be.** The rule read: *if you change the scoring model,
> re-record every composite-derived baseline in the same commit.* **That scope was too
> narrow, and the block above is the evidence.** The normalized-data migration was NOT a
> scoring change, so the rule as written never fired — yet it moved period membership,
> which moved everything per-period. The block then stood telling readers that ABC,
> Kraljic, spend/PO counts and control exposure "did NOT move" and were "the trustworthy
> regression gates", when every one of those per-period figures was wrong. **The list of
> supposedly STABLE baselines became the most misleading content in the file** — more
> harmful than the composite-derived numbers it was warning about, precisely because it
> invited trust.
>
> **Restated:** *if you change ANYTHING that alters which rows land in which window — the
> scoring model, the period tag, the date filter, the void set, an import — re-record
> EVERY per-period baseline in the SAME commit.* Ask what moved the **population**, not
> only what moved the formula. And when you write a "these did not move" list, **date it**:
> that claim rots faster than the numbers it vouches for.

> ⚠️ **AUDIT-DRIVEN DISPLAY FIXES (2026-07-14) — two wrong counts corrected + a NAMED
> recurring pattern.** An adversarial integrity audit surfaced two displayed numbers
> that didn't match the data (both landed after this doc's baseline correction above):
> 1. **Category count (`8e23026`).** Spend Overview's "Spend spans N categories" prose
>    AND the "Active suppliers · across N categories" KPI both counted
>    `spend_overview.by_category.length` — which is capped at top-8 + a synthetic "Other"
>    rollup for the donut — so with **14 real categories the app showed "9"** on every
>    period view (10 in 2026), even counting "Other" as a category. Fix: `compute_analyses.py`
>    emits **`total_categories`** (distinct REAL categories, "Other" excluded); both
>    surfaces read it (fallback to the complete `top_suppliers_by_category` key count for
>    old cached rows) and "Other" is now excluded from category NAMING. Recomputed (safe
>    recipe) so the field is the live path. Verified: **14/14/14/10**, donut unchanged.
>    ⚠️ **The KPI sublabel was a SECOND surface the audit's prose sweep missed** — found
>    by grepping the whole codebase for `by_category.length` after fixing the first.
> 2. **"Where to act" cap (`43e60d9`).** The Critical Issues / Hidden Gems / Bottleneck
>    cards showed the top-5-capped rec count ("5") while Classification showed the full
>    zone population ("12"). Now reads **"5 of 12"** (population from the already-loaded
>    perf zones / Kraljic quadrant; only the 3 capped categories get "of M"). Presentation
>    only — no compute change.
>
> ⚠️ **STANDING RULE — THE COMPUTE-LAYER CAP TRAP (now the 3rd sighting):** *the compute
> layer emits COMPLETE data; the display layer decides what to truncate. **If you cap in
> Python, you will poison a count.*** Three instances of the SAME pattern — a display cap
> living in the compute layer that leaked into a displayed COUNT: **`.head(15)`** on the
> cycle outliers (showed 11 outlier suppliers, truth 14 — `263d9f3`), **`head(8) + "Other"`**
> on categories (showed 9, truth 14 — `8e23026`), and **`[:5]`** on the recommendation
> lists (showed 5, population 12 — `43e60d9`). When you must cap for display, emit the full
> count/set alongside the capped list (e.g. `total_categories`, the z>2 anomaly set, the
> zone population) and let the UI show "N of M" — never derive a count from the capped array.

> ⚠️ **ACTION-PRIORITIES INSIGHT PANELS + THE "WHY THIS MATTERS" BAR (2026-07-14,
> `a87384d`).** Every "Where to act" category (8) and anomaly family (3) has a **"View
> more →"** that expands an insight panel IN PLACE (full-width below the section grid,
> ONE open at a time) — a computed lead sentence, 3 stats, the **FULL-set** evidence
> table (rows open the unified modal), and a **"Why this matters"** callout.
> **`lib/action-insights.ts` (pure, `buildInsight(key, ctx)`) is where cross-analysis
> prose lives**; `components/ActionInsightPanel.tsx` renders it. Data comes ONLY from what
> the page already loads (recommendations / perf / kraljic / cycle_time / the fetched
> breakdown / the hub) **+ one server-loaded `supplierCategory` map** (`getSupplierCategoryMap()`
> in `page.tsx`, passed as a prop — the only extra data, no client fetch). No numbers /
> logic / compute changed. It also **fixed the Concentration REDIRECT** (it opened the
> panel in place; the `/spend-overview` link is now a footer OPTION) and **revived 3 DEAD
> ROWS** (Tail Spend / Process Improvement / Slowest Stage had no href + no expand — they
> did nothing).
>
> ⚠️ **STANDING RULE — THE "WHY THIS MATTERS" BAR:** *every panel's "Why this matters"
> must say something **NO SINGLE NUMBER ON THE PAGE ALREADY SAYS**. If a "why" just
> restates a stat, CUT IT — a short honest panel beats a padded one.* Why this is the bar:
> - **Concentration** — *"3 of the 8 suppliers here are Strategic AND below the performance
>   median"* is a JOIN across **category × Kraljic × performance**. No single page computes
>   that. **That's the bar.**
> - **Slowest Stage** — the table shows **PO→Delivery marked "excluded — physical lead
>   time"**: a design decision the **Methodology page DEFENDS**, made VISIBLE on the page
>   that makes it. **Honest > hidden.**
> - **Process Improvement** — the *"failing on your easiest relationships"* reframe only
>   fires when **Leverage IS actually the worst quadrant** (`worstFraming(worst.q)`); the
>   prose ADAPTS to the data instead of asserting a fixed finding.
>
> ⚠️ **COROLLARY:** *if a panel can't say something meaningful with the data on hand, CUT
> IT rather than fake it.* Padding a panel with filler is how a dashboard starts lying.

> ⚠️ **DO NOT TRUST the two untracked `dashboard_*.md` files** (`dashboard_meeting_notes.md`
> + `dashboard_audit_meeting_prep.md`) — STALE meeting-prep notes (dated 2026-06-28,
> commit `2ad76cb`) that describe a **`tier`** concept and a **5-dimension / Service**
> scoring model (weights 25/25/20/15/15), BOTH LONG REMOVED. They also cite Adaro. A cold
> session must NOT trust them for current state — use THIS file + `git log`. They are
> untracked (never committed) and safe to delete.

> ⚠️ **`tier` (declared Core/Established/Standard) was REMOVED ENTIRELY in
> `158849b`** — data, Prisma columns (`Supplier.tier` + `SupplierMetric.tier`,
> migration `remove_tier`), compute (all tier emitters + the whole
> `tier_reclassification` recommendation category), every API/UI surface, the
> report tier-filter dimension, and methodology §4.4. No `TIER_MAP`, no tier
> chips/columns/headers. Classifications were byte-identical (tier was never an
> analysis input); the Action Dashboard went 22→16 recs across 4 categories.
> **Historical mentions of tier below are batch history — tier no longer exists.**
> Also in `158849b`: the two Classification-views tabs were relabeled
> **"Kraljic matrix" → "Exposure positioning"** and **"Performance vs spend" →
> "Performance positioning"** (PillTabs code keys `kraljic`/`performance`
> unchanged).

4 analytical pages live (Kraljic + Performance-vs-Spend merged into one Supplier
Classification page; ABC merged into Spend Overview): Spend Overview, Supplier
Classification, Process Health Monitoring, Action Priorities
(+ Reports, Methodology, and the admin-only Import page). `/` → `/spend-overview`; `/abc-analysis` →
`/spend-overview` (both redirects). The Action Priorities page (`/action-dashboard`
URL unchanged) was **REDESIGNED (2026-07-13) into the analysis-page language** — a
prose "Priorities at a glance" narrative → a `StatBlock` grid → a compact "Where to
act" (3 group cards) → **cross-analysis anomalies as 3 family count cards + ONE
filterable/sortable supplier table** (see the "ACTION PRIORITIES REDESIGN" block at
the top). Still holds all 3 anomaly families + the 8 recommendation categories — same
data/numbers, calmer layout.

> ⚠️ **Supplier Selection was REMOVED ENTIRELY (2026-07-13, latest — reverts
> `f72c9d3`).** The route (`app/(dashboard)/supplier-selection/`), the client
> (`components/SupplierSelection/`), the engine (`lib/supplier-selection.ts`), and
> the nav entry (+ its `Award` lucide import in `Sidebar.tsx`) are all deleted;
> `/supplier-selection` now 404s. **Why:** the "★ Recommended supplier per category"
> framing overclaims — in real procurement, "who should I buy from" is dominated by
> contracts, vendor relationships, internal politics, OEM compatibility, and
> switching costs, none of which the data captures, so a data-derived recommendation
> is presumptuous and indefensible. Cut rather than ship a page that overreaches.
> **Removal was clean** — Supplier Selection was purely additive (it only *read*
> shared libs `getSupplierCategoryMap`/`getSupplierDirectory` + `compute-range`,
> nothing imported *it*); tsc/ESLint clean, no compute/Python/migration change, and
> the anomaly hub (46/36/11/18), Process Health (11/2/35), Reports, the unified modal,
> Spend Overview, and Supplier Classification all verified unchanged. The old
> "SUPPLIER SELECTION VIEW" session block below is HISTORY.

### How I work (default approach — the operator can override per task)

1. **Orient read-only first** — read the code/docs and confirm the current state
   before proposing anything.
2. **Propose + HOLD** — for anything non-trivial, lay out the plan/approach and HOLD
   for operator approval before building.
3. **Build staged** — smallest safe increments; do the regression-sensitive part first.
4. **Verify against LIVE data** — independently recompute the expected numbers +
   screenshot; treat any shared-code extraction as a REGRESSION SURFACE and re-verify
   the source page. ⚠️ **The current Process Health gate is `5 / 19 / 37` on the Range**
   (outlier / inconsistent / stage-dominated suppliers), live-measured 2026-07-24 — NOT
   the pre-migration `14/2/35`. ⚠️ It is NOT payload-derived: re-verify by running the
   production libs (`computeCycleBreakdown` + `deriveCycleFlags`) or loading the live
   page, never by grepping a payload. See the 2026-07-24 re-record near the top for the
   per-period triples and the AP hub. The most robust gate remains the whole-window
   BASELINE line at the top of this file, which the migration did not move.
5. **HOLD before committing** — present the diff + verification and let the operator
   review; commit (and update this file) only on their go.
6. **Standard gotchas** — the browser preview intermittently redirects to
   `/spend-overview` (just re-navigate); stale HMR after new files/routes → cold-restart
   ONE fresh dev server (kill any zombie squatting on `:3000`); write commit messages via
   a Bash heredoc (`git commit -F - <<'EOF' … EOF`), NOT PowerShell here-strings.

### KNOWN OPEN ITEMS (handoff — 2026-07-14)

A consolidated punch-list for the next session. None block the app; all recorded so
nothing is lost across the migration.

- **✅ DONE — the report SETTINGS PANEL was rebuilt** (the four-question panel + the
  supplier brief / category deep-dive; see "REPORT SETTINGS PANEL REBUILT" below).
  The old ~30-control table-dump panel is gone. **No longer the next job.**
- **⚠️ Orphaned `ReportPreset` model + table** — the Saved-views UI + the
  `/api/report-presets` routes were deleted in the rebuild, but the Prisma
  `ReportPreset` model + its DB table remain (migration `add_report_preset`). Drop
  them in a future migration (Prisma 7 `migrate dev` is interactive — author the SQL
  via `migrate diff … --script` then `migrate deploy`, per the gotcha below). NOT YET
  DROPPED; harmless (nothing reads it).
- **✅ FIXED (2026-07-14, `263d9f3`) — the `.head(15)` outlier truncation.** The
  `python/compute_analyses.py` `cycle_time` emitter now emits the COMPLETE z>2 set
  (cap removed; the display paginates via "View all N"). Process Health (Range) went
  **11/2/35 → 14/2/35** (outlier POs 15→24); AP hub `46/36/11/18` unchanged. See the
  "OUTLIER-CAP FIX" note near the top. *(No longer an open item.)*
- **✅ FIXED (2026-07-14, `e53eb6f`) — `country_distance_score` list holes** (`python/scores.py`):
  the ASEAN tier now lists all nine non-ID members (`{SG,MY,TH,VN,PH,BN,MM,LA,KH}` → 30)
  and `NZ` joins Asia-Pacific (`{CN,JP,KR,AU,NZ,IN}` → 60). India stays in Asia-Pacific
  (geographic) — its RCEP exit only affects `import_friction`'s trade-bloc scale, which
  is deliberately different. ⚠️ **Verified BYTE-IDENTICAL** — none of BN/MM/LA/KH/NZ
  appear in the data (countries are ID/AU/CH/DE/FR/GB/JP/SE/US), so every composite,
  Risk sub-score, and quadrant is unchanged (md5 diff of all cached analyses = 0; the
  only per-recompute delta is `recommendations.generated_at`, a wall-clock timestamp).
- **⚠️ `recommendations.generated_at` breaks byte-reproducibility (NOT FIXED — noted
  2026-07-14).** The `recommendations` analysis payload embeds a wall-clock
  `generated_at` timestamp, so its RAW `resultJson` md5 changes on every recompute even
  when the data is identical (a no-op recompute changes it; stripping `generated_at`
  makes two recomputes byte-equal). ⚠️ **This is a false-alarm trap when diffing cached
  analyses** — a country-lookup change (2026-07-14) showed a recommendations md5 diff
  that turned out to be ONLY the timestamp. Harmless (nothing displayed reads it; all
  recommendation DATA is deterministic), but it means the compute pipeline isn't
  byte-reproducible (same data in ≠ same raw JSON out) — a legitimate property to want
  if anyone verifies "same import → same analyses" by hashing. The other 5 analyses
  carry no timestamp and ARE byte-reproducible. Fix = drop/freeze the field.
- **✅ FIXED (2026-07-14, `4e87ad0`) — `single_source_risk` dead code removed.** A reader audit
  found it was ALREADY gone from the runtime: the Prisma `SupplierMetric.singleSourceRisk`
  column was dropped in migration `20260706130000`, the import path (`import_compute.py`
  + the upload zod) doesn't reference it, and `scores.py`'s `compute_scores` ignores it
  (`supply_concentration` replaced it). The only live reference was BROKEN dead code in
  the offline `scripts/transform_dataset.py` — a diagnostic log reading
  `metrics["single_source_risk"]` AFTER the column had been filtered out by `OUT_COLS`
  (would `KeyError`); removed it + its stale risk-formula comment. **Kept:** the historical
  RATIONALE comments in `scores.py`/`compute_analyses.py`/`analysis-types.ts` that explain
  why the current roster-concentration signal replaced it (they document the design, and
  prevent re-adding it) + the reference docs. Changes nothing at runtime.
- **The 2 stale-read surfaces** (detailed under "THE LAST OPEN DATA-INTEGRITY HOLE"):
  the evolution-tab sub-score sparklines + the spend-detail composite "snapshot" read
  the stored per-period `SupplierMetric`, which only refreshes on a FULL IMPORT — so
  after a manual create/delete they lag, and a newly-CREATED supplier (Supplier row
  only, no `SupplierMetric`) shows nothing on those two surfaces until a reimport.
- **Not-yet-cleaned (trivial):** a test `ExecutiveSummary` row (`cmrj9064…`, a normal
  2025 report created 2026-07-13 while verifying the report save round-trip) still sits
  in the DB / reports list; and the 3 now-unused `TEMPLATES` methods
  (`cover`/`keyFindings`/`recommendedPriorities`) remain in `lib/report-templates.ts`
  (inert — pruning means editing the `SectionTemplates` type + all 3 tone objects).
- **⚠️ LATENT (audit 2026-07-14, NOT firing now) — the spend ranking drops a
  metric-less supplier.** `app/api/spend-overview/route.ts` builds its ranking roster
  from `SupplierMetric` (`distinct supplierExternalId`) and looks up each supplier's
  Purchase-aggregate spend. A supplier with POs but **no `SupplierMetric` row — i.e. one
  added via the UI (`POST /api/suppliers` inserts only a `Supplier` row)** — is NOT in
  that roster, so its spend is **silently dropped from the ranking table**, even though
  the KPI "Total spend" (from the Python `spend_overview` aggregate over all POs) still
  counts it → the table would under-sum the KPI. Verified not firing today (all 55
  Purchase suppliers have metric rows). Fix = seed the roster from the Purchase
  aggregate (or union it in), not just `SupplierMetric`. Same root cause as the
  stale-read hole above (manual add ≠ full import).
- **⚠️ LATENT (audit 2026-07-14) — hardcoded `≥ 80` lens-disagreement cutoff in report
  copy.** `lib/report-narrative.ts:637` (`"≥ 80 pts"`) and
  `components/Reports/ReportDocument.tsx:356` (`"rank ≥ 80 percentile-points apart"`)
  hardcode the cutoff instead of interpolating `CLASSIFICATION_DISAGREEMENT_CUTOFF`
  (`lib/anomaly-crossref.ts:190`). Consistent today; if the constant is retuned these two
  copy strings won't follow. Fix = interpolate the constant.
- **Phase 10 polish → v1.0** (see "Next / parked"): loading states, error boundaries,
  mobile responsive, README, smoke test.

### REPORT SETTINGS PANEL REBUILT (2026-07-14, latest) — FOUR QUESTIONS + SUPPLIER BRIEF / CATEGORY DEEP-DIVE

**The report SETTINGS PANEL was rebuilt around the FOUR QUESTIONS the decision-first
report actually answers, and Focus → one supplier now renders a SUPPLIER BRIEF (Focus →
one category a deep-dive).** The old ~30-control panel configured a TABLE DUMP; the
report is an ARGUMENT, so most of those controls were dead or appendix-only. Shipped in
5 staged commits (`b3ec5d8` config strip → `cf5c0b5` panel → `5812f88` assembler →
`0f25e3d` render → `377ad27` docs). **The key audit finding: the argument (`renderReportArgument`)
reads ONLY the analyses + tone — so NO filter or section toggle could ever change a
finding.** −614 lines in stage 1 alone.

- **The four-question panel** (`ReportEditorSidebar`, full rewrite): ① **Focus** —
  The portfolio (default) / One supplier / One category, with a **searchable
  `TypeableCombobox`** picker (supplier options show name + category + span-scoped
  spend, built from the loaded `performance_spend` suppliers; category lists all).
  ② **Period** (unchanged). ③ **Length** — the `detailLevel` radios relabelled
  Executive brief / Standard / Full (brief = decision-only, NO appendix). ④ **Attach
  evidence** — the appendix `sections` as SIX checkboxes (Spend & ABC toggle together;
  "Cross-analysis anomalies" = the `actionDashboard` block), disabled at brief; in
  supplier/category focus ONLY Methodology shows (the subject's own evidence renders
  inline). Plus **Draft voice** demoted to a small pill row (it only sets the prose
  register). `FilterStatusStrip` now reads `focus · length · voice`.
- **CUT (dead or leaked-in dashboard behaviour):** `recommendationFilters` (categories
  + Top-N — never read by the rewritten report), `filters` + `filterScope` (category
  row-filter — appendix-only, never changed a finding), Quick-View pills
  (`lib/report-pills.ts` DELETED), Saved views + the `/api/report-presets` routes
  (DELETED; the `ReportPreset` model/table remain — see KNOWN OPEN ITEMS).
  `ReportConfig` lost those three fields + gained `focus`. **`normalizeReportConfig`**
  maps OLD persisted configs → portfolio focus + drops the dead fields (backward
  compat; verified an old report still renders).
- **Focus rendering (`ReportDocument` branches on `config.focus`):** portfolio keeps
  the argument UNCHANGED; supplier → `renderSupplierBrief`, category →
  `renderCategoryDeepDive` (both in `lib/report-narrative.ts`, same 3 tone registers).
  - **Supplier brief** = a document you read on the way to a meeting: a **DERIVED
    headline** (branches on the supplier's ZONE, so a Star, a Critical-Issues, and a
    Hidden-Gem supplier get genuinely different opening sentences), situation in prose,
    "What's flagged" in plain language (process flags / lens disagreement / temporal
    move — NO S/P/R codes), "What you buy" (item breakdown), "Trajectory" (what moved +
    what it means), "The conversation" (what to say). Item + trajectory TABLES append at
    Standard/Full; Methodology per the checkbox.
  - **Category deep-dive** = concentration headline + who-leads/performance situation +
    a supplier comparison table + a resilience/engagement recommendation.
- **`lib/report-focus.ts` (NEW, server-only) — the read-only assembler.** A supplier
  brief needs two per-supplier cuts the analyses don't carry: the **item breakdown**
  and the **YoY trajectory**. `assembleSupplierFocus(id, start, end)` runs the SAME
  queries the modal's `spend-detail` (byItem) + `evolution` routes run, WITHOUT touching
  them (no recompute; identity/position/anomaly/rec come from the analyses the report
  already has). ⚠️ **VERIFIED `diffCount: 0`** against the UnifiedSupplierDetailModal for
  Sandvik — matched to the cent, down to identical float artifacts. Types in
  `lib/report-focus-types.ts` (client-safe: `SupplierFocusData` / `ReportFocusData`).
- **Wiring (server-assembled → PDF-safe):** the persisted `/reports/[id]` page assembles
  the focus data SERVER-SIDE; the editor fetches **`/api/reports/focus`** SEPARATELY from
  the analyses (keyed on supplier+span) so a focus change doesn't refetch the whole
  payload. `supplierCategory` returns to `ReportDocument` for the category view.

> ⚠️ **THREE DATA-HONESTY GUARDS — a NAMED RECURRING TRAP, found by reading the brief's
> own output before shipping. Check for these BY DEFAULT in any new narrative:**
> 1. **THE PARTIAL-YEAR TRAP** (⚠️ **STANDING RULE** — this is now the THIRD sighting:
>    the temporal anomaly family, the report's temporal section, and now the brief's
>    trajectory). **A stub year (e.g. 2026 = ~24 invoices) must be SET ASIDE from ANY
>    trend, never reported as a "−72% collapse".** The brief guards via
>    `TRAJECTORY_PARTIAL_FRACTION = 0.5` (a trailing year under half the prior year's
>    spend is dropped from the trend + noted). **Any year-over-year comparison must guard
>    against the partial year — assume it's there until you've checked.**
> 2. **MEDIAN-RELATIVE vs ABSOLUTE.** A $3.1M supplier can be a "Star" (above the spend
>    MEDIAN) yet is NOT "high-spend" in absolute terms. **Never describe a median-relative
>    position in absolute language** — the brief's headline gates "high-spend" on
>    `genuinelyLarge = spendPct ≥ 5 || rank ≤ 10`, else "performs well for what you spend".
> 3. **SUB-1% SHARES render "<1%", never "0%"** (`sharePct` helper) — the long tail is
>    genuinely <1%, not zero.

> ⚠️ **PRINT-SAFE BY CONSTRUCTION.** The supplier brief + category deep-dive contain **NO
> charts and NO `<canvas>`** — pure text + `<table>` + prose. So they print correctly by
> construction (native `window.print()` + `@media print`; `pdf-page-break` on every
> section, `.no-print` chrome hidden, real selectable text). **⚠️ Before adding a chart to
> either, remember the Recharts-in-a-hidden-container bug** (the reason embedded report
> charts must STACK, not tab) — a chart here would reintroduce that risk. The PORTFOLIO
> report keeps its 15 vector Recharts SVGs (no canvas either).

- **⚠️ VERIFIED (2026-07-14).** Three genuinely different headlines: Liebherr (Critical
  Issues) "…clearest underperforming exposures — $62.1M (11%) … scoring 72 against the
  78-point median", United Tractors (Stars) "…high-spend supplier that delivers — $64.2M …
  A relationship to protect", Cipta Krida Bahari (Hidden Gems) "…punching above its
  weight — 89 on just $0.5M (<1% of spend)". **Persisted round-trip PASSES** (saved a
  single-year supplier brief → `/reports/[id]` → server-assembled focus renders the
  identical brief incl. item breakdown + trajectory). PDF-safe on all 3 focus modes
  (0 canvas everywhere). Regressions HELD: Process Health **11/2/35**, AP hub
  **46/36/11/18**, portfolio report byte-identical. tsc + ESLint clean.

### ACTION PRIORITIES REDESIGN (2026-07-13) — ANALYSIS-PAGE LANGUAGE, ONE ANOMALY TABLE

**Action Priorities was rebuilt in the calm, spacious design language of the analysis
pages (Process Health = the reference).** ⚠️ **PRESENTATION ONLY — NO lib/compute/
threshold/anomaly-definition change; same data, same numbers, same 3 families + 8
categories.** ONE file: `components/ActionDashboardView.tsx` (full rewrite, **370 lines
SHORTER** — net −370). No `page.tsx` change, no pure-lib change, no Python.

- **New top-to-bottom structure** (was: dense synthesis headline + 8 category tiles
  across 3 bands + 3 stacked chip-soup anomaly blocks, ~3 screens):
  1. **Subtitle** line.
  2. **`Priorities at a glance`** — a PROSE narrative `Card` (mirrors "Cycle at a
     glance"): lead paragraph (roster/spend/concentration/top-10) + **"Where the
     exposure sits"** paragraph + **"Worth noting"** bullets (flagged-important + $,
     widest lens gap, biggest temporal move, compound count) + italic hint. All
     computed live; the hub-derived bullets fill in once the breakdown loads.
  3. **`StatBlock` grid** (4 comfortable cards): Category concentration % · Flagged
     suppliers (family split as sublabel) · On important relationships ($ exposure
     sublabel) · Top-10 needing attention.
  4. **`Where to act`** — ONE `Card` → 3 compact group cards (Spend / Suppliers /
     Process), each listing its categories as one-line rows (dot + label + metric +
     count); supplier-bearing categories EXPAND to clickable rows → modal.
     Concentration keeps its `/spend-overview` link. (Replaces the donut/list/stat/bar
     TILE grid.)
  5. **`Cross-analysis anomalies`** — **3 FAMILY COUNT CARDS** (Process / Lens
     disagreement / Changed over time; descriptor = by-signal mix; clicking filters +
     scrolls) **+ ONE UNIFIED SORTABLE TABLE** of all flagged suppliers with **filter
     chips**: All / Process / Lens disagreement / Changed over time / Important only /
     In 2+ families. Table cols: #, Supplier, Spend, ABC, Exposure (Kraljic),
     Performance (`PerfBar`), **Anomalies** (per-family chips — process flag chips ·
     `Lens gap N` · quadrant `A → B` / `Spend ±%` / `Score ±`). Uses `useTableSort`
     (default spend desc) + the shared `SortHead`/`SortArrow`/`TintChip` primitives.
- **⚠️ THE BIG STRUCTURAL FIX:** the 3 stacked anomaly blocks (each with its own
  chip-laden list) are GONE → one filterable table. **This ALSO FIXED the single-year
  layout collision** (the old TemporalBlock header overlapped the ClassificationBlock's
  expanded rows) — structurally impossible now.
- **Architecture:** the breakdown fetch + `buildAnomalyHub` were **LIFTED into
  `ActionDashboardView`** (mirrors `CycleTimeClient`) so the glance, stat grid, AND the
  one table read ONE hub. Deleted: `SpendBand`/`SuppliersBand`/`ProcessBand`,
  `Tile`/`ListTile`/`StatTile`/`DonutTile`/`BarTile`, `ProcessBlock`/
  `ClassificationBlock`/`TemporalBlock`, `AnomalyRow`/`ClassificationRow`/
  `TemporalRow`/`LensBars`/`SubBlockHeader`/`CrossAnalysisAnomalyHub`.
- **Modal tab-routing (cross-family table):** a row's **process-family members open the
  Process tab** (richest cycle detail); everything else → **Classification** (lens +
  evolution live there). Reuses `UnifiedSupplierDetailModal` unchanged.
- **Temporal note-states surface ON the "Changed over time" family card** (disabled +
  the reason): single-year partial-year / no-prior / <2-periods. So single-year reads
  cleanly.
- **⚠️ VERIFIED numbers IDENTICAL.** Range hub **46** (36 process / 11 lens / 18
  temporal), 19 compound, 17 important, $491.8M; every filter chip reconciles
  (All 46 / Process 36 / Lens 11 / Changed 18 / Important 17 / In 2+ 19); table 46
  rows. Single-year **2025 fires 41** (33/10/18, 19 compound, 14 important); **2026 →
  partial-year note** (card disabled); **2024 → no-prior note** (card disabled).
  Process Health **11/2/35** untouched. Filters/sort/modal work; dark-mode token-safe
  (zero hex; `.dark` variants confirmed); tsc + ESLint clean; no console/server errors.
  *(Full-page screenshots couldn't be captured — the in-app browser's rasterizer timed
  out on this page even with no modal; verified via DOM + computed-style inspection.)*

### TEMPORAL PERIOD-AWARENESS (2026-07-13) — "CHANGED OVER TIME" NOW FIRES IN BOTH MODES

**The hub's temporal ("Changed over time") family is now PERIOD-AWARE in BOTH
modes** — previously it only worked in Range and went inert in single-year. NO
threshold/constant change (SPEND_FOLD_CUTOFF 2.5, SCORE_SWING_CUTOFF 18,
SPEND_SMALL_BASE_MIN 100K, PARTIAL_YEAR_SPEND_FRACTION 0.5, quadrant any-jump all
unchanged), NO Python/compute/endpoint/migration change — only the period-SELECTION
logic + the block's state rendering.

- **`lib/temporal-load.ts` `loadTemporalMatrix(opts?: {selectedPeriodId?})` is now
  PERIOD-AWARE** and returns a discriminated **`TemporalLoad`** (new type in
  `lib/temporal-anomalies.ts`, a plain non-`server-only` type so the client hub can
  switch on it):
  `{kind:"ok"; matrix}` · `{kind:"no-prior"; label}` · `{kind:"partial-year"; label;
  priorLabel}` · `{kind:"insufficient"}`.
  - **RANGE (no `selectedPeriodId`) — UNCHANGED, byte-identical:** latest-vs-prior,
    stepping back past a partial newest year (2024→2025, 2026 excluded via
    `skippedLabel`). Still **18/48**.
  - **SINGLE-YEAR (`selectedPeriodId` = year Y):** compares **Y vs Y-1**. Earliest
    year (idx 0) → `no-prior`. **⚠️ Partial-year trap:** if the SELECTED year is sparse
    (`totals[Y] < 0.5 × totals[Y-1]`, e.g. 2026 ~$29.7M vs 2025 ~$283.6M) → `partial-year`
    note, NOT a wall of ~85%-of-roster fake −90% drops. **Range can step FORWARD to a
    comparable pair; single-year can't (the user explicitly chose Y), so the guard
    becomes a NOTE instead of a re-pick** — this asymmetry is deliberate.
- **`app/(dashboard)/action-dashboard/page.tsx`** loads per-branch now: cached branch
  calls `loadTemporalMatrix({selectedPeriodId: source.periodId})` (in the `Promise.all`);
  range branch calls `loadTemporalMatrix()`. (Was one mode-blind top-level call.)
- **`ActionDashboardView` / `RangeCompute` prop `temporal` is now `TemporalLoad | null`**
  (was `TemporalMatrix | null`). The hub gate became
  `temporal?.kind === "ok" ? buildTemporalAnomalies(temporal.matrix) : null` (fires in
  BOTH modes); the `!isRangeMode` inert branch + `hasMatrix` prop are GONE.
  `TemporalBlock` renders the no-prior / partial-year / insufficient states as notes.
- **Block label is now explicit + mode-aware:** **"2025 vs 2024"** (single-year) /
  **"2024 → 2025" + "(2026 excluded — partial year.)"** in the synthesis line (range).
- **⚠️ Reports are now PERIOD-AWARE too (updated 2026-07-13 — supersedes the old
  "reports temporal is RANGE-only").** `assembleReportRangeAnalyses`
  (`lib/report-analyses.ts`) takes an optional `selectedPeriodId` and passes the WHOLE
  discriminated `TemporalLoad` through (no unwrap): a SINGLE-YEAR report (editor sends
  `selectedPeriodId`; persisted `/reports/[id]` uses its own `periodId`) compares Y vs
  Y-1 with the no-prior / partial-year note states; a RANGE report stays latest-vs-prior
  (partial-year skip). So a single-year report now shows all 3 anomaly families, matching
  the Action Priorities page. `ReportDocument` dropped the `config.period.mode === "range"`
  gate and renders the note states.
- **⚠️ VERIFIED (2026-07-13).** Range still **18/48** (Spend 10·Quadrant 7·Score 3,
  2024→2025); **single-year 2025 now FIRES the same 18/48** (2025 vs 2024, no skipped
  clause — direct pair); **2026 → partial-year note**; **2024 → no-prior note**; hub
  synthesis reconciles in single-year (2025: 41 = 33 process ∪ 10 classification ∪ 18
  temporal); Process Health **11/2/35** unchanged. tsc/ESLint clean; dark-mode safe
  (`--temporal` token only); no console/server errors.

### REPORTS REWRITE (2026-07-13, latest) — DECISION-FIRST NARRATIVE

**The report was restructured from 8 pages of dashboard-order tables into an
ARGUMENT.** New order (`ReportDocument`): **cover + HEADLINE → The situation → What
we found (top-3 findings) → What to do (action table) → Worth watching → Appendix
(all analysis tables/charts + the anomaly detail)**. All prose is COMPUTED from the
data (no hardcoded findings); numbers are IDENTICAL (pure re-presentation, no recompute).
- **`lib/report-narrative.ts` (NEW) is the argument model** — `renderReportArgument(analyses, tone)`
  builds a tone-agnostic fact model (headline / situation / findings / actions /
  watching) + tone-aware prose, reusing the existing pure anomaly builders
  (`deriveCycleFlags` / `buildAnomalyCrossref` / `buildClassificationAnomalies` /
  `buildTemporalAnomalies`).
- **HEADLINE = the top FINDING, not a fact.** Findings ranked by insight × exposure:
  the CROSS-ANALYSIS join (high-spend ∩ underperforming) leads by DEFAULT (base 1.0 +
  $-exposure); a massive control failure or catastrophic temporal move can outlead
  (×4 ⇒ needs ~>33% of spend); raw category **concentration is DEMOTED** to a
  supporting clause; cycle/lens demoted too.
- **SITUATION surfaces the cross-analysis the old report threw away** — Class-A ∩
  Strategic and Class-A ∩ Critical-Issues, in prose.
- **⚠️ The grouped `ACTION_GROUPS` rec cards are GONE** — replaced by ONE **action
  table ranked by $-exposure** with real **P1/P2/P3** tiers, deduped per supplier
  (no "Engage X / Steward X" wallpaper).
- **Anomaly detail moved to the APPENDIX and is READABLE** — no raw `S/P/R` codes
  ("bottom-decile spend, mid-range performance, top-decile supply risk — the widest
  lens disagreement", via `lensVerdict`).
- **3 tones are genuine registers** (executive terse/no-names · operational named ·
  analytical +thresholds/method); `brief` = decision-only (NO appendix).
- **⚠️ `generateExecutiveSummary` was DROPPED** (`f976ca2`) — the report renders LIVE
  from the analyses, so the stored `ExecutiveSummary.narrative` markdown (never
  displayed) was dead prose. `ReportMetrics` shrank to `{cycle_framing?, narratives?}`;
  the generate route now stores `metricsJson: {config, cycle_framing}` + a stub
  narrative. `deriveReportContext` + the TEMPLATES SECTION prose stay (they feed the
  appendix); the 3 now-unused TEMPLATES methods (cover/keyFindings/recommendedPriorities)
  are inert, pending a trivial prune.
- **PDF is native `window.print()` + `@media print`** — the new sections carry
  `.pdf-page-break`; findings are cards, the action table is a `<table>`, all covered
  by the print CSS. Verified on both paths (persisted single-year + editor range),
  numbers identical, tsc/ESLint clean.

### REPORTS: FULL 3-FAMILY ANOMALY HUB (2026-07-10) — PROCESS + TEMPORAL ADDED

**Reports now render ALL THREE anomaly families** (process + classification +
temporal), finishing the deferred follow-up from the reports-alignment batch
(`d74d831`, which shipped classification-only). The process + temporal data is
**assembled SERVER-SIDE into `ReportAnalyses`** so every render path — editor,
persisted `/reports/[id]`, ephemeral `/reports/preview`, AND **PDF export** —
has it at render time. NO client fetch (that was the deferral reason: PDF export
captures the RENDERED DOM — now native `window.print()`, formerly html2canvas — so
async-fetched data wouldn't be present).

- **⚠️ `computeCycleBreakdown` EXTRACTED to `lib/cycle-breakdown.ts`** (verbatim from
  the `/api/cycle-time/breakdown` route → the route is now a thin auth+validate
  wrapper). One source of truth for the breakdown. **Regression-sensitive** — Process
  Health, the live hub, AND the modal's Process tab all consume that route;
  **verified UNCHANGED** (Process Health 11/2/35 + filter sync; hub 46 flagged/3
  families; modal Process tab). Optional `preloaded` ABC/perf param lets report
  paths skip a redundant `getRangeAnalyses`.
- **`lib/report-analyses.ts` `assembleReportRangeAnalyses`** = `getRangeAnalyses` +
  `computeCycleBreakdown` + `loadTemporalMatrix`. Returns `RangeAnalyses & {breakdown,
  temporal}` (non-null fields preserved for `generateExecutiveSummary`; structurally
  assignable to the nullable `ReportAnalyses`).
- **New endpoint `/api/reports/analyses`** → the assembler. **The editor's fetch was
  repointed** from `/api/analyses/compute-range` to it (same `{startDate,endDate}`
  body). ⚠️ **The dashboard's `compute-range` is UNTOUCHED** — non-report pages don't
  over-compute the breakdown/temporal. Ephemeral route uses the assembler; the
  persisted page adds the breakdown INLINE (reusing its Mode-A abc/perf via
  `preloaded`, keeping its fast per-period reads) and OMITS temporal.
- **⚠️ SUPERSEDED (2026-07-13) — temporal in reports is now PERIOD-AWARE in BOTH modes**
  (the old `config.period.mode === "range"` gate in `ReportDocument` is GONE). Single-year
  reports (persisted + editor preview) show all three families (Y vs Y-1, with the
  no-prior / partial-year note states); range reports are unchanged. See the "Reports are
  now PERIOD-AWARE" note in the TEMPORAL PERIOD-AWARENESS block above.
- **`ReportAnalyses` extended** with `breakdown?` + `temporal?`. **`ReportDocument`
  computes all 3 families SYNCHRONOUSLY from props** (reuses `deriveCycleFlags` +
  `buildAnomalyCrossref`, `buildClassificationAnomalies`, `buildTemporalAnomalies` —
  NO reimplementation) and renders three summary sub-blocks; the old "deferred" inline
  note is GONE.
- **Header-date hydration fix** (pre-existing, folded in): the persisted (SSR) report
  header used `new Date(meta.generatedAt).toLocaleString()` → locale/zone mismatch
  server vs client. Now a module-level fixed `Intl.DateTimeFormat("en-US", {dateStyle,
  timeStyle, timeZone:"Asia/Jakarta"})` → deterministic; hydration warning gone.
- **⚠️ VERIFIED numbers MATCH the live hub** (range report): process **36 / 16 important
  / $491.8M** (Outlier 11 · Inconsistent 2 · Stage-dom 35); classification **11/55**
  (gaps 96/94); temporal **18/48** (Spend 10 · Quadrant 7 · Score 3, 2026 excluded).
  Persisted 2024 report: process 27 + classification, temporal omitted. **PDF: all 3
  families inside captured `.pdf-page-break` sections.** tsc/ESLint clean; no Python
  change, no migration; export structure intact.

### SUPPLIER SELECTION VIEW (2026-07-10) — REMOVED 2026-07-13 (HISTORY)

> 🗑️ **THIS FEATURE WAS DELETED on 2026-07-13** (reverting `f72c9d3`) — the
> recommendation framing overclaims for real procurement. See the removal note near
> the top of this file. Everything below is HISTORY; the files it describes no
> longer exist. **The Path-B price refinement noted below is MOOT** (there is no
> Supplier Selection engine to refine).

**New page `/supplier-selection` (nav: after Action Priorities) — the
decision-support half of the cross-page vision (the anomaly hub was the diagnostic
half).** Per procurement CATEGORY, ranks suppliers by a transparent weighted blend
of THREE EXISTING signals and surfaces a recommended pick with reasoning. NO new
fundamental scoring, NO Python/compute change, NO new endpoint (reuses
compute-range). 5th analytical page.

- **`lib/supplier-selection.ts` (NEW, pure):** `fit = 0.50·Performance +
  0.30·Safety + 0.20·PriceValue` (all 0–100). `SELECTION_WEIGHTS = {perf:0.50,
  safety:0.30, price:0.20}` — NAMED constant, tunable. **Performance** =
  `perf.performance_score` (composite); **Safety** = `100 − Kraljic
  supply_risk_score`; **PriceValue** = `100 − cost_premium×4` (the 0–25 Kraljic
  cost-premium term). `buildSupplierSelection` ranks per category (fit desc),
  flags the top pick, derives a plain "why" from the component pattern, sets
  `soleSource` (1 supplier) / `thinData` (≤2) edge flags; categories sorted
  most-spend-first.
- **⚠️ PRICEVALUE IS AN OVERPRICING PENALTY, NOT A CHEAPNESS REWARD.** The source
  `cost_premium` is `clip(premium×62.5, 0, 25)` — below-market clips to 0, so
  at-market, below-market, AND un-benchmarked suppliers ALL score PriceValue 100;
  only measured above-benchmark pricing is docked. Live: 31/55 suppliers at
  premium 0, 24/55 with a measured premium. **Surfaced honestly in the UI** — Price
  bars labelled "Price vs. benchmark" + a page-level caveat box ("reflects not
  overpaying… not a 'cheapest' ranking"). No-benchmark fallback = PriceValue 100.
  **⚠️ FUTURE REFINEMENT (Path B, deliberately NOT this batch):** a SIGNED
  price-from-Purchase signal (per-supplier per-item unit price vs the item
  spend-weighted benchmark, keeping the below-market sign) would REWARD cheapness
  and map no-benchmark → neutral 50 — needs a new TS route querying Purchase
  (replicating `_cost_premium_points`); no Python change. Noted as a follow-up.
- **`components/SupplierSelection/SupplierSelectionClient.tsx` (NEW):** client
  fetches span-scoped `perf` + `kraljic` (+ `cycle_time` for the modal) via
  `/api/analyses/compute-range`, runs the pure blend, renders per-category cards —
  ranked rows with **★ Recommended** (amber ring), 3-component bars (Perf green
  `--zone-stars` / Safety blue `--quadrant-routine` / Price amber `--warning`), fit
  score, the "why", and meta chips (ABC / Kraljic / zone / spend / country). Rows →
  **REUSE `UnifiedSupplierDetailModal`** (perf/kraljic/cycleTime/dates all in hand).
  Keyed on the span so a period change remounts (avoids set-state-in-effect).
- **`page.tsx` (NEW, server):** resolves the span (BOTH modes), loads the GLOBAL
  catalog maps `getSupplierCategoryMap` + `getSupplierDirectory` (category + country
  — the analysis rows don't carry these), passes to the client. **Span-scoped like
  the other analyses** (single-year + range both via compute-range).
- **⚠️ VERIFIED (Range 2024–2026).** Picks sensible: Heavy Equipment OEM ★
  Kobexindo fit 95.5 (Perf 91/Safety 100/Price 100); Mining Contractor ★ Madhani
  (C-tier hidden gem); Cipta Kridatama correctly docked to 80.5 (Price 60, +9.9%
  premium → "prices well above the category benchmark"). fit math verified; "why"
  matches components; thin-data note (Conveyor & Belt 2 suppliers). Single-year 2026
  recomputes (United Tractors ★ 98.6). Rows→modal (Classification tab). Dark-mode
  token-safe. **No regressions** (Process Health, anomaly hub, modal intact after
  the shared `Sidebar.tsx` nav edit). tsc/ESLint clean; Python untouched.

### CROSS-PAGE ANOMALIES, BATCH 3 (2026-07-10) — TEMPORAL FAMILY → 3-FAMILY HUB COMPLETE

> ⚠️ **PRESENTATION SUPERSEDED (2026-07-13) — the cyan `TemporalBlock` + stacked layout
> are HISTORY** (the component was deleted in the redesign). The temporal family now
> renders as the "Changed over time" **family count card + rows in the ONE unified
> table** (with the note-states on the card), and `buildTemporalMatrix`/
> `buildTemporalAnomalies` are period-aware (see "ACTION PRIORITIES REDESIGN" + "TEMPORAL
> PERIOD-AWARENESS" at the top). **The temporal COMPUTE below is unchanged** — same
> detectors, thresholds, and 2024→2025 numbers (18/48, Spend 10 · Quadrant 7 · Score 3).

**The Cross-Analysis Anomaly Hub is now COMPLETE with 3 families: process (Batch 1)
· classification (Batch 2) · changed-over-time (Batch 3, NEW).** The temporal
family compares each supplier's LATEST vs PRIOR period. NO Python change, NO new
endpoint, NO migration/recompute — reads the trustworthy per-period AnalysisResults
(Purchase-derived; the stored-SupplierMetric lag does NOT touch this — see the prior
investigation). Both AP modes; dark-mode/token-safe.

- **New pure lib `lib/temporal-anomalies.ts`** (`buildTemporalMatrix` +
  `buildTemporalAnomalies`) + server loader **`lib/temporal-load.ts`**
  (`loadTemporalMatrix`, cached `getAnalysisResult` reads). Three detectors, latest
  vs prior: **spend FOLD ≥ 2.5×** (`SPEND_FOLD_CUTOFF`; ratio, NOT raw % — drops cap
  at −100% while spikes reach +1600%) with a **$100K small-base guard**
  (`SPEND_SMALL_BASE_MIN`); **Kraljic quadrant jump** (any change, ranked diagonal >
  adjacent via axes-flipped); **score swing ≥ 18 pts** (`SCORE_SWING_CUTOFF`). All
  NAMED CONSTANTS.
- **⚠️ PARTIAL-YEAR GUARD (`PARTIAL_YEAR_SPEND_FRACTION = 0.5`).** The naive latest
  pair = 2026 vs 2025 is DEGENERATE — **2026 is a partial year (~$30M vs 2025's
  ~$284M)** so ~85% of suppliers show a volume-artifact drop. The guard skips a
  latest year whose total spend < 50% of the prior's → compares **2025 vs 2024**
  (two comparable years); the block live-labels "(2026 excluded — partial year)".
- **⚠️ CALIBRATED against live data.** On 2024→2025: each detector selective (spend
  ~21%, quadrant 15%, score ~6% at ≥18); FAMILY union **18/48 (38%)** — higher than
  classification's 20% because it's 3 DISTINCT sharp signals on a dynamic year-pair,
  every one a real move (verified: +801%, −68%, Leverage→Bottleneck diagonal). Was
  46% at score≥15; tightened to **≥18** to trim the least-dramatic swings → 38%.
  Ranked by significance (quadrant distance dominates, then spend magnitude, then
  score).
- **`buildAnomalyHub` now folds in the temporal family** and generalizes the compound
  system: `compoundIds: Set` → **`familiesBySupplier: Map<id, Set<family>>`** so the
  "⧉ also X" badge spans all 3 families. Batch 1 (`cycle-flags`) + Batch 2
  (`buildClassificationAnomalies`) logic UNTOUCHED.
- **Cyan `TemporalBlock`** (`--temporal` token, light+dark) below the violet
  Classification block: synthesis + a significance-ranked list with change chips
  (quadrant `→`, spend Δ%, score Δpts) + position chips. Rows → unified modal
  **Classification tab** (where the evolution sparklines live). Plumbing: `page.tsx`
  server-loads the matrix (mode-independent) + passes `temporal` + `isRangeMode`;
  `RangeCompute` forwards them (range mode → `isRangeMode`).
- **⚠️ SUPERSEDED (2026-07-13) — single-year is NO LONGER inert; the temporal family
  is now PERIOD-AWARE in BOTH modes.** (Was: single-year showed "Select Range to see
  year-over-year changes" and contributed 0.) Now `loadTemporalMatrix` resolves the
  pair from the selected mode and returns a discriminated **`TemporalLoad`** (see the
  "TEMPORAL PERIOD-AWARENESS" block at the top): single-year **Y compares Y vs Y-1**
  (fires normally — e.g. 2025 vs 2024, 18/48, same pair as range); **earliest year →
  `no-prior` note**; a **partial selected year → `partial-year` note** (the guard
  becomes a note, since we can't step back from a user-chosen year). Range is
  unchanged. Hub synthesis now includes the temporal clause in single-year too.
  **Graceful:** <2 periods → `insufficient` ("needs ≥2 periods"); zero temporal →
  "no sharp changes". *(The original INERT bullet below is HISTORY.)*
- **⚠️ VERIFIED numbers.** RANGE hub: **46 distinct = 36 process + 11 classification +
  18 temporal, 19 compound** (runtime value — the redesign section re-verified 19, which
  is what 46 = 36∪11∪18 implies; check live if in doubt); temporal **18/48 (38%)**, 2024→2025, by-signal
  Spend/Quadrant/Score. Process Health UNCHANGED (11/2/35). $100K guard confirmed
  (Total Energies 4.2× fold / $68.5K → NOT flagged). Dark cyan `#22d3ee`. tsc/ESLint
  clean; Python untouched.

### REPORTS ALIGNED (2026-07-10) — ACTION PRIORITIES STRUCTURE + CLASSIFICATION ANOMALY SUMMARY

> ⚠️ **PRESENTATION SUPERSEDED (2026-07-13) — see "REPORTS REWRITE" above.** The grouped
> `ACTION_GROUPS` rec cards + the "Impact N" framing described in this block are GONE
> (replaced by the decision-first action table); the classification anomaly summary moved
> to the readable appendix. The COMPUTE (anomaly families, categories) is unchanged.
> History below.

**The Reports feature was brought in line with the current app.** Presentation/copy
only — NO `scores.py`/compute change, export path untouched, both render paths
(persisted `/reports/[id]` + ephemeral `/reports/preview`) work.

- **⚠️ "Impact N" REMOVED; recs regrouped by the 3 diagnostic analyses.**
  `ReportDocument` no longer renders the flat impact-ranked list with an "Impact N"
  badge. Recs are now grouped by `ACTION_GROUPS` (From your Spend / Supplier /
  Process analysis — imported from `lib/action-priorities`), each item tagged with
  its **category chip** (one of the current 8) + a `CATEGORY_COLOR_VAR` token
  border; priority is conveyed by ORDER, not a number. The stale local
  `ACTION_COLORS` hex map (only the old 4 actions) was DELETED.
- **Classification anomaly summary ADDED (contained, no new fetch).** A
  "Cross-analysis anomalies — lens disagreement" sub-block in the Recommended
  Priorities section, computed via the shared `buildClassificationAnomalies`
  (Batch 2) from data the report ALREADY has (`performance_spend` + `kraljic` +
  `abc` — all in `ReportAnalyses`). Gated on `!brief`. Verified byte-consistent with
  the live hub (Range 11/55, gaps 96/94/93). Same cutoff (80).
- **✅ SUPERSEDED by `c04eb0b` — reports now render ALL 3 families** (process +
  classification + temporal), server-assembled into `ReportAnalyses` (PDF-safe) — see
  the "REPORTS: FULL 3-FAMILY ANOMALY HUB" block at the top. The note below is HISTORY.
  **(Originally deferred:) the process-cycle anomaly half** (outlier / inconsistent /
  stage-dominated) was NOT in reports — it needed the per-PO
  `/api/cycle-time/breakdown` roster (per-supplier IQR + stage anomalies), which
  `ReportAnalyses` didn't carry. Plumbing was deliberately deferred (risky
  unsupervised); the report then rendered an inline note pointing to the live hub. The
  finish (done in `c04eb0b`): extract `computeCycleBreakdown` + assemble breakdown +
  temporal server-side, then reuse `deriveCycleFlags` + `buildAnomalyCrossref`.
- **Prose reframed in all 3 tones** (`lib/report-templates.ts`):
  `recommendedPriorities` (executive/operational/analytical) + the operational
  `methodology` line dropped "ranked by impact score" / "score N leads the list" →
  "organised by analysis (Spend / Suppliers / Process)". ⚠️ **Reports never encoded
  the old scoring weights** (templates say "CIPS-aligned performance score"
  generically), so NO scoring-model copy change was needed in reports — the
  methodology-page fix covered that surface.
- Dark-mode safe (category chips + group titles are theme tokens, no hex).
  tsc/ESLint clean.

### DOC FIX (2026-07-10) — METHODOLOGY PAGE ALIGNED TO CURRENT MODEL

**The in-app Methodology page (`app/(dashboard)/methodology/page.tsx`) was the LAST
stale scoring surface — now corrected.** It described the pre-`aca864c` model
(Service dimension, weights 25/25/20/15/15, `risk = 100 − (0.4·country +
0.3·complaints + 0.3·single_source)`), which contradicted the live dashboard AND
`methodology_defense_doc.md`. Now consistent with both (`python/scores.py` = source
of truth): composite **0.30·Q + 0.30·D + 0.22·P + 0.18·R** (four dims), **Service
removed** (survey-based RFx/response-time; 15% redistributed proportionally),
**Risk `100 − (0.6·country_distance + 0.4·roster_concentration)`** structural-only,
**Quality per-PO** (defect+complaint counts), and the **two-risk-scores distinction**
(composite Risk higher=safer vs Kraljic supply-risk higher=riskier, shared
roster-concentration signal). Also fixed: §8 inverted "annual aggregates / not
per-transaction" claim → per-PO; §2 dropped the stale single-source-flags mention
(scores now computed at import via `scores.py`); §3.2 supply_concentration "within
the period" → "across the full roster"; §8 dropped leftover "k = 4" (no clustering
analysis exists). §6 light-touched: "Action Dashboard" → **Action Priorities** with
its current **8 categories** (Concentration · Critical Spend · Tail Spend · Critical
Issues Engagement · Hidden Gems Promotion · Bottleneck Risk Mitigation · Process
Improvement · Slowest Stage); §6 impact-formula detail left for a future pass. ⚠️
**Presentation/copy ONLY — no `scores.py`/compute change.** §1/3.1/3.4/5/7/9 left
as-is (already current). tsc/ESLint clean; renders correctly (formula blocks +
dark-mode verified).

### SESSION (2026-07-10) — CROSS-PAGE ANOMALIES, BATCH 2: "CROSS-ANALYSIS ANOMALY HUB"

> ⚠️ **PRESENTATION SUPERSEDED (2026-07-13) — the STACKED-BLOCKS layout is HISTORY.**
> The "hub header + synthesis + Block 1 (process) + Block 2 (classification) [+ Block 3
> (temporal)]" stack of chip-laden lists was REPLACED by **3 family count cards + ONE
> filterable/sortable supplier table** (see "ACTION PRIORITIES REDESIGN" at the top).
> **The COMPUTE is UNCHANGED and still current** — `buildAnomalyHub` +
> `buildClassificationAnomalies` + `CLASSIFICATION_DISAGREEMENT_CUTOFF = 80` +
> `familiesBySupplier`/`compoundCount`/`importantUnionCount` are the SAME pure lib the
> new table reads; only the rendering (Blocks → cards + table) changed. Numbers
> identical (Range classification 11/55, gaps 96/94/93).

**Batch 2 shipped: Batch 1's standalone process-anomaly section was RESTRUCTURED
into a unified "Cross-Analysis Anomaly Hub" holding TWO anomaly families, and a
NEW second family was added — cross-lens classification disagreement.** One amber
section: hub header + hub-level synthesis + Block 1 (process) + Block 2
(classification). Pure compute added to `lib/anomaly-crossref.ts`; NO Python, NO
new endpoint, NO migration, NO recompute. Both AP modes; dark-mode/token-safe.

- **⚠️ `lib/cycle-flags.ts` + Process Health UNTOUCHED** (verified still 11/2/35 on
  the Range). Batch 1's `buildAnomalyCrossref` is UNCHANGED and reused inside the
  new `buildAnomalyHub`. `AnomalyExposureSection` → `CrossAnalysisAnomalyHub`.
- **Block 1 — Process anomalies** = Batch 1's content verbatim (cycle flags ×
  ABC/Kraljic/zone, severity-inverting synthesis, Exposure `$` stat tile, flagged
  list), now a sub-block. Rows → unified modal **Process** tab.
- **Block 2 — Classification anomalies (NEW): cross-lens DISAGREEMENT ranking.**
  For each roster supplier, percentile-rank three lenses — **S = spend**
  (`perf.total_spend_usd`), **P = performance** (`perf.performance_score`), **R =
  supply-risk** (⚠️ numeric `kraljic.quadrant_assignments[].supply_risk_score` — the
  `kraljic` prop AP already passes; `perf` only carries the categorical quadrant).
  `disagreement = max(S,P,R) − min(S,P,R)`; percentiles are **integer-rounded FIRST**
  so the bars reconcile with the displayed spread exactly. **Cutoff =
  `CLASSIFICATION_DISAGREEMENT_CUTOFF = 80`** (a named const in the lib, referenced
  by the display copy so they stay in sync). Ranked by spread desc; each row shows
  rank · name · spread · **three-lens mini-bars** (S blue `--quadrant-routine` / P
  green `--zone-stars` / R red `--quadrant-strategic`, distinct hues so the
  contradiction is visible) · a **computed verdict** ("Top performance, bottom
  spend" etc., from the max/min axes) · position chips. Rows → unified modal
  **Classification** tab.
- **⚠️ Cutoff CALIBRATED to 80 (was 50).** ≥50 flagged ~60% of the roster (33/55
  Range, 13/20 2026) — not an "anomaly". The live spread distribution has a natural
  break at **87→80→79**, so 80 cuts just above the dense 78-79 tail → flags the
  genuine extremes only (one lens ~top-decile, another ~bottom-decile): **11/55
  Range (20%), 3/20 2026 (15%)**. The striking top is unchanged (Total Energies 96,
  Lintas Marga 94, Kobexindo 93, Madhani 91).
- **Hub-level synthesis** ties both families: "N suppliers show a cross-analysis
  anomaly — M process, K classification, J both. X on important relationships."
  **Compound badge** (`⧉ also process` / `⧉ also classification`) marks suppliers in
  BOTH families — the cross-supplier overlap surfaced without a merged list. Violet
  accent (`--zone-hidden-gems`) for the classification family vs amber for the hub.
- **Drill routing:** hub process rows → Process tab, hub classification rows →
  Classification tab (reuses Batch 1's `initialTab` prop; band rows still →
  Classification, unchanged).
- **⚠️ VERIFIED numbers (cutoff 80).** RANGE: **41 flagged = 36 process + 11
  classification − 6 both**; 17 important. 2026: **11 = 10 + 3 − 2**; 5 important.
  Both reconcile. Disagreement math spot-checked (Total Energies S2/P4/R98 → spread
  96 "high supply-risk, bottom spend"; Kobexindo S85/P98/R5 → 93 "top performance,
  low supply-risk"; bars match the spread). Dark-mode tokens resolve (amber
  `#fbbf24`, violet `#a78bfa`, bars `#60a5fa`/`#34d399`/`#f87171`). tsc/ESLint clean.

### SESSION (2026-07-10) — CROSS-PAGE ANOMALIES, BATCH 1: "ANOMALY EXPOSURE"

**Batch 1 of the cross-page-anomaly project shipped: a new AMBER "Anomaly
exposure" section on Action Priorities that cross-references the THREE EXISTING
Process Health cycle-time anomaly flags against each flagged supplier's ABC /
Kraljic / performance-zone position.** The first "hub" piece — it spans analyses,
so it renders as a dedicated 4th section BELOW the 3 `ACTION_GROUPS` bands (not
inside any one band). Presentation + a pure join only; NO compute change, NO new
endpoint, NO migration, NO range-cache clear. Both AP modes; dark-mode/token-safe.

- **Shared flag helper (`lib/cycle-flags.ts`, NEW) — the regression-sensitive
  extraction.** The ~15-line flag derivation was lifted VERBATIM out of
  `CycleTimeClient.tsx` into `deriveCycleFlags({roster, anomalies, stageAnomalies})
  → {flagsBySupplier, flagCounts, flagPoCounts, iqrCutoff}`. Same
  `IQR > 1.5×median(roster IQRs)` rule, same outlier-set + stage-dom-set
  membership. **Imported by BOTH `CycleTimeClient` AND `ActionDashboardView`** so
  the flags are guaranteed identical across the two pages. ⚠️ **Process Health is a
  regression surface** — verified byte-identical via independent recompute (Range:
  outlier 11 suppliers / 15 POs, inconsistent 2, stage-dom 35 / 95 POs; roster
  chips + filter sync unchanged). Do NOT re-inline this logic.
- **Cross-reference (`lib/anomaly-crossref.ts`, NEW, pure):**
  `buildAnomalyCrossref({flagsBySupplier, perfSuppliers, roster})` joins each
  flagged supplier's `{flags}` with `{abc_class}` (from the breakdown roster) +
  `{total_spend_usd, kraljic_quadrant, zone}` (from `performance_spend`).
  **`important = abc_class==='A' OR kraljic_quadrant==='Strategic'`.** Rolls up
  `flaggedCount / importantCount / importantSpend / flagMix`, rows sorted
  IMPORTANT-first then spend-desc.
- **Plumbing = ONE breakdown fetch, no new endpoint.** `ActionDashboardView`'s new
  `AnomalyExposureSection` self-fetches `/api/cycle-time/breakdown?start&end`
  (span-scoped, keyed on the dates AP already passes in BOTH modes — the exact
  route + lazy pattern Process Health / the unified modal use). `has_outlier` comes
  from the already-loaded `cycleTime.anomalies` (needs no breakdown); ABC comes
  FREE from `breakdown.bySupplier[].abc_class`; spend/Kraljic/zone from the `perf`
  prop AP already loads.
- **The section (amber accent = `--warning`):** band header "Anomaly exposure —
  process anomalies, weighted by who they hit" + "N flagged"; a
  severity-INVERTING synthesis line (≥1 important → "concentrated on your most
  important relationships"; 0 important → "lower urgency"); a `$`-exposure StatTile
  (importantSpend + coverage + flag-mix line); a wide list tile (flagged suppliers,
  important-first, top-4 + "+N more") with FLAG chips (Outlier=`--warning`,
  Inconsistent=`--primary`, Stage-dom=`--destructive` — mirrors PH's `FLAG_META`)
  and bordered POSITION chips (Class A / Kraljic / zone — A-tier + Strategic
  highlighted amber). Rows call `onSupplier(id)` → the **unified modal**.
- **Row → unified modal opens on the PROCESS tab.** Added an optional `initialTab?:
  Tab` prop to `UnifiedSupplierDetailModal` (default `"classification"` → all
  existing callers unchanged); the anomaly rows pass `"process"`, and
  `processOpened` is seeded true so the lazy Process fetch fires. Band rows +
  peer-links still open on Classification.
- **⚠️ VERIFIED numbers (2026-07-10).** RANGE (2024–2026): **36 flagged / 16
  important / $491.8M** exposure / flag-mix outlier 11 · inconsistent 2 · stage-dom
  35. SINGLE-YEAR 2026: **10 / 5 / $23.2M** / mix **0** · 7 · 4 (exercises the
  Outlier-0 case). Both match an independent recompute EXACTLY. tsc + ESLint clean;
  no console/server errors on a cold build. **Degraded (breakdown-fetch-fail →
  outlier-only + note) + zero-flagged (neutral state) branches are
  written-and-type-checked but NOT runtime-forced** (no failing/empty span was
  available to trigger them) — accepted as defensive for Batch 1.

### SESSION (2026-07-09) — ACTION PRIORITIES → 3-GROUP DASHBOARD GRID

> ⚠️ **SUPERSEDED (2026-07-13) — the VIEW below is HISTORY.** The "instrument-panel
> dashboard grid" of tiles + the 3-band tile layout were REPLACED by the analysis-page
> redesign (prose glance → stat grid → compact 3-group "Where to act" → 3 family cards +
> one table). See the "ACTION PRIORITIES REDESIGN" block at the top. **The COMPUTE/DATA
> half of this block is still current** — the 8 categories, the 3 `ACTION_GROUPS`, the 3
> added `recommendations_analysis` categories (`critical_spend`/`tail_spend`/`slow_stage`),
> the de-dups, the narrative fields, and the `--priority-*` tokens are all unchanged; only
> the tiled VIEW (`ActionDashboardView.tsx`) and the tile components were rewritten.

**Action Priorities restructured into 3 analysis-grouped sections + 3 new
categories, rendered as a compact instrument-panel dashboard grid.** ONE commit
covering BOTH the compute/data changes AND the tiled-view rebuild (an earlier
stacked-card version of the grouping was rejected and superseded by the grid).
The existing 4 categories' compute + impact formulas + `priority_rank` are
UNCHANGED; the new work is additive + a presentation rebuild.

- **3 groups (`ACTION_GROUPS` in `lib/action-priorities.ts`):** Spend → Suppliers
  → Process, one per diagnostic analysis. Spend = Concentration · Critical Spend ·
  Tail Spend; Suppliers = Engage · Promote · Mitigate (three equal list tiles);
  Process = Improve · Slowest Stage.
- **3 NEW categories (`recommendations_analysis`, `python/compute_analyses.py`):**
  - `critical_spend` / **steward** — the A-tier "vital few" (REUSES `abc_analysis`
    80/95 tiers — no re-implement), ranked by spend; drills to the supplier.
  - `tail_spend` / **consolidate** — ONE portfolio-summary card: sub-1% suppliers
    (`TAIL_SPEND_SHARE = 0.01`) — count + combined spend share + roster share.
  - `slow_stage` / **streamline** — internal P2P stages above the 8-day flag
    (PO→Delivery excluded), ranked by avg days; carries `avg_days` +
    `cycle_share_pct`.
- **De-dups (the only two existing categories that changed):** Concentration is now
  **CATEGORY-LEVEL ONLY** (`CATEGORY_CONC_THRESHOLD` 0.30; the old supplier-level
  >10% branch + `SUPPLIER_CONC_THRESHOLD` are GONE → supplier criticality lives in
  Critical Spend). `process_improvement` (Improve) is now **COMPLIANCE-ONLY** (the
  worst-quadrant 3-way-match item; the per-stage timing items moved to Slowest
  Stage). No item appears under two Process-group categories.
- **Narrative (`summary_stats.narrative`) gained** `a_items_count`,
  `slowest_stage_name`, `slowest_stage_avg_days` (all optional → old cached rows
  degrade). `attention` (the "N of top-10" stat) is now **engage + mitigate only**
  (the removed supplier-concentration term is gone; Critical Spend is deliberately
  excluded so it doesn't pull in every top spender). `by_category` has 8 keys.
- **Tokens (`app/globals.css`, light+dark):** `--priority-steward` (cyan),
  `--priority-consolidate` (teal), `--priority-slowstage` (indigo — NOT improve's
  blue; they share the Process group). Types: `RecommendationCategory`/`Action` +3
  each; new optional `Recommendation` fields (`abc_class` / `avg_days` /
  `cycle_share_pct` / `tail_*`). Reports render the new cats **generically**
  (`ALL_REC_CATEGORIES` + `REC_CATEGORY_LABELS` + `ACTION_VERB` extended). ⚠️
  reports still show "Impact N" — known follow-up, no report redesign this batch.
- **View = instrument-panel dashboard grid** (`components/ActionDashboardView.tsx`,
  full rewrite; **`ActionRecommendationCard.tsx` DELETED**). 3 bands (accent header
  + tagline + "N flagged" + one computed finding) over a 3-col tile grid. Tile
  kinds (lightweight inline SVG/CSS, tokens only): **donut** (Concentration share),
  **list** (Critical Spend / Engage / Promote / Mitigate — top-4 + "+N more" inline
  expand, drill-through rows), **stat** (Tail spend; Match compliance = the
  worst-quadrant failure %, which IS `process_improvement.impact_score`), **bar**
  (P2P stages — slowest accented, others dimmed, an 8-day flag line). Advice is
  stated **ONCE per tile** (small-caps action verb + the existing `CATEGORY_NUDGE`,
  de-"Suggested:"d) — NOT per row. Fits ~1 screen.
- **⚠️ The P2P bar tile reads the CACHED `cycle_time` analysis** (all three
  internal `stage_breakdown.*.mean`) — `recommendations` alone only carries FLAGGED
  stages. Plumbed with NO compute change: the page loads
  `getAnalysisResult(period,"cycle_time")` in cached mode and `RangeCompute` passes
  `state.data.cycle_time` in range mode → `ActionDashboardView` gets an optional
  `cycleTime` prop.
- **Drill-through preserved** (supplier_id → `/supplier-classification?supplier=`;
  concentration-category → `/spend-overview`). Graceful degradation: no stage
  clears 8d → bars all "balanced" + no streamline advice; empty category → neutral
  tile.
- **Compute + `AnalysisResult` SHAPE unchanged by the view rebuild.** When the 3
  categories were ADDED, the cache was recomputed once via the safe recipe
  (per-period `--period-id` ×3 + clear the `periodId IS NULL` range rows); source
  data untouched. ⚠️ **VERIFIED numbers:** 2024 slow_stage = Invoice→Payment ~17.9d
  (range ~12.2d); **2025 & 2026 have NO slow_stage** (no internal stage clears 8d →
  Process band shows "balanced"). Critical Spend counts = A-tier (2024/25/26 =
  8/10/4). Both compute modes render; dark-mode token-safe; no hardcoded hex.

**Follow-up (later 2026-07-09) — INSIGHT LAYER + IN-PLACE CENTERED SUPPLIER
MODAL.** Two presentation/interaction additions to Action Priorities; compute +
`AnalysisResult` shape unchanged.
- **Insight layer (light):** a computed synthesis headline below the intro (from
  `summary_stats.narrative` — `top10_in_attention` + top-category share) plus one
  interpretive takeaway line per band (Spend concentration / supplier attention /
  slowest stage), replacing the bare per-band finding. Tiles untouched, page not
  re-bloated.
- **In-place supplier detail — the `?supplier=` REDIRECT IS GONE.** Clicking a
  supplier row (Critical Spend / Engage / Promote / Mitigate) now opens
  `SupplierClassificationDetailPanel` as a **centered modal** over the dashboard
  (URL stays `/action-dashboard`; Esc / close / click-outside returns; the user
  stays on Action Priorities). The panel is **REUSED AS-IS** — it's self-contained
  (fetches its own spend-detail + evolution) and already renders as a centered
  `Dialog`, so **no change to the shared Dialog primitive or the panel**. It only
  needs `perf` + `kraljic` + the period span, which `page.tsx` loads in cached mode
  (`getAnalysisResult` + `getDateRangeFromSelection`) and `RangeCompute` passes
  from `state.data` in range mode (no new fetch). *(A right-slide-over variant was
  explored first, then dropped for the centered default.)*
- The **concentration-category donut keeps its `/spend-overview` link** (a category
  has no supplier panel); Tail spend, the P2P bars, and the stat tiles stay
  non-clickable. Both modes render; single-year degradation preserved; dark-mode
  token-safe.

**Follow-up (later 2026-07-09) — UNIFIED SUPPLIER DETAIL MODAL (3 analysis tabs).**
The Action Priorities supplier click now opens ONE centered modal
(`components/UnifiedSupplierDetailModal.tsx`, NEW) with three top-level tabs —
**Classification / Spend / Process** — replacing the single Classification panel.
Presentation/interaction only; compute + the 3 source pages unchanged.
- **⚠️ BODY EXTRACTION — the reuse mechanism.** Each of the three page panels was
  split into its **shell** (Dialog + own fetch + identity header) and a
  **presentational body**, both exported from the SAME file:
  `SpendDetailBody` (`SpendDecompositionPanel.tsx`), `ClassificationDetailBody`
  (`SupplierClassificationDetailPanel.tsx`), `ProcessDetailBody`
  (`CycleTimeSupplierDetailPanel.tsx`). The bodies are presentational — they take
  the fetched data + loading/error as PROPS and own only their sub-tab state; the
  shells keep their fetch + header and render `Dialog(header + <XBody>)`. **The
  three own pages (Supplier Classification, Spend Overview, Process Health) render
  byte-identically** (the JSX moved into a child at the same position) — verified:
  each page's panel still opens with its own header + sub-tabs and NO top-level
  analysis tabs. Do NOT re-inline the bodies.
- **Shared/deduped fetch:** the modal fetches `spend-detail` + `evolution` ONCE
  (its own useEffects, keyed on supplier) and feeds BOTH the Classification and
  Spend bodies as props → opening Classification then Spend does **not** re-fetch
  (verified: spend-detail=1 / evolution=1). The header identity is sourced from
  `spend-detail.supplier` (same fields the Spend panel header uses).
- **Process = FULL FIDELITY, lazy.** The Process tab fetches
  `/api/cycle-time/breakdown` (span roster) + the per-supplier
  `cycle-time/supplier-detail` **only on first open** (verified: cycle-time fired
  0× until Process opened), then derives `iqrCutoff = 1.5·median(roster.iqr)`,
  `inconsistent`, `stageDominatedPoIds = Set(stageAnomalies.po_id)`, and
  `portfolio` (`{…cycleTime.distribution median/p25/p75, supplierMedians, iqrCutoff}`)
  — the SAME derivation `CycleTimeClient` + `CycleSupplierSection` do — so the tab
  shows the speed-rank gauge, portfolio deltas, inconsistency flag, and
  stage-dominated PO flags identically to the Process Health panel. `cycleTime` is
  already on Action Priorities (P2P tile) and is passed into the modal.
- **Wiring:** `ActionDashboardView` mounts `UnifiedSupplierDetailModal`
  (perf/kraljic/cycleTime/dates already available). Peer-supplier links inside the
  Classification body re-target the modal (resets to the Classification tab).
  Concentration-category donut keeps `/spend-overview`; other tiles non-clickable.
  Both AP modes; dark-mode safe; no compute change.

### SESSION (2026-07-06, later) — FILTER-LIVE COMPOSITE

**The performance composite is now FILTER-LIVE** — recomputed from the POs in the
current time filter (single-year = that year's POs; range = all POs in the span)
instead of being read as a frozen per-period / latest-snapshot value. ONE engine;
the TS duplicate is deleted. Staged in 4 stages, **held for commit** (not yet in
`git log`). Touches `python/scores.py`, `python/compute_analyses.py`,
`app/api/suppliers/[id]/spend-detail/route.ts`; **deletes** `lib/score-methodology.ts`.

- **Engine (Stage 1):** `scores.build_window_metrics(metrics, purchases, roster)`
  aggregates delivery/process over ANY filtered PO set (period dimension
  collapsed) then `compute_scores` → the 6 scores. Shares the aggregation helper
  `_aggregate_purchase_group` with `build_period_metrics` (behavior-preserving).
  **Proven byte-identical** to the per-year computation for 2024/2025/2026
  (`test_scores.test_window_matches_period`). Camel/snake boundary =
  `scores.rename_purchase_columns` (DB Purchase camelCase → engine snake_case).
- **Compute swap (Stage 2):** `compute_analyses.main()` builds `_LIVE_COMPOSITE_MAP`
  once from the filtered POs (`build_live_composite_map`, joins `country` from the
  Supplier frame — SupplierMetric has none); the three `perf_of` fns
  (performance_spend zones, kraljic avg_performance, recommendations) read it
  instead of stored `SupplierMetric.compositeScore` (stored kept as fallback).
- **⚠️ 0.82 of the composite is filter-dependent; only Risk (0.18) is pinned.**
  Weights are **0.30·Q + 0.30·D + 0.22·P + 0.18·R** (`scores.py` — Service was REMOVED,
  not 0.25/0.20). Quality (0.30, **now per-PO defect/complaint aggregation — filter-live**,
  not a soft-survey constant), Delivery (0.30), and Process (0.22) ALL re-aggregate over
  the filtered POs → **Q+D+P = 0.82** responds to the window; only the structural Risk
  sub-score (0.18 — `100 − (0.6·country_distance + 0.4·roster_concentration)`) is
  window-independent. *(This corrects the earlier stale "0.45 dependent / 0.55 pinned"
  note, which pre-dated the Service-removal + per-PO-Quality changes.)*
- **VERIFIED numbers.** ⚠️ **STALE — these zone counts predate `aca864c` (the very
  next commit) and are SUPERSEDED **twice** — first by `aca864c`, then by the
  order-year migration. See "PER-PERIOD BASELINES RE-RECORDED (2026-07-24)" near the
  top; no figures are repeated here so this pointer cannot go stale again.**
  SINGLE-YEAR is **byte-identical to the prior stored**
  composite: 2024 **17/9/9/18** (med 74.18), 2025 **19/6/6/19** (79.24), 2026
  **6/4/4/6** (82.96) — 0 composite diffs. RANGE moved from the latest-snapshot
  **18/9/9/19** to the true span-aggregate **19/8/8/20** (perf_median **80.01 →
  77.47**; 49/55 composites changed). ⚠️ **Range is the DEFAULT landing**, so the
  default performance zones changed.
- **ABC + Kraljic QUADRANT ASSIGNMENT unchanged** everywhere (composite-independent
  — spend × supply-risk). Only composite-derived zones / avg_performance / recs
  move, and only in range/multi-year.
- **Panels unified (Stage 3):** `lib/score-methodology.ts` (the stale **pre-D9** TS
  range calculator — it still used `single_source_risk*100`) DELETED. The
  spend-detail range `performance.score` now reads the filter-live
  `performance_spend` analysis (same source as the zone chip + the Classification
  page) → the panel and the page AGREE (the pre-D9 divergence is resolved by
  elimination). `SpendDetail.subScores` + `storedSubScores` removed (never
  rendered — the Classification panel reads per-year evolution sub-scores instead).

**Also this session — `product_description` DROPPED, `unit` KEPT.** The ghost sweep
found `product_description` (Suppliers + SupplierMetrics sheets) unconsumed →
dropped from zod (`SuppliersRow`/`SupplierMetricsRow`), the route supplier mapping,
`scores.IDENTITY_COLS`, `lib/python.ts`, both sheets of
`data/raw/procurement_data_raw.xlsx`, and `Supplier.productDescription` (migration
`20260706120000_drop_product_description`, **held/unapplied** — DB still has the
column). ⚠️ **`unit` is KEPT** (Purchases sheet + `Purchase.unit` + spend-detail
plumbing). ⚠️ **`single_source_risk` is DEAD CODE** — a raw soft-survey column wired
to nothing (see the KNOWN OPEN ITEMS block near the top): `supply_concentration`
replaced it, so it feeds NO composite (D9 uses roster concentration) and NO
recommendation. *(The older "KEPT — feeds the AD bottleneck 'Single-source' string"
claim was stale; no bottleneck rec references it.)* Sample file
now **Suppliers 4 / Purchases 21 / SupplierMetrics 9**; imports byte-identically
for the staying columns.

### SESSION (2026-07-06) — BACKEND-SCORING REBUILD (Stages 1–3)

**BACKEND-SCORING REBUILD, Stages 1–3 — LIVE. Import now takes RAW data only; the
backend computes all 6 scores server-side.** Commits: `b34c40a` (Stage 1),
`1f507fa` (Stage 2), `af1152d` (Stage 3, live).
- **Architecture change (the big one):** the import route
  (`app/api/imports/upload/route.ts`) no longer reads pre-computed score columns
  from the xlsx. `SupplierMetricsRow` zod is now **raw-only**, one row per
  supplier: `supplier_id, supplier_name, country, category, product_description`
  (identity) + `defect_rate_pct, complaint_count_annual, rfx_response_rate_pct,
  avg_response_time_days, single_source_risk` (soft-survey). **NO `period`, NO 6
  score columns, NO operational aggregates** (all computed server-side). ⚠️
  `country` + `product_description` ARE required (the engine's
  `build_period_metrics` sources supplier identity from these rows); zod strips
  any extra columns. Flow: **parse+validate raw → `runImportCompute` (Python
  bridge, `lib/python.ts`, fail-before-write) → atomic `$transaction` write →
  `compute_analyses` per period → clear range cache.** Compute runs **before** the
  write (a Python failure → 500, no partial state). `sample-data` now serves
  `data/raw/procurement_data_raw.xlsx` (raw), not the enriched one.
- **`python/scores.py` is the single source of truth** for the 6 formulas (D9
  baked in): `norm_high/low`, `country_distance_score`, `concentration_0_100` +
  `_CONC_POINTS`, `roster_category_counts`, `build_period_metrics`,
  `compute_scores`. `scripts/transform_dataset.py` was refactored to import from
  it (behavior-preserving, byte-identical output — proven) and is now
  **offline-transformer-only** (it still writes the enriched xlsx for offline use;
  the app never reads that file anymore). Tests: `python/test_scores.py`,
  `python/test_import_compute.py` lock formula-exactness + the rebucket invariants.

> ✅ **RESOLVED — the D9-REVERT LANDMINE is DEAD (Stage 3).** The uploaded file no
> longer carries composites, so there is nothing to revert to — the route
> recomputes all scores from raw (D9 in `scores.py`) on **every** import. Verified
> live: **two consecutive imports produced byte-identical scores.** Re-importing is
> safe and deterministic. (Supersedes the 2026-07-04 landmine warning below.)

> ✅ **DONE — the deferred SupplierMetric invoice→payment rebucket landed.** The
> live import wrote **payment-year-bucketed** SupplierMetric rows: row-set is now
> **53 / 50 / 20** (was 54/50/16 invoice-bucketed; S054 2024→2026, S002/S003/S020
> gained 2026). D9 composites are regenerated from source (raw) — the two deferred
> items converged in this one live import, exactly as planned. (Supersedes the
> 2026-07-04 "DEFERRED" note below.)

⚠️ **VERIFIED CURRENT NUMBERS (post-Stage-3, computedAt 2026-07-06) — supersede any
older doc.** SupplierMetric **payment-bucketed 53/50/20**. Only performance zones
moved (they read the composite); everything spend/risk-based is unchanged. ⚠️⚠️ **THE
WHOLE BLOCK IS NOW HISTORY — every per-period figure below is PRE-MIGRATION.** The zone
counts were already stale (pre-`aca864c`); the order-year migration then moved the
spend/risk-based ones too, so the "spend/risk-based numbers below are still current"
claim that stood here **was wrong and has been removed** — 2025 Kraljic, ABC, control
exposure, PO count and spend all moved. Current values: see "PER-PERIOD BASELINES
RE-RECORDED (2026-07-24)" near the top.
- **2025:** zones still **19 / 6 / 6 / 19** but with 2 rebucket swaps (**S054
  Stars→Critical, S061 Critical→Stars**; perf_median 79.70→79.24). UNCHANGED:
  Kraljic **10/15/15/10**, ABC **10/9/31**, risk split 25/25, control **$42.47M**,
  313 POs, $283,596,813.69.
- **2024:** zones **17/9/9/18** (2 swaps S008 Stars→Critical, S005 Critical→Stars);
  Kraljic 12/14/15/12, ABC 8/10/35, control $83.82M — unchanged.
- **2026:** zones now **6 / 4 / 4 / 6** (row-set grew 16→20; 7 movers as the 4
  boundary suppliers gain a 2026 composite); Kraljic 5/5/5/5, ABC 4/3/13, control
  $7.45M — unchanged.
- Whole-portfolio SupplierMetric means: composite **77.40**, risk **68.42**.
- ✅ **RESOLVED — `defense.md` was aligned to the current model in `e451f93`** (this
  older "zone numbers need update" flag is done). ⚠️ **The "Kraljic 10/15/15/10 is
  still current" claim that stood here is REVOKED** — it was true of the rebucket it
  was written about, but the order-year migration moved it to **14/11/12/14** for 2025.
  See the 2026-07-24 re-record near the top.

**⚠️ PENDING — NEXT TASK: sample-data reconcile + update.** The sample file
(`data/raw/procurement_data_raw.xlsx`, served by `app/api/sample-data/route.ts`)
may NOT match the current **raw-only** import schema — it likely still carries a
`tier` column and stale per-supplier operational-aggregate columns
(`total_spend_usd`, `num_pos`, otd%, 3wm%, etc.) that the raw-only schema doesn't
expect. zod strips extras so an import still SUCCEEDS, but the sample should be
clean. Do a **read-only reconcile first**: compare what the raw file's
SupplierMetrics sheet actually contains vs the raw-only `SupplierMetricsRow`
schema (identity `supplier_id/supplier_name/country/category/product_description`
+ soft `defect_rate_pct/complaint_count_annual/rfx_response_rate_pct/
avg_response_time_days/single_source_risk` ONLY), report the exact mismatch, THEN
update the sample to match the CURRENT Stage-3 schema (drop period/scores/computed
aggregates; keep identity + soft). **Match the current schema, not any old column
list.** Suppliers + Purchases sheets are already raw and fine.

**Session state / restore nets (this session's scratch, gitignored — outside the
repo).** Pre-Stage-3 DB snapshot: `…/scratchpad/db_snapshot_prestage3_<ts>.sql`
(pg_dump, ~810KB — restore net if the payment-bucketed state ever needs reverting;
path also in `…/scratchpad/last_snapshot_path.txt`). Baseline score dump:
`…/scratchpad/baseline_supplier_scores.csv` (the 120-row invoice-bucketed
pre-rebuild scores the Stage-1/2 tests verify against, via `$BASELINE_CSV`).
`…/scratchpad/baseline_aggregates.json` = pre-rebuild 2024/25/26 aggregates.

**Non-issue seen this session (don't chase):** Spend Overview "won't open" was a
**stale/zombie dev server** on :3000 (404'd even `/api/auth/login`), NOT an
import/data bug — verified 200 + full render on a clean server. The import clears
the range cache (`AnalysisResult periodId IS NULL`), so the FIRST range-mode load
after ANY import recomputes Mode B (~2s) and self-caches — normal, non-fatal. Fix
= restart ONE clean dev server (kill any zombie squatting on :3000).

### SESSION (2026-07-04)

**Supplier Classification supply-risk fixes — A1 + B5 + D9 (`07c2e5c`), recomputed +
verified fresh DB.** Also an earlier frontend-only commit this session (`96b4b2f`:
E11 synthesis `<=` to match the Python zone convention, E10 self-omit guard on the
"All Strategic" line, F14 portfolio-size denominator = kraljic roster sum).
- **A1** — `compute_supply_risk` supply_concentration now counts the **FULL category
  roster** (all known suppliers, active or not — an inactive-but-qualified supplier is
  still an available alternative), NOT just the period-active set. Loaded once in
  `main()` via `load_roster_category_counts(conn)` (DB `Supplier` master table) into a
  module global `_ROSTER_CAT_COUNTS`; falls back to period-scoped size if unset.
  cost_premium + import_friction stay active-only (correct). Trace: S114 50→35,
  Local-Steel S104/S100/S101 22→5, **10 suppliers corrected in 2025**.
- **B5** — Kraljic risk-axis median split `>` → **`>=`** (discrete tie-heavy risk score;
  strict `>` dumped all tied-at-median suppliers into low-risk). Spend axis keeps `>`
  (continuous, no ties) — asymmetry intentional. 2025 risk split **24/26 → 25/25**.
- **D9** — composite `risk_score` concentration term: dropped `single_source_risk*100`,
  now the **same roster concentration** A1 uses, scaled ×2 onto the composite's 0-100
  axis (`concentration_0_100`, `_CONC_POINTS` in `transform_dataset.py`; single-source→100
  preserves the old endpoint). So composite + Kraljic share ONE concentration signal.

> ✅ **SUPERSEDED / RESOLVED by Stage 3 (2026-07-06) — see the top session block.**
> The D9-revert landmine is DEAD: the import now computes scores from raw (no scores
> in the uploaded file), and the DB is now payment-bucketed 53/50/20. The historical
> warning below is kept for context. ⚠️ **D9 IS IN THE DB BUT NOT IN THE COMMITTED
> XLSX (LANDMINE).** D9 was applied **in-place** to the DB's `SupplierMetric` rows
> (recomputed `riskScore` + `compositeScore` on the existing 120 rows via the
> transformer's exact D9 functions, keeping the other 4 sub-scores + the row set) AND
> to `transform_dataset.py` source — but **NOT baked into
> `data/raw/procurement_data.xlsx`** (deliberately restored, to avoid bundling the
> out-of-scope invoice→payment rebucketing). **CONSEQUENCE: a full re-import of the
> current committed xlsx would REVERT D9 in the DB.** Do **NOT** re-import the xlsx
> outside the planned rebucket+reimport batch.

> ✅ **SUPERSEDED / DONE by Stage 3 (2026-07-06).** The rebucket + D9-from-source
> convergence landed via the live raw import (row-set now 53/50/20). Historical note:
> **DEFERRED — SupplierMetric rebucket + reimport.** `transform_dataset.py` now holds
> the D9 edit as source-of-truth, but re-running the transformer ALSO rebuckets
> per-period `SupplierMetric` rows **invoice-year → payment-year** (a separate deferred
> fix; observed as row-set drift 54/50/16 → 53/50/20, S054 2024→2026, S002/S003/S020
> gain 2026). When that batch runs it will regenerate D9 composites from source AND fix
> the bucketing **together** — the intended convergence point. Until then the DB carries
> the correct D9 values via the in-place update.

**Recompute procedure (SAFE):** D9 in-place update (120 rows) → idempotent
`Purchase.periodId` re-tag by paymentDate (**0 rows**, already correct, 306/313/28) →
`compute_analyses.py --period-id` ×3 (6/6 each, computedAt **2026-07-04 20:26**) →
`DELETE FROM "AnalysisResult" WHERE "periodId" IS NULL` (30 range rows). NOT the
migrate-script. `.env` BOM → inject `DATABASE_URL` (`utf-8-sig`) for standalone Python.

⚠️ **VERIFIED CURRENT NUMBERS (2025) — supersede any older doc.** Kraljic
**10 / 15 / 15 / 10** (Strategic/Leverage/Bottleneck/Routine) — **was 8/17/16/9** before
A1/B5; risk split **25/25**; risk_median 24.71. Performance zones **Stars 19 / Critical 6
/ Hidden Gems 6 / Long Tail 19** (distribution UNCHANGED by D9 — 4 symmetric membership
swaps: S008 Critical→Stars, S031 LongTail→HiddenGems, S061 Stars→Critical, S070
HiddenGems→LongTail; perf_median 80.27→79.70). UNCHANGED: ABC 10/9/31, 313 POs,
$283,596,813.69, control exposure $42.47M. **Any doc citing 8/17/16/9 WAS
KNOWN-STALE; `defense.md` was aligned to the current model in `e451f93`. The only
remaining defense-doc work is filling the `[NEEDS URL]` source citations + verifying
the data claims — operator homework, NOT a staleness bug.**

⚠️ **COMMIT-MESSAGE TOOLING NOTE.** In the Git Bash tool, write commit messages with a
**heredoc** (`git commit -F - <<'EOF' … EOF`) or a message file — **NOT** PowerShell
here-string syntax (`@'…'@`), which the POSIX shell passes literally and leaves a stray
`@` prefixing the subject line (has happened several times; had to amend).

### SESSION (2026-07-03)

**Insight-fragility audit — DONE (`47ffcd9` / `9c3df01` / `6fbdafc`).** 12 auto-generated
insight/narrative surfaces audited + fixed so every adjective/direction is data-driven
(guards / shape-detection / self-omit / drop) — see roadmap (a). Bundled the AD rec
reword (#6 "weakest match compliance") + AD stage-arrows "→"→"to", now LIVE.

**Recompute ran + verified (fresh DB).** `compute_analyses.py` edits (audit #6, AD stage
arrows "to") live (`46d6276`). SAFE procedure: idempotent `Purchase.periodId` re-tag
(already paymentDate-correct, distribution **306/313/28**) → `compute_analyses.py
--period-id` ×3 (computedAt 10:49) → `DELETE FROM "AnalysisResult" WHERE "periodId" IS
NULL`. ⚠️ Aggregates **byte-identical** (2025: 313 POs / $283,596,813.69 / 50 suppliers /
control $42.47M) — only rec strings changed. ⚠️ `.env` has a UTF-8 BOM → standalone
Python must read `DATABASE_URL` with `encoding="utf-8-sig"` (Node passes it in, so the
app path is unaffected).

**Process Health supplier-card overhaul (`267926e` + `44c904c`) — DISPLAY-ONLY, no
recompute.** The cycle-time drill-down (`CycleTimeSupplierDetailPanel`) was rebuilt:
- **PO block = ONE Table⇄Chart toggle** (shared `components/ViewToggle.tsx`, extracted
  from `SpendDecompositionPanel`; default **Table**). TABLE = the 5-milestone date table
  (PR·PO·Delivery·Invoice·Payment). CHART = the cycle-consistency line chart.
- **Consistency line chart:** cycle days per PO, x = **order sequence by payment date**
  (integer axis, not calendar). ⚠️ **WHOLE-LINE colour = the supplier's Inconsistent flag
  verdict** (black = flagged, blue = consistent). A prior **windowed-IQR segmenting was
  BROKEN + REMOVED** — it tested a 4-order-window IQR against a full-history-calibrated
  threshold (**scope mismatch**), so flagged suppliers whose spread came from gradual
  drift showed an all-blue line under their own flag. **Do NOT reintroduce
  windowed-vs-full-history.** Unified anomaly dot (red = Outlier and/or Stage-dom, blue =
  normal; hover reveals which); rich tooltip (PO id, order #, badges, cycle, slowest, 5
  dates); own-median ref line; <3-PO "not enough POs" degradation.
- **`FLAG_TOOLTIP`** (cycle-time-types) explains the 3 flags on roster pills / anomaly
  cards / a supplier-level "Flagged Inconsistent" note above the chart.
- **Cycle stats restyled to the Supplier-Classification aesthetic** (soft `rounded-xl
  bg-card ring-1 ring-foreground/10` cards): median **delta badge with INVERTED colours**
  (slower = red/↑, faster = green/↓ vs the **population** median), a **spread chip driven
  by the Inconsistent flag** (never contradicts it), and a **speed-rank gauge**. Portfolio
  context (`CyclePortfolioContext` = population median/p25/p75 + roster medians) plumbed
  CycleTimeClient → CycleSupplierSection → panel.

⚠️ **Inconsistent flag = supplier-level, client-side, NO recompute.** In `CycleTimeClient`
(~L124): `iqrCutoff = 1.5 × median(all suppliers' full-history IQRs)`; `inconsistent =
supplier's full-history IQR > iqrCutoff`. The consistency line colour, the "Flagged
Inconsistent" note, AND the spread chip are all driven by this one `inconsistent` value,
so they cannot contradict each other. Roadmap (a)–(e) all complete; no major pending items.

### PRIOR SESSION (`3d79e24` → `a96c38e`)

**Period tagging: invoiceDate → paymentDate app-wide (`462a5ef`).** The date that
tags a PO to a period is now **`COALESCE(paymentDate, prDate)`** (was invoiceDate),
consistently across: Python `load_frames` + BOTH monthly-trend bucketings,
`transform_dataset.py` per-period metric bucketing, upload route (`periodId` write
+ year detection), `spend-overview` aggregate, all cycle-time routes
(breakdown / stage-occupancy / supplier-detail), `spend-detail` (both filters),
`evolution` bucketing, and `migrate-period-tags.ts` (default `--by` now `payment`,
`--by=pr` kept). paymentDate is non-null on all 647 POs → the `prDate` fallback
never fires. **Left untouched (not tags):** display-value `invoiceDate` returns +
the stage-occupancy stage-math boundary. Calc logic (medians, composite weights,
ABC 80/95, Kraljic median splits, `total_cycle_days = paymentDate − prDate`) is
UNCHANGED — only the per-period population shifted.
- ⚠️ **DO NOT run `migrate-period-tags.ts`** against the current per-period model —
  its `supplierMetric.updateMany({ periodId: maxYear })` collapses all per-period
  `SupplierMetric` rows onto the latest period (corrupts per-period metrics). The
  re-tag was done via a **targeted `Purchase.periodId` UPDATE** (Purchase only) +
  `python compute_analyses.py --period-id <id>` per period +
  `DELETE FROM "AnalysisResult" WHERE "periodId" IS NULL` (range-cache clear).
  (`compute_analyses.py` reads metrics by the period's date bounds, not by
  `Purchase.periodId`, so it doesn't depend on that column.)
- **Recomputed + verified (2025, paymentDate basis):** 313 POs · $283.6M · 50
  active suppliers (55 roster) · ABC A10/B9/C31 · Kraljic Strategic8 / Leverage17 /
  Bottleneck16 / Routine9 · zones Stars19 / Critical6 / HiddenGems6 / LongTail19 ·
  **control exposure $42.47M / 15.0% / 41 POs / 24 suppliers** · cycle median 31.0 /
  mean 32.58 / typical range 25–39. ⚠️ Do NOT trust Ruby's separate/larger dataset
  numbers ($30.34M / 314 POs / 54) — that's a DIFFERENT dataset in another env, not
  this DB.
- ⚠️ **`SupplierMetric` per-period rows are still invoice-year bucketed** (the
  transformer was NOT re-run — needs the enriched xlsx closed in Excel + a
  re-import). Only affects the composite basis feeding Performance zones;
  everything Purchase-derived is fully paymentDate-correct.

**Pipeline chart = whole-integer stage-occupancy + Payment series (`a0d3a2f`).**
Route `/api/cycle-time/stage-occupancy` is **LIVE** (queries Purchase per request,
NOT cached). Supervisor's rule: each of the 4 stage-gaps (PR→PO, PO→Delivery,
Delivery→Invoice, Invoice→Payment) counts a whole **+1 in EVERY window month its
span touches** (occupancy), PLUS a 5th **Payment** series (terminal milestone,
+1 in its own payment month). `StageOccupancyRow` = `pr_active / po_active /
delivery_active / invoice_active / payment`. Worked example (PR Jan1, PO Jan10,
Del Feb5, Inv Mar4, Pay Mar8) → Jan: PR,PO · Feb: PO,Delivery · Mar:
Delivery,Invoice,Payment. ⚠️ This REPLACED a brief **uncommitted "milestone
point-events" experiment that was discarded** (git restore) — the rule is
occupancy, not point-events. Labels: series "PR active … Invoice active, Payment",
y-axis "POs active", heading "…(POs active per stage, plus payments)". Population =
payment-tagged POs, so single-year has year-boundary undercount on early
milestones (range mode is clean); occupancy series exceed the PO count by design.

**Spend Overview panel "All invoices over time" → paymentDate (`420cebc`).** The
decomposition panel's PO time-chart + table now bucket money by **paymentDate**
(cash-basis, rule B); table header "Payment date". `SpendDetail.pos` gained
`paymentDate`. (This was the ONE money view still on invoiceDate.)

**Stage/tenure/date arrows "→" → "to" (`bd5f59e`, `a96c38e`).** Process Health stage
names (bd5f59e); Reports `STAGE_LABELS`, Classification card (quadrant-tenure trail
+ "Moved X to Y" + activity date range), methodology stage-stats line (a96c38e) —
all "to". ⚠️ **Value-transition arrows KEPT as "→"** (report `median A → B`,
`PerformanceTrajectory` score before→after, methodology `benchmark → neutral`,
`+8% → 5`). ✅ **RESOLVED (recompute ran 2026-07-03) — both Python recommendation
edits are now LIVE** in the cached `recommendations` (verified from a fresh DB read):
1. **Stage arrows** (`compute_analyses.py` ~L1060) → "to" (`46d6276`). Now emits
   `scope: "Stage: Invoice to Payment"` (the arrow fix only surfaces where a stage
   rec fires — Invoice→Payment mean >8 — i.e. 2024 + the full range; 2025/2026
   single-year emit no stage rec, unchanged).
2. **Audit #6 (`47ffcd9`) — `compute_analyses.py:1052`** "concentrated process
   compliance issue" → "the weakest match compliance among quadrants" (removes the
   claim that contradicted the softened dashboard control-exposure insight).
Recompute procedure used (the SAFE one — NOT the migrate-script SupplierMetric
clobber): idempotent `Purchase.periodId` re-tag (0 rows — already paymentDate-correct,
distribution **306/313/28**) → `compute_analyses.py --period-id` for all 3 periods
(exit 0, 6/6 upserted each, `computedAt` 2026-07-03 10:49) → `DELETE FROM
"AnalysisResult" WHERE "periodId" IS NULL` (24 range rows cleared; regenerates lazily
via Mode B, which also emits the new strings). ⚠️ **Aggregates byte-identical
before↔after** (same paymentDate population): **313 POs / $283,596,813.69 / 50
suppliers / ABC 10-9-31 / Kraljic 8-17-16-9 / control $42.47M (14.98%, 41 POs, 24
suppliers)** — only the recommendation strings changed. ⚠️ The `.env` has a UTF-8 BOM
on line 1, so standalone Python must load `DATABASE_URL` with `encoding="utf-8-sig"`
(or have it passed in the env, as Node does when it spawns the script).

**Process Health rename (`3d79e24`).** "Cycle Time" → **Process Health Monitoring**;
URL **`/cycle-time` → `/process-health`** (permanent redirect in `next.config.ts`).
⚠️ **`/api/cycle-time/*` API paths UNCHANGED** (only the page URL moved).

**Roster table + 3 supplier cards (`1c32b51` → `693ec16`).**
- Roster columns: **# · Supplier · Median · POs · Slowest stage · ABC · Exposure ·
  Performance · Anomalies**. Added **# rank** (unsortable, reflects current sort) +
  sortable **Slowest stage** chip; CUT the Typical-range column + the "Cycle Time
  by Supplier" bar chart (redundant with the sortable Median column; empty-state
  moved onto the table guard).
- **"Flags" renamed "Anomalies" page-wide** (`aa28fbd`/`40196ec`/`fd3c580`) — roster
  column, panel PO-table column, anomaly-cards section title + copy. Outlier /
  Stage-dom pills kept; flagged PO rows get a faint amber (`--warning` 9%) row tint.
- **Panel PO table** merged the old "flagged POs" section into the main table (one
  "Anomalies" column, no triangle icon); per-stage bars are **MEAN** (`spend_mean`/
  `portfolio_mean` from `supplier-detail`); "Exposure" label added to the quadrant
  chip.
- **All 3 supplier detail cards now share ONE identity-header pattern:**
  `name` → subline `category · ABC · Exposure(Kraljic) · Performance zone ·
  country + CountryFlag` → "Showing {period}". The **Performance positioning zone**
  (Stars / Critical Issues / Hidden Gems / Long Tail, `ZONE_COLORS`) was added to
  all three sublines — Classification (`4b37eca`, from the `perf` prop), Spend
  Overview (`68c93ef`, via new `SpendDetail.zone` populated in BOTH spend-detail
  branches), Process Health (`693ec16`, via new `CycleSupplierDetail.zone`; also
  DELETED that card's separate "Classification context" section + added
  `CountryFlag`). ⚠️ `CycleSupplierDetail.composite` is now populated-but-unrendered
  (dead — the raw perf score was intentionally dropped from that card).

### ROADMAP — all items (a)–(e) COMPLETE
- (a) ✅ **DONE — Insight-fragility audit** (`47ffcd9` / `9c3df01` / `6fbdafc`, 12
  insights fixed). Every insight/narrative surface was audited for hardcoded
  adjectives/directions that mislead on data shifts; fixed via guards /
  shape-detection / self-omit / drop. **Batch 1** (`47ffcd9`): stage-insight
  shape-detection + dropped occupancy claim, report basis label invoice→payment,
  control-exposure softened to facts-only, AD rec reword (⚠️ see recompute note
  below — #6 not yet live). **Batch 2** (`9c3df01`): cycle-glance downstream/internal
  now from live PR→PO share; spend-glance diversification cap bug (now reaches
  "broad") + "dominates" / "heavily concentrated" gated. **Batch 3** (`6fbdafc`):
  report-templates — skew direction, dropped uncomputed volatility claim, top-2
  co-dominance (single- vs two-market), concentration adjective scaled,
  value-at-risk self-omits when the critical zone is empty. Already-robust insights
  (distribution insight, classification-at-a-glance, anomaly cards, evolution
  insights, per-tab lines, ABC templates) were confirmed sound and left untouched.
- (b) ✅ **DONE (`47ffcd9`, batch 1)** — the shape-detection IS the flexible-template
  implementation (not partial). `StageInsight` (`StageBreakdownSection`) ¶2 now
  shape-detects **two-stage / single-dominant / even-spread**, ¶1's "dominates" is
  guarded, the unverified occupancy claim was dropped, ¶3 self-omits (gated on ≥2
  categories) and ¶4 branches on even-spread/external — so all four paragraphs are
  data-driven. This replaced the old fixed "one dominates, the other three are short
  and steady" story, which was the entire flexible-template goal.
- (c) ✅ **RESOLVED / N/A** — `defense.md` is a methodology doc and never contained a
  stage-duration narrative; the stale stage story was the DASHBOARD stage insight,
  fixed in (b). No doc edit needed.
- (d) ✅ **DONE (`d9b7f83`)** — the Process Health supplier-card PO table now shows all
  5 milestone dates (PR · PO · Delivery · Invoice · Payment, compact "Feb 3 '25";
  Slowest-stage column dropped for width; reconciles with cycle days).
- (e) ✅ **DONE (`46d6276` + recompute 2026-07-03)** — Action Dashboard stage arrows
  → "to" (`compute_analyses.py` ~L1060) AND the bundled audit-#6 reword
  (`:1052`, `47ffcd9`) are both LIVE after the recompute. Verified from a fresh DB
  read (computedAt 10:49, new strings present, aggregates byte-identical — see the
  "RESOLVED" recompute note above for the full procedure + numbers).

### Cycle Time page overhaul (`a919b7a` → `5c8c930`)
The Cycle Time (Process Health) **dashboard** was substantially rebuilt. ⚠️
`CycleTimeView` is **SHARED** with reports + range-compute (`ReportDocument`,
`RangeCompute`); every dashboard-only change is gated by a `showX`/prop so
**reports/range-compute pass none → render the ORIGINAL layout unchanged**. The
gates on `CycleTimeView`: `showAnomaliesTable`, `showMonthlyTrend`, `showStatGrid`,
`showStageDecomposition` (all default **true** = reports keep it), plus opt-in
`showDistributionInsight` (default false), `controlExposure`, `onOutlierClick`.

- **Naming/jargon (`a919b7a`, `42a4bbb`, `32c5323`):** "Slow POs"→**Outlier POs**;
  "Stage anomalies"→**Stage-dominated POs**; "Supplier Type"→Kraljic quadrant;
  Kraljic/Perf-vs-spend tabs + labels → **Exposure positioning / Performance
  positioning** (Kraljic cited as the framework in descriptions only; methodology
  keeps formal "Kraljic"); **IQR → "Typical range"**, **Mean → "Average"**, dropped
  the σ and `n =` stat sublabels. `useTableSort` fixed so nulls sort last + numeric
  columns stay numeric. Methodology §3.4 now documents Typical range/IQR (linear
  quantiles) + the 3 supplier flags.
- **Glance = narrative (`eaef83d`, `c8e5d15`):** "Cycle at a glance" is prose
  (lead + "Where the time goes" + "Worth noting" bullets + hint); its old KPI row
  was removed (duplicated the stat grid + flags).
- **Anomaly section (`85ed1a3`):** the 3 flag cards are **supplier-level** (Has
  outlier POs / Inconsistent / Has stage-dominated POs, muted cards) that filter
  the SINGLE roster (synced with roster filter chips; chart+table filter together);
  a **Flags** column replaced "slowest stage"; the two PO tables collapsed — PO
  detail lives in the drill-down's "flagged POs" section. Reports keep the Outlier
  POs table via `showAnomaliesTable`.
- **Stat grid + interactions (`c8e5d15`):** extracted **`CycleStatGrid`** (Median /
  Typical range / Average / Range + optional 5th **Slowest stage** card via
  `includeSlowest`, dashboard-only); flipped so the stat grid sits ABOVE the anomaly
  flags; **box-plot outlier dots are clickable** → open the same supplier detail
  panel as roster rows (`onOutlierClick`; lifted `selectedSupplierId` in
  `CycleTimeClient`).
- **Distribution insight (`67f88a2`):** dashboard-only shape lines under the box
  plot (slow-skew + one-directional-outliers, self-omitting) via
  `showDistributionInsight`; box-plot **x-axis clamped to 0** (everywhere).
- (a) **Stage breakdown merged section (`11ee645`, + `df1b2b8`/`4c000ec`):** ONE
  dashboard-only "Stage breakdown" card = **pipeline chart** (row 1) + 50/50 row of
  **decomposition table + a self-omitting 4-paragraph stage insight** (left) and
  **category stacked bars** (right). The decomposition table is **gated out of the
  dashboard's `CycleTimeView` via `showStageDecomposition={false}`** but kept in
  reports. The **pipeline chart** (`StageOccupancyChart`, route
  `/api/cycle-time/stage-occupancy`) replaced the Monthly Cycle Time Trend on the
  dashboard (trend kept in reports via `showMonthlyTrend`); it is **whole-integer
  "POs active" per stage per month on the 303 invoiceDate-tagged population** (was
  fractional/339 lifecycle-overlap — ⚠️ boundary-month undercounting ACCEPTED
  pending a supervisor decision on the 303-vs-339 population; fractional/339 version
  preserved in a spec doc). New files: `StageBreakdownSection`,
  `StageDecompositionTable` (extracted from CycleTimeView),
  `StageByCategoryChart`, `StageOccupancyChart`, `CycleStatGrid`; **deleted**
  `StageOccupancySection`.
- (b) **Period-vs-Period Comparison REMOVED (`6fc1339`):** the interactive
  date-picker widget + `ComparisonResult` + the `/api/analyses/cycle-compare` route
  + `runCycleCompare` (`lib/python.ts`) + the `--comparison-*` Python CLI path are
  all **deleted** (dashboard + reports). ⚠️ **KEPT:** `_comparison_block` + the
  default midpoint-split `period_comparison` emit + the `PeriodComparison` type —
  they still feed the **glance stability sentence** and the **report cycle-time
  narrative prose**. Cycle-time now always does the midpoint split (no CLI override).
- (c) **3-Way Match → "Control Exposure" reframe (`5c8c930`, dashboard-only):** the
  bare pass-rate table became a **spend-at-risk** card — headline **$37.1M /
  13.6% of spend / 38 POs across 22 suppliers** + a data-honest "diffuse, not
  concentrated" insight (explicitly: failures are NOT tied to payment time, supplier
  quality, or PO size — all tested null) + the quadrant pass-rate table **demoted**
  below. Powered by a new **`controlExposure` aggregate on `/api/cycle-time/breakdown`**
  (added `threeWayMatchPass` + `totalValueUsd` to its select), passed via a **gated
  optional `controlExposure` prop**; reports pass nothing → **keep the bare
  pass-rate table**.
- (d) **Mean-based "% of cycle" (`11ee645`):** the slowest-stage share is now
  `stage_mean ÷ Σ(4 stage means)` = **49%** consistently across the **glance**,
  the **Slowest-stage stat card**, and the **Stage-breakdown insight** (was
  median-based 47% on the glance/card).

### Recent work (post-Batch-6, through `3d0757a`)
- **Cycle Time modernization** (`478fc69`, `39c73b2`, `6da0708`, `ff46c9a`,
  `48366b3`): data-driven "Cycle at a glance" panel replacing the generic intro;
  3 anomaly action cards (Slow POs / Inconsistent suppliers / Stage anomalies) that
  filter + smooth-scroll to the Anomalies table or supplier roster; per-supplier
  drill-down panel with classification context; sort arrows, StatBlock density,
  card elevation, styled header; theme-aware chart colours. Thresholds: **stage
  anomaly = one stage > 60% of total cycle**; **inconsistent supplier = IQR > 1.5×
  portfolio-median IQR (Tukey)**. Stage Decomposition + per-quadrant tables at 2dp.
- **Detail-panel period-aware fixes** (`7009df1`): sub-score sparklines sliced to
  the selected year (range = all years); zero-delta renders "stable" (not "0.00 vs
  prev"); classification history is the compact TABLE on BOTH panels
  (`HistoryTimeline` DELETED); inactive-but-has-history suppliers show the
  trajectory + a `PerformanceInactiveNote` instead of "No data".
- **Spend Overview detail-panel restructure** (`45b0812`, `788fcfc`): the
  performance expand is REMOVED from this panel (performance depth lives on the
  Classification panel); 4-card KPI grid (Total spend / Invoices / Avg invoice /
  period composite, compact currency); "Spend insights" section (portfolio-rank +
  YoY-change cards, green ↑ / red ↓); identity header = plain-text classification +
  SVG `CountryFlag` (`components/CountryFlag.tsx`, `country-flag-icons`) after the
  country code; "Activity period" + "Spend detail" tabs; Annual breakdown
  deduplicated (classification arrows + perf chart dropped; spend-only insights).
- **Supplier Classification page fixes** (`3d0757a`): Recharts scatter legends
  `verticalAlign="top"` (no collision with the bottom axis label); quadrant + zone
  tables Avg performance at 2dp; `routine_risk` synthesis card harmonized to blue
  to match `--quadrant-routine`.

### Next / parked
- **Supplier Classification detail-panel parity** (next): port the rich Spend
  Overview treatment onto it — identity-header parity (plain-text ABC/Kraljic +
  `CountryFlag`), classification-specific insight cards, and the 4-card KPI grid /
  "Spend insights" / "Activity period" formatting. Data is already in scope (the
  panel fetches the same `spend-detail` + `evolution`), so it is a pure
  presentation port — no API/data change.
- **Action Dashboard period-awareness** — separate batch; do not retrofit ad-hoc.
  ✅ **LARGELY CLOSED FOR THE HUB (2026-07-13):** the Cross-Analysis Anomaly Hub is now
  fully period-aware across all 3 families — process + classification were always
  span-scoped (they read the per-period/range `perf`/`kraljic` + the span breakdown),
  and the **temporal family is now period-aware in BOTH modes** (single-year Y vs Y-1;
  see the "TEMPORAL PERIOD-AWARENESS" block at the top). **What remains:** the
  NON-hub parts of Action Priorities are already period-scoped too (the 3 ACTION_GROUPS
  bands read the selected period's `recommendations`/`cycle_time`), so there is no
  latest-snapshot staleness left on this page — the only open item is a possible
  future period-COMPARISON view for the recommendation bands themselves (e.g. "this
  rec is new vs last year"), which is a NEW feature, not a staleness fix.
- **Phase 10 polish → v1.0**: loading states, error boundaries, mobile responsive,
  README, smoke test. ✅ **VISUAL UNIFICATION — RESOLVED (2026-07-13):** a read-only
  cross-surface design audit (Spend Overview / Supplier Classification / Reports /
  Methodology vs the Process Health / Action Priorities language) found the pages
  ALREADY COHERENT — one shared design system (glance narrative, `StatBlock`,
  `cardElevation`, `color-mix` chips, `SortArrow`/`PerfBar` all originated here and are
  reused); NO unification project needed. Only one real gap (Supplier Classification
  lacked the prominent `StatBlock` KPI row) + a few trivial nits (3 flat Spend Overview
  chart cards, Methodology flat cards, 3 color literals) — all fixed in the polish pass.
  Reports is appropriately a distinct document/PDF surface (left as-is); the two
  raw-`<table>` rankings are invisible-to-users internal DRY (left as-is). **Don't
  re-litigate — the pages are unified.**

### Spend Overview redesign + polish + Supplier Evolution + ABC merge
- **`/` and `/abc-analysis` both redirect to `/spend-overview`** (renamed from
  "Overview"; ABC Analysis page deleted and merged in). Nav lost both "Overview"
  (renamed) and "ABC Analysis" entries.
- **The page is client-fetched in BOTH cached + range modes.** Server
  `spend-overview/page.tsx` resolves the period/range to a date span and renders
  `SpendOverviewClient`, which POSTs `/api/spend-overview {startDate,endDate}` →
  `{ spend_overview, abc, ranking }` (charts + ABC card + 54-row ranking). No
  server-cached fast path; brief loading spinner (same pattern as the editor).
- **Ranking data is a server-side `Purchase` aggregate** (spend / invoice count /
  avg over the span) merged with ABC class + Kraljic quadrant from the analyses +
  category — period/range-accurate. ⚠️ NOT from `spend_overview.top_suppliers`
  (which is top-10 only and lacks counts).
- **KPIs are dashboard-only** (Total spend, Total invoices, Active suppliers, Avg
  invoice value — no "Total POs", no "Avg cycle time"). They live in
  `SpendOverviewClient`, NOT in the shared `OverviewCharts` (which the report
  editor still uses unchanged; only `TopSuppliersCard` was exported from it).
- **`formatCompactCurrency()` in `lib/utils.ts`** ("$25.6M"/"$1.2K"/"$487") —
  used in the ranking table; KPIs already compact (not double-shortened); exact
  values live in tooltips + the panel.
- **Invoice-based labels** ("Invoices", "Avg invoice") everywhere in Spend
  Overview; numbers equal PO counts (invoiceDate is 1:1 non-null). `PO ID`
  columns/identifiers are NOT renamed.
- **ABC content = `AbcParetoCard`** (between Top 10 and the ranking table):
  Class A/B/C summary blocks + the reused `ParetoChart` (bars by class colour +
  cumulative-% line + 80/95 reference lines) + methodology footer. ⚠️ `AbcView`
  and `ParetoChart` are RETAINED — still imported by the shared `RangeCompute`
  (its `kind="abc"` branch is now unreachable but harmless).
- **Spend decomposition panel** (`SpendDecompositionPanel`) is a **centered
  floating card** (not a docked sidebar) — refactored onto the shadcn/base-ui
  `Dialog`/`DialogContent` primitive (`components/ui/dialog.tsx`), which owns the
  dim backdrop, fade-in + zoom-in animation, focus trap, scroll lock, and the ESC
  / backdrop-click close paths. Open is controlled by `open={!!supplierId}` +
  `onOpenChange`→`onClose` (parent always mounts it). Widened to ~680px
  (`sm:max-w-[680px]`, `max-h-[85vh]` with internal scroll) to accommodate the
  chart-driven content; header X button + DialogTitle (supplier name) retained,
  the primitive's built-in close button is suppressed (`showCloseButton={false}`).
  It is CHART-DRIVEN: Tab 1 "Spend by item" = horizontal bar chart (top 15 + Others);
  Tab 2 "All POs" = time-series bar chart; both have a "View as table" toggle
  (chart default). Tabs 1+2 are **period-scoped** via
  `/api/suppliers/[id]/spend-detail?start&end` (optional params; omit = all-time,
  backward compat) — panel totals reconcile with the clicked ranking row.
- **Evolution tab** (`/api/suppliers/[id]/evolution`, NOT period-scoped — all
  years): classification chips (ABC/Kraljic per year) + spend line + performance
  line + product-mix stacked bars + auto insights. Gap years (supplier inactive)
  render as zero/null gracefully.
- ⚠️ **RETIRED — "Performance trajectory is flat by design" is FALSE now.** The
  backend rebuild made `SupplierMetric.compositeScore` per-payment-year (delivery/
  process vary per year), and the FILTER-LIVE composite change (top session block)
  makes the displayed composite recompute per time filter. Single-year is
  byte-identical to the stored per-year value; range is a true span-aggregate. The
  composite is no longer a flat per-supplier snapshot.
- **Panel ABC/Kraljic chips** ⚠️ **SUPERSEDED** — were latest-period; now
  **period-scoped** (see "Panel consistency + data integrity batch" below). The
  Evolution tab still shows the full per-year trajectory.
- **Report editor unchanged**: it keeps its own ABC section and `OverviewCharts`;
  dashboard→report propagation is deferred (`dashboard_report_propagation.md`).

### Spend Overview design unification + insights panel
- **`StatBlock` primitive (`components/ui/stat-block.tsx`)** — the single stat
  callout (`Card` container, sentence-case `label`, `font-semibold` value,
  optional `sublabel`, `accent` left-border, `size` default/`lg`). Replaced THREE
  divergent patterns: KPI cards (now `lg`), ABC class boxes (`accent`
  destructive/warning/success), and the panel header stats. Lives in
  `components/ui/` for reuse on future merges (e.g. Supplier Classification).
- **Chart colours are CSS vars (Approach A).** `lib/chart-colors.ts` now holds
  `var(--chart-1..8)` / `var(--abc-*)` / `var(--quadrant-*)` / `var(--zone-*)`
  instead of hex; the tokens are defined in `app/globals.css` for **both** light
  (values preserve the prior hardcoded hex — light mode unchanged) and dark
  (brightened ≈Tailwind *-400). ⚠️ Recharts resolves `var()` in `fill`/`stroke`
  (verified in-browser). Charts now adapt to dark mode app-wide. The Pareto
  cumulative line uses `var(--chart-line)` (was `#334155`).
- ⚠️ **Hex-alpha concatenation (`${color}22`) breaks with CSS vars** — replaced
  with `color-mix(in srgb, ${color} 13%, transparent)` at the badge tints in
  `SpendDecompositionPanel` AND (compat-only, appearance-preserving) the report
  editor's `SupplierDetailPanel` `Pill`. This is the one report-editor file the
  batch touched, and only to keep it rendering identically after the constant
  migration.
- **Number formatting — "tooltips local" (user ruling).** Dashboard-only surfaces
  (KPIs, `InsightsPanel`, ranking) use `formatCompactCurrency` (the canonical
  compact formatter); the duplicate `Intl` `usdCompact` was removed from
  `SpendOverviewClient`. ⚠️ The **shared chart components keep `usdCompact`** so
  report tooltips stay byte-identical (they render in `ReportDocument`); the
  decomposition panel keeps `usd0` (exact) since it's the exact-values surface.
  *(Deferred: when the report editor is synced, reconcile report-chart tooltips —
  the intended report convention is FULL numbers. There is no
  `dashboard_report_propagation.md` file in the repo yet; this note records it.)*
- **`InsightsPanel` (`components/SpendOverview/InsightsPanel.tsx`)** — consolidated
  analytical summary at the TOP of the page (below title, above KPIs), in a `Card`
  titled "Spend at a glance". Three sections (scale+concentration paragraph,
  "Where the money goes" category/top-supplier paragraph, "Patterns worth noting"
  bullets) + an italic closing hint. Computed CLIENT-SIDE from already-loaded
  `spend_overview` + `abc` + `ranking` (no new API/Python). **Period-aware**:
  `periodPhrase()` renders "from 2024 to 2026" (range) vs "in 2026" (single year),
  threaded via new `periodLabel`/`isRangeMode` props from `page.tsx`
  (`isRangeMode = source.kind === "range"`). Top-supplier invoice count is joined
  from `ranking` by `supplier_id` (not in `top_suppliers`). ⚠️ The "supplier
  consistency across periods" idea from the spec was **replaced with an in-span
  spend-concentration bullet** (suppliers to reach 50%/80%) — per-period
  decomposition isn't in the loaded aggregate and new fetches were out of scope.
  Gated on `data.abc` (skips gracefully in any abc-less mode).
- **Per-section card descriptions REMOVED** (Monthly Spend Trend, Pareto/ABC, All
  Suppliers) — the InsightsPanel now carries all context. Spend-by-Category and
  Top-10 already had none.
- **Typography unified**: panel `DialogTitle` uses `CardTitle` styling
  (`font-heading font-medium`, not the old `font-semibold` override); all
  `uppercase tracking-wide` labels (panel header stats + Evolution-tab headers)
  are now sentence case.

### Spend Overview visual polish (follow-up)
- **`StatBlock` density + coherence.** It now sets explicit padding (`p-3`
  default / `p-4` `lg`) — `Card` only applies `py`, so without this the content
  was flush to the horizontal edges. Tight top-aligned stack (no
  `justify-between`); `lg` is the same component a notch larger. KPI cards carry
  period-aware **sublabels** ("from 2024 to 2026" / "in 2026", "N.N per supplier",
  "across N categories", "per invoice") via `periodPhrase()` in
  `SpendOverviewClient` (mirrors `InsightsPanel`'s).
- **Category colours are a SEPARATE family.** `CATEGORY_COLORS` (`var(--category-1..8)`,
  defined in `app/globals.css` light+dark) — deliberately blues/violets/cyans/
  magentas with **no** red/amber/lime/green, so the Spend-by-Category donut never
  collides with `--abc-*` (Class C lime) or `--quadrant-*`. ⚠️ Only
  `SpendByCategoryChart` uses it; `CHART_COLORS` is unchanged and still used by the
  other series (Top 10, trends, panel). The panel's product-mix stacked bars still
  cycle `CHART_COLORS` (left as-is — not the donut).
- **Top 10 supplier labels are theme-aware.** `TopSuppliersChart` uses a custom
  `SupplierNameTick` (`fill="var(--foreground)"`) instead of Recharts' hardcoded
  `#666` (which didn't adapt to dark mode). The **pinned** supplier's label is
  highlighted (`var(--primary)` + weight 600) so the cross-chart pin reads on the
  label, not just the bar. (No actual "pink labels" bug was found in `0820996`;
  this applied the decision's stated remedy — theme-aware default + distinct
  pinned — which also fixes dark-mode legibility.)

### Supplier ranking table polish (follow-up)
- **No internal scroll** — the `max-h-[640px] overflow-y-auto` wrapper was removed;
  all 54 rows render at natural height and the page scrolls.
- **Page-sticky column header** — `sticky top-0 z-10` is on the `<th>` cells (with
  `bg-card` + `border-b`). ⚠️ The card must be `overflow-visible`: the `Card`
  primitive's default `overflow-hidden` establishes a scroll-container that would
  trap `position: sticky`. The page `Header` is NOT sticky (it scrolls away), so
  `top-0` pins to the viewport — no header offset needed.
- **ABC + Kraljic are `color-mix` chips** (`rounded-md px-2 py-0.5 text-xs`,
  `var(--abc-*)` / `var(--quadrant-*)` tint at 12% + full-intensity text) instead
  of bare colored letters/words. ABC chip = just "A"/"B"/"C"; Kraljic chip = full
  quadrant name.
- **Row-click only** (no per-cell handlers exist) — every cell opens the panel via
  the `<tr>` onClick. Categorical cells are plain `--foreground` text (Category was
  `text-muted-foreground`) with NO link affordance; `py-3` rows, `hover:bg-muted/40`,
  selected row keeps `ring-inset`. Numeric columns were already right-aligned.

### Supplier ranking + detail panel + sidebar (follow-up)
- **Kraljic + Tier columns removed** from the ranking table → 7 cols (`# ·
  Supplier · Category · Total spend · Invoices · Avg invoice · ABC`). `kraljic_quadrant`
  stays in the row data, just unrendered; the `SortKey` member + `QUADRANT_COLORS`
  import were dropped from the table.
- **Detail-panel header is now a 3-section supplier profile** — each a `border-b
  p-4` block with a sentence-case `text-sm font-medium text-muted-foreground`
  subheader: **"Spend at a glance"** (3 StatBlocks) · **"Performance &
  classification"** (Performance-score StatBlock + ALWAYS-on ABC + Kraljic chips
  via a shared `Chip` helper — `rounded-md` color-mix 12% tint, null → muted "—"
  placeholder) · **"Activity"**. The old single stats+chips block is gone.
  ⚠️ The tier-mismatch badge that once lived here was **REMOVED** (data-integrity
  batch); the perf StatBlock is labeled "out of 100 · latest snapshot".
- ⚠️ **`spend-detail` route** — `performanceScore` (= `SupplierMetric.compositeScore`)
  in `SpendDetail.supplier`; ABC/Kraljic are **period-scoped** via
  `getRangeAnalyses(start,end)` (NOT latest-period — superseded). `calculatedTier`
  / `tierMismatch` were removed from the SELECT and the type.
- **Sidebar is collapsible** (`components/Sidebar.tsx`): chevron toggle at top,
  `w-60`↔`w-16`, `transition-[width] duration-200`, labels hidden when collapsed,
  `title`-attribute tooltips (no `Tooltip` primitive exists in the repo). State
  persists in `localStorage["dashboard_sidebar_collapsed"]`, read via
  **`useSyncExternalStore`** (server snapshot = expanded) — this both avoids the
  lint-banned set-state-in-effect and stays hydration-safe. Content area
  auto-expands (sidebar is `shrink-0`, `<main>` is `flex-1` — no `ml` math).
  ⚠️ The width transition is throttled in hidden preview tabs (measure with
  transition disabled to verify the 240/64 px target).

### Score Methodology Architecture (methodology rebuild)
- **All five sub-scores are code-derived in `scripts/transform_dataset.py`**
  from raw operational inputs — the transformer (not the xlsx) is the source of
  truth for every derived value. It is **fully deterministic — no `rng` / no
  Gaussian noise anywhere**.
- ⚠️ **Two-file schema (xlsx cleanup).** The dataset is split into two committed
  workbooks under `data/raw/`:
  `procurement_data_raw.xlsx` = **input**, operational measurements only (NO
  derived score columns), the source of truth for raw data; and
  `procurement_data.xlsx` = **output**, raw columns + the 8 computed scores,
  **regenerated each transformer run** and the file the import route reads.
  **Flow: raw xlsx → transformer → enriched xlsx → import → DB.** The transformer
  reads `RAW_XLSX`, **strictly rejects** any of the 8 derived columns in the raw
  input (`DERIVED_COLS`, clear abort message), computes, and writes `XLSX`. The
  import zod schema still requires the derived columns, so it reads the enriched
  output — unchanged.
- ⚠️ **CURRENT COMPOSITE MODEL (`aca864c`) — this supersedes the pre-`aca864c`
  formulas/stats in this section. `python/scores.py` is the source of truth.**
  Composite = **`0.30·Quality + 0.30·Delivery + 0.22·Process + 0.18·Risk`** (4
  dimensions — the **Service dimension was DROPPED**; its 15% redistributed
  proportionally, priorities unchanged). All 2dp.
  - `quality  = (norm_low(defect_rate_pct,0,10) + norm_low(complaint_rate_pct,0,100))/2`
    — **per-PO derived + filter-live**: defect_rate = Σdefect_count/Σqty·100,
    complaint_rate = orders-with-≥1-complaint / num_pos·100 (0–100). NOT survey
    constants.
  - `delivery = (norm_high(on_time_delivery_pct,0,100) + norm_low(avg_lead_time_days,0,60))/2`
  - `process  = norm_high(three_way_match_pct,0,100)`
  - `risk     = 100 − (0.6·country_distance + 0.4·roster_concentration)` — **purely
    STRUCTURAL, higher = SAFER**. country_distance = ID 0 / ASEAN 30 / Asia-Pacific
    60 / other 100. **NO complaint term** (dropped — double-counted Quality), **NO
    single_source flag** (replaced by the continuous roster-concentration measure,
    the same signal Kraljic's supply_concentration uses, scaled 0–100).
- **Fixed industry bounds** (NOT population min/max) so scores are stable when data
  changes; `norm_high/norm_low` clamp to [0,100]. ⚠️ **The formulas + rebuild stats
  BELOW are the PRE-`aca864c` transform_dataset.py-era model (5 dims incl. Service,
  single_source in risk, weights 0.25/0.25/0.15/0.20/0.15) — kept as history, NOT
  current.** On the old model: `risk_score` fix corrected a polarity bug and the
  rebuild shifted composites (mean ~68→76). `calculated_tier` + `tier_mismatch` were
  REMOVED (data-integrity batch); the transformer no longer computes them.
- **`scripts/transform_dataset.py` logs an old-vs-new diff** (summary + buckets +
  top-5/score + tier crossings + mismatch flips) and saves the full diff to
  `scripts/score_rebuild_diff.json` (**gitignored**, intermediate). ⚠️ The diff
  baseline is the **PREVIOUS enriched output** (`procurement_data.xlsx` read
  before overwrite), not the raw input — on a first run with no prior output the
  diff is skipped. It prompts before overwrite when interactive; auto-proceeds
  when stdin is piped.
- ⚠️ **The transformer writes the xlsx only — the DB is refreshed by re-importing
  via `/api/imports/upload`** (admin), which re-runs the Python analyses. ABC /
  Kraljic are spend-based → unchanged; Performance-vs-Spend zones + Action recs
  recompute from the new composite (expected).

### Panel consistency + data integrity batch
- **Tier mismatch REMOVED entirely** (unreliable: 45% fire rate, uncorrelated
  with composite). Dropped from: Prisma `SupplierMetric` (migration
  `remove_tier_mismatch` drops `calculatedTier` + `tierMismatch`), the transformer
  (no compute; `DERIVED_COLS` now 6), the enriched xlsx, the upload zod, the
  `SpendDetail` type, the detail panel badge, the methodology page, and these docs.
- **ABC + Kraljic chips are now PERIOD-SCOPED** (revises the old "latest-period"
  Decision F). `spend-detail` sources them via **`getRangeAnalyses(start,end)`** —
  the SAME function the ranking uses — so the panel chips and the ranking table's
  ABC column always agree for the selected period. Absent from the period → `null`
  → "—". (No-span fallback: latest period, backward-compat.)
- **Performance score stays a single snapshot** (`SupplierMetric.compositeScore`,
  tagged latest period) — labeled **"out of 100 · latest snapshot"** in the panel
  so its non-period scope is explicit (true per-period perf needs per-period
  operational metrics, deferred).
- **The ranking table lists ALL suppliers** (`SupplierMetric` roster, not just
  in-period ones). Suppliers with no period activity get `inactive: true`, render
  **muted (`opacity-50`)** with "—" for spend/invoices/avg, ABC "—", ranked last
  (sort by spend desc). Still clickable → panel shows the honest absent view.
  ⚠️ `InsightsPanel` concentration math filters to `!inactive` so $0 rows don't
  inflate the long-tail count.
- **Absent-supplier detail panel:** spend stats "—", Activity "No activity in this
  period", chips "—", Spend-by-item/All-POs tabs show empty states; Evolution
  (all-years) still renders. `spend-detail` returns **200 with zeroed stats** for
  an existing-but-inactive supplier (404 only for a genuinely unknown id) — the old
  misleading "Supplier not found" no longer fires for real suppliers.
- **PT Gunung Raja Paksi (S101) is no longer a phantom** — 7 reconciled Local-Steel
  POs added to `procurement_data_raw.xlsx` (spread 2024–2026); its SupplierMetric
  operational aggregates (otd/twm/lead/cycle/spend/npos/avg) are DERIVED from those
  POs (preserving the "aggregates == purchase-derived rates" invariant), soft
  metrics (defect/complaints/rfx/response/single-source) set to spec values.

### Cycle Time reframe (Batch 5)
- **`automation_period` column NO LONGER EXISTS** — dropped from the xlsx,
  `transform_dataset.py`, Prisma schema, DB (migration
  `remove_automation_period`), upload route, and Python. The synthetic data's
  one-time pre/post automation label was analytically brittle over time.
- **Cycle Time is ONE analysis type, renamed `hypothesis` → `cycle_time`.** It
  emits process-health monitoring (monthly trend + trailing 3-mo rolling avg,
  median/IQR distribution, stage decomposition, Z-score anomalies at **> 2σ above
  the mean**, per-quadrant cycle descriptives, 3-way-match pass rates) **plus** a
  default midpoint-split `period_comparison` (two-sided Mann-Whitney U +
  rank-biserial r). Metric = **`total_cycle_days`** (was invoice-to-payment).
- **`/api/analyses/cycle-compare`** computes custom date-range comparisons
  on-demand (Mode B + `--comparison-*` flags via `runCycleCompare`); **not
  cached**, returns only the `period_comparison` block.
- **`cycle_by_quadrant` + `three_way_match_by_quadrant` are single-population
  descriptives** (pre/post split dropped). 3-way match now reports
  `pass_rate_pct` + `is_worst` (was `fail_rate_pct`).
- **6 statistical methods**: time-series descriptives, distribution/IQR, stage
  descriptives, Z-score anomalies, Mann-Whitney U, rank-biserial r.
- Box plot is **hand-composed SVG** (`CycleTimeBoxPlot`, single-population +
  outlier dots) — Recharts has no native box plot, matching the codebase's
  existing approach. Deleted dead charts: `CycleTimeHistogram`,
  `StageBreakdownChart`, `CycleByQuadrantChart`.

### Chart interactions (Batch 6b)
- **`supplier_id` is the stable cross-chart identity key.** Python now emits it
  in `cycle_time.anomalies`, `spend_overview.top_suppliers`, **and**
  `spend_overview.top_suppliers_by_category` (`CycleAnomaly.supplier_id` +
  `TopSupplier` types, both required). ⚠️ **Any emitter output-shape change
  requires the full Python-first workflow**: recompute Mode A for every period
  THEN `DELETE FROM "AnalysisResult" WHERE "periodId" IS NULL` (clear the range
  cache) — otherwise the editor serves stale cached rows without the new field
  and interactions break silently.
- **Single cross-chart pin** lifted into `ReportEditor` (`pinnedSupplierId`),
  shared via an **OPTIONAL** React context `components/Reports/PinContext.tsx`
  (no-op defaults). Only `ReportEditor` mounts the `PinProvider`; charts read it
  via `usePin()`/`useIsPinned()`, so the standalone dashboard pages (which mount
  no provider) render exactly as before. Pin clears on period change (render-time
  `spanKey` compare, NOT an effect — the eslint config bans both
  set-state-in-effect AND ref-access-during-render).
- **Tooltip = HYBRID, by design.** Recharts charts keep their **native** Recharts
  `<Tooltip>` (HTML overlay, not SVG-clipped); only the hand-composed SVG box
  plot uses a cursor-following body-portal tooltip
  (`components/charts/PortalTooltip.tsx`). A single unified global tooltip was
  rejected because the chart components are shared with provider-less dashboard
  pages — routing tooltips through a context `showTooltip` would make them vanish
  there. Native tooltips satisfy the no-SVG-clipping intent everywhere.
- **Detail panel** = `SupplierDetailPanel` right-side slideout (~320px) over the
  report area only (left settings sidebar stays usable). Content assembled by the
  pure `lib/supplier-detail.ts` `buildSupplierDetail()` from loaded analyses +
  `supplierCategory` + `getSupplierDirectory()` (country + numPos snapshot).
  Anomaly-dot click reuses this panel (no separate modal).
- **Cross-chart highlight is REPORT-SCOPED.** It works across the charts/tables
  actually present in the report document: Top Suppliers bars, cycle box-plot
  anomaly dots, ABC table rows, Action Dashboard recommendation cards. ⚠️ The
  **Kraljic scatter, Performance scatter, and Pareto charts are NOT in the
  report** (it renders TABLES for those analyses) — those chart components are
  wired for pinning but **DORMANT** (they live only on standalone dashboard
  pages). Making "pin in Kraljic → ring in Performance" real is a future-batch
  task (embed those charts in `ReportDocument`, or add a provider to the
  dashboard pages). `/reports/[id]` (persisted reports) has no provider → no
  interactivity, unchanged (backward compat).

### Navigation polish (Batch 6c)
- **Sparkline data comes from the monthly_trend emitters.** Python now emits
  `po_count` in `spend_overview.monthly_trend` and `median_cycle_days` in
  `cycle_time.monthly_trend` (both **optional** types for pre-6c cached rows).
  ⚠️ Adding these required the full Python-first workflow (recompute Mode A for
  every period THEN clear the range cache — see [[batch6b-supplier-id-emitters]]).
- ⚠️ **PDF export is NATIVE `window.print()` + `@media print` (updated 2026-07-13 —
  `c605fd7`; html2canvas/html2canvas-pro/jspdf REMOVED).** `DownloadPdfButton` just
  calls `window.print()`; the print layout lives in the `@media print` block in
  `app/globals.css` (hide chrome via `.no-print`/`aside`/`header`/`[data-slot=select-trigger]`,
  `sticky`→`static`, `print-color-adjust:exact`, real 1px card borders — cards define
  via a non-printing `ring`, `break-inside:avoid` on cards/tables/charts, `@page` A4).
  Real selectable text + vector charts — no bitmap rasterisation.
- ⚠️ **Collapsed section bodies reveal in print via the `.hidden` CLASS + `print:flex`,
  NOT the `hidden` ATTRIBUTE.** The native `hidden` attribute can't be overridden by an
  author print rule (even a same-specificity `@media print { .export-reveal { … } }`
  loses — only inline style wins; verified in-browser), so `ReportSection` renders
  `export-reveal … print:flex` + `hidden` (class) when collapsed. (The old html2canvas-era
  "strip the `hidden` attribute in JS then capture" hack is GONE.)
- ⚠️ **The embedded (report) `OverviewCharts` STACKS its three charts — it no longer
  TABS them.** Recharts never sizes a chart inside a `display:none` tab, so a tabbed
  inactive chart (the by-category donut, top-suppliers) printed BLANK. Stacking mounts
  all three → complete PDF + WYSIWYG editor preview. The dashboard Spend Overview page
  (which doesn't use this branch) is unaffected.
- **`ReportDocument` is keyed by `spanKey` in `ReportEditor`** so it remounts on
  period change, resetting all per-session local UI state (section collapse,
  active Spend-Overview tab, TOC active section). No reset effect needed.
- **All 6c chrome is gated on the `embedded` prop** (TOC, sticky headers,
  collapse chevrons, KPI sparklines). *(The Spend-Overview tab switcher was REMOVED
  2026-07-13 — embedded charts now stack; see the PDF note above.)* `/reports/[id]`
  renders `ReportDocument` without `embedded` → static immutable view, unchanged.
- **Sticky stack:** `ReportTOC` is `sticky top-0`; section headers are
  `sticky top-9` (below the TOC). TOC active section uses an IntersectionObserver
  scroll-spy. Sidebar width animates via `transition-[width] duration-150`.
- ⚠️ **Environment artifact (testing note):** CSS transitions and
  IntersectionObserver are throttled in hidden/headless preview tabs
  (`document.visibilityState === "hidden"`). Frame-dependent behavior (sidebar
  slide, TOC scroll-spy highlight) is correct but only observable in a VISIBLE
  browser — don't mistake the throttling for a bug.

### Architecture facts (current as of 11F)
- **Period tagging uses invoice date** with PR-date fallback, i.e.
  `(invoiceDate ?? prDate).year`. Python `load_frames` filters by
  `COALESCE(invoiceDate, prDate)`. This surfaces a **2026** period.
- **Default landing is Range mode (all years)**, not single-year latest
  (`getCurrentPeriodSelection` fallback in `lib/period.ts`).
- **`AnalysisResult` has nullable `periodId` + `rangeStartDate` + `rangeEndDate`.**
  Single-year rows set `periodId`; range cache rows set the dates. **Two separate
  unique constraints** (`[periodId, analysisType]` and `[rangeStartDate,
  rangeEndDate, analysisType]`), NOT one 4-column — a single nullable 4-col
  unique would not enforce uniqueness (Postgres NULLs are distinct).
- **Range results are cached** in `AnalysisResult` (computed once, then read);
  the range cache (`periodId IS NULL` rows) is **invalidated on re-upload**.
- **Reports use `ReportConfig`** (`lib/report-config.ts`): ⚠️ **REBUILT 2026-07-14 to
  FOUR fields** — `focus` (portfolio / supplier / category), `period`, `detailLevel`
  (brief/standard/detailed = the "Length" question), `sections` (the appendix
  "Attach evidence" toggles) + **3 tones** (the demoted "Draft voice"). The old
  `recommendationFilters` / `filters` / `filterScope` fields were REMOVED (dead /
  appendix-only). See "REPORT SETTINGS PANEL REBUILT". `normalizeReportConfig` maps
  old persisted configs forward.
- **Tone variants are applied at RENDER time** (`ReportDocument` picks
  `TEMPLATES[tone][section]` for the appendix; the argument + brief prose are
  tone-aware in `lib/report-narrative.ts`), not baked. *(The old "filter philosophy =
  visibility-only" row-hiding is GONE with the category filter — the appendix renders
  the full population.)*
- **Single-year reports persist** (`ExecutiveSummary` + `/api/reports/generate`);
  **range reports are never saved** — they render live in the editor at `/reports/preview`
  (`ReportEditor` fetching `/api/reports/analyses`). *(The old `generate-ephemeral` route +
  the `EPHEMERAL_KEY`/`sessionStorage` hand-off were dead code and were DELETED 2026-07-13.)*
- **`generate_dataset.py` does NOT exist in this repo.** The synthetic dataset
  was generated externally; **`scripts/transform_dataset.py`** is the
  deterministic transformer (seed 42) that produced the current
  `data/raw/procurement_data.xlsx` (risk_score/single_source fixes).

### Kraljic decisions (from Phase 11)
- **Supply Risk Score** (reworked `57097d7`) = `supply_concentration(≤50) + cost_premium(≤25) + import_friction(≤25)`, caps sum to 100 (clip is a no-op). Replaced the old `single_source(30)+category_competition(30)+country_distance(20)+switching_cost(20)`.
  - **supply_concentration** (≤50): roster-derived step on the # of OTHER suppliers in the same category, counted against the **FULL roster** (all known suppliers, active or not — A1; falls back to period-scoped size only if the roster map is unset) — `0→50, 1→35, 2→22, 3→12, 4→5, ≥5→0`. MERGES the former single_source flag + category_competition (the stored single-source flag contradicted the roster for ~91% of flagged suppliers AND double-counted with competition).
  - **cost_premium** (≤25): period-scoped item-price premium. Per item, benchmark = spend-weighted avg unit price across ALL its suppliers; supplier premium = its spend-weighted avg unit price / item_avg − 1, counted ONLY when supplier×item ≥2 POs AND the item has ≥2 suppliers (single-source items → neutral); `clip(premium × 62.5, 0, 25)`; at/below market → 0.
  - **import_friction** (≤25): Indonesia trade-agreement coverage (NOT geographic distance) — `ID→0 / AFTA→8 / RCEP-non-ASEAN (JP,KR,CN,AU,NZ)→16 / else→25` (explicit safe default).
  - ⚠️ Emitted as `risk_components` per `quadrant_assignment` (each 2dp; total == `supply_risk_score`, reconciles with the detail-panel breakdown bars). ⚠️ DISTINCT from the **performance composite's `risk_score` sub-score** (`scores.py`, now `100 − (0.6·country_distance + 0.4·roster_concentration)` — structural only, NO complaints, NO single_source; changed in `aca864c`) — same word "risk", different metric; don't conflate. Both share the roster-concentration signal.
- **Kraljic quadrants** = median split on `log_spend` × `supply_risk_score` (Strategic = hi/hi, Leverage = hi-spend/lo-risk, Bottleneck = lo-spend/hi-risk, Routine = lo/lo).
- **Performance score** = the composite. ⚠️ **UPDATED — now filter-live** (see the
  top session block): `compute_analyses` recomputes it from the filtered POs via
  `scores.build_window_metrics` per period/range (was: read `SupplierMetric.compositeScore`
  as-is, latest-snapshot for range). Single-year is byte-identical to the stored value.
- Per-period quadrant data lives in `AnalysisResult.kraljic`; `SupplierMetric.kraljicQuadrant` is a last-period-wins convenience snapshot (not period-accurate).
- **Quadrant colours** (anti-drift — resolved from `app/globals.css`, light / dark):
  Strategic `#ef4444` / `#f87171` (red), Leverage `#10b981` / `#34d399` (green),
  Bottleneck `#f59e0b` / `#fbbf24` (amber), Routine `#3b82f6` / `#60a5fa` (blue).
  ⚠️ The `routine_risk` synthesis card (`lib/supplier-classification.ts`, Tailwind
  classes) matches `--quadrant-routine` (blue) as of `3d0757a` — the other 3
  synthesis cards already echo their quadrant hues; keep all four aligned.

### Key files added in 11F
- `scripts/transform_dataset.py` — one-off dataset transformer (DQ fixes, seed 42).
- `scripts/migrate-period-tags.ts` — re-tag purchases by invoice year (reversible: `--by=pr`).
- `lib/report-config.ts` — `ReportConfig` type (focus/period/length/sections/tone),
  defaults + `normalizeReportConfig` (rebuilt 2026-07-14).
- `lib/report-narrative.ts` — the argument model + `renderSupplierBrief` /
  `renderCategoryDeepDive` (the Focus-mode prose).
- `lib/report-focus.ts` (server-only) + `lib/report-focus-types.ts` (client-safe) —
  the read-only supplier-focus assembler (item breakdown + trajectory).
- `lib/range-analyses.ts` — `getRangeAnalyses()` cache-or-compute helper.
- `lib/suppliers.ts` — `getSupplierCategoryMap()` / `getCategories()`.
- `components/Reports/ReportDocument.tsx` — shared config + tone-driven report renderer
  (branches on `config.focus`: portfolio argument / supplier brief / category deep-dive).
- ⚠️ `CustomizeReportModal.tsx` + `ReportGenerator.tsx` **NO LONGER EXIST** — the report
  UI is the always-on `components/Reports/ReportEditor.tsx` + `ReportEditorSidebar.tsx`
  (rebuilt 2026-07-14 into the FOUR-QUESTION panel; no launcher modal). ⚠️
  `lib/report-pills.ts` + `app/api/report-presets/*` were also DELETED in that rebuild.
- ⚠️ `app/api/reports/generate-ephemeral/route.ts` — **DELETED 2026-07-13** (was dead code;
  the editor's range preview uses `/api/reports/analyses`). The `EPHEMERAL_KEY` /
  `sessionStorage` hand-off it implied is gone too.
- `app/(dashboard)/reports/preview/page.tsx` — in-memory range report viewer.
- `prisma/migrations/.../add_range_cache_columns/` — nullable periodId + range columns.

### Critical gotchas

> ⚠️ **HIDDEN-PREVIEW-TAB ANIMATION THROTTLING — a phantom "stuck modal", not a bug.**
> When the in-app browser/preview tab loses focus (`document.visibilityState ===
> "hidden"`), the browser THROTTLES/FREEZES CSS animations. base-ui's `Dialog`
> unmounts a *closed* dialog on `animationend` — which never fires while frozen — so a
> dialog you just closed can LINGER in the DOM (`role="dialog"` still present, its
> backdrop stuck at `opacity: 1` with `data-closed`, or a just-opened one frozen at
> `data-open` `opacity: 0`). ⚠️ **This looks exactly like a stuck/broken modal or a
> double-scrim, but it is an ARTIFACT of the throttling, not a real stuck-modal bug —
> DON'T chase it.** Confirm by reading `document.visibilityState` (if `"hidden"`, the
> exit animation is simply frozen); the React open-state is correct. Verify dialog
> open/close by the state logic + atomic DOM presence (e.g. a ✕-click that *unmounts*
> the element), not by watching the fade complete — animation completion is not
> observable in a hidden tab. (Same root cause as the sidebar-width / TOC-scroll-spy
> throttling notes elsewhere in this file.)

> ⚠️ **CRUD REWORK (2026-07-13) — the four CRUD gotchas immediately below are
> SUPERSEDED in the parts noted here; read this first.**
> - **EDIT REMOVED (governance).** ⚠️ **STALE for SUPPLIER as of the normalized model —
>   `PATCH /api/suppliers/[id]` EXISTS, works, is fully audited (one
>   `SupplierChangeLog` row per changed field) and recomputes. It simply has NO UI
>   caller** (no `method: "PATCH"` anywhere; the roster offers only the status
>   toggle), so supplier edit is reachable by API only. The PURCHASE PATCH is still
>   gone. The rest of this bullet stands. Original note: the supplier + purchase
>   **PATCH handlers are DELETED**, and the Pencil/edit buttons + edit dialogs are
>   gone (both `Add*Card`s
>   are now add-only). Defensible line: transactional records can be **added or
>   removed, never silently ALTERED** (no in-place edit without an audit trail). So
>   "Supplier/Purchase edit/delete recomputes…" (Batch A/B below) is now **DELETE-only**
>   — the edit half of those bullets, incl. the supplier re-point + name-only-skip +
>   derived-field-recompute-on-edit, no longer exists.
> - **CREATE NOW RECOMPUTES (integrity).** `POST /api/suppliers` **and** `POST
>   /api/purchases` now call `recomputeAllPeriods()` synchronously after the insert —
>   so a manual add is reflected in EVERY analysis immediately (verified: add supplier
>   → all periods recompute + range cache cleared; add purchase → its spend appears in
>   the cached spend_overview/ABC). This **REVERSES** the "manual add does NOT
>   recompute / stays byte-identical" claims in Batch 2 + Batch 3 below. (The Batch-2
>   delete-then-insert-wipe-on-reimport note + the Batch-3 derived-field COMPUTE note
>   still hold.)
> - **FAILURES ARE HONEST (create AND delete).** On ANY period's recompute failure the
>   route returns a real **500** (not `success:true` + a soft `recomputeWarning`), and
>   the **range cache is NOT cleared** on failure (`deleteMany` gated on
>   `failedPeriods.length === 0`). A **60s per-period timeout** was added
>   (`runComputeAnalyses(periodId, timeoutMs?)`; the bulk-import caller omits it →
>   unchanged). `recomputeWarning` is gone from every route + client.
> - ⚠️ **NO ROLLBACK ON CREATE FAILURE.** If the insert succeeds but the recompute
>   fails, the row **persists** (not rolled back) and the 500 tells the admin to
>   re-import — same as delete (which can't un-delete). So a create-then-recompute-fail
>   leaves a row that isn't in the analyses until a full import.
> - **UNCHANGED:** add + remove (single + batch) + the bulk import all stay; the bulk
>   import is still the source of truth; `lib/recompute.ts` stays (now used by create +
>   delete); analyses/anomaly-hub/pure-libs/Python untouched.

- **Manually-added suppliers are replaced by a full re-import (Batch 2).** The
  add-supplier card (`POST /api/suppliers`, one INSERT tagged to the LATEST
  period, no analyses recompute) writes a `Supplier` row that the bulk import's
  per-period delete-then-insert will wipe on the next re-import of that period.
  Inherent to delete-then-insert; manual adds are supplementary, the bulk import
  is the source of truth. Single-create reuses the shared
  validation/id-gen/mapper in `lib/supplier-import.ts`.
- **Manually-added purchases don't feed the cached scorecards until a reimport
  (Batch 3).** The add-purchase card (`POST /api/purchases`, one INSERT tagged to
  the PAYMENT-year period, no analyses recompute + no range-cache clear) writes a
  `Purchase` row so cached scores stay byte-identical. The new PO shows only in
  Purchase-derived LIVE views (Spend-Overview ranking spend, the supplier's
  spend-detail "All invoices") until a full reimport of its period recomputes the
  scorecards. ⚠️ The bulk import reads `total_value_usd` + all `*_days` verbatim
  from the file (the synthetic total is deliberately NOT qty×price); a manual add
  COMPUTES them via `lib/purchase-import.computeDerivedFields`
  (`total = round(qty×price, 2)`, cycle-days = exact date diffs).
- **Supplier edit/delete recomputes via `lib/recompute.ts`, but stored
  `SupplierMetric` scores lag until a reimport (Batch A).** `PATCH`/`DELETE
  /api/suppliers/[id]` + `POST /api/suppliers/batch-delete` mutate the `Supplier`
  row (edit also syncs denormalized `supplierName`/`category` on `Purchase` +
  `SupplierMetric`) then call `recomputeAllPeriods()` (the import recipe:
  `runComputeAnalyses` per period + clear the range cache — NOT the migrate-tags
  script). That refreshes the `AnalysisResult` cache and the pages' LIVE composite,
  so Spend/Classification/Process-Health/Action-Dashboard show correct new numbers.
  ⚠️ **THE LAST OPEN DATA-INTEGRITY HOLE (re-anchored 2026-07-13 — edit is gone, so
  the trigger is now CREATE/DELETE, not edit).** Recompute refreshes `AnalysisResult`
  but does NOT rewrite the stored per-period `SupplierMetric` **sub-scores / composite**
  — those refresh ONLY on a FULL IMPORT. So the two surfaces that read the stored
  values — the evolution tab's sub-score sparklines and the spend-detail composite
  "performance snapshot" — can lag after ANY add/delete until a reimport. ⚠️ **Worse
  for a newly CREATED supplier:** a manual add inserts only a `Supplier` row (no
  `SupplierMetric`), so those two surfaces show NOTHING for it until a full import.
  Delete is blocked if the supplier has any purchases (no orphans).
- **Purchase edit/delete recomputes globally — a supplier re-point moves BOTH
  suppliers automatically (Batch B).** `PATCH`/`DELETE /api/purchases/[id]` +
  `POST /api/purchases/batch-delete` mutate the `Purchase` row then call
  `recomputeAllPeriods()`. Because `compute_analyses` groups all purchases by
  `supplierExternalId` across every supplier, changing a purchase's supplier
  reattributes its spend/OTD/cycle/defect in one pass — the OLD supplier drops it,
  the NEW gains it, no per-supplier logic. Edit RECOMPUTES the derived fields
  (`total_value` + 5 cycle-days) via the shared `computeDerivedFields`, enforces
  date-ordering (no negative cycle days), and re-tags the payment-year period (a
  payment-date edit can move the PO across years — compute buckets by payment date
  regardless). Same stored-`SupplierMetric` lag as the supplier CRUD. The import
  page's Purchases table is client-side filtered + paginated (all 647 rows loaded,
  one page in the DOM). No delete block (a purchase can't orphan anything).
- **"Strategic" is now ONLY a Kraljic quadrant name** — the declared tier that
  also carried the name was removed entirely in `158849b`.
- **Prisma 7 `migrate dev` is interactive** (fails in non-interactive shells).
  Use `prisma migrate diff --from-config-datasource --to-schema ... --script` to
  author the SQL, then `prisma migrate deploy`.
- **Old reports (pre-3c) without `config` in `metricsJson`** default to
  `standard` detail + all sections + `operational` tone (backward compat).
- **Old reports (pre-Batch-5) lack `cycle_framing: "monitoring"` in
  `metricsJson`.** Reports re-render from LIVE analyses, so the report detail
  page (`reports/[id]`) detects the missing marker and passes the stored
  `narratives.cycle_time` (legacy pre/post prose) as `legacyCycle` to
  `ReportDocument`, which renders it + a "legacy framing" note instead of the
  live monitoring view. Old reports are preserved as history, not back-filled.
- **Known synthetic-data note:** risk_score and single_source_risk were
  saturated until 3a; the transformer fixed them (risk ~19–90, ~20% single-source).

## Tech stack
- Next.js 16 (App Router) + TypeScript
- Prisma 7 + PostgreSQL (local)
- Tailwind v4 + shadcn/ui
- Recharts for charts
- bcrypt + iron-session for auth
- Python script computes analyses post-import

## Note on shadcn components
- `toast` was removed upstream; we use `sonner` for notifications instead
- `form` was pulled from the `new-york` style (base-nova ships an empty placeholder)
- All other components are standard shadcn defaults with Slate base color

## Architecture
- /app — Next.js pages and API routes (App Router)
- /lib — utilities (prisma.ts client singleton, session.ts edge-safe iron-session config, auth.ts helpers, calculation helpers)
- /components — reusable React components
- /hooks — React hooks
- /types — shared TypeScript types
- /prisma — schema and migrations
- /python — analysis compute scripts (called from API after import)
- /data/raw — original CSVs for seed/sample data

## Reference documents (read these as needed)
- `nextjs_build_plan.md` — full architecture, schema, phase-by-phase build plan
- `procurement_analytics_gameplan_technical.md` — analytical methodology (Parts 2-6 only; Part 1 is OBSOLETE Streamlit content, ignore it)
- `dataset_type_explainer.md` — data field meanings and provenance

## Auth pattern
- Hardcoded seeded users (admin + viewer roles)
- bcrypt for passwords, iron-session for sessions
- `proxy.ts` (Next.js 16 proxy convention — replaces the deprecated `middleware.ts`) protects all routes except /login, /api/auth/*, and static assets
- Admin: full access (import, generate reports, manage periods)
- Viewer: read-only access to dashboards and reports

### Auth architecture (Phase 4)
- `lib/prisma.ts` — shared PrismaClient singleton using the pg driver adapter (`new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })`) with a `globalThis` HMR guard. Always import the generated client from `@/lib/generated/prisma/client`.
- `lib/session.ts` — edge-safe iron-session config: the `SessionData` type + `sessionOptions` only. NO Prisma import, so `proxy.ts` (Edge runtime) can import it safely.
- `lib/auth.ts` — Node-side auth helpers that DO use Prisma (`getSession`, `createSession`, `destroySession`, `requireAuth`, `requireAdmin`); re-exports `SessionData` from `lib/session.ts`.

## Critical scope rules — DO NOT VIOLATE
- ALL analyses use FIXED methodology — no parameter sliders
- ABC thresholds FIXED at 80%/95%
- Hypothesis test FIXED to Mann-Whitney U (now within `cycle_time`'s `period_comparison`)
- 2-decimal precision on ALL scores EVERYWHERE (composite, sub-scores, quadrant/zone table averages)
- Theme-aware tokens only — NO hardcoded hex; tints via `color-mix()`
- Period selector behavior preserved — period-scoped surfaces stay period-scoped across Range / 2024 / 2025 / 2026
- Reporting periods are metadata; data is filterable but analyses don't change
- Single organization (no multi-tenancy)
- No signup flow — all accounts seeded

## Conventions
- All API routes use Prisma with type-safe queries
- Use shadcn/ui components consistently
- Charts use Recharts (NOT matplotlib, chart.js, or d3)
- Forms use react-hook-form + zod
- Server Components by default; "use client" only when needed
- All routes auth-guarded except /login
- TypeScript strict mode
- Use cuid() for IDs (not uuid)

## Data flow for imports

THREE upload modes, all validated fully BEFORE any write, each one transaction, each
followed by `recomputeAllPeriods()`. A template is downloadable at
`GET /api/imports/template` (generated from `REQUIRED_COLUMNS`, so it cannot go stale).

| mode | route | sheets | semantics |
|---|---|---|---|
| Replace all | `POST /api/imports/upload` | all 12 | wipes and rebuilds the whole dataset |
| Append suppliers | `POST /api/imports/suppliers` | `suppliers` | UPSERT by `supplier_id` |
| Append transactions | `POST /api/imports/transactions` | 8 document sheets (+ `sourcing_events`/`responses` iff any PO uses a SOURCED method — `rfq` or `tender`) | INSERT-only, complete chains |

Both append routes accept `mode=preview` in the form data: validate and return the
plan WITHOUT writing, which is what the UI shows before you commit.

**Replace-all** (`lib/dataset-import.ts`): validate all 12 sheets (required columns,
non-empty core sheets, PK uniqueness, FK closure across all 18 relation edges, and the
`buying_method` vocabulary — unknown OR blank is rejected, matching append) →
single `$transaction` (wipe reverse-FK, insert FK order, upsert missing
`ReportingPeriod`) → recompute. ⚠️ Destructive: deletes manually-added suppliers and
ALL posted corrections. Supplier change-history is PRESERVED for suppliers the new
file still contains. The confirmation names every loss with live counts.

**Append rules** (`lib/dataset-append.ts`) — how append differs from replace-all:
1. FK closure widens from "within the file" to **file ∪ database**.
2. PKs must be unique in the file AND checked against the database.
3. What a database collision MEANS depends on the table, and this is not a style choice:
   - **Supplier is master data with no immutability trigger → UPSERT.** Each changed
     field is written to `SupplierChangeLog` exactly as a hand edit would be.
   - **The ten posted document tables carry BEFORE UPDATE triggers → collision is
     REJECTED.** Upserting a posted document would be an in-place edit, which those
     triggers forbid; a correction must be posted instead.
4. For a transactions file, **chain references must resolve INSIDE the file** while
   **master-data references (supplier, framework) must resolve in the DATABASE**. A
   child document pointing at a parent that exists only in the database means the
   upload is extending a posted chain — an edit — and is rejected with that wording.
   Suppliers are never created by a transactions file; upload them first.
5. **Complete chains only** (same rule as transaction-create): per PO ≥1 po_line, ≥1
   GRN, exactly 1 invoice; per po_line ≥1 grn_line and exactly 1 invoice_line; per
   invoice exactly 1 payment. Plus the buying-method conditionals, forward date
   ordering, and `period` == order year of `poDate`. ⚠️ An invoice-less PO is refused
   because the view COALESCEs it to `threeWayMatchPass = TRUE` while it contributes to
   no other rate denominator — it would silently inflate processScore.

A supplier append **skips the recompute entirely when nothing changed** (a file
matching the roster returns in ~0.2s instead of ~6s).

⚠️ **EMPTY REPORTING PERIODS ARE AUTO-REMOVED.** Appending a transaction in a new
order-year creates a `ReportingPeriod`; if that year's data later disappears (a
replace-all or reseed without it), `seed_compute` clears the period's derived rows and
DROPS the period. Rationale: it would otherwise stay selectable with nothing behind it,
and `compute_analyses` exits non-zero on an empty window — an orphaned period failed
EVERY subsequent recompute. Guarantees: only periods with ZERO purchase orders are ever
considered, so a period holding data can never be dropped (2024/2025/2026 always
survive); it runs BEFORE the analysis step, so it cannot race a recompute; a period
carrying a saved `ExecutiveSummary` is cleared but KEPT (user work); `Import` rows are
re-pointed to a surviving period (their period tag is arbitrary for a dataset-wide
file). A stale UI selection is already safe — `getCurrentPeriodSelection()` validates
every id against the live period set and falls back to latest/oldest.

## Excel file schema
**ONE workbook, 12 sheets** — `data/raw/procurement_dataset_full.xlsx`. Raw facts
only: NO derived columns (no `*_days`, no `total_value_usd`, no `three_way_match_pass`,
no scores). Everything derived is reconstructed by the `EnrichedPurchase` VIEW at read
time; scores are computed by `python/seed_compute.py`.

| sheet | key columns |
|---|---|
| suppliers | supplier_id, supplier_name, country, category, status, is_mining_service, iujp_no, iujp_valid_until |
| frameworks | framework_id, supplier_id, title, category, start_date, end_date, status |
| requisitions | pr_id, pr_date, requester, department, category, need_by_date, estimated_value_usd, status |
| sourcing_events | sourcing_event_id, pr_id, issue_date, close_date, num_suppliers_invited, awarded_supplier_id, awarded_response_id |
| responses | response_id, sourcing_event_id, supplier_id, quoted_unit_price_usd, quoted_lead_time_days, submitted_date, is_awarded |
| purchase_orders | po_id, pr_id, sourcing_event_id, supplier_id, buying_method, framework_id, justification, po_date, promised_delivery_date, payment_terms, complaint_count, status, period |
| po_lines | po_line_id, po_id, item_name, category, unit, quantity_ordered, unit_price_usd, need_by_date |
| goods_receipts | grn_id, po_id, receipt_date, received_by, site, status |
| grn_lines | grn_line_id, grn_id, po_line_id, quantity_received, quantity_rejected, defect_count |
| invoices | invoice_id, po_id, supplier_id, supplier_invoice_no, invoice_date, total_amount_usd, status |
| invoice_lines | invoice_line_id, invoice_id, po_line_id, quantity_billed, unit_price_usd |
| payments | payment_id, invoice_id, payment_date, amount_paid_usd, method |

⚠️ `purchase_orders.buying_method` is one of **`rfq | tender | spot_buy | call_off |
direct`** (see "BUYING METHODS" at the top). Per-method conditionals: the two SOURCED
methods (`rfq`, `tender`) each need their own `sourcing_events` row with `responses` and
an award, and only they may carry a `sourcing_event_id`; `call_off` needs a
`framework_id`; `direct` needs a `justification`; `spot_buy` needs none of them.
⚠️ The exclusivity rules are ASYMMETRIC: `framework_id` is enforced BOTH ways (only a
call-off may carry one), and `sourcing_event_id` likewise, but `justification` is only
REQUIRED for `direct` — no rule forbids it on the other methods. ⚠️ `sourcing_events`
has **no `solicitation_type` column** — that was explored and dropped; the distinction
lives in `buying_method`.

⚠️ `/api/sample-data` and the two old sample workbooks are GONE (deleted 2026-07-20).
Use `GET /api/imports/template` instead — it generates the 12-sheet template plus a
README sheet and ONE complete example chain, from `REQUIRED_COLUMNS`.

## When uncertain
Default to the simpler implementation. Don't add features I didn't request.
Don't add real-time features. Don't add multi-org logic. Don't add charts I didn't ask for.
If you're about to make an architectural decision, ASK ME FIRST.
