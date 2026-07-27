"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  lookupTableError,
  lookupCoverage,
  tableContentEqual,
  type LookupTable,
  type LookupTableDefault,
  type LookupTableEdit,
  type LookupRow,
  type LookupCoverageInputs,
} from "@/lib/risk-model";

// Draft keeps values + members as STRINGS so inputs type smoothly ("0.", "ID, IN"); parsed
// to numbers/arrays for validation, coverage and save. `rid` is a stable React key that
// survives editing a country row's key (the tier name is itself editable).
type DraftRow = { rid: string; key: string; valueStr: string; membersStr: string };
type DraftTable = { defaultStr: string; rows: DraftRow[] };

function toDraft(table: LookupTable): DraftTable {
  return {
    defaultStr: String(table.default),
    rows: table.rows.map((r, i) => ({
      rid: `r-${i}`,
      key: String(r.key),
      valueStr: String(r.value),
      membersStr: (r.members ?? []).join(", "),
    })),
  };
}

// Parse a draft to the edit payload. Members are upper-cased + de-duped here so coverage,
// validation and dirty-detection all see the same canonical form the server will store.
function parseDraft(draft: DraftTable, input: "count" | "country", id: string): LookupTableEdit {
  const rows: LookupRow[] = draft.rows.map((r) => {
    const value = Number.parseFloat(r.valueStr);
    if (input === "country") {
      const seen = new Set<string>();
      const members: string[] = [];
      for (const token of r.membersStr.split(/[\s,]+/)) {
        const code = token.trim().toUpperCase();
        if (code && !seen.has(code)) {
          seen.add(code);
          members.push(code);
        }
      }
      return { key: r.key.trim(), value, members };
    }
    return { key: Number(r.key), value };
  });
  return { id, default: Number.parseFloat(draft.defaultStr), rows };
}

function countLabel(key: string): string {
  if (key === "0") return "0 others · single source";
  return `${key} other${key === "1" ? "" : "s"} in category`;
}

function CoverageCell({ n }: { n: number }) {
  return (
    <span
      className={cn(
        "tabular-nums",
        n === 0 ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {n === 0 ? "0 · never fires" : `${n} supplier${n === 1 ? "" : "s"}`}
    </span>
  );
}

export function LookupTableCard({
  tableId,
  table,
  defaults,
  coverageInputs,
  consumers,
  busy,
  saving,
  onSave,
}: {
  tableId: string;
  table: LookupTable;
  defaults: LookupTableDefault;
  coverageInputs: LookupCoverageInputs;
  consumers: string[];
  busy: boolean;
  saving: boolean;
  onSave: (edit: LookupTableEdit) => Promise<string | null>;
}) {
  const input = table.input;
  const isCountry = input === "country";
  const [draft, setDraft] = useState<DraftTable>(() => toDraft(table));
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const parsed = parseDraft(draft, input, tableId);
  const validationError = lookupTableError({ input, default: parsed.default, rows: parsed.rows });
  const coverage = lookupCoverage(input, parsed.rows, coverageInputs);
  const dirty = !tableContentEqual(parsed.default, parsed.rows, table.default, table.rows);
  const atDefaults = tableContentEqual(table.default, table.rows, defaults.default, defaults.rows);
  const shared = consumers.length > 1;

  function setRow(rid: string, patch: Partial<DraftRow>) {
    setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.rid === rid ? { ...r, ...patch } : r)) }));
  }
  function addRow() {
    setDraft((d) => ({
      ...d,
      rows: [...d.rows, { rid: `n-${Math.random().toString(36).slice(2)}`, key: "", valueStr: "", membersStr: "" }],
    }));
  }
  function removeRow(rid: string) {
    setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.rid !== rid) }));
  }
  function discard() {
    setDraft(toDraft(table));
    setError(null);
    setConfirmingReset(false);
  }
  async function save() {
    setError(null);
    const err = await onSave(parseDraft(draft, input, tableId));
    if (err) setError(err); // success bumps the table version -> this card remounts (keyed)
  }
  async function reset() {
    setConfirmingReset(false);
    const err = await onSave({ id: tableId, default: defaults.default, rows: defaults.rows });
    if (err) setError(err);
  }

  const valueInput = (value: string, onChange: (v: string) => void, label: string) => (
    <Input
      type="text"
      inputMode="decimal"
      value={value}
      disabled={busy}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={!Number.isFinite(Number.parseFloat(value))}
      className="w-20 text-right tabular-nums"
      aria-label={label}
    />
  );

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{table.label}</span>
          <Badge variant="outline">{isCountry ? "by country" : "by count"}</Badge>
          <span className="text-xs tabular-nums text-muted-foreground">v{table.version}</span>
        </span>
        <span className="flex items-center gap-2 print:hidden">
          {dirty && <span className="text-xs font-medium text-primary">unsaved</span>}
          {validationError ? (
            <span className="text-xs font-medium text-destructive">Needs attention</span>
          ) : (
            <span className="text-xs text-muted-foreground">valid</span>
          )}
        </span>
      </div>

      <div className="flex flex-col gap-3 border-t px-3 py-3">
        {/* Consumer note — driven from consumersOfTable, not hardcoded. A shared table
            states that editing moves BOTH scores by design. */}
        <p className="text-xs text-muted-foreground">
          {shared ? (
            <>
              <span className="font-medium text-foreground">Shared input.</span> Editing this
              curve changes <span className="font-medium">{consumers.join(" and ")}</span> —
              both by design. The two risk scores share this signal, which is why they move
              together (their −0.852 correlation follows from it).
            </>
          ) : (
            <>Used by {consumers.length ? consumers.join(", ") : "no component"}.</>
          )}
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-foreground">
                <th className="py-1.5 pr-3 font-medium">{isCountry ? "Tier" : "Alternatives"}</th>
                <th className="py-1.5 pr-3 text-right font-medium">Value (0–100)</th>
                {isCountry && <th className="py-1.5 pr-3 font-medium">Members (ISO codes)</th>}
                <th className="py-1.5 pr-3 font-medium">Coverage</th>
                {isCountry && <th className="py-1.5 font-medium print:hidden" aria-label="remove" />}
              </tr>
            </thead>
            <tbody>
              {draft.rows.map((r, i) => (
                <tr key={r.rid} className="border-b align-top">
                  <td className="py-1.5 pr-3">
                    {isCountry ? (
                      <Input
                        type="text"
                        value={r.key}
                        disabled={busy}
                        onChange={(e) => setRow(r.rid, { key: e.target.value })}
                        className="w-32"
                        aria-label="Tier name"
                        placeholder="tier name"
                      />
                    ) : (
                      <span className="text-muted-foreground">{countLabel(r.key)}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    {valueInput(r.valueStr, (v) => setRow(r.rid, { valueStr: v }), "Value")}
                  </td>
                  {isCountry && (
                    <td className="py-1.5 pr-3">
                      <Input
                        type="text"
                        value={r.membersStr}
                        disabled={busy}
                        onChange={(e) => setRow(r.rid, { membersStr: e.target.value })}
                        className="w-full min-w-[10rem]"
                        aria-label="Members"
                        placeholder="e.g. SG, MY, TH"
                      />
                    </td>
                  )}
                  <td className="py-1.5 pr-3">
                    <CoverageCell n={coverage.perRow[i] ?? 0} />
                  </td>
                  {isCountry && (
                    <td className="py-1.5 print:hidden">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => removeRow(r.rid)}
                        aria-label="Remove tier"
                      >
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {/* The explicit default rendered as a trailing "everything else" row. */}
              <tr className="align-top">
                <td className="py-1.5 pr-3 text-muted-foreground">
                  {isCountry ? "Everything else" : `${draft.rows.length}+ others`}
                </td>
                <td className="py-1.5 pr-3 text-right">
                  {valueInput(draft.defaultStr, (v) => setDraft((d) => ({ ...d, defaultStr: v })), "Default value")}
                </td>
                {isCountry && <td className="py-1.5 pr-3 text-muted-foreground">— (no members)</td>}
                <td className="py-1.5 pr-3">
                  <CoverageCell n={coverage.default} />
                </td>
                {isCountry && <td className="print:hidden" />}
              </tr>
            </tbody>
          </table>
        </div>

        {isCountry && (
          <div className="print:hidden">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={addRow}>
              Add tier
            </Button>
          </div>
        )}

        {validationError && (
          <p className="text-xs font-medium text-destructive">{validationError}</p>
        )}
        {error && <p className="text-xs font-medium text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={!dirty || validationError !== null || busy}
          >
            {saving ? "Saving & recomputing…" : "Save"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={discard} disabled={!dirty || busy}>
            Discard
          </Button>
          {!confirmingReset ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingReset(true)}
              disabled={atDefaults || busy}
              title={atDefaults ? "Already at the shipped defaults" : "Restore this table's shipped defaults"}
            >
              Reset to defaults
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Reset to defaults? Saves a new version &amp; recomputes.</span>
              <Button type="button" size="sm" variant="destructive" onClick={reset} disabled={busy}>
                Confirm reset
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setConfirmingReset(false)} disabled={busy}>
                Cancel
              </Button>
            </span>
          )}
          {!dirty && !saving && !confirmingReset && (
            <span className="text-xs text-muted-foreground">No unsaved changes.</span>
          )}
        </div>
      </div>
    </div>
  );
}
