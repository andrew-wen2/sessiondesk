// Low-level Anthropic tool-call primitives shared by both generation engines
// (the competition-math corpus pipeline in app/api/generate/route.ts and the
// corpus-free general engine in lib/generation/general.ts). Extracted verbatim so
// there is ONE implementation of the double-encode recovery, the streaming vs.
// non-streaming decision, and the transient-retry policy.
//
// We use tool-use (structured output) rather than parsing free text: LaTeX is
// backslash-heavy and the model would frequently emit JSON that won't parse
// (bad escapes, preamble, truncated strings). Forcing an emit_problems tool call
// makes the SDK hand us already-valid structured data.

import Anthropic from "@anthropic-ai/sdk";
import type { Problem } from "@/lib/types";

export const PROBLEMS_TOOL: Anthropic.Tool = {
  name: "emit_problems",
  description: "Return the generated practice problems for the session.",
  input_schema: {
    type: "object",
    properties: {
      problems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            problem: { type: "string", description: "Problem statement, LaTeX in $...$ / $$...$$" },
            answer: { type: "string", description: "Final answer only — no working" },
            solution: { type: "string", description: "Concise solution, 3–8 lines" },
            difficulty: {
              type: "string",
              description: "Difficulty self-estimate as a competition reference, e.g. 'AIME #12'",
            },
          },
          required: ["problem", "answer", "solution", "difficulty"],
        },
      },
    },
    required: ["problems"],
  },
};

export const EMPTY_TOOL_OUTPUT = "Tool output missing problems array";

// Pull the problems array out of a tool_use input. The easy tier (Haiku 4.5) has a
// systematic failure mode on longer outputs: it DOUBLE-ENCODES the array, emitting
// `{ "problems": "[{...}]" }` — `problems` is a JSON string of the array, not the array
// itself. The outer object is valid JSON (strict parse succeeds), so this is not a
// bad-escape/partial-parse issue; the value is just one level too deep. Recover it
// deterministically by parsing the string once. (Genuinely empty/garbled output throws
// EMPTY_TOOL_OUTPUT, which isTransient() treats as a retry.)
export function extractProblems(raw: unknown): unknown[] {
  if (!raw || typeof raw !== "object") throw new Error(EMPTY_TOOL_OUTPUT);
  let problems = (raw as { problems?: unknown }).problems;
  if (typeof problems === "string") {
    try {
      problems = JSON.parse(problems);
    } catch {
      throw new Error(EMPTY_TOOL_OUTPUT);
    }
  }
  if (!Array.isArray(problems)) throw new Error(EMPTY_TOOL_OUTPUT);
  return problems;
}

export function validateProblems(raw: unknown): Problem[] {
  return extractProblems(raw).map((p) => {
    if (
      !p ||
      typeof (p as Problem).problem !== "string" ||
      typeof (p as Problem).answer !== "string" ||
      typeof (p as Problem).solution !== "string"
    ) {
      throw new Error("Problem item missing required string fields");
    }
    const { problem, answer, solution, difficulty } = p as Problem;
    return { problem, answer, solution, difficulty: typeof difficulty === "string" ? difficulty : undefined };
  });
}

// Adapt path (hard/variant): the heavy pass emits `solutionSketch` instead of a full
// `solution`. The tool is named "emit_problems" too — only one tool is ever passed per
// call, so the name can match (keeps the prompt's "call the emit_problems tool" valid).
// `solution` is left empty here and filled by the expansion stage.
export const VARIANT_PROBLEMS_TOOL: Anthropic.Tool = {
  name: "emit_problems",
  description: "Return the generated practice problems (with solution sketches) for the session.",
  input_schema: {
    type: "object",
    properties: {
      problems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            problem: { type: "string", description: "Problem statement, LaTeX in $...$ / $$...$$" },
            answer: { type: "string", description: "Final answer only — no working" },
            solutionSketch: {
              type: "string",
              description: "Terse sketch: key insight + major steps + final arithmetic that yields the answer",
            },
            difficulty: {
              type: "string",
              description: "Difficulty self-estimate as a competition reference, e.g. 'AIME #12'",
            },
          },
          required: ["problem", "answer", "solutionSketch", "difficulty"],
        },
      },
    },
    required: ["problems"],
  },
};

export function validateVariantProblems(raw: unknown): Problem[] {
  // Lenient: skip a malformed item rather than dropping the whole chunk (one bad item
  // shouldn't waste its well-formed siblings + their thinking tokens). If the model put
  // the sketch in `solution` instead of `solutionSketch`, accept that as the sketch.
  const out: Problem[] = [];
  for (const p of extractProblems(raw)) {
    const item = p as { problem?: unknown; answer?: unknown; solutionSketch?: unknown; solution?: unknown; difficulty?: unknown };
    const sketch =
      typeof item?.solutionSketch === "string" && item.solutionSketch.trim()
        ? item.solutionSketch
        : typeof item?.solution === "string" && item.solution.trim()
          ? item.solution
          : undefined;
    if (!item || typeof item.problem !== "string" || typeof item.answer !== "string" || sketch === undefined) {
      console.warn("[/api/generate] skipped malformed variant item (missing fields)");
      continue;
    }
    // `solution` filled later by the expansion stage; carry the sketch through.
    out.push({
      problem: item.problem,
      answer: item.answer,
      solution: "",
      solutionSketch: sketch,
      difficulty: typeof item.difficulty === "string" ? item.difficulty : undefined,
    });
  }
  return out;
}

// Validate an env-supplied effort against the allowed set, falling back to a default.
export function parseEffort(
  v: string | undefined,
  fallback: "low" | "medium" | "high"
): "low" | "medium" | "high" {
  return v === "low" || v === "medium" || v === "high" ? v : fallback;
}

// Per-tier generation config. effort is optional because Haiku 4.5 rejects
// output_config.effort — omit it entirely for the easy tier. `tool`/`validate` select
// the full-solution path (PROBLEMS_TOOL) or the adapt sketch path (VARIANT_PROBLEMS_TOOL).
export type CallConfig = {
  thinking: Anthropic.ThinkingConfigParam;
  effort?: "low" | "medium" | "high";
  toolChoice: Anthropic.ToolChoice;
  maxTokens: number;
  tool: Anthropic.Tool;
  validate: (raw: unknown) => Problem[];
  // Sonnet tiers stream (long worked-solution outputs would hit the SDK's non-streaming
  // HTTP timeout). The easy tier (Haiku, short outputs) does NOT stream: streaming
  // finalizes tool input with a lenient partial-JSON parser that skips backslash escapes,
  // which corrupts Haiku's occasional double-encoded `{ "problems": "[...]" }` emission
  // (the escaped quotes terminate the string early). Non-streaming returns the
  // API-parsed input, so extractProblems can un-stringify it cleanly. Default: stream.
  stream?: boolean;
};

// One tool-forced generation call → structurally-valid Problem[]. Throws
// "truncated" / "no_tool" on infrastructure failures so the caller can map them.
//
// Hard problems with full worked solutions are long — 10 of them overran the old
// non-streaming cap. We stream so we can allow a high max_tokens without hitting
// the SDK's non-streaming HTTP timeout, and read the final message.
export async function callTool(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  config: CallConfig,
  recordUsage: (u: Anthropic.Usage) => void
): Promise<Problem[]> {
  // effort is omitted entirely for the easy tier (Haiku 4.5 rejects output_config.effort).
  // Cast to MessageCreateParams so we can include output_config without TS objecting to
  // the ParseableMessageCreateParams narrow override that MessageStreamParams carries.
  const streamParams = {
    model,
    max_tokens: config.maxTokens,
    // Reason through each (hard) problem before committing to an answer. Without
    // this the model emits a solution it never actually worked out — the source
    // of mathematically wrong answers. Adaptive is the only on-mode for Sonnet 4.6;
    // easy tier sets thinking disabled (Haiku 4.5, generate-from-scratch).
    thinking: config.thinking,
    // The stable instructions + rubric live in the system block and are cached;
    // the deficit-retry and same-student repeat generations read
    // them back at ~0.1× instead of full input price.
    system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
    tools: [config.tool],
    // Hard tier: must be "auto" — forced tool_choice is rejected when thinking is on.
    // Easy tier: forced tool_choice is fine (thinking is off) and ensures the tool fires.
    tool_choice: config.toolChoice,
    messages: [{ role: "user" as const, content: user }],
    ...(config.effort !== undefined ? { output_config: { effort: config.effort } } : {}),
  };
  // output_config is an extension field not yet in the SDK's stream-params typing;
  // cast through unknown only at the call boundary rather than mislabeling the whole
  // object as MessageCreateParams.
  const message: Anthropic.Message =
    config.stream === false
      ? ((await client.messages.create(
          streamParams as unknown as Anthropic.MessageCreateParamsNonStreaming
        )) as Anthropic.Message)
      : await client.messages
          .stream(streamParams as unknown as Parameters<typeof client.messages.stream>[0])
          .finalMessage();
  // Stage-tagged token accounting (thinking is a subset of output — handled in
  // UsageAccountant). cache_read should be > 0 on deficit retries / same-student repeats.
  recordUsage(message.usage);
  // Per-call line too (before the truncation throw), so a partial/killed run still
  // reports what it spent and which calls truncated.
  const u = message.usage;
  console.log(
    `[/api/generate] gen call input=${u.input_tokens} cacheR=${u.cache_read_input_tokens ?? 0} output=${u.output_tokens} thinking=${u.output_tokens_details?.thinking_tokens ?? 0} stop=${message.stop_reason}`
  );
  if (message.stop_reason === "max_tokens") throw new Error("truncated");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("no_tool");
  return config.validate(toolUse.input);
}

// A transient failure is worth retrying (a brief Anthropic overload, a rate
// limit, a dropped connection, a streamed response that arrived without the
// forced tool block, or a tool emission with no usable problems array even after
// the double-encode recovery in extractProblems — see EMPTY_TOOL_OUTPUT).
// "truncated" and the per-item validation errors are terminal — retrying won't
// change the outcome, so they fall through to the caller.
export function isTransient(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (e instanceof Anthropic.APIError && typeof e.status === "number") {
    return e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  }
  return e instanceof Error && (e.message === "no_tool" || e.message === EMPTY_TOOL_OUTPUT);
}

// callTool with a couple of extra attempts on transient errors so a single API
// blip doesn't surface to the user as "Generation failed". The SDK already
// retries the stream-opening request (maxRetries); this covers mid-stream drops
// and missing-tool responses that the SDK can't retry for us.
export async function callToolWithRetry(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  config: CallConfig,
  recordUsage: (u: Anthropic.Usage) => void
): Promise<Problem[]> {
  const maxTries = 3;
  for (let t = 1; ; t++) {
    try {
      return await callTool(client, model, system, user, config, recordUsage);
    } catch (e) {
      if (t >= maxTries || !isTransient(e)) throw e;
      const name = e instanceof Error ? e.message || e.name : "unknown";
      console.warn(`[/api/generate] transient failure (attempt ${t}/${maxTries}): ${name} — retrying`);
      await new Promise((r) => setTimeout(r, 400 * t)); // 400ms, 800ms backoff
    }
  }
}
