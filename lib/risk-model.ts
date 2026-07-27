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
 *  - Fingerprints are DERIVED (never stored), over COMPUTE-AFFECTING fields only
 *    (weights, enabled, invertPolarity, derived dependsOn — NOT labels/definitions/
 *    polarityLabel/version), so "fingerprint changed" means "the numbers changed".
 *  - configFingerprint (whole config) is the report-footer + drift anchor. It covers
 *    everything, including future lookup tables, with no format change.
 *  - compositeFingerprint is dependency-aware (over the composite AND its transitive
 *    deps), so editing performanceRisk changes performanceComposite's fingerprint even
 *    though its own components are untouched — used for settings-UI audit granularity.
 */
import riskModelJson from "@/config/risk-model.json";
import defaultsJson from "@/config/risk-model.defaults.json";

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

export interface RiskModel {
  /** Config FILE-FORMAT version, separate from the per-composite content versions. */
  schemaVersion: string;
  composites: RiskComposite[];
}

/** Frozen default editable knobs (weight + enabled) per composite/component. The reset
 * target — the same source the byte-identical baseline is defined against. */
export type RiskModelDefaults = Record<
  string,
  Record<string, { weight: number; enabled: boolean }>
>;

/** Float tolerance for the "weights sum to 1.0" checks (mirrors the Python side). */
export const WEIGHT_SUM_TOL = 1e-9;

export const RISK_MODEL: RiskModel = riskModelJson as unknown as RiskModel;
export const RISK_MODEL_DEFAULTS: RiskModelDefaults = defaultsJson as RiskModelDefaults;

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

// COMPUTE-AFFECTING projection of ONE composite: only the fields that change a score —
// invertPolarity, the derived dependency list, and per component {enabled, weight}.
// Deliberately excludes label/definition/provenance/builtin/polarityLabel/shortLabel/
// version. (Stage 4 adds bounds / lookup values under each component here.)
function projectComputeAffecting(composite: RiskComposite): Record<string, unknown> {
  const components: Record<string, unknown> = {};
  for (const c of composite.components) {
    // A DISABLED component's weight is dropped by resolveEffectiveWeights, so it reaches
    // no score — omit it so the fingerprint tracks EXACTLY the values that determine the
    // numbers. Editing a parked (disabled) weight must not move the fingerprint; it would
    // otherwise bump a version + trigger a recompute for byte-identical output.
    components[c.id] = c.enabled ? { enabled: true, weight: c.weight } : { enabled: false };
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
 * changes anywhere (incl. a dependency edit, or — in Stage 4 — a lookup value), even if
 * a version bump was forgotten. Independent of labels and version strings.
 */
export function configFingerprint(composites: RiskComposite[]): string {
  const proj: Record<string, unknown> = {};
  for (const c of composites) proj[c.id] = projectComputeAffecting(c);
  return fnv1a(canonical(proj));
}

/**
 * Dependency-aware fingerprint of ONE composite: over its own compute-affecting
 * projection AND the projections of its transitive dependencies. Editing performanceRisk
 * changes performanceComposite's fingerprint even though its own components are untouched
 * — the settings UI shows this per composite for audit granularity. Cycle-guarded per
 * path (the graph is a DAG today).
 */
export function compositeFingerprint(id: string, composites: RiskComposite[]): string {
  const byId = new Map<string, RiskComposite>(composites.map((c) => [c.id, c]));
  const build = (cid: string, path: Set<string>): unknown => {
    if (path.has(cid)) return { cycle: cid };
    const c = byId.get(cid);
    if (!c) return { missing: cid };
    const next = new Set(path).add(cid);
    const deps: Record<string, unknown> = {};
    for (const d of dependenciesOf(c)) deps[d] = build(d, next);
    return { self: projectComputeAffecting(c), deps };
  };
  return fnv1a(canonical(build(id, new Set())));
}

/** Build-time whole-config fingerprint of the bundled config (a fallback default). */
export const RISK_MODEL_FINGERPRINT: string = configFingerprint(RISK_MODEL.composites);

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
    fingerprint: configFingerprint(model.composites),
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
