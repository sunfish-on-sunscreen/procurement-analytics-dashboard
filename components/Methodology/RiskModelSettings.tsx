"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";

import { setSensitivityRecomputing } from "@/lib/sensitivity-status";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  resolveEffectiveWeights,
  configFingerprint,
  compositeFingerprint,
  consumersOfTable,
  componentTableRefs,
  nextVersion,
  normalizeLookupTableEdit,
  WEIGHT_SUM_TOL,
  RISK_MODEL_DEFAULTS,
  type RiskModel,
  type RiskComposite,
  type RiskComponent,
  type ConfigStamp,
  type LookupTableEdit,
  type LookupCoverageInputs,
  type FormulaBounds,
} from "@/lib/risk-model";
import { LookupTableCard } from "@/components/Methodology/LookupTableCard";
import { FormulaEditorCard } from "@/components/Methodology/FormulaEditorCard";
import { CostPremiumPartitionCard } from "@/components/Methodology/CostPremiumPartitionCard";

// The draft keeps each weight as a STRING so the input types smoothly ("0.", "0.5");
// it is parsed to a number for the live renormalization + validation.
type DraftComponent = Omit<RiskComponent, "weight"> & { weightStr: string };
type DraftComposite = Omit<RiskComposite, "components"> & { components: DraftComponent[] };

function toDraftComposite(c: RiskComposite): DraftComposite {
  return { ...c, components: c.components.map((comp) => ({ ...comp, weightStr: String(comp.weight) })) };
}

function toDraft(composites: RiskComposite[]): DraftComposite[] {
  return composites.map(toDraftComposite);
}

// A draft composite -> a real RiskComposite (weights parsed; NaN for bad input). Display
// + versioning fields (shortLabel, version, polarityLabel, builtin, configuredIn) are
// carried through unchanged — the UI never edits them; the server preserves them on save.
function parse(d: DraftComposite): RiskComposite {
  return {
    id: d.id,
    label: d.label,
    shortLabel: d.shortLabel,
    version: d.version,
    invertPolarity: d.invertPolarity,
    polarityLabel: d.polarityLabel,
    components: d.components.map((c) => ({
      id: c.id,
      label: c.label,
      definition: c.definition,
      provenance: c.provenance,
      enabled: c.enabled,
      weight: Number.parseFloat(c.weightStr),
      builtin: c.builtin,
      configuredIn: c.configuredIn,
      formula: c.formula,
      bounds: c.bounds,
    })),
  };
}

// Non-throwing mirror of the server checks (validateComposite + the resolve guard),
// so guard/validation problems render as inline messages instead of crashing.
type Status = {
  effective: Record<string, number> | null;
  declaredSum: number;
  error: string | null;
};

function statusOf(c: RiskComposite): Status {
  const hasNaN = c.components.some((x) => !Number.isFinite(x.weight));
  const enabled = c.components.filter((x) => x.enabled);
  const declaredSum = c.components.reduce(
    (s, x) => s + (Number.isFinite(x.weight) ? x.weight : 0),
    0,
  );
  if (hasNaN) return { effective: null, declaredSum, error: "Every weight must be a number." };
  if (enabled.length === 0)
    return { effective: null, declaredSum, error: "At least one component must be enabled." };
  if (Math.abs(declaredSum - 1) > WEIGHT_SUM_TOL)
    return {
      effective: null,
      declaredSum,
      error: `Declared weights must sum to 100% (currently ${(declaredSum * 100).toFixed(1)}%).`,
    };
  try {
    return { effective: resolveEffectiveWeights(c), declaredSum, error: null };
  } catch (e) {
    return { effective: null, declaredSum, error: e instanceof Error ? e.message : "Invalid." };
  }
}

const pct = (w: number) => `${(w * 100).toFixed(1)}%`;

// Compare a component (weight+enabled) against a {weight,enabled} target.
function sameKnobs(
  a: { enabled: boolean; weight: number },
  b: { enabled: boolean; weight: number } | undefined,
): boolean {
  return !!b && a.enabled === b.enabled && a.weight === b.weight;
}

export function RiskModelSettings({
  initialModel,
  coverageInputs,
}: {
  initialModel: RiskModel;
  coverageInputs: LookupCoverageInputs;
}) {
  const [active, setActive] = useState<RiskModel>(initialModel);
  const [draft, setDraft] = useState<DraftComposite[]>(() => toDraft(initialModel.composites));
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(initialModel.composites.map((c) => c.id)),
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [confirmingResetId, setConfirmingResetId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string | null>>({});
  // Stage F: which draft component's formula overlay is open ({composite index, component index}).
  const [formulaEdit, setFormulaEdit] = useState<{ ci: number; cj: number } | null>(null);

  const router = useRouter();
  // Phase 2 of the two-phase save: after ANY successful config save, auto-run the sensitivity
  // analysis (~60s) and drive the shared "recomputing" flag the §3.5 tables read. Serialized
  // via refs (never awaited from a save, so the Save button returns immediately): a save during
  // a run sets `pending`, and the loop re-runs once more against the newest config so the final
  // stamp matches. router.refresh() re-renders §3.5 from the fresh snapshot (or, on failure,
  // as stale — the config changed but the snapshot did not).
  const sensRunning = useRef(false);
  const sensPending = useRef(false);
  async function triggerSensitivity() {
    if (sensRunning.current) {
      sensPending.current = true;
      return;
    }
    sensRunning.current = true;
    setSensitivityRecomputing(true);
    try {
      do {
        sensPending.current = false;
        const res = await fetch("/api/risk-model/sensitivity", { method: "POST" });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(data.error ?? "Sensitivity recompute failed.");
        }
      } while (sensPending.current);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sensitivity recompute failed.");
    } finally {
      sensRunning.current = false;
      setSensitivityRecomputing(false);
      router.refresh();
    }
  }

  const parsed = draft.map(parse);
  const statuses = parsed.map(statusOf);
  const configFp = configFingerprint(active.composites, active.lookupTables, active.variables ?? {});

  // Per-composite dirty: any component's weight/enabled differs from the SAVED (active).
  function isDirty(i: number): boolean {
    const a = active.composites[i];
    if (!a) return true;
    return draft[i].components.some((comp, j) => {
      const ac = a.components[j];
      return (
        !ac ||
        comp.enabled !== ac.enabled ||
        Number.parseFloat(comp.weightStr) !== ac.weight ||
        comp.formula !== ac.formula ||
        comp.bounds?.lo !== ac.bounds?.lo ||
        comp.bounds?.hi !== ac.bounds?.hi
      );
    });
  }

  // Is the SAVED composite already at its shipped defaults? (Reset is offered only when not.)
  function activeAtDefaults(i: number): boolean {
    const a = active.composites[i];
    const defs = RISK_MODEL_DEFAULTS.composites[a.id];
    if (!defs) return true;
    return a.components.every((c) => sameKnobs(c, defs[c.id]));
  }

  // A composite whose knobs are the shipped defaults (for reset-to-defaults save).
  function defaultComposite(i: number): RiskComposite {
    const a = active.composites[i];
    const defs = RISK_MODEL_DEFAULTS.composites[a.id] ?? {};
    return {
      ...a,
      components: a.components.map((c) =>
        defs[c.id] ? { ...c, enabled: defs[c.id].enabled, weight: defs[c.id].weight } : c,
      ),
    };
  }

  function setComponent(ci: number, cj: number, patch: Partial<DraftComponent>) {
    setDraft((prev) =>
      prev.map((c, i) =>
        i !== ci
          ? c
          : { ...c, components: c.components.map((x, j) => (j === cj ? { ...x, ...patch } : x)) },
      ),
    );
  }

  function toggleOpen(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Save ONE composite: sends only that composite so the server bumps only its version
  // (a per-composite Save must never bump another). On success, updates the saved (active)
  // state — which also re-derives every dependent composite's fingerprint.
  async function saveComposite(composite: RiskComposite) {
    setSavingId(composite.id);
    setErrorById((e) => ({ ...e, [composite.id]: null }));
    try {
      const payload = {
        composites: [
          {
            id: composite.id,
            components: composite.components.map((x) => ({
              id: x.id,
              enabled: x.enabled,
              weight: x.weight,
              // Formula + bounds are sent only for formula-defined components; the server rejects
              // a formula edit on a builtin sub-score anyway.
              ...(x.builtin ? {} : { formula: x.formula, bounds: x.bounds }),
            })),
          },
        ],
      };
      const res = await fetch("/api/risk-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        stamp?: ConfigStamp;
        changedIds?: string[];
        error?: string;
      };
      if (!res.ok) {
        setErrorById((e) => ({ ...e, [composite.id]: data.error ?? "Save failed." }));
        toast.error(data.error ?? "Save failed.");
        return;
      }
      const newVersion =
        data.stamp?.composites.find((c) => c.id === composite.id)?.version ?? composite.version;
      const saved: RiskComposite = { ...composite, version: newVersion };
      setActive((prev) => ({
        ...prev,
        schemaVersion: data.stamp?.schemaVersion ?? prev.schemaVersion,
        composites: prev.composites.map((c) => (c.id === composite.id ? saved : c)),
      }));
      setDraft((prev) => prev.map((d) => (d.id === composite.id ? toDraftComposite(saved) : d)));
      toast.success(`Saved ${composite.label} (v${newVersion}). All periods recomputed.`);
      void triggerSensitivity();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Network error.";
      setErrorById((err) => ({ ...err, [composite.id]: msg }));
      toast.error(msg);
    } finally {
      setSavingId(null);
    }
  }

  // Discard: revert this composite's unsaved draft to the SAVED state. Client-only.
  function handleDiscard(i: number) {
    const id = draft[i].id;
    setDraft((prev) => prev.map((d, j) => (j === i ? toDraftComposite(active.composites[i]) : d)));
    setErrorById((e) => ({ ...e, [id]: null }));
    if (confirmingResetId === id) setConfirmingResetId(null);
  }

  // Reset to defaults: restore the shipped values AND persist — it IS a save (bumps the
  // version, recomputes), because it changes persisted configuration and must be recorded.
  async function handleReset(i: number) {
    const dc = defaultComposite(i);
    setDraft((prev) => prev.map((d, j) => (j === i ? toDraftComposite(dc) : d)));
    setConfirmingResetId(null);
    await saveComposite(dc);
  }

  // Readable consumer descriptors for a lookup table ("supply-risk · Supply concentration"),
  // derived from consumersOfTable (never hardcoded) so a shared table names both consumers.
  function consumerDescriptors(tableId: string): string[] {
    return consumersOfTable(tableId, active.composites, active.variables ?? {}).map((ref) => {
      const [cid, compId] = ref.split(".");
      const composite = active.composites.find((c) => c.id === cid);
      const component = composite?.components.find((x) => x.id === compId);
      return `${composite?.shortLabel ?? cid} · ${component?.label ?? compId}`;
    });
  }

  // Save ONE lookup table (its own scope — a shared table cannot be saved by a composite's
  // Save button). Shares the global `savingId` lock so no two recomputes overlap. On success
  // updates active with the normalized content + the bumped table version (deterministic —
  // the server bumps identically), which re-derives the whole-config fingerprint and remounts
  // the card (keyed by version). Returns an error message, or null on success.
  async function saveTable(id: string, edit: LookupTableEdit): Promise<string | null> {
    setSavingId(id);
    try {
      const res = await fetch("/api/risk-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookupTables: [edit] }),
      });
      const data = (await res.json()) as { changedIds?: string[]; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Save failed.");
        return data.error ?? "Save failed.";
      }
      const label = active.lookupTables[id]?.label ?? id;
      setActive((prev) => {
        const table = prev.lookupTables[id];
        if (!table) return prev;
        const norm = normalizeLookupTableEdit(edit, table.input);
        const changed = (data.changedIds ?? []).includes(id);
        return {
          ...prev,
          lookupTables: {
            ...prev.lookupTables,
            [id]: {
              ...table,
              default: norm.default,
              rows: norm.rows,
              version: changed ? nextVersion(table.version) : table.version,
            },
          },
        };
      });
      toast.success(`Saved ${label}. All periods recomputed.`);
      void triggerSensitivity();
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Network error.";
      toast.error(msg);
      return msg;
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Active whole-config identity — schema + the fingerprint printed reports carry. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Active configuration</span>
        <Badge variant="secondary">schema v{active.schemaVersion}</Badge>
        <span className="text-muted-foreground">config fingerprint</span>
        <span className="tabular-nums text-xs text-muted-foreground">{configFp}</span>
      </div>

      {/* INTERACTIVE CONTROLS — hidden entirely when printing. */}
      <div className="flex flex-col gap-4 print:hidden">
        {draft.map((composite, ci) => {
          const status = statuses[ci];
          const isOpen = open.has(composite.id);
          const dirty = isDirty(ci);
          const saving = savingId === composite.id;
          const busy = savingId !== null;
          const compositeFp = compositeFingerprint(composite.id, active.composites, active.lookupTables, active.variables ?? {});
          const canReset = !activeAtDefaults(ci);
          const confirming = confirmingResetId === composite.id;
          const err = errorById[composite.id];
          return (
            <div key={composite.id} className="rounded-lg border">
              <button
                type="button"
                onClick={() => toggleOpen(composite.id)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="font-medium text-foreground">{composite.label}</span>
                  <Badge variant="outline">{composite.polarityLabel}</Badge>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    v{active.composites[ci]?.version} · {compositeFp}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {dirty && <span className="text-xs font-medium text-primary">unsaved</span>}
                  {status.error ? (
                    <span className="text-xs font-medium text-destructive">Needs attention</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">valid</span>
                  )}
                </span>
              </button>

              {isOpen && (
                <div className="flex flex-col gap-3 border-t px-3 py-3">
                  <p className="text-xs text-muted-foreground">
                    Allocate 100% across the components; disabling one redistributes its
                    share proportionally among the rest. The renormalized weight is shown
                    beside each input.
                  </p>

                  {composite.components.map((comp, cj) => {
                    const eff = status.effective?.[comp.id];
                    // A built-in sub-score that is ITSELF produced by another composite
                    // (risk_score -> performanceRisk): surface where it is configured and
                    // that the two weight sets multiply, not add.
                    const producer = comp.configuredIn
                      ? parsed.find((c) => c.id === comp.configuredIn)
                      : undefined;
                    // Lookup tables this component's formula reads (formula -> variables -> table),
                    // replacing the dropped per-component lookupTable field (Prerequisite P).
                    const tableRefs = componentTableRefs(comp, active.variables ?? {});
                    return (
                      <div
                        key={comp.id}
                        className="flex flex-col gap-1 border-t pt-3 first:border-t-0 first:pt-0 sm:flex-row sm:items-start sm:gap-3"
                      >
                        <Button
                          type="button"
                          size="sm"
                          variant={comp.enabled ? "default" : "outline"}
                          disabled={busy}
                          onClick={() => setComponent(ci, cj, { enabled: !comp.enabled })}
                          className="w-24 shrink-0"
                        >
                          {comp.enabled ? "Enabled" : "Disabled"}
                        </Button>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "font-medium",
                                comp.enabled ? "text-foreground" : "text-muted-foreground",
                              )}
                            >
                              {comp.label}
                            </span>
                            <Badge variant={comp.provenance === "computed" ? "secondary" : "outline"}>
                              {comp.provenance}
                            </Badge>
                            {comp.builtin && <Badge variant="outline">built-in</Badge>}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">{comp.definition}</p>
                          {producer && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              This sub-score is itself configured in{" "}
                              <span className="font-medium">{producer.label}</span> below — those
                              component weights <em>multiply</em> with this{" "}
                              {eff != null ? pct(eff) : "weight"}, they do not add.
                            </p>
                          )}
                          {tableRefs.length > 0 && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Reads the{" "}
                              <span className="font-medium">
                                {tableRefs
                                  .map((tid) => active.lookupTables[tid]?.label ?? tid)
                                  .join(", ")}
                              </span>{" "}
                              lookup {tableRefs.length > 1 ? "tables" : "table"} (in{" "}
                              <span className="font-medium">Lookup tables</span> below).
                            </p>
                          )}
                          {!comp.builtin && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                              <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs break-all">
                                {comp.formula ?? "—"}
                              </code>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => setFormulaEdit({ ci, cj })}
                              >
                                Edit formula
                              </Button>
                            </div>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={comp.weightStr}
                            disabled={busy}
                            onChange={(e) => setComponent(ci, cj, { weightStr: e.target.value })}
                            aria-invalid={!Number.isFinite(Number.parseFloat(comp.weightStr))}
                            className="w-20 text-right tabular-nums"
                            aria-label={`${comp.label} weight`}
                          />
                          <span className="w-24 text-xs tabular-nums text-muted-foreground">
                            {!comp.enabled
                              ? "— disabled"
                              : eff != null
                                ? `→ ${pct(eff)}`
                                : "—"}
                          </span>
                        </div>
                      </div>
                    );
                  })}

                  {status.error && (
                    <p className="text-xs font-medium text-destructive">{status.error}</p>
                  )}
                  {err && <p className="text-xs font-medium text-destructive">{err}</p>}

                  {/* Per-composite controls: Save + Discard (this composite only), and
                      Reset to defaults (a confirmed save back to the shipped values). */}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => saveComposite(parse(composite))}
                      disabled={!dirty || status.error !== null || busy}
                    >
                      {saving ? "Saving & recomputing…" : "Save"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleDiscard(ci)}
                      disabled={!dirty || busy}
                    >
                      Discard
                    </Button>
                    {!confirming ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmingResetId(composite.id)}
                        disabled={!canReset || busy}
                        title={
                          canReset
                            ? "Restore this composite's shipped default weights"
                            : "Already at the shipped defaults"
                        }
                      >
                        Reset to defaults
                      </Button>
                    ) : (
                      <span className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">
                          Reset to defaults? Saves a new version &amp; recomputes.
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => handleReset(ci)}
                          disabled={busy}
                        >
                          Confirm reset
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirmingResetId(null)}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                      </span>
                    )}
                    {!dirty && !saving && !confirming && (
                      <span className="text-xs text-muted-foreground">No unsaved changes.</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <p className="text-xs text-muted-foreground">
          Saving a composite overwrites <code>config/risk-model.json</code>, bumps that
          composite&apos;s version, and recomputes every period. There is no role restriction
          and no undo — the printed report footer is the only record of a prior configuration.
        </p>

        {/* LOOKUP TABLES — their own subsection with per-table Save / Discard / Reset. A
            shared curve is no single composite's knob, so it versions and saves itself. */}
        <div className="mt-2 flex flex-col gap-3 border-t pt-4">
          <div>
            <p className="text-sm font-medium text-foreground">Lookup tables</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The 0–100 response curves the risk components read. Each table versions itself
              and has its own Save. Coverage shows how many of the{" "}
              {coverageInputs.totalSuppliers} current suppliers each row matches, so a row
              that never fires is visible while you edit.
            </p>
          </div>
          {Object.entries(active.lookupTables).map(([id, table]) => {
            const defaults = RISK_MODEL_DEFAULTS.lookupTables[id];
            if (!defaults) return null;
            return (
              <LookupTableCard
                key={`${id}:${table.version}`}
                tableId={id}
                table={table}
                defaults={defaults}
                coverageInputs={coverageInputs}
                consumers={consumerDescriptors(id)}
                busy={savingId !== null}
                saving={savingId === id}
                onSave={(edit) => saveTable(id, edit)}
              />
            );
          })}
        </div>

        {/* Cost-premium benchmark (Stage G): the partition parameters + external price list. */}
        <div className="mt-2 flex flex-col gap-3 border-t pt-4">
          <div>
            <p className="text-sm font-medium text-foreground">Cost premium</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The peer-group price comparison behind <code className="font-mono">cost_premium</code>.
            </p>
          </div>
          <CostPremiumPartitionCard
            initial={
              active.variables?.cost_premium?.partition ?? {
                key: "item",
                benchmarkStat: "spend_weighted_mean",
                minGroupMembers: 2,
                minPosPerSupplierItem: 2,
                belowMinimum: "excluded",
                benchmarkMode: "internal",
              }
            }
            busy={savingId !== null}
            onAfterSave={() => {
              void triggerSensitivity();
              router.refresh();
            }}
          />
        </div>
      </div>

      {/* PRINT-ONLY STATIC SUMMARY — no toggles, no inputs; just the active values. */}
      <div className="hidden print:block">
        <p className="text-sm font-medium text-foreground">
          Active risk-model configuration — schema v{active.schemaVersion} · config
          fingerprint {configFp}
        </p>
        {active.composites.map((composite) => {
          const eff = statusOf(composite).effective ?? {};
          return (
            <div key={composite.id} className="mt-2">
              <p className="text-sm font-medium text-foreground">
                {composite.label} — v{composite.version} ·{" "}
                {compositeFingerprint(composite.id, active.composites, active.lookupTables, active.variables ?? {})}
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-foreground">
                    <th className="py-1 pr-3 font-medium">Component</th>
                    <th className="py-1 pr-3 font-medium">Provenance</th>
                    <th className="py-1 pr-3 text-right font-medium">Weight</th>
                    <th className="py-1 pr-3 text-right font-medium">Effective</th>
                    <th className="py-1 font-medium">State</th>
                  </tr>
                </thead>
                <tbody>
                  {composite.components.map((comp) => (
                    <tr key={comp.id} className="border-b">
                      <td className="py-1 pr-3">
                        {comp.label}
                        {comp.formula ? (
                          <span className="font-mono text-muted-foreground"> = {comp.formula}</span>
                        ) : null}
                      </td>
                      <td className="py-1 pr-3">{comp.provenance}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{pct(comp.weight)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {comp.enabled && eff[comp.id] != null ? pct(eff[comp.id]) : "—"}
                      </td>
                      <td className="py-1">{comp.enabled ? "enabled" : "disabled"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        {Object.entries(active.lookupTables).map(([id, table]) => {
          const consumers = consumerDescriptors(id);
          const isCountry = table.input === "country";
          return (
            <div key={id} className="mt-2">
              <p className="text-sm font-medium text-foreground">
                {table.label} — v{table.version}
                {consumers.length > 0 && (
                  <span className="text-muted-foreground"> · used by {consumers.join(", ")}</span>
                )}
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-foreground">
                    <th className="py-1 pr-3 font-medium">{isCountry ? "Tier" : "Alternatives"}</th>
                    <th className="py-1 pr-3 text-right font-medium">Value</th>
                    {isCountry && <th className="py-1 font-medium">Members</th>}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r) => (
                    <tr key={String(r.key)} className="border-b">
                      <td className="py-1 pr-3">{String(r.key)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.value}</td>
                      {isCountry && <td className="py-1">{(r.members ?? []).join(", ")}</td>}
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1 pr-3 text-muted-foreground">everything else</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{table.default}</td>
                    {isCountry && <td className="py-1" />}
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      {formulaEdit &&
        (() => {
          const dc = draft[formulaEdit.ci];
          const comp = dc?.components[formulaEdit.cj];
          if (!dc || !comp) return null;
          const initialBounds: FormulaBounds = comp.bounds ?? { lo: 0, hi: 100 };
          return (
            <FormulaEditorCard
              compositeId={dc.id}
              componentId={comp.id}
              componentLabel={comp.label}
              weight={Number.parseFloat(comp.weightStr)}
              composites={parsed}
              variables={active.variables ?? {}}
              initialFormula={comp.formula ?? comp.id}
              initialBounds={initialBounds}
              onApply={(formula, bounds) => {
                setComponent(formulaEdit.ci, formulaEdit.cj, { formula, bounds });
                setFormulaEdit(null);
              }}
              onClose={() => setFormulaEdit(null)}
            />
          );
        })()}
    </div>
  );
}
