import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { assembleReportRangeAnalyses } from "@/lib/report-analyses";
import { assembleSupplierFocus } from "@/lib/report-focus";
import {
  buildBriefPayload,
  renderSupplierBrief,
  type ArgumentInput,
} from "@/lib/report-narrative";
import { generateSupplierBriefNarrative } from "@/lib/report-llm";

export const runtime = "nodejs";

const dateField = z
  .string()
  .refine((s) => /^\d{4}-\d{2}-\d{2}/.test(s), "Expected YYYY-MM-DD")
  .transform((s) => s.slice(0, 10));

const bodySchema = z.object({
  supplierId: z.string().min(1),
  startDate: dateField,
  endDate: dateField,
  // Single-year briefs send the period id so the temporal family compares that year
  // vs its prior — mirrors the analyses endpoint.
  selectedPeriodId: z.string().nullable().optional(),
  tone: z.enum(["executive", "operational", "analytical"]),
  prompt: z.string().min(1).max(4000),
});

/**
 * Generate the OPTIONAL LLM narrative for a supplier brief. ONE request per explicit
 * user action (a Generate click) — never on page load. The route re-assembles the
 * analyses + focus SERVER-SIDE and builds the minimal aggregate payload here, so the
 * server alone decides what leaves for the API (no raw rows / line prices ever).
 *
 * DEGRADES, NEVER ERRORS on the generation path: a missing key, API failure, or
 * timeout returns 200 { available:false, reason } and the client renders the template
 * narrative + a visible note. Only auth (401) and a malformed body (400) are hard
 * failures. Any authenticated user (same as the analyses endpoint).
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { supplierId, startDate, endDate, selectedPeriodId, tone, prompt } =
    parsed.data;

  try {
    const analyses = await assembleReportRangeAnalyses(
      startDate,
      endDate,
      selectedPeriodId ? { selectedPeriodId } : undefined,
    );
    if (!analyses) {
      return NextResponse.json({ available: false, reason: "error" });
    }
    const focus = await assembleSupplierFocus(supplierId, startDate, endDate);
    // ReportRangeAnalyses is structurally an ArgumentInput (all six analyses + the
    // breakdown/temporal extras) — the same input the report already renders from.
    const input = analyses satisfies ArgumentInput;
    const facts = buildBriefPayload(input, focus, supplierId);
    const draft = renderSupplierBrief(input, focus, supplierId, tone);
    const result = await generateSupplierBriefNarrative({
      facts,
      draft,
      prompt,
      tone,
    });
    return NextResponse.json(result);
  } catch {
    // Any assembly/compute failure degrades to the template — never a 500 to the user.
    return NextResponse.json({ available: false, reason: "error" });
  }
}
