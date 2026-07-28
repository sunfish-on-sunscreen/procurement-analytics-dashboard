import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth";
import { recomputeAllPeriods } from "@/lib/recompute";
import {
  validateComposite,
  resolveEffectiveWeights,
  mergeAndBumpVersions,
  mergeAndBumpTableVersions,
  normalizeLookupTableEdit,
  lookupTableError,
  formulaError,
  boundsError,
  buildConfigStamp,
  isCustomComponentId,
  componentReferrers,
  RISK_MODEL_DEFAULTS,
} from "@/lib/risk-model";
import { readRiskModel, writeRiskModel } from "@/lib/risk-model-server";

export const runtime = "nodejs";

// A save carries composite weight/enabled edits, lookup-table content edits, or both — at
// least one. For composites only weight + enabled are client-editable; for tables only the
// default + rows (values, and country-table members). labels / definitions / provenance /
// polarity / `input` / the JSON comment are structural and preserved from the on-disk
// config server-side. Table content is validated (range / contiguity / disjointness) below.
const Body = z
  .object({
    composites: z
      .array(
        z.object({
          id: z.string(),
          components: z
            .array(
              z.object({
                id: z.string(),
                enabled: z.boolean(),
                weight: z.number().finite().min(0).max(1),
                // Stage F: formula-defined components only (the server rejects a formula/bounds
                // edit aimed at a builtin sub-score below).
                formula: z.string().optional(),
                bounds: z.object({ lo: z.number().finite(), hi: z.number().finite() }).optional(),
                // Stage I: display name for an ADDED component, or a RENAME of a custom one.
                label: z.string().optional(),
                // TASK 2: description for an APPENDED component (so a reset can restore a removed
                // shipped component's definition). Display-only; ignored for kept components.
                definition: z.string().optional(),
              }),
            )
            .min(1),
        }),
      )
      .optional(),
    lookupTables: z
      .array(
        z.object({
          id: z.string(),
          default: z.number().finite(),
          rows: z
            .array(
              z.object({
                key: z.union([z.string(), z.number()]),
                value: z.number().finite(),
                members: z.array(z.string()).optional(),
              }),
            )
            .min(1),
        }),
      )
      .optional(),
    // Stage G: the cost_premium partition parameters (compute-affecting config).
    costPremiumPartition: z
      .object({
        key: z.enum(["item", "item_period", "item_category"]),
        benchmarkStat: z.enum(["spend_weighted_mean", "mean", "median"]),
        minGroupMembers: z.number().int().min(1),
        minPosPerSupplierItem: z.number().int().min(1),
        belowMinimum: z.enum(["excluded", "neutral"]),
        benchmarkMode: z.enum(["internal", "external", "hybrid"]),
      })
      .optional(),
  })
  .refine(
    (b) => (b.composites?.length ?? 0) + (b.lookupTables?.length ?? 0) + (b.costPremiumPartition ? 1 : 0) > 0,
    { message: "Nothing to save." },
  );

/**
 * Save the risk-model weights (any authenticated user — configuration is unrestricted
 * by design; the limitation is documented in Methodology §4.2). Validates via the SHARED
 * pure functions, writes config/risk-model.json bumping ONLY the composites whose own
 * components changed, then recomputes every period through the sanctioned
 * recompute-on-read path. No snapshot/cache layer.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  // Merge weight + enabled into the CURRENT on-disk config, bumping the version of ONLY
  // the composites whose own components changed (a per-composite Save must never bump
  // another). Everything else (labels, polarity, schemaVersion) is preserved.
  const current = await readRiskModel();
  let merged = current;
  const changedIds: string[] = [];

  // Stage I: gate component ADD / REMOVE against the on-disk composite BEFORE merging. The edit's
  // component list is authoritative for a composite's NON-BUILTIN components, so an id not on disk
  // is an ADD and a non-builtin id on disk but absent from the edit is a REMOVE. Adds are allowed
  // only on a composite with no built-in sub-scores (drive off the builtin flag, not an id check)
  // and only with a generated `custom_` id; a remove is blocked if anything still references it.
  for (const ce of parsed.data.composites ?? []) {
    const cur = current.composites.find((c) => c.id === ce.id);
    if (!cur) continue; // unknown composite — the merge ignores it
    const curIds = new Set(cur.components.map((c) => c.id));
    const editIds = new Set(ce.components.map((c) => c.id));
    const addEligible = cur.components.every((c) => !c.builtin);
    for (const c of ce.components) {
      if (curIds.has(c.id)) continue; // an ADD
      if (!addEligible) {
        return NextResponse.json(
          { error: `${ce.id}: components cannot be added to a composite of built-in sub-scores.` },
          { status: 400 },
        );
      }
      // Allowed adds: a generated custom_ id, OR a shipped default component being RESTORED by
      // reset-to-defaults (a removed shipped component re-added — not a custom id, but a known one).
      const isKnownDefault = (RISK_MODEL_DEFAULTS.composites[ce.id] ?? []).some((d) => d.id === c.id);
      if (!isCustomComponentId(c.id) && !isKnownDefault) {
        return NextResponse.json(
          { error: `${ce.id}.${c.id}: a component added here must be generated ("custom_…") or a shipped default being restored.` },
          { status: 400 },
        );
      }
    }
    for (const comp of cur.components) {
      if (comp.builtin || editIds.has(comp.id)) continue; // builtins never removed; kept ones stay
      const referrers = componentReferrers(comp.id, current.composites);
      if (referrers.length > 0) {
        return NextResponse.json(
          { error: `${ce.id}.${comp.id} cannot be removed — referenced by ${referrers.join(", ")}.` },
          { status: 400 },
        );
      }
    }
  }

  // Composite weight/enabled edits: bump only the composites whose own components changed.
  if (parsed.data.composites?.length) {
    const r = mergeAndBumpVersions(merged, parsed.data.composites);
    merged = r.merged;
    changedIds.push(...r.changedIds);
  }

  // Lookup-table content edits: normalize members against each table's structural `input`,
  // then bump only the tables whose content changed (a shared table versions itself; no
  // composite version is touched — the fingerprint carries the transitive effect).
  if (parsed.data.lookupTables?.length) {
    const normalized = parsed.data.lookupTables.map((edit) => {
      const table = current.lookupTables[edit.id];
      return table ? normalizeLookupTableEdit(edit, table.input) : edit;
    });
    const r = mergeAndBumpTableVersions(merged, normalized);
    merged = r.merged;
    changedIds.push(...r.changedIds);
  }

  // Cost-premium partition edit (Stage G): overwrite variables.cost_premium.partition. Variables
  // are not versioned; the whole-config fingerprint carries the effect (partition is
  // compute-affecting). The Python load-time validator re-checks the enum/int values.
  if (parsed.data.costPremiumPartition) {
    const vars = { ...(merged.variables ?? {}) };
    const cp = vars.cost_premium;
    if (cp) {
      vars.cost_premium = { ...cp, partition: parsed.data.costPremiumPartition };
      merged = { ...merged, variables: vars };
      changedIds.push("cost_premium.partition");
    }
  }

  // Validate every composite: declared weights sum to 1.0, and at least one enabled.
  // Surface either failure as a 400 the UI renders inline (naming the composite).
  for (const composite of merged.composites) {
    try {
      validateComposite(composite);
      resolveEffectiveWeights(composite);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid risk model" },
        { status: 400 },
      );
    }
  }

  // Stage F: reject a formula/bounds edit aimed at a BUILTIN sub-score (its formula is a
  // scores.py column, not editable), then validate every formula-defined component's formula +
  // bounds so a bad formula is a 400 BEFORE the config is written (never a broken recompute).
  const builtinRefs = new Set<string>();
  for (const c of merged.composites) {
    for (const comp of c.components) if (comp.builtin) builtinRefs.add(`${c.id}.${comp.id}`);
  }
  for (const ce of parsed.data.composites ?? []) {
    for (const comp of ce.components) {
      if ((comp.formula !== undefined || comp.bounds !== undefined) && builtinRefs.has(`${ce.id}.${comp.id}`)) {
        return NextResponse.json(
          { error: `${ce.id}.${comp.id} is a built-in sub-score — its formula is not editable.` },
          { status: 400 },
        );
      }
    }
  }
  const catalogueVars = merged.variables ?? {};
  for (const composite of merged.composites) {
    for (const comp of composite.components) {
      if (comp.builtin || comp.formula === undefined) continue;
      const fe = formulaError(comp.formula, composite.id, merged.composites, catalogueVars, comp.enabled);
      if (fe) return NextResponse.json({ error: `${composite.id}.${comp.id}: ${fe}` }, { status: 400 });
      if (comp.bounds !== undefined) {
        const be = boundsError(comp.bounds);
        if (be) return NextResponse.json({ error: `${composite.id}.${comp.id}: ${be}` }, { status: 400 });
      }
    }
  }

  // Validate every lookup table: value range, contiguous count keys, disjoint country
  // members. Same rules as the Python load-time validator and the settings UI.
  for (const [id, table] of Object.entries(merged.lookupTables)) {
    const err = lookupTableError(table);
    if (err) {
      return NextResponse.json({ error: `${id}: ${err}` }, { status: 400 });
    }
  }

  // Persist ONLY when something changed (a no-op save writes nothing + bumps no
  // version). But ALWAYS recompute: a save is also how an admin RETRIES after a prior
  // save whose config write SUCCEEDED but whose recompute FAILED — the config is then
  // already on disk (so a retry of the same values is a config no-op), yet the analyses
  // are still stale and MUST be reconciled. Short-circuiting the recompute on "no config
  // change" would leave the footer stamping a config the numbers were not produced under.
  const stamp = buildConfigStamp(merged);
  if (changedIds.length > 0) {
    await writeRiskModel(merged);
  }

  const result = await recomputeAllPeriods();
  if (!result.ok) {
    // The config is already written; the analyses may now be inconsistent. Surface it
    // honestly — same failure contract as the CRUD routes. Re-saving retries the recompute.
    const saved = changedIds.length ? `Saved (${changedIds.join(", ")})` : "No config change";
    return NextResponse.json(
      {
        error: `${saved}, but the recompute failed — the dashboard may be stale until it succeeds; re-saving retries it. ${result.error}`,
        stamp,
        changedIds,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ stamp, changedIds });
}
