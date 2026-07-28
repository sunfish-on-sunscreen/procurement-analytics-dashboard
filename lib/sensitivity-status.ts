/**
 * Tiny shared client store for the "sensitivity is recomputing" flag (Stage C, phase 2).
 *
 * The config editor (RiskModelSettings) and the §3.5 tables (SensitivityTables) are separate
 * islands on the Methodology page. After a save, the editor auto-runs phase 2 (~60s) and the
 * tables must show a "recomputing" state — so the two coordinate through this module-level
 * store (read via useSyncExternalStore), not props. The server snapshot is always `false`, so
 * SSR/first paint is stable.
 */
let recomputing = false;
const listeners = new Set<() => void>();

export function getSensitivityRecomputing(): boolean {
  return recomputing;
}

export function setSensitivityRecomputing(value: boolean): void {
  if (recomputing === value) return;
  recomputing = value;
  for (const l of listeners) l();
}

export function subscribeSensitivityRecomputing(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
