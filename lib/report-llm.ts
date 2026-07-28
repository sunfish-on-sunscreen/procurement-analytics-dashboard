import "server-only";
import { GoogleGenAI, Type, ApiError, type Schema } from "@google/genai";
import { createHash } from "node:crypto";
import type { ReportTone } from "@/lib/report-config";
import type { BriefFactsPayload } from "@/lib/report-narrative";
import type { RenderedSupplierBrief } from "@/lib/report-narrative";
import type {
  BriefNarrativeResult,
  BriefNarrativeUnavailableReason,
  GeneratedBriefProse,
} from "@/lib/report-llm-types";

/**
 * OPTIONAL LLM narrative for a supplier brief. Layered on top of the template
 * (lib/report-narrative) — NEVER replacing it. The model receives computed,
 * pre-formatted values and rewrites the six prose strings; it never computes,
 * recomputes, or alters a number.
 *
 * PROVIDER: Google Gemini via the @google/genai SDK. ⚠️ On the FREE tier, Google may
 * use API inputs and outputs to improve its products and human reviewers may read them
 * (the paid tier does not) — see Methodology §2.8. The payload is aggregate values only
 * (buildBriefPayload) — no transaction rows, no line prices — so exposure is bounded,
 * and this dataset is synthetic. Point it at real procurement data only after reading
 * that section.
 *
 * FALLBACK IS THE DEFAULT. A missing GEMINI_API_KEY, an API error, a rate-limit, or a
 * timeout all return { available: false } — the caller renders the template narrative
 * and a visible note. The app is fully functional with no key (the handover condition).
 * Every FAILURE (everything but a deliberately-absent key) is logged to the SERVER
 * CONSOLE first — class, message, and status, with the key scrubbed — so the route's
 * 200-and-degrade design cannot hide the cause. Nothing is ever surfaced to the client.
 *
 * MODEL IS CONFIG, NOT CODE (GEMINI_REPORT_MODEL) with a gemini-flash-latest default, so
 * the organisation can pin or raise the model later without a code change — the same
 * config-not-code discipline as the risk-model weights.
 */

// gemini-flash-latest is an ALIAS that tracks the current GA flash model, chosen
// deliberately over a pinned version: pinned `gemini-2.5-flash` was RETIRED for new
// users (404 "no longer available to new users"), and the alias cannot suffer that
// failure mode. Operators who need a pinned model set GEMINI_REPORT_MODEL.
const DEFAULT_MODEL = "gemini-flash-latest";
// One request per explicit user action; cap output so a runaway generation can't balloon
// token use. The six prose fields need well under this — the headroom exists because the
// current flash models THINK by default (see the config below), and thinking tokens count
// against this budget, so it must fit the reasoning plus the JSON. A truncated response
// parses as unusable and degrades to the template (now logged), so this is sized to avoid
// that on the success path.
const MAX_OUTPUT_TOKENS = 4096;
const TIMEOUT_MS = 25_000;

/** The env-configured narrative model (default gemini-2.5-flash). */
export function reportNarrativeModel(): string {
  return process.env.GEMINI_REPORT_MODEL?.trim() || DEFAULT_MODEL;
}

/** Whether the feature is enabled at all (a key is present). Read server-side only. */
export function reportNarrativeEnabled(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim();
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
// "" (not null) when the brief has no item / trajectory block. Gemini's responseSchema
// is a Schema built from the Type enum (no `additionalProperties`); `propertyOrdering`
// pins the field order so the emitted JSON is stable.
const OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    headline: { type: Type.STRING },
    situation: { type: Type.ARRAY, items: { type: Type.STRING } },
    flagged: { type: Type.ARRAY, items: { type: Type.STRING } },
    buyProse: { type: Type.STRING },
    trajectoryProse: { type: Type.STRING },
    recommendation: { type: Type.STRING },
  },
  required: [
    "headline",
    "situation",
    "flagged",
    "buyProse",
    "trajectoryProse",
    "recommendation",
  ],
  propertyOrdering: [
    "headline",
    "situation",
    "flagged",
    "buyProse",
    "trajectoryProse",
    "recommendation",
  ],
};

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

/** Classify a thrown SDK/runtime error into a degrade reason. A free-tier rate/quota
 *  cap (HTTP 429 RESOURCE_EXHAUSTED) is DISTINCT from a generic failure so the editor
 *  can tell the user to wait and retry rather than to check the key — the two read
 *  differently during a demo. A client-side abort maps to timeout; everything else is a
 *  generic error. Every case still degrades to the template. */
function classifyError(err: unknown): BriefNarrativeUnavailableReason {
  if (err instanceof ApiError && err.status === 429) return "rate_limited";
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" ||
      err.name === "AbortError" ||
      /timeout|timed out|abort/i.test(err.message))
  ) {
    return "timeout";
  }
  return "error";
}

/** Redact the API key from any string before it reaches the server console. Google auth
 *  errors do not echo the key, but a failing request could carry a URL that does — so
 *  scrub the full value (and a leading chunk, as insurance). */
function scrubKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  let out = text.split(apiKey).join("[REDACTED_KEY]");
  if (apiKey.length >= 16) out = out.split(apiKey.slice(0, 16)).join("[REDACTED_KEY]");
  return out;
}

/** Print a legible diagnostic to the SERVER CONSOLE *before* the route degrades to the
 *  template. Without it a provider failure (bad key, wrong credential type, quota,
 *  network, timeout) is swallowed by the 200-and-degrade design and invisible in the
 *  logs. SERVER ONLY — never returned to the client; the key is scrubbed from the
 *  message so it can never leak into a log. */
function logGenerationFailure(err: unknown, model: string, apiKey: string): void {
  const name = (err as { name?: unknown } | null)?.name;
  const cls =
    err instanceof ApiError
      ? "ApiError"
      : typeof name === "string" && name
        ? name
        : typeof err;
  const statusVal = (err as { status?: unknown } | null)?.status;
  const status = typeof statusVal === "number" ? statusVal : undefined;
  const rawMessage =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  console.error(
    "[report-llm] Gemini narrative generation failed — degrading to template. " +
      `model=${model} class=${cls}` +
      (status !== undefined ? ` status=${status}` : "") +
      `: ${scrubKey(rawMessage, apiKey)}`,
  );
}

export async function generateSupplierBriefNarrative(
  args: GenerateArgs,
): Promise<BriefNarrativeResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
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

  const ai = new GoogleGenAI({ apiKey });
  try {
    const res = await ai.models.generateContent({
      model,
      contents: userContent,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        // A grounded prose rewrite: keep it low-temperature so the model reshapes
        // wording rather than inventing figures the system prompt already forbids.
        temperature: 0.4,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // Structured JSON — Gemini guarantees response.text is valid JSON matching
        // OUTPUT_SCHEMA (no fences, no prose wrapper).
        responseMimeType: "application/json",
        responseSchema: OUTPUT_SCHEMA,
        // Deliberately NO thinkingConfig. The current flash models (gemini-flash-latest,
        // the 3.x generation) REJECT `thinkingBudget: 0` with 400 INVALID_ARGUMENT — only
        // the now-retired 2.5 line accepted it. Letting each model use its default thinking
        // keeps the request valid across model churn; MAX_OUTPUT_TOKENS is sized to absorb
        // the thinking tokens, and a truncated/empty response still degrades to the template.
        // Client-side timeout: abort after TIMEOUT_MS and degrade to the template.
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });

    const raw = res.text?.trim() ?? "";
    if (!raw) {
      // A 200 with empty text usually means a safety/finish block — surface which one,
      // so this degrade is not silent either.
      const finish = res.candidates?.[0]?.finishReason;
      const block = res.promptFeedback?.blockReason;
      console.warn(
        "[report-llm] Gemini returned no usable text — degrading to template. " +
          `model=${model}` +
          (finish ? ` finishReason=${finish}` : "") +
          (block ? ` blockReason=${block}` : ""),
      );
      return { available: false, reason: "empty" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(
        "[report-llm] Gemini response was not valid JSON — degrading to template. " +
          `model=${model} length=${raw.length}`,
      );
      return { available: false, reason: "empty" };
    }
    const prose = coerceProse(parsed, draftProse);
    if (!prose) {
      console.warn(
        "[report-llm] Gemini response JSON missing required prose fields — degrading to template. " +
          `model=${model}`,
      );
      return { available: false, reason: "empty" };
    }
    const usage = {
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    };
    return { available: true, prose, model, inputsHash, usage };
  } catch (err) {
    logGenerationFailure(err, model, apiKey);
    return { available: false, reason: classifyError(err) };
  }
}
