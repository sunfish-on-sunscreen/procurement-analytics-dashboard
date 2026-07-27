import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth";
import { recomputeAllPeriods } from "@/lib/recompute";
import {
  validateComposite,
  resolveEffectiveWeights,
  nextConfigVersion,
  fingerprintComposites,
  type RiskModel,
} from "@/lib/risk-model";
import { readRiskModel, writeRiskModel } from "@/lib/risk-model-server";

export const runtime = "nodejs";

// Only weight + enabled are client-editable; labels / definitions / provenance /
// polarity / the JSON comment are preserved from the on-disk config server-side.
const Body = z.object({
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
    .min(1),
});

function todayYYYYMMDD(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * Save the risk-model weights (any authenticated user — configuration is unrestricted
 * by design; the limitation is documented in Methodology §4.2). Validates via the SHARED
 * pure functions, writes config/risk-model.json with a bumped version, then recomputes
 * every period through the sanctioned recompute-on-read path. No snapshot/cache layer.
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

  // Merge weight + enabled into the CURRENT on-disk config (everything else preserved).
  const current = await readRiskModel();
  const edits = new Map(
    parsed.data.composites.map((c) => [c.id, new Map(c.components.map((x) => [x.id, x]))]),
  );
  const merged: RiskModel = {
    ...current,
    composites: current.composites.map((composite) => {
      const compEdits = edits.get(composite.id);
      return {
        ...composite,
        components: composite.components.map((comp) => {
          const e = compEdits?.get(comp.id);
          return e ? { ...comp, enabled: e.enabled, weight: e.weight } : comp;
        }),
      };
    }),
  };

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

  merged.version = nextConfigVersion(current.version, todayYYYYMMDD());
  const fingerprint = fingerprintComposites(merged.composites);
  await writeRiskModel(merged);

  const result = await recomputeAllPeriods();
  if (!result.ok) {
    // The config is already written; the analyses may now be inconsistent. Surface it
    // honestly — same failure contract as the CRUD routes.
    return NextResponse.json(
      {
        error: `Weights saved as ${merged.version}, but the recompute failed — the dashboard may be stale until it succeeds. ${result.error}`,
        version: merged.version,
        fingerprint,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ version: merged.version, fingerprint });
}
