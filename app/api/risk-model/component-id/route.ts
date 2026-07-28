import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth";
import { generateComponentId } from "@/lib/risk-model";
import { readRiskModel } from "@/lib/risk-model-server";

export const runtime = "nodejs";

const Body = z.object({
  displayName: z.string(),
  // The client's CURRENT draft component ids (across all composites, incl. adds not yet saved),
  // so a second add-before-save gets the right collision suffix. Optional; the server also unions
  // the on-disk ids so a stale client cannot mint a colliding id.
  existingIds: z.array(z.string()).optional(),
});

/**
 * Stage I: mint a stable, read-only component id for a NEW risk component, SERVER-SIDE — the
 * server is the authority on the on-disk component-id set, so the collision suffix is checked
 * against every id in the config (plus the client's pending-draft ids). Returns { id } like
 * `custom_<slug>[_n]`. Read-only: nothing is written; the id is persisted only when the parent
 * composite is later saved through /api/risk-model. Any authenticated user (configuration is
 * unrestricted by design).
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

  const model = await readRiskModel();
  const existing = new Set<string>(parsed.data.existingIds ?? []);
  for (const c of model.composites) for (const comp of c.components) existing.add(comp.id);

  const id = generateComponentId(parsed.data.displayName, existing, randomUUID());
  return NextResponse.json({ id });
}
