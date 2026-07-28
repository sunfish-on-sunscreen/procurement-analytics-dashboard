"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  FORMULA_OPERATORS,
  boundsError,
  builtinInputBlockedIn,
  deriveProvenance,
  formulaError,
  variableSheet,
  type RiskComposite,
  type CatalogueVariable,
  type CatalogueVariables,
  type FormulaBounds,
} from "@/lib/risk-model";
import type { PreviewData } from "@/lib/preview-types";

const FUNCS = ["min", "max", "abs", "sqrt"] as const;

/**
 * Stage F formula editor — an OVERLAY card (not inline). Pick a sheet → its variables appear →
 * click a variable/operator to append to the formula. Bounds guarantee 0-100 by construction.
 * The provenance badge is derived, never entered. Live preview (raw -> normalized per supplier)
 * + label-impact are computed by the PYTHON evaluator via /api/risk-model/preview (no second TS
 * evaluator — the two would disagree on rounding). Locked + blocked variables render disabled
 * with their reason. Apply writes the formula/bounds into the parent draft; the parent's Save
 * persists it through the existing two-phase path. Every control is print:hidden (the Dialog is
 * portalled + the settings panel already hides interactive controls when printing).
 */
export function FormulaEditorCard({
  compositeId,
  componentId,
  componentLabel,
  weight,
  composites,
  variables,
  initialFormula,
  initialBounds,
  onApply,
  onClose,
}: {
  compositeId: string;
  componentId: string;
  componentLabel: string;
  weight: number;
  composites: RiskComposite[];
  variables: CatalogueVariables;
  initialFormula: string;
  initialBounds: FormulaBounds;
  onApply: (formula: string, bounds: FormulaBounds) => void;
  onClose: () => void;
}) {
  const [formula, setFormula] = useState(initialFormula);
  const [loStr, setLoStr] = useState(String(initialBounds.lo));
  const [hiStr, setHiStr] = useState(String(initialBounds.hi));
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const bounds: FormulaBounds = { lo: Number.parseFloat(loStr), hi: Number.parseFloat(hiStr) };
  const fErr = formulaError(formula, compositeId, composites, variables);
  const bErr = boundsError(bounds);
  const valid = !fErr && !bErr;
  const provenance = valid ? deriveProvenance(formula, variables) : null;

  const sheets = useMemo(() => {
    const g: Record<string, [string, CatalogueVariable][]> = {};
    for (const [id, v] of Object.entries(variables)) (g[variableSheet(v)] ??= []).push([id, v]);
    return g;
  }, [variables]);
  const sheetNames = Object.keys(sheets);
  const currentSheet = activeSheet ?? sheetNames[0] ?? "";

  const endsWithOperator = (FORMULA_OPERATORS as readonly string[]).includes(formula.trim().slice(-1));
  const append = (t: string) => setFormula((f) => (f.trim() ? `${f.trim()} ` : "") + t);
  const backspace = () => setFormula((f) => f.trim().split(/\s+/).slice(0, -1).join(" "));

  // The candidate composite = the current draft composite with THIS component's edited
  // formula/bounds/weight applied — what preview.py scores + measures impact against.
  const candidate = useMemo(() => {
    const c = composites.find((x) => x.id === compositeId);
    if (!c) return null;
    return {
      ...c,
      components: c.components.map((comp) =>
        comp.id === componentId ? { ...comp, formula, bounds, weight } : comp,
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composites, compositeId, componentId, formula, loStr, hiStr, weight]);

  // Debounced preview; a request id guards against out-of-order responses.
  const reqId = useRef(0);
  useEffect(() => {
    // Render gates the preview display on `valid`, so an invalid formula simply skips the fetch
    // (no setState here — the eslint config bans synchronous setState in an effect).
    if (!valid || !candidate) return;
    const id = ++reqId.current;
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const res = await fetch("/api/risk-model/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ composite: candidate }),
        });
        const data = (await res.json()) as PreviewData;
        if (id === reqId.current) setPreview(data);
      } catch {
        if (id === reqId.current) setPreview({ error: "Preview request failed." });
      } finally {
        if (id === reqId.current) setPreviewLoading(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [valid, candidate]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[88vh] w-full overflow-y-auto sm:max-w-3xl">
        <DialogTitle>Edit formula — {componentLabel}</DialogTitle>
        <p className="text-xs text-muted-foreground">
          Component id <code className="font-mono">{componentId}</code> (read-only — renaming the
          display name never changes the config key). Output is normalized to 0–100 by the bounds
          below, so a component stays in range by construction.
        </p>

        <div className="min-h-9 rounded-md border bg-muted/40 p-2 font-mono text-sm break-words">
          {formula || <span className="text-muted-foreground">Click a variable or operator to build the formula…</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {provenance && (
            <Badge variant={provenance === "computed" ? "secondary" : "outline"}>{provenance}</Badge>
          )}
          {fErr ? (
            <span className="font-medium text-destructive">{fErr}</span>
          ) : bErr ? (
            <span className="font-medium text-destructive">{bErr}</span>
          ) : (
            <span className="text-muted-foreground">valid</span>
          )}
        </div>

        {/* operators / functions / edit controls */}
        <div className="flex flex-wrap gap-1">
          {FORMULA_OPERATORS.map((op) => (
            <Button
              key={op}
              size="sm"
              variant="outline"
              className="w-9 font-mono"
              disabled={!formula.trim() || endsWithOperator}
              onClick={() => append(op)}
            >
              {op}
            </Button>
          ))}
          {["(", ")"].map((p) => (
            <Button key={p} size="sm" variant="outline" className="w-9 font-mono" onClick={() => append(p)}>
              {p}
            </Button>
          ))}
          {FUNCS.map((fn) => (
            <Button key={fn} size="sm" variant="ghost" className="font-mono text-xs" onClick={() => append(`${fn}(`)}>
              {fn}()
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={backspace} disabled={!formula.trim()}>
            ⌫
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFormula("")} disabled={!formula.trim()}>
            Clear
          </Button>
        </div>

        {/* sheet picker */}
        <div className="flex flex-wrap gap-1">
          {sheetNames.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === currentSheet ? "default" : "outline"}
              className="text-xs"
              onClick={() => setActiveSheet(s)}
            >
              {s}
            </Button>
          ))}
        </div>

        {/* variables of the current sheet — eta² visible next to each; locked/blocked disabled */}
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {(sheets[currentSheet] ?? []).map(([id, v]) => {
            const blocked = builtinInputBlockedIn(v, compositeId, composites);
            const reason = v.locked ? `locked: ${v.locked}` : blocked ? `blocked — feeds ${blocked.feedsBuiltin}` : null;
            const disabled = !!reason;
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                onClick={() => append(id)}
                className={cn(
                  "flex flex-col items-start rounded-md border px-2 py-1 text-left text-xs",
                  disabled ? "cursor-not-allowed opacity-60" : "hover:bg-muted/50",
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="font-mono">{id}</span>
                  {v.eta2 && (
                    <span className="tabular-nums text-muted-foreground">
                      η² {v.eta2.category.toFixed(2)}/{v.eta2.country.toFixed(2)}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground">{v.label}</span>
                {reason && <span className="mt-0.5 text-destructive">{reason}</span>}
              </button>
            );
          })}
        </div>

        {/* normalization bounds */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Normalize raw</span>
          <Input value={loStr} onChange={(e) => setLoStr(e.target.value)} className="w-20 text-right tabular-nums" aria-label="lower bound" />
          <span className="text-muted-foreground">to</span>
          <Input value={hiStr} onChange={(e) => setHiStr(e.target.value)} className="w-20 text-right tabular-nums" aria-label="upper bound" />
          <span className="text-muted-foreground">→ 0–100</span>
        </div>

        {/* live preview + impact */}
        <div className="rounded-md border p-2 text-xs">
          <p className="font-medium">
            Preview {previewLoading && <span className="text-muted-foreground">(computing…)</span>}
          </p>
          {!valid ? (
            <p className="text-muted-foreground">Fix the formula to see the preview.</p>
          ) : preview && "error" in preview ? (
            <p className="text-destructive">{preview.error}</p>
          ) : preview && "impact" in preview ? (
            <>
              <p className="mt-1 font-medium text-foreground">
                {preview.impact.changed} of {preview.impact.total} suppliers change {preview.impact.kind} if saved.
              </p>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="pr-2">Supplier</th>
                      <th className="pr-2 text-right">raw</th>
                      <th className="pr-2 text-right">normalized</th>
                      <th className="text-right">score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.perSupplier.slice(0, 6).map((r) => {
                      const c = r.components.find((x) => x.id === componentId);
                      return (
                        <tr key={r.supplier_id}>
                          <td className="pr-2 font-mono">{r.supplier_id}</td>
                          <td className="pr-2 text-right tabular-nums">{c ? c.raw : "—"}</td>
                          <td className="pr-2 text-right tabular-nums">{c ? c.normalized : "—"}</td>
                          <td className="text-right tabular-nums">{r.score}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-muted-foreground">
                Showing 6 of {preview.perSupplier.length}, computed by the Python evaluator.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">Computing…</p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid} onClick={() => onApply(formula.trim(), bounds)}>
            Apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
