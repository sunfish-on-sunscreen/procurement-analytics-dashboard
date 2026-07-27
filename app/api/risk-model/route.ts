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
  buildConfigStamp,
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
  })
  .refine((b) => (b.composites?.length ?? 0) + (b.lookupTables?.length ?? 0) > 0, {
    message: "Nothing to save.",
  });

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
