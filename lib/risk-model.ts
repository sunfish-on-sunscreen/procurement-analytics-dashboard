/**
 * Typed loader for config/risk-model.json — the single source of truth for the two
 * risk composites (supply risk + performance-risk sub-score).
 *
 * The BINDING consumer in Phase 1 is the Python compute (python/risk_config.py); this
 * TS module mirrors its interface + behaviour so the config is consumable from the
 * app's surfaces (methodology page, detail panels) in a later phase. It is not yet
 * wired into any compute — TS currently only renders the Python-produced risk numbers.
 *
 * resolveEffectiveWeights is the renormalization function (the peer of the Python one):
 * it drops disabled components and proportionally redistributes their weight so the
 * result always sums to 1.0, throwing if every component is disabled.
 */
import riskModelJson from "@/config/risk-model.json";

export interface RiskComponent {
  id: string;
  label: string;
  definition: string;
  provenance: "computed" | "lookup";
  enabled: boolean;
  weight: number; // 0..1
}

export interface RiskComposite {
  id: "supplyRisk" | "performanceRisk";
  label: string;
  invertPolarity: boolean;
  components: RiskComponent[];
}

export interface RiskModel {
  /** Human-readable config version, stamped into every printed report. */
  version: string;
  composites: RiskComposite[];
}

/** Float tolerance for the "weights sum to 1.0" checks (mirrors the Python side). */
export const WEIGHT_SUM_TOL = 1e-9;

export const RISK_MODEL: RiskModel = riskModelJson as unknown as RiskModel;

/** Declared config version (from config/risk-model.json). */
export const RISK_MODEL_VERSION: string = RISK_MODEL.version;

// Deterministic canonical serialization (recursively key-sorted) so the fingerprint
// depends only on the weights/enabled/polarity, never on key order or the JSON comment.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// FNV-1a 32-bit hash — not cryptographic, just a stable content fingerprint so a
// report's stamp changes iff a weight/enabled/polarity actually changed.
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Content fingerprint of a set of composites (weights + enabled + polarity),
 * independent of the declared version. Two configs with the same weights share a
 * fingerprint; changing any weight changes it — even if someone forgets to bump
 * `version`. Pure + deterministic, so the server (reading the live file) and the
 * settings UI (previewing an edit) compute the same value.
 */
export function fingerprintComposites(composites: RiskComposite[]): string {
  return fnv1a(canonical(composites));
}

/** Build-time fingerprint of the bundled config (a fallback default). */
export const RISK_MODEL_FINGERPRINT: string = fingerprintComposites(RISK_MODEL.composites);

/**
 * Next config version on save: `rc-{YYYYMMDD}-{n}`, where n increments within a day.
 * If `current` already names today (`rc-{today}-{k}`), returns k+1; otherwise 1. Pure —
 * the caller passes today's date so this stays deterministic and testable.
 */
export function nextConfigVersion(current: string, todayYYYYMMDD: string): string {
  const prefix = `rc-${todayYYYYMMDD}-`;
  let n = 1;
  if (current.startsWith(prefix)) {
    const k = Number.parseInt(current.slice(prefix.length), 10);
    if (Number.isFinite(k) && k >= 1) n = k + 1;
  }
  return `${prefix}${n}`;
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
 * THE renormalization function — used by both composites. Returns
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
