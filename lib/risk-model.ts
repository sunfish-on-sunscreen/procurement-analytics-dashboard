/**
 * Typed loader for config/risk-model.json — the single source of truth for the three
 * scoring composites (performanceComposite + the two risk composites).
 *
 * The BINDING compute consumer is python/risk_config.py; this TS module mirrors its
 * weight/enabled/polarity interface AND owns the VERSIONING + FINGERPRINTING the reports
 * and settings UI use. Python ignores version/schemaVersion/shortLabel/polarityLabel, so
 * none of the Stage-2 versioning touches a score.
 *
 * VERSIONING MODEL (Stage 2):
 *  - Each composite carries its OWN `version`; a save bumps only the composites whose
 *    own components changed (see mergeAndBumpVersions). A top-level `schemaVersion` tracks
 *    the config FILE format, separate from the content versions.
 *  - SCHEMA = FINGERPRINT SCOPE. A fingerprint is only comparable to one produced under
 *    the SAME schemaVersion, because the version records what the fingerprint COVERS.
 *    schema 2.1.0 (Stage A, commit fa7d75f) EXPANDED that scope to include lookup-table
 *    values, so a 2.0.0 fingerprint and a 2.1.0 fingerprint differ at IDENTICAL weights
 *    (RISK_MODEL_FINGERPRINT moved to e4db2d7e) without any score changing. schema 2.2.0
 *    (Prerequisite P) EXPANDED it again to cover each formula-defined component's formula +
 *    bounds and the specs of the variables it references, so a 2.1.0 fingerprint (e4db2d7e)
 *    and a 2.2.0 fingerprint again differ at identical weights without any score changing —
 *    P made formulas reproducibility-tracked BEFORE Stage F makes them user-editable. Bump
 *    schemaVersion whenever the projected scope changes, and stamp it beside the
 *    fingerprint (the report footer does) so an old fingerprint stays interpretable
 *    rather than a bare mismatch.
 *  - Fingerprints are DERIVED (never stored), over COMPUTE-AFFECTING fields only
 *    (weights, enabled, invertPolarity, derived dependsOn, each formula-defined component's
 *    formula + normalization bounds, the specs of the variables that formula references, and
 *    the resolved values of every lookup table those variables read — NOT labels/definitions/
 *    polarityLabel/version), so "fingerprint changed" means "the numbers changed".
 *  - configFingerprint (whole config) is the report-footer + drift anchor. It covers
 *    everything, including the lookup tables (Stage A), with no format change.
 *  - compositeFingerprint is dependency-aware (over the composite AND its transitive
 *    deps), so editing performanceRisk changes performanceComposite's fingerprint even
 *    though its own components are untouched — used for settings-UI audit granularity.
 */
import riskModelJson from "@/config/risk-model.json";
import defaultsJson from "@/config/risk-model.defaults.json";

/** Per-component normalization bounds (Stage D): the formula result on [lo, hi] maps to
 * [0, 100] (default (0, 100) is a bit-exact identity). */
export interface FormulaBounds {
  lo: number;
  hi: number;
}

export interface RiskComponent {
  id: string;
  label: string;
  definition: string;
  provenance: "computed" | "lookup";
  enabled: boolean;
  weight: number; // 0..1
  /**
   * Marks a built-in sub-score (the performanceComposite dimensions) that is computed
   * by scores.py and NOT formula-defined — so the future formula editor must not offer
   * to edit its formula. Absent/false on the risk composites' components. Weight edit
   * and enable/disable stay allowed; add/remove are not offered.
   */
  builtin?: boolean;
  /**
   * For a built-in sub-score that is ITSELF produced by another composite, the id of
   * that composite (risk_score -> "performanceRisk"). This is the DEPENDENCY declaration
   * (dependenciesOf derives the graph from it); the two weight sets multiply, not add.
   */
  configuredIn?: string;
  /**
   * Stage D: whitelisted arithmetic over `variables` ids; the component's value is
   * normalize_to_bounds(evaluate(formula, env), bounds.lo, bounds.hi). Absent on the built-in
   * sub-scores. IN the compute-affecting fingerprint since Prerequisite P (schema 2.2.0): the
   * projection covers formula + bounds + the referenced variables' specs + the resolved content
   * of every lookup table those variables read (projectComponentFormula), so editing a formula,
   * a bound, a variable spec, or a shared table moves the fingerprint. Table references are
   * DERIVED through formula -> variables -> table (componentTableRefs); the old per-component
   * `lookupTable` field was DROPPED in P, because a composed formula can read several tables
   * that one field cannot represent. A table may still be SHARED — concentration_curve backs
   * BOTH supplyRisk.supply_concentration AND performanceRisk.roster_concentration — so editing
   * it moves both scores' fingerprints (via each component's referenced tables).
   */
  formula?: string;
  bounds?: FormulaBounds;
}

export interface RiskComposite {
  id: "supplyRisk" | "performanceRisk" | "performanceComposite";
  label: string;
  /** Compact label for the report footer (e.g. "performance", "supply-risk"). */
  shortLabel: string;
  /** Per-composite content version; bumps when THIS composite's own components change. */
  version: string;
  invertPolarity: boolean;
  /**
   * Display badge copy for the score's direction (e.g. "higher = safer"). AUTHORITATIVE
   * for the UI — never re-derive the badge from invertPolarity, which is a compute flag
   * (whether to apply the 100-minus), a different concern from display text.
   */
  polarityLabel: string;
  components: RiskComponent[];
}

/**
 * One row of a lookup table: a key mapped to a 0-100 value. Geographic (country) tables
 * also carry `members` — the ISO codes that resolve to this row's value. Numeric (count)
 * tables omit `members` (the integer key IS the input).
 */
export interface LookupRow {
  key: string | number;
  value: number; // 0..100 (validated at load)
  members?: string[];
}

/**
 * A named value curve in the top-level `lookupTables` block — the config home of a lookup
 * that used to be hardcoded in Python (Stage A). `input` selects the match algorithm
 * ("count" = integer step curve, e.g. concentration_curve; "country" = ISO-code
 * membership, e.g. country_distance / import_friction). `default` is REQUIRED and applies
 * to any key no row matches. A table may be referenced by more than one component
 * (concentration_curve is SHARED — see consumersOfTable); edit it once, every consumer moves.
 */
export interface LookupTable {
  label: string;
  /**
   * Per-table content version; bumps when THIS table's own default/rows/members change
   * (mergeAndBumpTableVersions). A table edit moves its CONSUMERS' fingerprints but NOT
   * their versions — a shared table is no composite's own knob, so it versions itself and
   * the fingerprint carries the transitive effect (same principle as composites). Lives in
   * the config + the settings UI, NOT the report footer (which stays one line).
   */
  version: string;
  definition: string;
  /** STRUCTURE, never user-editable: selects the match algorithm (count vs country). */
  input: "count" | "country";
  default: number; // 0..100
  rows: LookupRow[];
}

export type LookupTables = Record<string, LookupTable>;

/**
 * A catalogue variable (Stage D): a per-supplier scalar RESOLVED OUTSIDE the evaluator and
 * injected into env[id]. `lookup` variables declare `table` + `key` (the source field); their
 * missing-value default is the TABLE's own default (single-source, not re-declared here).
 * `computed` variables (cost_premium — a Stage G partition) declare an explicit `default`.
 */
export interface CatalogueVariable {
  label: string;
  kind: "lookup" | "computed";
  table?: string;
  key?: string;
  resolver?: string;
  default?: number;
}
export type CatalogueVariables = Record<string, CatalogueVariable>;

export interface RiskModel {
  /** Config FILE-FORMAT version, separate from the per-composite content versions. */
  schemaVersion: string;
  /**
   * Named value curves referenced by `provenance: "lookup"` components (Stage A). A table
   * is SHARED when its id appears on more than one component — concentration_curve backs
   * both risk composites' concentration terms.
   */
  lookupTables: LookupTables;
  /**
   * The formula namespace (Stage D): variable id -> resolver spec, referenced by component
   * formulas and resolved to per-supplier scalars outside the evaluator. Optional so pre-Stage-D
   * configs still type; the shipped config always carries it.
   */
  variables?: CatalogueVariables;
  composites: RiskComposite[];
}

/** Frozen default content for a lookup table (default value + rows). NOT its `version`
 * (reset bumps the version like any save) and NOT input/label (structural/display,
 * preserved from the live config). */
export interface LookupTableDefault {
  default: number;
  rows: LookupRow[];
}

/** Frozen defaults: editable knobs (weight + enabled) per composite/component AND the
 * content (default + rows) per lookup table. The reset target — the same source the
 * byte-identical baseline is defined against. Reset restores BOTH, so a table edit cannot
 * survive "reset to defaults" (a partial reset that reports success is worse than none). */
export interface RiskModelDefaults {
  composites: Record<string, Record<string, { weight: number; enabled: boolean }>>;
  lookupTables: Record<string, LookupTableDefault>;
}

/** Float tolerance for the "weights sum to 1.0" checks (mirrors the Python side). */
export const WEIGHT_SUM_TOL = 1e-9;

export const RISK_MODEL: RiskModel = riskModelJson as unknown as RiskModel;
export const RISK_MODEL_DEFAULTS: RiskModelDefaults = defaultsJson as unknown as RiskModelDefaults;

/** Config schema (file-format) version from config/risk-model.json. */
export const RISK_MODEL_SCHEMA_VERSION: string = RISK_MODEL.schemaVersion;

// Deterministic canonical serialization (recursively key-sorted) so a fingerprint
// depends only on values, never on key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// FNV-1a 32-bit hash — not cryptographic, just a stable content fingerprint.
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The direct dependencies of a composite — the composites that PRODUCE its built-in
 * sub-scores — derived from each component's `configuredIn`. Sorted + deduped. This is
 * the single, config-declared source of the dependency graph (no separate dependsOn
 * field to drift). supplyRisk / performanceRisk have none today.
 */
export function dependenciesOf(composite: RiskComposite): string[] {
  const deps = new Set<string>();
  for (const c of composite.components) if (c.configuredIn) deps.add(c.configuredIn);
  return [...deps].sort();
}

/** The whitelisted formula functions (mirrors python/formula_eval.ALLOWED_FUNCS). They are
 * RESERVED — never variable ids — so any identifier that is NOT one of them is a variable. */
const RESERVED_FORMULA_FUNCS = new Set(["min", "max", "abs", "sqrt"]);
// Matches a numeric literal (integer / decimal / scientific) OR an identifier, alternation
// number-first so the exponent letter of `1e5` is consumed as part of the number and never
// captured as a name. Only the identifier alternative captures (group 1).
const FORMULA_TOKEN_RE = /(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * The variable ids a formula references — every identifier that is not a whitelisted function
 * name (min/max/abs/sqrt), deduped and SORTED. The TS mirror of
 * python/formula_eval.referenced_names for the fingerprint projection + the settings UI: the two
 * implementations only have to agree on which names are VARIABLES, not on how a formula evaluates
 * (only TS computes the fingerprint). Returned sorted so any collection built from it is order-
 * independent (Prerequisite P addition 1).
 */
export function referencedVariables(formula: string): string[] {
  const out = new Set<string>();
  for (const m of formula.matchAll(FORMULA_TOKEN_RE)) {
    const ident = m[1];
    if (ident && !RESERVED_FORMULA_FUNCS.has(ident)) out.add(ident);
  }
  return [...out].sort();
}

/**
 * The lookup tables a component's formula reads, via formula -> referenced variables -> each
 * lookup variable's `table`, deduped and SORTED by table id. Replaces the dropped
 * `component.lookupTable` field (Prerequisite P): a composed formula can read several tables,
 * which one field could not represent. Empty for a built-in sub-score (no formula) or a
 * computed-only formula (cost_premium). Used by consumersOfTable + the settings-UI badge, and
 * mirrors the table set projectComponentFormula inlines into the fingerprint.
 */
export function componentTableRefs(
  component: { formula?: string },
  variables: CatalogueVariables,
): string[] {
  if (!component.formula) return [];
  const ids = new Set<string>();
  for (const id of referencedVariables(component.formula)) {
    const v = variables[id];
    if (v?.kind === "lookup" && v.table) ids.add(v.table);
  }
  return [...ids].sort();
}

/**
 * The components that reference a given lookup table, as "compositeId.componentId" strings
 * (sorted). A table with MORE THAN ONE consumer is SHARED: concentration_curve returns both
 * "performanceRisk.roster_concentration" and "supplyRisk.supply_concentration". The settings
 * grid (Stage B) uses this to name every composite an edit will move, so nobody edits a
 * shared curve thinking it is local to one composite. Resolved through each component's formula
 * -> variables -> table (componentTableRefs) since Prerequisite P dropped component.lookupTable;
 * there is no stored consumer list to drift.
 */
export function consumersOfTable(
  tableId: string,
  composites: RiskComposite[],
  variables: CatalogueVariables,
): string[] {
  const out: string[] = [];
  for (const composite of composites) {
    for (const c of composite.components) {
      if (componentTableRefs(c, variables).includes(tableId)) out.push(`${composite.id}.${c.id}`);
    }
  }
  return out.sort();
}

// Compute-affecting content of a lookup table's default + rows, keyed by row key with
// members sorted — depends only on the MAPPING, never on row/member order. Shared by the
// fingerprint projection AND table-edit change detection so they can never disagree on
// what "the same table" means.
function projectTableContent(dflt: number, rows: LookupRow[]): Record<string, unknown> {
  const projRows: Record<string, unknown> = {};
  for (const r of rows) {
    projRows[String(r.key)] = r.members
      ? { value: r.value, members: [...r.members].sort() }
      : { value: r.value };
  }
  return { default: dflt, rows: projRows };
}

// COMPUTE-AFFECTING projection of ONE lookup table: input mode + its content. `version`
// and label/definition are EXCLUDED — a version bump or relabel must not move a score's
// fingerprint, so "fingerprint changed" == "a value or member assignment changed".
function projectLookupTable(table: LookupTable): Record<string, unknown> {
  return { input: table.input, ...projectTableContent(table.default, table.rows) };
}

// COMPUTE-AFFECTING projection of ONE formula-defined component (Prerequisite P): its formula
// string, its normalization bounds, the compute-affecting spec of each referenced variable (a
// lookup carries {key, table} — the var->table linkage, which is itself compute-affecting since
// swapping which table a variable reads changes the score — a computed carries {resolver,
// default}), and the resolved content of every lookup table those variables read. Returns
// undefined for a built-in sub-score, which has no formula and contributes only enabled+weight,
// exactly as before P.
//
// DETERMINISM (P addition 1): a formula may reference SEVERAL tables. `vars` is in referenced-
// variable-id order (referencedVariables sorts) and `tables` is EXPLICITLY sorted by table id and
// deduped, so the projection — and thus the hash — is identical regardless of the order the
// variables appear in the formula string. The explicit `.sort()` is load-bearing; do not rely on
// canonical()'s incidental key-sort (arrays preserve order). Guarded by scripts/fingerprint_check.ts.
function projectComponentFormula(
  component: RiskComponent,
  variables: CatalogueVariables,
  lookupTables: LookupTables,
): Record<string, unknown> | undefined {
  if (!component.formula) return undefined;
  const bounds = component.bounds ?? { lo: 0, hi: 100 };
  const tableIds = new Set<string>();
  const vars = referencedVariables(component.formula).map((id) => {
    const v = variables[id];
    if (!v) return { id, missing: true };
    if (v.kind === "lookup") {
      if (v.table) tableIds.add(v.table);
      return { id, kind: "lookup", key: v.key ?? null, table: v.table ?? null };
    }
    return { id, kind: "computed", resolver: v.resolver ?? null, default: v.default ?? null };
  });
  const tables = [...tableIds].sort().map((tid) => {
    const t = lookupTables[tid];
    // `missing` keeps the projection defined if a reference dangles (a malformed edit) rather
    // than silently dropping the table.
    return t ? { id: tid, ...projectLookupTable(t) } : { id: tid, missing: true };
  });
  return { formula: component.formula, bounds: { lo: bounds.lo, hi: bounds.hi }, vars, tables };
}

// COMPUTE-AFFECTING projection of ONE composite: only the fields that change a score —
// invertPolarity, the derived dependency list, and per component {enabled, weight, and — for a
// formula-defined component — its formula + bounds + referenced-variable specs + resolved tables
// (projectComponentFormula)}. Deliberately excludes label/definition/provenance/builtin/
// polarityLabel/shortLabel/version.
// (Stage A inlined the resolved lookup values under each lookup component; Prerequisite P, schema
// 2.2.0, replaced that with formula + bounds + the variable defs and DROPPED the per-component
// lookupTable field, resolving tables through formula -> variables -> table. Editing a SHARED
// table (concentration_curve) still moves EVERY consumer's fingerprint — supplyRisk AND
// performanceRisk directly, performanceComposite transitively through its risk_score dependency.)
function projectComputeAffecting(
  composite: RiskComposite,
  lookupTables: LookupTables,
  variables: CatalogueVariables,
): Record<string, unknown> {
  const components: Record<string, unknown> = {};
  for (const c of composite.components) {
    // A DISABLED component's weight is dropped by resolveEffectiveWeights, so it reaches
    // no score — project only {enabled:false} so the fingerprint tracks EXACTLY the values
    // that determine the numbers. Editing a parked (disabled) weight, formula, or its table
    // must not move the fingerprint; it would otherwise bump a version + trigger a recompute
    // for byte-identical output.
    if (!c.enabled) {
      components[c.id] = { enabled: false };
      continue;
    }
    const entry: Record<string, unknown> = { enabled: true, weight: c.weight };
    const formulaProj = projectComponentFormula(c, variables, lookupTables);
    if (formulaProj) Object.assign(entry, formulaProj);
    components[c.id] = entry;
  }
  return {
    invertPolarity: composite.invertPolarity,
    dependsOn: dependenciesOf(composite),
    components,
  };
}

/**
 * Whole-config fingerprint over the compute-affecting projection of ALL composites — the
 * report-footer stamp and the drift anchor. Changes iff some score-determining value
 * changes anywhere (a weight/enabled/dependency edit, a lookup-table value, or — since
 * Prerequisite P — a formula, bounds, or referenced-variable edit), even if a version bump
 * was forgotten. Independent of labels and version strings.
 */
export function configFingerprint(
  composites: RiskComposite[],
  lookupTables: LookupTables,
  variables: CatalogueVariables,
): string {
  const proj: Record<string, unknown> = {};
  for (const c of composites) proj[c.id] = projectComputeAffecting(c, lookupTables, variables);
  return fnv1a(canonical(proj));
}

/**
 * Dependency-aware fingerprint of ONE composite: over its own compute-affecting
 * projection AND the projections of its transitive dependencies. Editing performanceRisk
 * changes performanceComposite's fingerprint even though its own components are untouched
 * — the settings UI shows this per composite for audit granularity. Cycle-guarded per
 * path (the graph is a DAG today).
 */
export function compositeFingerprint(
  id: string,
  composites: RiskComposite[],
  lookupTables: LookupTables,
  variables: CatalogueVariables,
): string {
  const byId = new Map<string, RiskComposite>(composites.map((c) => [c.id, c]));
  const build = (cid: string, path: Set<string>): unknown => {
    if (path.has(cid)) return { cycle: cid };
    const c = byId.get(cid);
    if (!c) return { missing: cid };
    const next = new Set(path).add(cid);
    const deps: Record<string, unknown> = {};
    for (const d of dependenciesOf(c)) deps[d] = build(d, next);
    return { self: projectComputeAffecting(c, lookupTables, variables), deps };
  };
  return fnv1a(canonical(build(id, new Set())));
}

/** Build-time whole-config fingerprint of the bundled config (a fallback default). */
export const RISK_MODEL_FINGERPRINT: string = configFingerprint(
  RISK_MODEL.composites,
  RISK_MODEL.lookupTables,
  RISK_MODEL.variables ?? {},
);

/**
 * Next per-composite version on save: bump the patch segment of a semver string
 * (1.0.0 -> 1.0.1). Pure + monotonic. A non-semver legacy value starts a fresh patch
 * line at 1.0.1 so the value still changes on save.
 */
export function nextVersion(current: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current.trim());
  if (m) return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  return "1.0.1";
}

/** A minimal per-composite edit payload (id + component enabled/weight). */
export interface CompositeEdit {
  id: string;
  components: { id: string; enabled: boolean; weight: number }[];
}

/**
 * Merge weight/enabled edits into the current config and bump the version of ONLY the
 * composites whose own components actually changed — saving one composite must never
 * bump another. Returns the merged model + the ids that changed. Pure; the route does
 * the file write + recompute. schemaVersion and all display fields are preserved.
 */
export function mergeAndBumpVersions(
  current: RiskModel,
  edits: CompositeEdit[],
): { merged: RiskModel; changedIds: string[] } {
  const editById = new Map(
    edits.map((e) => [e.id, new Map(e.components.map((c) => [c.id, c]))]),
  );
  const changedIds: string[] = [];
  const composites = current.composites.map((composite) => {
    const compEdits = editById.get(composite.id);
    if (!compEdits) return composite;
    let changed = false;
    const components = composite.components.map((comp) => {
      const e = compEdits.get(comp.id);
      if (!e) return comp;
      if (e.enabled !== comp.enabled || e.weight !== comp.weight) changed = true;
      return { ...comp, enabled: e.enabled, weight: e.weight };
    });
    if (!changed) return { ...composite, components };
    changedIds.push(composite.id);
    return { ...composite, components, version: nextVersion(composite.version) };
  });
  return { merged: { ...current, composites }, changedIds };
}

/** A per-table edit payload: the table id + its full editable content (default + rows). */
export interface LookupTableEdit {
  id: string;
  default: number;
  rows: LookupRow[];
}

/**
 * True iff two lookup-table CONTENTS (default + rows) are compute-equal — same mapping,
 * ignoring row and member order. This is the EXACT test mergeAndBumpTableVersions uses to
 * decide a version bump, exported so the settings UI's dirty detection matches the server's
 * decision: a member reorder is not a change (won't enable Save, won't bump a version).
 */
export function tableContentEqual(
  aDefault: number,
  aRows: LookupRow[],
  bDefault: number,
  bRows: LookupRow[],
): boolean {
  return (
    canonical(projectTableContent(aDefault, aRows)) ===
    canonical(projectTableContent(bDefault, bRows))
  );
}

/**
 * Normalize a table edit to canonical storage: for a country table, members are trimmed,
 * upper-cased, empties dropped and de-duped (so "vn" and " VN " never coexist and the
 * fingerprint is stable); keys trimmed. For a count table, keys are coerced to integers.
 * Values/default untouched. Does NOT validate — call lookupTableError for that.
 */
export function normalizeLookupTableEdit(
  edit: LookupTableEdit,
  input: "count" | "country",
): LookupTableEdit {
  const rows: LookupRow[] = edit.rows.map((r) => {
    if (input === "country") {
      const seen = new Set<string>();
      const members: string[] = [];
      for (const m of r.members ?? []) {
        const code = String(m).trim().toUpperCase();
        if (code && !seen.has(code)) {
          seen.add(code);
          members.push(code);
        }
      }
      return { key: String(r.key).trim(), value: r.value, members };
    }
    return { key: Number(r.key), value: r.value };
  });
  return { id: edit.id, default: edit.default, rows };
}

/**
 * Non-throwing validation of a lookup table's content — used by BOTH the settings UI (inline
 * errors, block save) and the save route (400). Enforces: every value (rows + default) a
 * number in [0,100]; row keys present + unique; for a `count` table the integer keys are
 * CONTIGUOUS from 0 (a gap would silently fall through to the default — "no risk" for a real
 * count); for a `country` table the members are DISJOINT across rows (else the code->row
 * match is order-dependent and the score non-deterministic w.r.t. config order). A member
 * matching no current supplier is NOT an error (it may be anticipated onboarding). Mirrors
 * python/risk_config.validate_lookup_table. Returns a message, or null when valid.
 */
export function lookupTableError(table: {
  input: string;
  default: number;
  rows: LookupRow[];
}): string | null {
  const inRange = (v: number) => Number.isFinite(v) && v >= 0 && v <= 100;
  if (!inRange(table.default)) return "The default value must be a number between 0 and 100.";
  const keys = new Set<string>();
  for (const r of table.rows) {
    const k = String(r.key).trim();
    if (k === "") return "Every row needs a key.";
    if (keys.has(k)) return `Duplicate row key "${k}".`;
    keys.add(k);
    if (!inRange(r.value)) return `Row "${k}": the value must be a number between 0 and 100.`;
  }
  if (table.input === "count") {
    const ints = table.rows.map((r) => Number(r.key));
    if (ints.some((n) => !Number.isInteger(n) || n < 0)) {
      return "Count rows must have whole-number keys of 0 or more.";
    }
    const sorted = [...ints].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i) {
        return `Count rows must be contiguous from 0 (missing ${i}); a gap would fall through to the default.`;
      }
    }
  } else {
    const seen = new Map<string, string>();
    for (const r of table.rows) {
      for (const m of r.members ?? []) {
        const code = String(m).trim().toUpperCase();
        if (!code) continue;
        const prior = seen.get(code);
        if (prior !== undefined && prior !== String(r.key)) {
          return `"${code}" is in both "${prior}" and "${r.key}" — members must be disjoint (the match would be order-dependent).`;
        }
        seen.set(code, String(r.key));
      }
    }
  }
  return null;
}

/**
 * Merge lookup-table edits into the config, bumping the `version` of ONLY the tables whose
 * compute-affecting content (default/rows/members) actually changed. A shared table
 * (concentration_curve) versions ITSELF here; NO composite version is bumped — the
 * consumers' fingerprints already carry the effect. input/label/definition are preserved;
 * an edit for an unknown table id is ignored (tables are curated, never created by an edit).
 * Pure; the route does the file write + recompute.
 */
export function mergeAndBumpTableVersions(
  current: RiskModel,
  edits: LookupTableEdit[],
): { merged: RiskModel; changedIds: string[] } {
  const editById = new Map(edits.map((e) => [e.id, e]));
  const changedIds: string[] = [];
  const lookupTables: LookupTables = { ...current.lookupTables };
  for (const [id, table] of Object.entries(current.lookupTables)) {
    const edit = editById.get(id);
    if (!edit) continue;
    const before = canonical(projectTableContent(table.default, table.rows));
    const after = canonical(projectTableContent(edit.default, edit.rows));
    if (before === after) continue; // no compute-affecting change → no version bump
    changedIds.push(id);
    lookupTables[id] = {
      ...table,
      default: edit.default,
      rows: edit.rows,
      version: nextVersion(table.version),
    };
  }
  return { merged: { ...current, lookupTables }, changedIds };
}

/**
 * Roster inputs for per-row lookup coverage (how many suppliers each row / the default
 * matches). Server-derived from the Supplier roster and passed to the settings UI so a
 * never-firing row is visible WHILE editing. `countryCounts[CODE]` = # suppliers with that
 * country; `concentrationDist[k]` = # suppliers whose category has k OTHER members.
 */
export interface LookupCoverageInputs {
  totalSuppliers: number;
  countryCounts: Record<string, number>;
  concentrationDist: Record<number, number>;
}

/**
 * Per-row + default coverage for a table's CURRENT (draft) rows against the roster. Pure +
 * client-safe, so it recomputes as the user edits members and a 0-coverage (never-fires)
 * row shows immediately. Country: sum of countryCounts over each row's members (normalized
 * upper/trim); default = suppliers whose country is in no row. Count: concentrationDist at
 * each integer key; default = suppliers whose other-count is not a listed key.
 */
export function lookupCoverage(
  input: "count" | "country",
  rows: LookupRow[],
  inputs: LookupCoverageInputs,
): { perRow: number[]; default: number } {
  if (input === "country") {
    let matched = 0;
    const perRow = rows.map((r) => {
      let c = 0;
      for (const m of r.members ?? []) c += inputs.countryCounts[String(m).trim().toUpperCase()] ?? 0;
      matched += c;
      return c;
    });
    return { perRow, default: Math.max(0, inputs.totalSuppliers - matched) };
  }
  const listed = new Set(rows.map((r) => Number(r.key)));
  const perRow = rows.map((r) => inputs.concentrationDist[Number(r.key)] ?? 0);
  let dflt = 0;
  for (const [k, n] of Object.entries(inputs.concentrationDist)) {
    if (!listed.has(Number(k))) dflt += n;
  }
  return { perRow, default: dflt };
}

/**
 * The report-footer stamp: schema version, the whole-config fingerprint, and each
 * composite's compact label + version. All versions present and resolvable; one line.
 */
export interface ConfigStamp {
  schemaVersion: string;
  fingerprint: string;
  composites: { id: string; shortLabel: string; version: string }[];
}

export function buildConfigStamp(model: RiskModel): ConfigStamp {
  return {
    schemaVersion: model.schemaVersion,
    fingerprint: configFingerprint(model.composites, model.lookupTables, model.variables ?? {}),
    composites: model.composites.map((c) => ({
      id: c.id,
      shortLabel: c.shortLabel,
      version: c.version,
    })),
  };
}

/** The composite half of the footer line: "performance v1.0.0 · perf-risk v1.0.0 · …".
 * Degrades gracefully — N composites produce N tokens. */
export function formatStampComposites(stamp: ConfigStamp): string {
  return stamp.composites.map((c) => `${c.shortLabel} v${c.version}`).join(" · ");
}

export function getComposite(id: RiskComposite["id"]): RiskComposite {
  const composite = RISK_MODEL.composites.find((c) => c.id === id);
  if (!composite) throw new Error(`risk-model.json: no composite '${id}'`);
  return composite;
}

/**
 * Reject a config whose declared component weights don't sum to 1.0 within tolerance.
 * The error names the composite. Checks the authored config is coherent; the enabled
 * subset is renormalized to 1.0 separately by resolveEffectiveWeights.
 */
export function validateComposite(composite: RiskComposite, tol = WEIGHT_SUM_TOL): void {
  const total = composite.components.reduce((sum, c) => sum + c.weight, 0);
  if (Math.abs(total - 1) > tol) {
    throw new Error(
      `risk-model composite '${composite.id}': component weights sum to ${total}, expected 1.0 (within ${tol})`,
    );
  }
}

/**
 * THE renormalization function — used by all composites. Returns
 * { componentId -> effective weight } over the ENABLED components, dividing each by
 * the enabled total so the result sums to 1.0 (disabled weight redistributed
 * proportionally). Throws if every component is disabled. With all enabled and the
 * declared weights summing to 1.0, the divisor is exactly 1.0 — a no-op.
 */
export function resolveEffectiveWeights(composite: RiskComposite): Record<string, number> {
  const enabled = composite.components.filter((c) => c.enabled);
  if (enabled.length === 0) {
    throw new Error(
      `risk-model composite '${composite.id}': all components disabled - cannot compute a score`,
    );
  }
  const total = enabled.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) {
    throw new Error(
      `risk-model composite '${composite.id}': enabled weights sum to ${total} (must be > 0)`,
    );
  }
  const out: Record<string, number> = {};
  for (const c of enabled) out[c.id] = c.weight / total;
  return out;
}

export function invertPolarity(composite: RiskComposite): boolean {
  return composite.invertPolarity;
}

/**
 * Fold the summed weighted contributions into a final 0..100 score. invert=true applies
 * the 100-minus inversion (performance risk: higher = safer); invert=false leaves it
 * as-is (supply risk: higher = riskier). Then clamp to [0, 100].
 */
export function combineScore(contributionSum: number, invert: boolean): number {
  const raw = invert ? 100 - contributionSum : contributionSum;
  return Math.min(100, Math.max(0, raw));
}
