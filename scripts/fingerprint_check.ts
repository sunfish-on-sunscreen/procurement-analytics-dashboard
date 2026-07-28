/**
 * Committed fingerprint-behaviour gate for the risk-model config (Prerequisite P).
 *
 * The whole-config fingerprint is the report-footer reproducibility anchor. P expanded its
 * compute-affecting scope to cover each formula-defined component's formula + bounds + the specs
 * of the variables it references + the resolved content of every lookup table those variables
 * read (see lib/risk-model.projectComponentFormula). This script asserts the properties that scope
 * MUST have — determinism, order-independence, and the right things moving / not moving it — so a
 * refactor that silently breaks any of them fails here instead of quietly invalidating every
 * printed report's stamp.
 *
 * It is NOT the baseline harness (scripts/baseline_harness.py gates the SCORES). It gates the
 * FINGERPRINT — a TS-only concern the Python suite cannot reach.
 *
 * DETERMINISM MODEL (P addition 1): a component's formula string is hashed VERBATIM, so ANY
 * formula edit moves the fingerprint (the safe direction — never claims "same fingerprint" for a
 * differently-worded formula). The ORDER-INDEPENDENCE guarantee is about the referenced-variable
 * and referenced-table COLLECTIONS: they are serialized sorted by id, so the hash does not depend
 * on the order tables/variables are declared in the config or encountered during resolution.
 *
 * Run:  npx tsx scripts/fingerprint_check.ts     (exit 0 = all pass, 1 = a failure)
 */
import {
  RISK_MODEL,
  configFingerprint,
  compositeFingerprint,
  referencedVariables,
  componentTableRefs,
  builtinInputBlockedIn,
  mergeAndBumpVersions,
  formulaError,
  boundsError,
  type RiskModel,
  type RiskComposite,
  type RiskComponent,
} from "@/lib/risk-model";

// The pinned P baseline (schema 2.2.0). Deliberate config changes update these — same discipline
// as the harness md5 — but a drift with no intended change is a bug this catches.
const EXPECT_CONFIG_FP = "d3aa19ab";
const EXPECT_COMPOSITE_FP: Record<string, string> = {
  performanceComposite: "ad0a6986",
  performanceRisk: "13c3213f",
  supplyRisk: "9c8852d1",
};

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  [ok]   ${name}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
function reverseKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.keys(o).reverse().map((k) => [k, o[k]])) as T;
}
function cfp(m: RiskModel): string {
  return configFingerprint(m.composites, m.lookupTables, m.variables ?? {});
}
function kfp(id: string, m: RiskModel): string {
  return compositeFingerprint(id, m.composites, m.lookupTables, m.variables ?? {});
}
function composite(m: RiskModel, id: string): RiskComposite {
  const c = m.composites.find((x) => x.id === id);
  if (!c) throw new Error(`no composite ${id}`);
  return c;
}
function component(m: RiskModel, cid: string, compId: string): RiskComponent {
  const c = composite(m, cid).components.find((x) => x.id === compId);
  if (!c) throw new Error(`no component ${cid}.${compId}`);
  return c;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("Fingerprint gate (Prerequisite P):");

// A. Shipped baseline lock.
const base = cfp(RISK_MODEL);
check("shipped config fingerprint == baseline", base === EXPECT_CONFIG_FP, `${base} != ${EXPECT_CONFIG_FP}`);
for (const [id, fp] of Object.entries(EXPECT_COMPOSITE_FP)) {
  const got = kfp(id, RISK_MODEL);
  check(`shipped ${id} fingerprint == baseline`, got === fp, `${got} != ${fp}`);
}

// B. Stability — the same config hashes identically every call (no Set/object-order leak).
const repeats = new Set([0, 1, 2, 3, 4].map(() => cfp(RISK_MODEL)));
check("fingerprint stable across repeated calls", repeats.size === 1 && repeats.has(EXPECT_CONFIG_FP));

// C. Reference-extraction + table-resolution are order-independent (sorted).
const vars = RISK_MODEL.variables ?? {};
check(
  "referencedVariables is order-independent + sorted",
  eq(referencedVariables("country_distance + roster_concentration"), ["country_distance", "roster_concentration"]) &&
    eq(referencedVariables("roster_concentration + country_distance"), ["country_distance", "roster_concentration"]),
);
check(
  "componentTableRefs is order-independent + sorted by table id",
  eq(componentTableRefs({ formula: "country_distance + roster_concentration" }, vars), ["concentration_curve", "country_distance"]) &&
    eq(componentTableRefs({ formula: "roster_concentration + country_distance" }, vars), ["concentration_curve", "country_distance"]),
);

// D. Multi-table formula: the hash is invariant to the ORDER the referenced tables + variables are
//    DECLARED in the config (the nondeterminism addition 1 guards against — "Set, object key order").
const twoTable = clone(RISK_MODEL);
// perfRisk.country_distance now reads TWO tables (country_distance + concentration_curve via roster_concentration).
component(twoTable, "performanceRisk", "country_distance").formula = "country_distance + roster_concentration";
const twoTableReordered = clone(twoTable);
twoTableReordered.lookupTables = reverseKeys(twoTableReordered.lookupTables);
twoTableReordered.variables = reverseKeys(twoTableReordered.variables ?? {});
check(
  "multi-table hash invariant to lookupTables/variables declaration order",
  cfp(twoTable) === cfp(twoTableReordered),
  `${cfp(twoTable)} != ${cfp(twoTableReordered)}`,
);
check("...and that two-table formula edit did move the hash off baseline", cfp(twoTable) !== base);

// E. A formula edit MOVES the fingerprint (the gate).
const mFormula = clone(RISK_MODEL);
component(mFormula, "supplyRisk", "cost_premium").formula = "min(cost_premium, 50)";
check("formula edit moves the fingerprint", cfp(mFormula) !== base);

// F. A bounds edit MOVES the fingerprint (new P scope).
const mBounds = clone(RISK_MODEL);
component(mBounds, "supplyRisk", "supply_concentration").bounds = { lo: 0, hi: 200 };
check("bounds edit moves the fingerprint", cfp(mBounds) !== base);

// G. A label / definition / version edit does NOT move the fingerprint.
const mLabel = clone(RISK_MODEL);
composite(mLabel, "supplyRisk").label = "Renamed supply risk";
composite(mLabel, "supplyRisk").shortLabel = "sr";
composite(mLabel, "supplyRisk").version = "9.9.9";
component(mLabel, "supplyRisk", "cost_premium").label = "Renamed cost premium";
component(mLabel, "supplyRisk", "cost_premium").definition = "different words";
mLabel.lookupTables.concentration_curve.label = "Renamed curve";
mLabel.lookupTables.concentration_curve.version = "9.9.9";
if (mLabel.variables?.cost_premium) mLabel.variables.cost_premium.label = "Renamed";
check("label/definition/version edits do NOT move the fingerprint", cfp(mLabel) === base, `${cfp(mLabel)} != ${base}`);

// H. Editing a SHARED table (concentration_curve) moves ALL THREE composite fingerprints
//    (supplyRisk + performanceRisk directly, performanceComposite transitively via risk_score).
const mShared = clone(RISK_MODEL);
mShared.lookupTables.concentration_curve.default = 5.0;
check("shared-table edit moves supplyRisk fp", kfp("supplyRisk", mShared) !== EXPECT_COMPOSITE_FP.supplyRisk);
check("shared-table edit moves performanceRisk fp", kfp("performanceRisk", mShared) !== EXPECT_COMPOSITE_FP.performanceRisk);
check("shared-table edit moves performanceComposite fp (transitive)", kfp("performanceComposite", mShared) !== EXPECT_COMPOSITE_FP.performanceComposite);

// I. Precision — editing a table only ONE composite reads (country_distance) moves performanceRisk +
//    performanceComposite but NOT supplyRisk (which never references it).
const mPrecise = clone(RISK_MODEL);
const cd = mPrecise.lookupTables.country_distance.rows.find((r) => String(r.key) === "asean");
if (cd) cd.value = 35;
check("country_distance edit leaves supplyRisk fp UNCHANGED", kfp("supplyRisk", mPrecise) === EXPECT_COMPOSITE_FP.supplyRisk);
check("country_distance edit moves performanceRisk fp", kfp("performanceRisk", mPrecise) !== EXPECT_COMPOSITE_FP.performanceRisk);
check("country_distance edit moves performanceComposite fp", kfp("performanceComposite", mPrecise) !== EXPECT_COMPOSITE_FP.performanceComposite);

// J. A referenced-variable spec edit (computed default, lookup key) moves the fingerprint.
const mVarDefault = clone(RISK_MODEL);
if (mVarDefault.variables?.cost_premium) mVarDefault.variables.cost_premium.default = 5.0;
check("computed-variable default edit moves the fingerprint", cfp(mVarDefault) !== base);
const mVarKey = clone(RISK_MODEL);
if (mVarKey.variables?.country_distance) mVarKey.variables.country_distance.key = "country_alt";
check("lookup-variable key edit moves the fingerprint", cfp(mVarKey) !== base);

// K. Aggregate variables (Stage E): a formula referencing one carries its source + agg into
//    the fingerprint; eta2 + feedsBuiltin are display/validation metadata and stay OUT.
const aggBase = clone(RISK_MODEL);
component(aggBase, "supplyRisk", "cost_premium").formula = "cost_premium + cycle_time";
const aggFp = cfp(aggBase);
check("referencing an aggregate variable moves the fingerprint", aggFp !== base);
const aggAggEdit = clone(aggBase);
aggAggEdit.variables!.cycle_time.agg = "median";
check("aggregate 'agg' edit moves the fingerprint", cfp(aggAggEdit) !== aggFp);
const aggSrcEdit = clone(aggBase);
aggSrcEdit.variables!.cycle_time.source = "invoice_to_payment_days";
check("aggregate 'source' edit moves the fingerprint", cfp(aggSrcEdit) !== aggFp);
const aggMetaEdit = clone(aggBase);
aggMetaEdit.variables!.cycle_time.eta2 = { category: 0, country: 0 };
aggMetaEdit.variables!.cycle_time.feedsBuiltin = "delivery_score";
check("aggregate eta2/feedsBuiltin edits do NOT move the fingerprint", cfp(aggMetaEdit) === aggFp);

// L. builtinInputBlockedIn (Stage E) — the graph-derived double-count block.
// (reuses `vars` from check C)
check("builtin-input variable BLOCKED in performanceRisk",
  builtinInputBlockedIn(vars.on_time_rate, "performanceRisk", RISK_MODEL.composites) !== null);
check("builtin-input variable ALLOWED in supplyRisk (produces no builtin)",
  builtinInputBlockedIn(vars.on_time_rate, "supplyRisk", RISK_MODEL.composites) === null);
check("non-builtin variable ALLOWED in performanceRisk",
  builtinInputBlockedIn(vars.cycle_time, "performanceRisk", RISK_MODEL.composites) === null);
check("risk_score-input variable ALLOWED in performanceRisk (its own output)",
  builtinInputBlockedIn(vars.roster_concentration, "performanceRisk", RISK_MODEL.composites) === null);

// M. Stage F formula-save backend: mergeAndBumpVersions applies a formula edit + bumps the
//    version + moves the fingerprint, ignores a formula on a BUILTIN, and formulaError/boundsError
//    catch invalid input.
const fEdit = mergeAndBumpVersions(RISK_MODEL, [
  { id: "supplyRisk", components: [{ id: "cost_premium", enabled: true, weight: 0.25, formula: "cost_premium + import_friction" }] },
]);
const srAfter = fEdit.merged.composites.find((c) => c.id === "supplyRisk")!;
check("mergeAndBumpVersions applies a formula edit",
  srAfter.components.find((c) => c.id === "cost_premium")!.formula === "cost_premium + import_friction");
check("...bumps the composite version + moves the fingerprint",
  fEdit.changedIds.includes("supplyRisk") && cfp(fEdit.merged) !== base);
const builtinEdit = mergeAndBumpVersions(RISK_MODEL, [
  { id: "performanceComposite", components: [{ id: "quality_score", enabled: true, weight: 0.3, formula: "on_time_rate" }] },
]);
check("mergeAndBumpVersions IGNORES a formula edit on a builtin component",
  builtinEdit.merged.composites.find((c) => c.id === "performanceComposite")!
    .components.find((c) => c.id === "quality_score")!.formula === undefined);
check("formulaError flags a blocked variable in performanceRisk",
  formulaError("country_distance + on_time_rate", "performanceRisk", RISK_MODEL.composites, vars) !== null);
check("formulaError passes a valid performanceRisk formula",
  formulaError("country_distance + roster_concentration", "performanceRisk", RISK_MODEL.composites, vars) === null);
check("formulaError flags a trailing operator",
  formulaError("country_distance +", "performanceRisk", RISK_MODEL.composites, vars) !== null);
check("formulaError flags an unknown variable",
  formulaError("country_distance + nope", "performanceRisk", RISK_MODEL.composites, vars) !== null);
check("boundsError flags hi <= lo", boundsError({ lo: 100, hi: 0 }) !== null && boundsError({ lo: 0, hi: 100 }) === null);

console.log(failures === 0 ? "\nALL FINGERPRINT CHECKS PASSED" : `\n${failures} FINGERPRINT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
