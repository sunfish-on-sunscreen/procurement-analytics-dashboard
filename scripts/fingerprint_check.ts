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
  generateComponentId,
  isCustomComponentId,
  componentReferrers,
  resetCompositeToDefaults,
  compositeAtDefaults,
  RISK_MODEL_DEFAULTS,
  type RiskModel,
  type RiskComposite,
  type RiskComponent,
} from "@/lib/risk-model";
import { readFileSync } from "node:fs";
// The REAL token-gating helpers from the component — imported, NOT copied, so a source change to
// either breaks this gate (the two-implementations problem: a copied helper tests the copy).
import { expectsValue, LITERAL_RE } from "@/components/Methodology/FormulaEditorCard";

// The pinned P baseline (schema 2.2.0). Deliberate config changes update these — same discipline
// as the harness md5 — but a drift with no intended change is a bug this catches.
const EXPECT_CONFIG_FP = "ac398c0a"; // schema 2.4.0 (Stage G added cost_premium partition to scope)
const EXPECT_COMPOSITE_FP: Record<string, string> = {
  performanceComposite: "ad0a6986",
  performanceRisk: "13c3213f",
  supplyRisk: "c45418c0", // moved from 9c8852d1 in Stage G (partition now in cost_premium's spec)
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
check("formulaError flags a locked variable",
  formulaError("supply_concentration + cycle_time_cv", "supplyRisk", RISK_MODEL.composites, vars) !== null);
check("boundsError flags hi <= lo", boundsError({ lo: 100, hi: 0 }) !== null && boundsError({ lo: 0, hi: 100 }) === null);

// N. Stage G: a cost_premium partition-parameter edit moves the fingerprint (compute-affecting).
const partEdit = clone(RISK_MODEL);
if (partEdit.variables?.cost_premium?.partition) partEdit.variables.cost_premium.partition.minGroupMembers = 3;
check("cost_premium partition edit moves the fingerprint", cfp(partEdit) !== base);
const modeEdit = clone(RISK_MODEL);
if (modeEdit.variables?.cost_premium?.partition) modeEdit.variables.cost_premium.partition.benchmarkMode = "external";
check("cost_premium benchmarkMode edit moves the fingerprint", cfp(modeEdit) !== base);

// O. Stage I — component ADD / REMOVE / RENAME + server-side id generation.
// O.1 generateComponentId: prefixed slug, accent transliteration, collision suffix (from _2),
//     cross-set collision, and the empty-slug -> token fallback.
check("generateComponentId slugifies a name", generateComponentId("Delivery variance", []) === "custom_delivery_variance");
check("generateComponentId transliterates accents", generateComponentId("Café variance", []) === "custom_cafe_variance");
check(
  "generateComponentId suffixes a collision from _2",
  generateComponentId("Price premium", ["custom_price_premium"]) === "custom_price_premium_2",
);
check(
  "generateComponentId falls back to a token for an empty slug",
  generateComponentId("!!!", [], "AB12cd") === "custom_ab12cd",
);
check(
  "isCustomComponentId true for custom_, false for shipped",
  isCustomComponentId("custom_x") && !isCustomComponentId("cost_premium"),
);

// O.2 ADD moves the fingerprint + bumps the version + appends LAST (surviving order preserved).
const addEdit = mergeAndBumpVersions(RISK_MODEL, [
  {
    id: "supplyRisk",
    components: [
      { id: "supply_concentration", enabled: true, weight: 0.4 },
      { id: "cost_premium", enabled: true, weight: 0.25 },
      { id: "import_friction", enabled: true, weight: 0.25 },
      { id: "custom_delivery_variance", enabled: true, weight: 0.1, formula: "import_friction", bounds: { lo: 0, hi: 100 }, label: "Delivery variance" },
    ],
  },
]);
const srAdd = composite(addEdit.merged, "supplyRisk");
check("ADD appends the new component", srAdd.components.length === 4 && srAdd.components.some((c) => c.id === "custom_delivery_variance"));
check("ADD changed-length moves the config fingerprint + bumps supplyRisk", cfp(addEdit.merged) !== base && addEdit.changedIds.includes("supplyRisk"));
check("ADD moves the supplyRisk composite fingerprint", kfp("supplyRisk", addEdit.merged) !== EXPECT_COMPOSITE_FP.supplyRisk);
check(
  "ADD preserves surviving component order (new one is LAST)",
  srAdd.components.slice(0, 3).map((c) => c.id).join(",") === "supply_concentration,cost_premium,import_friction",
);

// O.3 REMOVE (a non-builtin omitted from the edit) drops it + moves the fingerprint.
const rmEdit = mergeAndBumpVersions(RISK_MODEL, [
  {
    id: "supplyRisk",
    components: [
      { id: "supply_concentration", enabled: true, weight: 0.5 / 0.75 },
      { id: "cost_premium", enabled: true, weight: 0.25 / 0.75 },
    ],
  },
]);
const srRm = composite(rmEdit.merged, "supplyRisk");
check("REMOVE drops the omitted non-builtin", srRm.components.length === 2 && !srRm.components.some((c) => c.id === "import_friction"));
check("REMOVE changed-length moves the fingerprint + bumps supplyRisk", cfp(rmEdit.merged) !== base && rmEdit.changedIds.includes("supplyRisk"));

// O.4 RENAME: a label change on a CUSTOM component keeps the frozen id AND does NOT move the
//     fingerprint (label is display-only, excluded from the projection). "create, rename, id unchanged".
const afterAddFp = cfp(addEdit.merged);
const renameEdit = mergeAndBumpVersions(addEdit.merged, [
  {
    id: "supplyRisk",
    components: [
      { id: "supply_concentration", enabled: true, weight: 0.4 },
      { id: "cost_premium", enabled: true, weight: 0.25 },
      { id: "import_friction", enabled: true, weight: 0.25 },
      { id: "custom_delivery_variance", enabled: true, weight: 0.1, formula: "import_friction", bounds: { lo: 0, hi: 100 }, label: "Delivery consistency" },
    ],
  },
]);
const renamed = composite(renameEdit.merged, "supplyRisk").components.find((c) => c.id === "custom_delivery_variance");
check("RENAME keeps the frozen id, diverging from the label", !!renamed && renamed.id === "custom_delivery_variance" && renamed.label === "Delivery consistency");
check("RENAME does NOT move the fingerprint (label excluded)", cfp(renameEdit.merged) === afterAddFp, `${cfp(renameEdit.merged)} != ${afterAddFp}`);

// O.5 Built-in components are PRESERVED even when an edit omits them (never removed), and omitting
//     them with no knob change does not bump the version.
const omitBuiltins = mergeAndBumpVersions(RISK_MODEL, [
  { id: "performanceComposite", components: [{ id: "quality_score", enabled: true, weight: 0.3 }] },
]);
check("builtins are never dropped by an omitting edit", composite(omitBuiltins.merged, "performanceComposite").components.length === 4);
check("omitting builtins with no knob change does NOT bump the version", !omitBuiltins.changedIds.includes("performanceComposite"));

// O.6 componentReferrers is empty on the shipped config — nothing references a component id, so a
//     non-builtin remove orphans nothing (vacuous by the data model; see the function's doc).
check("componentReferrers empty for a shipped component", componentReferrers("cost_premium", RISK_MODEL.composites).length === 0);

// P. TASK 2 — risk-model.defaults.json carries the FULL shipped component definition per composite,
//    so reset restores a removed component exactly (formula/bounds/label). Assert (a) defaults ==
//    shipped FIELD BY FIELD so an edit to one without the other fails loudly, and (b) reset
//    reproduces the shipped composite exactly even from a mutated (removed + reweighted) one.
const DEF_FIELDS: (keyof RiskComponent)[] = [
  "id", "label", "definition", "provenance", "builtin", "configuredIn", "enabled", "weight", "formula",
];
function componentsFieldEqual(a: RiskComponent, b: RiskComponent): boolean {
  for (const f of DEF_FIELDS) if ((a[f] ?? null) !== (b[f] ?? null)) return false;
  return (a.bounds?.lo ?? null) === (b.bounds?.lo ?? null) && (a.bounds?.hi ?? null) === (b.bounds?.hi ?? null);
}
for (const c of RISK_MODEL.composites) {
  const defs = RISK_MODEL_DEFAULTS.composites[c.id];
  const sameLen = !!defs && defs.length === c.components.length;
  const allEqual = sameLen && c.components.every((comp, i) => componentsFieldEqual(comp, defs[i]));
  check(`defaults.json ${c.id} == shipped components field-by-field`, allEqual,
    sameLen ? "a field differs" : `length ${defs?.length} != ${c.components.length}`);
}
// reset reproduces the shipped composite exactly, even from a mutated one (remove import_friction +
// reweight). supplyRisk has removable non-builtin components.
const mutated = clone(composite(RISK_MODEL, "supplyRisk"));
mutated.components = mutated.components.filter((c) => c.id !== "import_friction");
mutated.components[0].weight = 0.9;
const reset = resetCompositeToDefaults(mutated, RISK_MODEL_DEFAULTS);
const shipped = composite(RISK_MODEL, "supplyRisk");
check(
  "reset-to-defaults reproduces the shipped supplyRisk exactly (re-adds the removed component)",
  reset.components.length === shipped.components.length &&
    reset.components.every((comp, i) => componentsFieldEqual(comp, shipped.components[i])),
);
check(
  "compositeAtDefaults: true for shipped, false for the mutated composite",
  compositeAtDefaults(shipped, RISK_MODEL_DEFAULTS) && !compositeAtDefaults(mutated, RISK_MODEL_DEFAULTS),
);

// P.2 ORDER BUG — remove a MIDDLE component through the MERGE, then reset through the merge, and
// confirm the list matches shipped EXACTLY INCLUDING ORDER. A re-added shipped component must
// return to its shipped slot, not be appended last (float summation order is part of the identity).
// This exercises the SAVE path (mergeAndBumpVersions) both ways, not just the pure reset helper.
{
  const shippedSup = composite(RISK_MODEL, "supplyRisk");
  const survivors = shippedSup.components.filter((c) => c.id !== "cost_premium"); // cost_premium = index 1 (MIDDLE)
  const totalW = survivors.reduce((s, c) => s + c.weight, 0);
  const afterRemove = mergeAndBumpVersions(RISK_MODEL, [
    {
      id: "supplyRisk",
      components: survivors.map((c) => ({ id: c.id, enabled: c.enabled, weight: c.weight / totalW, formula: c.formula, bounds: c.bounds })),
    },
  ]).merged;
  const removedSup = composite(afterRemove, "supplyRisk");
  check(
    "merge REMOVE drops the middle component",
    removedSup.components.map((c) => c.id).join(",") === "supply_concentration,import_friction",
  );
  const resetSup = resetCompositeToDefaults(removedSup, RISK_MODEL_DEFAULTS);
  const afterReset = composite(
    mergeAndBumpVersions(afterRemove, [
      {
        id: "supplyRisk",
        components: resetSup.components.map((c) => ({ id: c.id, enabled: c.enabled, weight: c.weight, formula: c.formula, bounds: c.bounds, label: c.label, definition: c.definition })),
      },
    ]).merged,
    "supplyRisk",
  );
  check(
    "merge RESET restores shipped ORDER (re-added default returns to its slot, not last)",
    afterReset.components.map((c) => c.id).join(",") === shippedSup.components.map((c) => c.id).join(","),
    afterReset.components.map((c) => c.id).join(","),
  );
  check(
    "merge RESET matches shipped supplyRisk field-by-field including order",
    afterReset.components.length === shippedSup.components.length &&
      afterReset.components.every((c, i) => componentsFieldEqual(c, shippedSup.components[i])),
  );
}

// Q. Numeric literals (Stage I): a literal is part of the formula STRING, so a formula that adds
//    one moves the fingerprint through the existing projection (projectComponentFormula hashes the
//    formula verbatim); referencedVariables skips it (only identifiers are variables), so no
//    phantom variable enters the projection.
check(
  "referencedVariables skips numeric literals",
  eq(referencedVariables("0.5 * country_distance + 0.5 * import_friction"), ["country_distance", "import_friction"]),
);
const mLiteral = clone(RISK_MODEL);
component(mLiteral, "supplyRisk", "cost_premium").formula = "0.5 * cost_premium";
check("a numeric-literal formula edit moves the fingerprint", cfp(mLiteral) !== base);

// R. FormulaEditorCard token-gating — the adjacent-values guard. Uses the REAL imported
//    expectsValue + LITERAL_RE (a source change breaks this), applies the SAME disabled expressions
//    the JSX uses, and then cross-checks the source still wires those attrs to them (the logic test
//    can't see the wiring; the source check can't run the logic — together they cover both).
function fecStates(formula: string, literal = "", reason: string | null = null) {
  const wantsValue = expectsValue(formula);
  const depth = (formula.match(/\(/g)?.length ?? 0) - (formula.match(/\)/g)?.length ?? 0);
  return {
    operatorDisabled: wantsValue,
    literalInsertDisabled: !wantsValue || !LITERAL_RE.test(literal.trim()),
    variableDisabled: !!reason || !wantsValue,
    closeParenDisabled: wantsValue || depth <= 0,
  };
}
check(
  "FEC after a value: operators enabled, variables + number DISABLED (no adjacent value)",
  fecStates("cost_premium", "5").operatorDisabled === false &&
    fecStates("cost_premium", "5").variableDisabled === true &&
    fecStates("cost_premium", "5").literalInsertDisabled === true,
);
check(
  "FEC after an operator: operators DISABLED, values enabled",
  fecStates("cost_premium +", "5").operatorDisabled === true &&
    fecStates("cost_premium +", "5").variableDisabled === false &&
    fecStates("cost_premium +", "5").literalInsertDisabled === false,
);
check("FEC empty: no leading operator", fecStates("").operatorDisabled === true && fecStates("").variableDisabled === false);
check(
  "FEC ')' only with an open expression + preceding value",
  fecStates("min(").closeParenDisabled === true &&
    fecStates("min( cost_premium").closeParenDisabled === false &&
    fecStates("cost_premium").closeParenDisabled === true,
);
check("FEC blocked variable stays disabled", fecStates("cost_premium +", "", "blocked — feeds delivery_score").variableDisabled === true);
check(
  "FEC LITERAL_RE accepts decimals, rejects junk",
  ["0.5", "-5", "1e3", "12", ".5"].every((l) => LITERAL_RE.test(l)) &&
    !["5abc", "", ".", "1.2.3"].some((l) => LITERAL_RE.test(l)),
);
// Source cross-check: the JSX still wires each disabled attr to wantsValue / parenDepth /
// literalValid (all derived from the imported expectsValue). If a button is rewired, this fails.
const fecSrc = readFileSync(new URL("../components/Methodology/FormulaEditorCard.tsx", import.meta.url), "utf-8");
for (const expr of [
  "const wantsValue = expectsValue(formula)",
  "disabled={wantsValue}", // operators
  "disabled={!wantsValue}", // '(' + functions
  "disabled={wantsValue || parenDepth <= 0}", // ')'
  "disabled={!wantsValue || !literalValid}", // number insert
  "!!reason || !wantsValue", // variable button
]) {
  check(`FEC source wires the disabled state: ${expr}`, fecSrc.includes(expr));
}

console.log(failures === 0 ? "\nALL FINGERPRINT CHECKS PASSED" : `\n${failures} FINGERPRINT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
