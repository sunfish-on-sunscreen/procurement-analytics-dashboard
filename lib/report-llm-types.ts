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
 * `rate_limited` is kept DISTINCT from `error` so the editor can tell the user the
 * free-tier cap was hit (wait and retry) rather than that no key is configured — the
 * two read differently during a demo.
 */
export type BriefNarrativeUnavailableReason =
  | "no_key"
  | "error"
  | "timeout"
  | "empty"
  | "rate_limited";

/**
 * Informational free-tier request caps for the DEFAULT model (gemini-2.5-flash). The
 * free tier has no per-request cost, so what actually constrains use here is the request
 * rate. ⚠️ NOT a source of truth: Google sets rate limits PER PROJECT and no longer
 * publishes a universal table (the authoritative figures are in the Google AI Studio
 * dashboard), and free-tier quotas were reduced in December 2025. These are indicative
 * only — the analog of the old informational pricing constant — and change if the
 * operator overrides GEMINI_REPORT_MODEL. Update to match the project's actual quota.
 */
export const FREE_TIER_RATE_LIMITS = {
  requestsPerMinute: 15,
  requestsPerDay: 1500,
} as const;

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
      /** MEASURED token usage for this generation (from the provider's usage metadata).
       *  There is no per-request cost on the free tier — see FREE_TIER_RATE_LIMITS for
       *  what constrains use instead. */
      usage: { inputTokens: number; outputTokens: number };
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
