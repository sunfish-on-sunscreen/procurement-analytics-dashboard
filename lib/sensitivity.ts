/**
 * Client-safe types + pure logic for the weight-sensitivity snapshot (Stage C).
 *
 * Sensitivity is the ONE sanctioned snapshot (analytics is otherwise recompute-on-read):
 * the drop-one analysis costs ~60s and runs N+1 full recomputes, so it is persisted, STAMPED
 * with the whole-config fingerprint that produced it, and treated as STALE on mismatch. Its
 * validity is whole-config, never per-composite — any save invalidates all of it (one stamp,
 * one rerun). This module owns the fresh/stale/absent decision the page renders; the server
 * read/write + the Python run live in lib/sensitivity-server.ts + lib/python.ts.
 */

/** One drop-one measurement. `rho` is always present; the churn fields depend on the group
 * (composite/performanceRisk carry zone_*, supplyRisk carries quad_*). */
export interface SensitivityDrop {
  dropped: string;
  rho: number;
  n: number;
  zone_pct?: number;
  zone_changed?: number;
  zone_n?: number;
  quad_pct?: number;
  quad_changed?: number;
  quad_n?: number;
  kraljic_pct?: number;
}

export interface SensitivityWindow {
  label: string;
  n_kraljic: number;
  n_zone: number;
  composite: SensitivityDrop[];
  supplyRisk: SensitivityDrop[];
  performanceRisk: SensitivityDrop[];
}

/** The raw payload python/sensitivity.py --json emits. `schema` guards the shape. */
export interface SensitivityData {
  schema: number;
  windows: SensitivityWindow[];
}

/** The persisted snapshot as the page consumes it (the stored row, plainly typed). */
export interface StoredSensitivity {
  configFingerprint: string;
  computedAt: string; // ISO
  data: SensitivityData;
}

/**
 * The render decision for §3.5:
 *  - absent  → never computed under this deployment; show "not yet computed", not blank.
 *  - stale   → a snapshot exists but under a DIFFERENT config fingerprint; show it greyed and
 *              labelled with the fingerprint it belongs to, NEVER as the current configuration.
 *  - fresh   → the snapshot's fingerprint matches the current config; render normally.
 */
export type SensitivityView =
  | { status: "absent" }
  | { status: "stale"; snapshot: StoredSensitivity; currentFingerprint: string }
  | { status: "fresh"; snapshot: StoredSensitivity; currentFingerprint: string };

export function sensitivityView(
  stored: StoredSensitivity | null,
  currentFingerprint: string,
): SensitivityView {
  if (!stored) return { status: "absent" };
  return stored.configFingerprint === currentFingerprint
    ? { status: "fresh", snapshot: stored, currentFingerprint }
    : { status: "stale", snapshot: stored, currentFingerprint };
}

export function windowByLabel(
  data: SensitivityData,
  label: string,
): SensitivityWindow | undefined {
  return data.windows.find((w) => w.label === label);
}

/** rho for a named dropped component in a window's group, or null. Used by the prose so a
 * cited number is read from the data, never hardcoded. */
export function dropRho(win: SensitivityWindow | undefined, group: keyof Pick<SensitivityWindow, "composite" | "supplyRisk" | "performanceRisk">, dropped: string): number | null {
  const row = win?.[group].find((d) => d.dropped === dropped);
  return row ? row.rho : null;
}
