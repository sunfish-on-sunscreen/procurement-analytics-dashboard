import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type { ReportTone } from "@/lib/report-config";
import type { BriefFactsPayload } from "@/lib/report-narrative";
import type { RenderedSupplierBrief } from "@/lib/report-narrative";
import type {
  BriefNarrativeResult,
  GeneratedBriefProse,
} from "@/lib/report-llm-types";

/**
 * OPTIONAL LLM narrative for a supplier brief. Layered on top of the template
 * (lib/report-narrative) — NEVER replacing it. The model receives computed,
 * pre-formatted values and rewrites the six prose strings; it never computes,
 * recomputes, or alters a number.
 *
 * FALLBACK IS THE DEFAULT. A missing ANTHROPIC_API_KEY, an API error, or a timeout
 * all return { available: false } — the caller renders the template narrative and a
 * visible note. The app is fully functional with no key (the handover condition).
 *
 * MODEL IS CONFIG, NOT CODE (ANTHROPIC_REPORT_MODEL) with a Sonnet default, so the
 * organisation can raise the tier later without a code change — the same
 * config-not-code discipline as the risk-model weights.
 */

const DEFAULT_MODEL = "claude-sonnet-5";
// One request per explicit user action; cap output so a runaway generation can't
// balloon cost. Six short prose fields need well under this — the headroom is only so
// a long-but-valid rewrite is never truncated (you pay for tokens generated, not the cap).
const MAX_TOKENS = 1200;
const TIMEOUT_MS = 25_000;

/**
 * Informational pricing (USD per 1M tokens) purely to report a per-report cost —
 * NOT a billing source of truth. Update if Anthropic pricing changes. Sonnet 5 is
 * shown at its standard rate; an intro rate (lower) runs through 2026-08-31.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** The env-configured narrative model (default Sonnet 5). */
export function reportNarrativeModel(): string {
  return process.env.ANTHROPIC_REPORT_MODEL?.trim() || DEFAULT_MODEL;
}

/** Whether the feature is enabled at all (a key is present). Read server-side only. */
export function reportNarrativeEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

function estimateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const p = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  return (
    (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000
  );
}

/**
 * Recursively KEY-SORTED serialization — the same discipline as the config fingerprint
 * (lib/risk-model.canonical) — so the inputs hash depends only on values, never on key
 * order. Arrays keep their order (it is meaningful in the payload).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// The model returns exactly these six fields as JSON. buyProse / trajectoryProse are
// "" (not null) when the brief has no item / trajectory block — a plain-string schema
// (no nullable union) is the most portable across structured-output validators.
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "headline",
    "situation",
    "flagged",
    "buyProse",
    "trajectoryProse",
    "recommendation",
  ],
  properties: {
    headline: { type: "string" },
    situation: { type: "array", items: { type: "string" } },
    flagged: { type: "array", items: { type: "string" } },
    buyProse: { type: "string" },
    trajectoryProse: { type: "string" },
    recommendation: { type: "string" },
  },
} as const;

const SYSTEM_PROMPT = `You are a procurement analyst's writing assistant. You rewrite the PROSE of a single-supplier brief in a business report, following the reader's instruction and tone, while leaving every fact exactly as given.

You receive:
- facts: aggregate, already-computed values for one supplier. Every number is pre-formatted as a display string.
- draft: the current computed prose (headline, situation, flagged, buyProse, trajectoryProse, recommendation).
- instruction and tone: how the reader wants it written.

ABSOLUTE RULE — you never compute. Reference ONLY the values in facts and draft. Never calculate, derive, re-derive, estimate, round, rescale, or invent any number, percentage, score, rank, date, supplier name, item name, or classification. If a figure appears in your output, it must be copied verbatim from a value you were given. If a value is not provided, do not state it. Do not contradict the draft's numbers.

Your job is wording, emphasis, ordering, framing, and length — not facts. Rewrite each field to satisfy the instruction and tone. Keep it professional, concise, and decision-oriented. No preamble, no markdown, no headings, no bullet characters.

Fields:
- headline: one sentence — the single most important takeaway about this supplier.
- situation: 1-3 short paragraphs of plain prose (array of strings, one per paragraph).
- flagged: one short sentence per issue already present in the draft's flagged list (array). If the draft's flagged is empty, return an empty array — never invent a concern.
- buyProse: one or two sentences on what is bought. If the draft's buyProse is empty, return "".
- trajectoryProse: one or two sentences on the trend over time. If the draft's trajectoryProse is empty, return "".
- recommendation: one short paragraph — what to do next.

Return only the JSON object matching the schema.`;

type GenerateArgs = {
  facts: BriefFactsPayload;
  draft: Pick<
    RenderedSupplierBrief,
    | "headline"
    | "situation"
    | "flagged"
    | "flaggedClean"
    | "buy"
    | "trajectory"
    | "recommendation"
  >;
  prompt: string;
  tone: ReportTone;
};

/** Coerce/validate the model's JSON into GeneratedBriefProse, falling back to the
 *  template draft per-field so a partial response is still coherent. Returns null
 *  only if the shape is unusable (caller then renders the template). */
function coerceProse(
  parsed: unknown,
  draftProse: GeneratedBriefProse,
): GeneratedBriefProse | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() ? v : fallback;
  const arr = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : fallback;
  const strOrEmpty = (v: unknown): string => (typeof v === "string" ? v : "");
  // headline + recommendation are required prose; if both are missing the response
  // is unusable.
  if (typeof o.headline !== "string" && typeof o.recommendation !== "string") {
    return null;
  }
  const buy = strOrEmpty(o.buyProse).trim();
  const traj = strOrEmpty(o.trajectoryProse).trim();
  return {
    headline: str(o.headline, draftProse.headline),
    situation: arr(o.situation, draftProse.situation),
    flagged: arr(o.flagged, draftProse.flagged),
    buyProse: buy || draftProse.buyProse,
    trajectoryProse: traj || draftProse.trajectoryProse,
    recommendation: str(o.recommendation, draftProse.recommendation),
  };
}

export async function generateSupplierBriefNarrative(
  args: GenerateArgs,
): Promise<BriefNarrativeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { available: false, reason: "no_key" };
  const model = reportNarrativeModel();

  // The draft's six strings are the numeric grounding — the model rewrites these,
  // preserving their figures. flaggedClean → send an empty flagged list so the model
  // knows not to manufacture a concern.
  const draftProse: GeneratedBriefProse = {
    headline: args.draft.headline,
    situation: args.draft.situation,
    flagged: args.draft.flaggedClean ? [] : args.draft.flagged,
    buyProse: args.draft.buy?.prose ?? null,
    trajectoryProse: args.draft.trajectory?.prose ?? null,
    recommendation: args.draft.recommendation,
  };

  const requestPayload = {
    tone: args.tone,
    instruction: args.prompt,
    facts: args.facts,
    draft: {
      ...draftProse,
      buyProse: draftProse.buyProse ?? "",
      trajectoryProse: draftProse.trajectoryProse ?? "",
    },
  };
  const userContent = JSON.stringify(requestPayload);
  // A REQUEST fingerprint, not a prompt-only id: it covers the ENTIRE input to the model
  // — model id, system prompt, tone, the user instruction, the supplier's computed
  // values, and the template draft. It therefore changes per supplier (each brief has
  // different facts), so the footer/status label it "inputs", not "prompt". Canonical
  // (key-sorted) so identical inputs always hash identically regardless of key order.
  const inputsHash = createHash("sha256")
    .update(canonicalJson({ model, system: SYSTEM_PROMPT, request: requestPayload }))
    .digest("hex")
    .slice(0, 12);

  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  try {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // A grounded prose rewrite needs no chain-of-thought: disabling thinking keeps
      // cost predictable (no thinking tokens), gives the whole budget to the JSON (no
      // truncation), and is the cheapest configuration. effort:"low" trims the rest.
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      messages: [{ role: "user", content: userContent }],
    });
    if (res.stop_reason === "refusal") return { available: false, reason: "error" };
    const textBlock = res.content.find((b) => b.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text : "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { available: false, reason: "empty" };
    }
    const prose = coerceProse(parsed, draftProse);
    if (!prose) return { available: false, reason: "empty" };
    const usage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    };
    return {
      available: true,
      prose,
      model,
      inputsHash,
      usage,
      costUsd: estimateCost(model, usage),
    };
  } catch (err) {
    const reason =
      err instanceof Anthropic.APIConnectionTimeoutError ? "timeout" : "error";
    return { available: false, reason };
  }
}
