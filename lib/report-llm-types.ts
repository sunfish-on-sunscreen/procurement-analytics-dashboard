/**
 * Client-safe shapes for the OPTIONAL LLM-generated supplier-brief narrative.
 * Kept free of server-only imports so the editor + <ReportDocument> can import
 * them. The generation itself lives in lib/report-llm.ts (server-only); this file
 * is only the wire contract + the editable tone presets.
 *
 * The feature is layered ON TOP of the template narrative (lib/report-narrative),
 * never replacing it: the model rewrites the SAME six prose strings, and if it is
 * unavailable the template renders unchanged. Only the prose changes — every
 * number, table, and classification stays exactly as computed.
 */
import type { ReportTone } from "@/lib/report-config";

/** The six prose fields the model may rewrite — the exact string surface of a
 *  RenderedSupplierBrief. `buyProse` / `trajectoryProse` are "" when the brief has
 *  no item / trajectory block (the template value was null). */
export type GeneratedBriefProse = {
  headline: string;
  situation: string[];
  flagged: string[];
  buyProse: string | null;
  trajectoryProse: string | null;
  recommendation: string;
};

/**
 * Why a generation attempt did not produce prose. A MISSING KEY degrades exactly
 * like a failure — never an error — so the report always renders with the template.
 */
export type BriefNarrativeUnavailableReason = "no_key" | "error" | "timeout" | "empty";

export type BriefNarrativeResult =
  | {
      available: true;
      prose: GeneratedBriefProse;
      /** The exact model string that produced the prose (env-configurable). */
      model: string;
      /** Canonical (key-sorted) hash of the ENTIRE model input — model id, system
       *  prompt, tone, the user instruction, the supplier's computed values, and the
       *  template draft. A REQUEST fingerprint (it changes per supplier), stamped on the
       *  printed footer as "inputs" so a printout records what produced its prose. The
       *  prose itself is not reproducible from it — see Methodology. */
      inputsHash: string;
      usage: { inputTokens: number; outputTokens: number };
      /** Informational per-report cost at current pricing (USD). */
      costUsd: number;
    }
  | { available: false; reason: BriefNarrativeUnavailableReason };

/** Editor-side status for the narrative control. `unavailable` = an attempt ran and
 *  degraded (missing key / error); the report shows the template + a visible note. */
export type NarrativeStatus = "idle" | "loading" | "generated" | "unavailable";

/**
 * The tone registers as EDITABLE PRESETS (not a blank box). Selecting a Draft-voice
 * pill seeds the narrative instruction with that register's preset; the user can then
 * edit it before generating. These describe the register only — the numbers, findings,
 * and structure come from the computed brief regardless of what is typed here.
 */
export const TONE_PRESET_PROMPTS: Record<ReportTone, string> = {
  executive:
    "Write for a C-level reader: terse and decision-first. Lead with the single most " +
    "important takeaway, drop supplier minutiae and jargon, and keep each section to two " +
    "or three sentences.",
  operational:
    "Write for the category manager heading into the supplier meeting: name the supplier, " +
    "be concrete and tactical, and make the recommended next step unmistakable.",
  analytical:
    "Write for an analyst: precise and evidence-led. Note where each figure sits against " +
    "the median and reference the relevant thresholds. Keep it factual and neutral.",
};
