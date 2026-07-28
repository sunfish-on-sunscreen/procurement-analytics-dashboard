import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { runAndPersistSensitivity } from "@/lib/sensitivity-server";

export const runtime = "nodejs";

/**
 * PHASE 2 of the two-phase save (Stage C). The client calls this AFTER a successful config
 * save (phase 1 — /api/risk-model — which validated, wrote the config, and recomputed). It
 * runs the drop-one weight-sensitivity analysis (~60s, N+1 recomputes) against the just-saved
 * config and persists it, stamped with the current whole-config fingerprint.
 *
 * Split from the save deliberately: a synchronous 60s save request is fragile and looks hung.
 * If THIS never completes (interrupted / crashed / tab closed), the fingerprint stamp makes the
 * stored figures render as STALE rather than silently describing a configuration that is no
 * longer current. That safety net is why the split is safe.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const result = await runAndPersistSensitivity();
  if (!result.ok) {
    return NextResponse.json(
      {
        error: `Sensitivity analysis failed — the tables stay marked stale until it succeeds; re-run from the config panel. ${result.error}`,
      },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, configFingerprint: result.configFingerprint });
}
