"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  resolveEffectiveWeights,
  configFingerprint,
  compositeFingerprint,
  WEIGHT_SUM_TOL,
  RISK_MODEL_DEFAULTS,
  type RiskModel,
  type RiskComposite,
  type RiskComponent,
  type ConfigStamp,
} from "@/lib/risk-model";

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

export function RiskModelSettings({ initialModel }: { initialModel: RiskModel }) {
  const [active, setActive] = useState<RiskModel>(initialModel);
  const [draft, setDraft] = useState<DraftComposite[]>(() => toDraft(initialModel.composites));
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(initialModel.composites.map((c) => c.id)),
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [confirmingResetId, setConfirmingResetId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string | null>>({});

  const parsed = draft.map(parse);
  const statuses = parsed.map(statusOf);
  const configFp = configFingerprint(active.composites);

  // Per-composite dirty: any component's weight/enabled differs from the SAVED (active).
  function isDirty(i: number): boolean {
    const a = active.composites[i];
    if (!a) return true;
    return draft[i].components.some((comp, j) => {
      const ac = a.components[j];
      return !ac || comp.enabled !== ac.enabled || Number.parseFloat(comp.weightStr) !== ac.weight;
    });
  }

  // Is the SAVED composite already at its shipped defaults? (Reset is offered only when not.)
  function activeAtDefaults(i: number): boolean {
    const a = active.composites[i];
    const defs = RISK_MODEL_DEFAULTS[a.id];
    if (!defs) return true;
    return a.components.every((c) => sameKnobs(c, defs[c.id]));
  }

  // A composite whose knobs are the shipped defaults (for reset-to-defaults save).
  function defaultComposite(i: number): RiskComposite {
    const a = active.composites[i];
    const defs = RISK_MODEL_DEFAULTS[a.id] ?? {};
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
          const compositeFp = compositeFingerprint(composite.id, active.composites);
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
                {compositeFingerprint(composite.id, active.composites)}
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
                      <td className="py-1 pr-3">{comp.label}</td>
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
      </div>
    </div>
  );
}
