import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { runPreview } from "@/lib/python";

export const runtime = "nodejs";

/**
 * Stage F formula PREVIEW + IMPACT. POST { composite } — a candidate composite (the whole
 * composite the editor is editing) — returns per-supplier raw -> normalized -> score plus the
 * Kraljic-quadrant / performance-zone churn if it were saved, computed by python/preview.py
 * (THE Python evaluator, so the preview matches a saved report). Read-only: nothing is written,
 * no config is persisted; this is a what-if, distinct from the save path. The candidate's
 * formulas are evaluated by the whitelisted AST evaluator (no eval), so an arbitrary payload is
 * safe. Any authenticated user (configuration is unrestricted by design).
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const candidate = (body as { composite?: unknown } | null)?.composite;
  if (!candidate || typeof candidate !== "object") {
    return NextResponse.json({ error: "Missing 'composite' in body" }, { status: 400 });
  }

  const { code, data, stderr } = await runPreview(candidate);
  if (code !== 0 || !data) {
    return NextResponse.json(
      { error: stderr.trim().slice(-400) || `preview failed (exit ${code})` },
      { status: 500 },
    );
  }
  // data may itself carry { error } (preview.py surfaces a bad candidate structurally) — pass it
  // through with 200 so the editor can render the message inline.
  return NextResponse.json(data);
}
