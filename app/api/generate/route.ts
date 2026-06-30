import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { buildPrompt, buildAuditPrompt, buildExpandPrompt, buildSeedSketchPrompt } from "@/lib/generation-prompt";
import { calibrationFor, categoryFor, countForTier, tierFor } from "@/lib/calibration";
import { getAnchors } from "@/lib/corpus-retrieval";
import { answerOk, problemOk, solutionOk, solutionSketchOk, tooSimilarToSeed } from "@/lib/generation/verifier";
import { expandSolutions } from "@/lib/generation/expand";
import { sketchSeeds } from "@/lib/generation/seed-sketch";
import { auditSketch } from "@/lib/generation/verifier-model";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import type { Anchor, Problem } from "@/lib/types";

// POST /api/generate — server-only. Uses ANTHROPIC_API_KEY from env; never
// import this route or the SDK in a client component.
//
// Body: { studentId, sessionId, topic? }  — always generates 10 problems
//
// We use tool-use (structured output) rather than parsing free text: LaTeX is
// backslash-heavy and the model would frequently emit JSON that won't parse
// (bad escapes, preamble, truncated strings). Forcing an emit_problems tool
// call makes the SDK hand us already-valid structured data.

// Generating 10 hard problems with full solutions is a large, slow streamed call;
// up to two attempts (generate + regenerate the deficit). Needs a Vercel plan
// whose function limit allows this (Hobby caps at 60s).
export const maxDuration = 300;

// Sonnet tiers generate in PARALLEL CHUNKS of this many problems. A single big
// call put thinking + full solutions over max_tokens and truncated (and ran ~7
// min, past maxDuration). Chunks keep each call's output well under its cap and
// run concurrently, so the full 1–20 slider fits one request. 4 is a balance for
// the MID tier: small enough that a chunk's medium-effort thinking + solutions
// never truncate, large enough to limit duplicated system-block input. The HARD
// tier (AIME #13–15 variants) thinks far more per problem and overran a 4-wide
// chunk, so it chunks 2-wide — see sonnetChunk in POST.
const SONNET_CHUNK = 4;

const PROBLEMS_TOOL: Anthropic.Tool = {
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

const EMPTY_TOOL_OUTPUT = "Tool output missing problems array";

// Pull the problems array out of a tool_use input. The easy tier (Haiku 4.5) has a
// systematic failure mode on longer outputs: it DOUBLE-ENCODES the array, emitting
// `{ "problems": "[{...}]" }` — `problems` is a JSON string of the array, not the array
// itself. The outer object is valid JSON (strict parse succeeds), so this is not a
// bad-escape/partial-parse issue; the value is just one level too deep. Recover it
// deterministically by parsing the string once. (Genuinely empty/garbled output throws
// EMPTY_TOOL_OUTPUT, which isTransient() treats as a retry.)
function extractProblems(raw: unknown): unknown[] {
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

function validateProblems(raw: unknown): Problem[] {
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
const VARIANT_PROBLEMS_TOOL: Anthropic.Tool = {
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

function validateVariantProblems(raw: unknown): Problem[] {
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
function parseEffort(
  v: string | undefined,
  fallback: "low" | "medium" | "high"
): "low" | "medium" | "high" {
  return v === "low" || v === "medium" || v === "high" ? v : fallback;
}

// Per-tier generation config. effort is optional because Haiku 4.5 rejects
// output_config.effort — omit it entirely for the easy tier. `tool`/`validate` select
// the full-solution path (PROBLEMS_TOOL) or the adapt sketch path (VARIANT_PROBLEMS_TOOL).
type CallConfig = {
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
async function callTool(
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
function isTransient(e: unknown): boolean {
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
async function callToolWithRetry(
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

export async function POST(request: Request) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Generation is not configured — set ANTHROPIC_API_KEY." },
        { status: 500 }
      );
    }

    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const body = await request.json();
    const studentId = typeof body.studentId === "string" ? body.studentId : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const topic = typeof body.topic === "string" ? body.topic : "";

    if (!studentId || !sessionId) {
      return NextResponse.json({ error: "Missing student or session." }, { status: 400 });
    }

    // Batch all DB reads into parallel queries — student, session, and recent
    // topics. All scoped to the current user so generation can't be driven off
    // another user's student/session.
    const [student, sessionRow, recent] = await Promise.all([
      prisma.student.findFirst({
        where: { id: studentId, userId },
        select: { level: true },
      }),
      prisma.session.findFirst({
        where: { id: sessionId, userId },
        select: { id: true },
      }),
      // Last 5 non-empty topics for this student, most recent first.
      prisma.session.findMany({
        where: { studentId, userId, topic: { not: "" } },
        orderBy: { start: "desc" },
        take: 5,
        select: { topic: true },
      }),
    ]);
    if (!student || !sessionRow) {
      return NextResponse.json({ error: "Student or session not found." }, { status: 404 });
    }
    // Capture as a non-null local: the guard above doesn't narrow `student` inside
    // the nested generation closures below.
    const studentLevel = student.level;
    const recentTopics = recent.map((s) => s.topic);

    // Difficulty calibration: derive the competition + problem-number band, then
    // retrieve real same-difficulty anchor problems from the corpus.
    const cal = calibrationFor(student);
    const tier = tierFor(cal);
    const category = categoryFor(studentLevel, topic);
    // Problem count is fixed by difficulty tier (easy/mid → 10, hard → 5), not chosen
    // in the UI — the hard tier's long problems warrant a shorter set.
    const count = countForTier(tier);
    // Prompt mode: hard tier (AIME #10–15) transforms real corpus problems into
    // isomorphic variants (same structure, new surface + numbers). easy and mid
    // tiers generate fresh problems anchored by the retrieved references for calibration.
    const mode = tier === "hard" ? "variant" : "scratch";

    // Variant tier (AIME #10–15) fetches MORE distinct seeds than problems so each
    // generated variant can be anchored to its OWN seed — two variants spun off the
    // same seed come out near-identical (the duplicate-problem bug). Scratch tiers show
    // all anchors as calibration context, so a small set is enough. getAnchors returns
    // distinct problems (deduped by statement there).
    const anchorCount = tier === "hard" ? 6 : 4;
    const seedFetchCount = mode === "variant" ? count + 6 : anchorCount;
    const seedPool: Anchor[] = cal.competition
      ? await getAnchors({
          competition: cal.competition,
          bandLow: cal.bandLow,
          bandHigh: cal.bandHigh,
          category,
          count: seedFetchCount,
        })
      : [];
    const anchorLabel = (a: Anchor) => `${a.source}${a.number != null ? `#${a.number}` : ""}`;
    // Variant mode hands each chunk its OWN distinct slice of the seed pool, advancing
    // a cursor across chunks AND across deficit retries, so no two generated problems
    // are built from the same seed. Wraps only if the pool runs out (the cross-variant
    // dedup below is the backstop). Scratch mode ignores this and shows all anchors.
    let seedCursor = 0;
    const nextSeeds = (n: number): Anchor[] => {
      if (seedPool.length === 0) return [];
      const out: Anchor[] = [];
      for (let i = 0; i < n; i++) out.push(seedPool[seedCursor++ % seedPool.length]);
      return out;
    };

    // The adapt path (transform the seed's real solution → emit a sketch → cheap
    // expand) is gated on variant mode AND seeds that actually carry solutions
    // (AIME/AMC do; F=ma is null, but F=ma never reaches variant mode). easy/mid
    // (scratch) NEVER adapt — they keep emitting full solutions directly.
    // GENERATION_NO_ADAPT=1 is a kill-switch back to the from-scratch variant path.
    const useAdapt =
      process.env.GENERATION_NO_ADAPT !== "1" && mode === "variant" && seedPool.some((a) => a.solution);

    // Log the actual anchor problem numbers (not just the count) so a "too easy"
    // report can be diagnosed by what difficulty the references really were.
    const anchorNums = seedPool.map(anchorLabel).join(", ");
    console.log(
      `[/api/generate] tier=${tier} competition=${cal.competition ?? "none"} band=${cal.bandLow ?? "?"}-${cal.bandHigh ?? "?"} category=${category ?? "any"} mode=${mode} adapt=${useAdapt} anchors=[${anchorNums}]`
    );

    // Per-request, per-stage token accounting → one summary line at the end.
    const accountant = new UsageAccountant();
    const recordGen = (u: Anthropic.Usage) => accountant.record("generation", u);

    const built = buildPrompt({
      level: studentLevel,
      topic,
      count,
      recentTopics,
      competition: cal.competition ?? undefined,
      bandLow: cal.bandLow,
      bandHigh: cal.bandHigh,
      anchors: seedPool,
      mode,
      adapt: useAdapt,
    });

    // A client-level timeout is REQUIRED for the easy tier's non-streaming call.
    // The SDK builds a non-streaming request as `timeout: client.timeout ??
    // calculateNonstreamingTimeout(max_tokens)`, and calculateNonstreamingTimeout
    // THROWS ("Streaming is required for operations that may take longer than 10
    // minutes") when max_tokens implies a >10min estimate — which the easy tier's
    // max_tokens (up to 24k) does. A per-request `{ timeout }` can't prevent it (the
    // throw happens while evaluating the default, before options are spread); only a
    // client-level timeout short-circuits the `??`. Pin it to maxDuration (the Vercel
    // function cap, in ms) — past it the request can't finish anyway. Streaming tiers
    // are unaffected by the value.
    const client = new Anthropic({ maxRetries: 4, timeout: maxDuration * 1000 }); // reads ANTHROPIC_API_KEY from env
    // Model selection — GENERATION_MODEL is a global override that wins over all
    // tier-specific vars. GENERATION_MODEL_HARD/MID/EASY are optional per-tier overrides.
    // Defaults: hard → Sonnet 4.6 (adaptive thinking, variant seeds, AIME #10–15);
    //           mid  → Sonnet 4.6 (adaptive thinking, scratch, AMC #16–25 / AIME #1–9);
    //           easy → Haiku 4.5  (no thinking, scratch, AMC #1–15 / unclassified).
    const model =
      process.env.GENERATION_MODEL ??
      (tier === "easy"
        ? (process.env.GENERATION_MODEL_EASY ?? "claude-haiku-4-5")
        : tier === "mid"
          ? (process.env.GENERATION_MODEL_MID ?? "claude-sonnet-4-6")
          : (process.env.GENERATION_MODEL_HARD ?? "claude-sonnet-4-6"));
    console.log(`[/api/generate] model=${model}`);

    // Adapt-path knobs (env-swappable; only the adapt path reads them). Effort for
    // the transformation pass defaults LOW — adapting a known-correct seed solution is
    // far lighter than the from-scratch solve the old medium budget was sized for.
    const escalateModel = process.env.GENERATION_MODEL_VERIFY ?? process.env.GENERATION_MODEL_EXPAND ?? "claude-haiku-4-5";
    const expandModel = process.env.GENERATION_MODEL_EXPAND ?? "claude-haiku-4-5";
    const adaptEffort = parseEffort(process.env.GENERATION_EFFORT_ADAPT, "low");
    const escalateEffort = parseEffort(process.env.GENERATION_EFFORT_ESCALATE, "high");
    const verifyOn = process.env.GENERATION_VERIFY === "1";

    // STAGE A — seed-sketch (adapt path only). Distill each seed's real corpus solution
    // into a numbered step-by-step sketch ONCE, up front, and attach it to the seed. The
    // transpose stage (generateSonnet) then mutates that skeleton instead of re-reading
    // the prose solution — handing the model a concrete sketch is what narrows the task
    // and suppresses the heavy re-derivation (and 20k truncations) measured on the fused
    // call. Batched into one cheap, thinking-off Haiku call. Non-blocking: on failure the
    // seeds keep their prose solution and buildPrompt falls back to the transform framing.
    // GENERATION_NO_SEED_SKETCH=1 disables it (back to the one-shot adapt path).
    if (useAdapt && process.env.GENERATION_NO_SEED_SKETCH !== "1") {
      const withSolutions = seedPool.filter((a) => a.solution);
      const sketches = await sketchSeeds(
        client,
        expandModel,
        withSolutions.map((a) => ({ statement: a.statement, solution: a.solution ?? "", answer: a.answer })),
        buildSeedSketchPrompt,
        (u) => accountant.record("seed-sketch", u)
      );
      withSolutions.forEach((a, i) => {
        if (sketches[i]) a.sketch = sketches[i];
      });
      console.log(
        `[/api/generate] seed-sketch: distilled ${withSolutions.filter((a) => a.sketch).length}/${withSolutions.length} seed solutions`
      );
    }

    // Per-tier call configuration.
    // SONNET (hard + mid): adaptive thinking ON, tool_choice=auto (forced tool +
    //   thinking is a 400). The ADAPT path (hard tier with seed solutions) runs at
    //   effort=adaptEffort (low) emitting a short sketch — the model transforms the
    //   seed's real solution instead of re-deriving, so heavy reasoning is no longer
    //   needed. The non-adapt sonnet paths keep effort=medium (mid scratch, or the
    //   defensive variant-without-solutions fallback): there the model must solve from
    //   scratch with no verifier downstream, so correctness needs the reasoning budget.
    // EASY (Haiku): thinking OFF, NO effort param (Haiku 4.5 rejects
    //   output_config.effort), forced tool, single call — already fast/cheap.
    const easyConfig: CallConfig = {
      thinking: { type: "disabled" },
      toolChoice: { type: "tool", name: "emit_problems" },
      // Single un-chunked call emitting all `count` full-solution problems (no
      // chunk-level fallback like Sonnet — "truncated" is terminal here). 1300/problem
      // (15000 at count=10) truncated mid-solution on a 10-problem easy set, so give it
      // real headroom. Thinking is OFF for Haiku, so the whole budget is statements +
      // answers + solutions; Haiku 4.5 output is cheap, the higher cap is the floor we
      // ever reach, not the bill.
      maxTokens: Math.min(24000, 3000 + count * 2000),
      tool: PROBLEMS_TOOL,
      validate: validateProblems,
      // Non-streaming: avoids the lenient partial-parser corrupting a double-encoded
      // problems string; short Haiku output won't hit the non-streaming timeout.
      stream: false,
    };
    const sonnetChunkConfig = (chunkSize: number, effortOverride?: "low" | "medium" | "high"): CallConfig => ({
      thinking: { type: "adaptive" },
      effort: effortOverride ?? (useAdapt ? adaptEffort : "medium"),
      toolChoice: { type: "auto" },
      // Adapt path emits short sketches, so its per-problem budget is lower than the
      // from-scratch full-solution paths — but adaptive thinking can still spike, and a
      // 12k cap (4000+2*4000) truncated in testing, so give it real headroom. Hard
      // non-adapt (AIME #13–15 re-solved) needs the larger budget that once overran a
      // 4-wide chunk; mid keeps the original 4-wide sizing.
      // NOTE: a thinking-OFF + forced-tool transpose was measured here and was strictly
      // worse — the reasoning relocated into the (billed) solutionSketch field (12k+ token
      // "sketches"), backtracking leaked into that field and tripped the guard, and the
      // set came back short. Keep adaptive thinking on; the per-problem reasoning cost is
      // intrinsic to computing a correct hard-AIME answer.
      maxTokens: useAdapt
        ? Math.min(32000, 8000 + chunkSize * 6000)
        : tier === "hard"
          ? Math.min(32000, 6000 + chunkSize * 8000)
          : Math.min(32000, 8000 + chunkSize * 4500),
      tool: useAdapt ? VARIANT_PROBLEMS_TOOL : PROBLEMS_TOOL,
      validate: useAdapt ? validateVariantProblems : validateProblems,
    });
    const isSonnet = tier !== "easy";
    // Hard-tier chunks are smaller so a chunk's thinking + full solutions stay under
    // the per-call cap (a 4-wide hard chunk truncated at 26000); mid stays 4-wide.
    const sonnetChunk = tier === "hard" ? 2 : SONNET_CHUNK;

    // Fan a Sonnet generation request out into parallel chunks of ≤SONNET_CHUNK.
    // A chunk that fails (transient or truncation) is non-fatal — its siblings'
    // problems plus the outer deficit loop recover; only an all-chunks-failed batch
    // propagates an error (preserving the original reason so "truncated" still maps
    // to the right message). Each chunk rebuilds the prompt with its own count; the
    // system block is count-free, so it stays byte-identical and prompt-cache applies.
    //
    // Variant mode gives each chunk a DISTINCT slice of the seed pool (nextSeeds),
    // so no two chunks transform the same seed; scratch shows all anchors for calibration.
    async function generateSonnet(
      askN: number,
      effortOverride?: "low" | "medium" | "high"
    ): Promise<Problem[]> {
      const chunks: number[] = [];
      for (let r = askN; r > 0; r -= sonnetChunk) chunks.push(Math.min(sonnetChunk, r));
      // Allocate each chunk's seeds up front (synchronously) so the parallel map can't
      // interleave the cursor — each chunk owns a disjoint set of distinct seeds.
      const chunkSeeds = chunks.map((chunkSize) => (mode === "variant" ? nextSeeds(chunkSize) : seedPool));
      const settled = await Promise.allSettled(
        chunks.map((chunkSize, ci) => {
          const cb = buildPrompt({
            level: studentLevel,
            topic,
            count: chunkSize,
            recentTopics,
            competition: cal.competition ?? undefined,
            bandLow: cal.bandLow,
            bandHigh: cal.bandHigh,
            anchors: chunkSeeds[ci],
            mode,
            adapt: useAdapt,
          });
          return callToolWithRetry(
            client,
            model,
            cb.system,
            cb.user,
            sonnetChunkConfig(chunkSize, effortOverride),
            recordGen
          );
        })
      );
      const out: Problem[] = [];
      for (const r of settled) {
        if (r.status === "fulfilled") out.push(...r.value);
        else
          console.warn(
            `[/api/generate] chunk failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
          );
      }
      if (out.length === 0) {
        const firstReject = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
        throw firstReject ? firstReject.reason : new Error("no_tool");
      }
      return out;
    }

    // Generate, keep only well-solved problems, and regenerate the deficit. The
    // verification pass (problemOk/answerOk) drops bad items, so a single retry
    // can still land short of `count` if the retry under-delivers or its own
    // problems get dropped — over-request the deficit so one dropped problem
    // doesn't leave the set short of `count`.
    //
    // Capped at 2 attempts (one generate + one deficit refill). The variant tier
    // used to churn here: near-verbatim variants tripped the seed-similarity guard
    // and burned 4 full rounds. The prompt now forces a re-dressed surface on the
    // first pass, so the seed-similarity relaxation on the final attempt lands at
    // attempt 2 instead of 4 — far less wasted generation for the same shipped set.
    const maxAttempts = 2;
    const kept: Problem[] = [];
    const seen = new Set<string>();
    for (let attempt = 0; attempt < maxAttempts && kept.length < count; attempt++) {
      const need = count - kept.length;
      // Over-request on deficit retries: ask for a small buffer above the
      // shortfall so a dropped/duplicate problem still leaves enough to reach
      // `count` (the keep-loop below stops adding at `count` regardless).
      const ask = attempt === 0 ? need : Math.min(need + 2, count);
      // On the deficit retry, only `count` changes in the prompt (user block).
      // system is stable (cached), so rebuild only the user block by calling
      // buildPrompt with the updated count — the system value is identical and
      // the prompt-cache hit still applies.
      const attemptBuilt =
        attempt === 0
          ? built
          : buildPrompt({
              level: studentLevel,
              topic,
              count: ask, // only this differs from the first call
              recentTopics,
              competition: cal.competition ?? undefined,
              bandLow: cal.bandLow,
              bandHigh: cal.bandHigh,
              anchors: seedPool,
              mode,
              adapt: useAdapt,
            });

      let batch: Problem[];
      try {
        // Sonnet tiers fan out into parallel chunks; easy stays a single call.
        batch = isSonnet
          ? await generateSonnet(ask)
          : await callToolWithRetry(client, model, attemptBuilt.system, attemptBuilt.user, easyConfig, recordGen);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (kept.length > 0) break; // keep what we have if a retry fails
        const status = e instanceof Anthropic.APIError ? ` status=${e.status}` : "";
        const name = e instanceof Error ? e.name : "";
        console.error(`[/api/generate] generation failed: ${msg || name}${status}`);
        return NextResponse.json(
          {
            error:
              msg === "truncated"
                ? "Generation was too long — try fewer problems."
                : "Generation failed — try again.",
          },
          { status: 500 }
        );
      }

      // Adapt path emits a sketch (checked by solutionSketchOk); all other paths emit
      // a full solution (solutionOk).
      const sketchGuardOk = useAdapt ? solutionSketchOk : solutionOk;
      for (const p of batch) {
        if (kept.length >= count) break;
        if (seen.has(p.problem)) continue;
        if (!problemOk(p)) {
          console.warn(`[/api/generate] dropped malformed problem: ${p.problem.slice(0, 80)}…`);
          continue;
        }
        if (!answerOk(p, cal.competition ?? undefined)) continue;
        if (!sketchGuardOk(p)) {
          console.warn(`[/api/generate] dropped ${useAdapt ? "sketch" : "solution"} with backtracking: ${p.problem.slice(0, 80)}…`);
          continue;
        }
        // Seed-similarity is no longer a drop reason — distinct per-chunk seeds already
        // keep variants away from each other, and a variant resembling its OWN seed is
        // acceptable. We only log it (helps diagnose a "too close to the real problem"
        // report) and never churn on it. Duplicates are caught by the cross-variant
        // dedup below, which is the real guarantee.
        if (mode === "variant") {
          const simReason = tooSimilarToSeed(p, seedPool);
          if (simReason) console.log(`[/api/generate] note: variant near seed (${simReason}) — keeping`);
        }
        // Cross-variant dedup — only on the variant (hard) path. Distinct per-chunk
        // seeds make this rare, but it's the hard guarantee against shipping the same
        // problem twice (e.g. the same 2-regular-graph count dressed once as computers
        // and once as dancers): compare each candidate to what's already kept and drop a
        // near-duplicate. Never relaxed — a duplicate in one set is always wrong; better
        // to ship one fewer.
        if (mode === "variant" && kept.length > 0) {
          const dupReason = tooSimilarToSeed(
            p,
            kept.map((k) => ({ source: "kept", number: null, statement: k.problem, answer: k.answer, solution: null }))
          );
          if (dupReason) {
            console.warn(`[/api/generate] dropped near-duplicate of a kept problem (${dupReason}): ${p.problem.slice(0, 80)}…`);
            continue;
          }
        }
        seen.add(p.problem);
        kept.push(p);
      }
    }

    if (kept.length === 0) {
      return NextResponse.json(
        { error: "Generation failed — couldn't produce solvable problems. Try again." },
        { status: 500 }
      );
    }

    // Adapt path: optional correctness audit + bounded escalation, then expand the
    // sketches into full student-facing solutions. (Off paths already hold full solutions.)
    if (useAdapt) {
      const sketchItems = () =>
        kept.map((p) => ({ problem: p.problem, answer: p.answer, solutionSketch: p.solutionSketch ?? "" }));

      // STAGE 2 — verification (off unless GENERATION_VERIFY=1). Audit sketch→answer
      // arithmetic; escalate at most 3 flagged items to a single heavy full-solve that
      // regenerates fresh variants to replace them. No re-verify, no loop.
      if (verifyOn) {
        const verdicts = await auditSketch(client, escalateModel, sketchItems(), buildAuditPrompt, (u) =>
          accountant.record("verification", u)
        );
        const failIdx = verdicts.flatMap((v, i) => (v === "fail" ? [i] : [])).slice(0, 3);
        if (failIdx.length > 0) {
          console.warn(`[/api/generate] audit flagged ${failIdx.length} sketch(es) — escalating to a heavy solve`);
          let replacements: Problem[] = [];
          try {
            replacements = await generateSonnet(failIdx.length, escalateEffort);
          } catch (e) {
            console.warn(`[/api/generate] escalation failed, keeping flagged items: ${e instanceof Error ? e.message : String(e)}`);
          }
          let r = 0;
          for (const rep of replacements) {
            if (r >= failIdx.length) break;
            if (seen.has(rep.problem)) continue;
            if (!problemOk(rep) || !answerOk(rep, cal.competition ?? undefined) || !solutionSketchOk(rep)) continue;
            const target = failIdx[r];
            seen.delete(kept[target].problem);
            seen.add(rep.problem);
            kept[target] = rep;
            r++;
          }
        }
      }

      // STAGE 3 — expansion (always). Cheap model turns each sketch into a full
      // solution; keep BOTH. Re-check the expanded text for backtracking and fall back
      // to the sketch if the expander leaked any.
      const solutions = await expandSolutions(client, expandModel, sketchItems(), buildExpandPrompt, (u) =>
        accountant.record("expansion", u)
      );
      kept.forEach((p, i) => {
        p.solution = solutions[i] ?? p.solutionSketch ?? "";
        if (!solutionOk(p)) p.solution = p.solutionSketch ?? p.solution;
      });
    }

    // Strip the model's difficulty self-tag (e.g. "AMC 10 #15"). It's a
    // generation-time calibration aid only — never surfaced on the problem. Keep the
    // sketch alongside the expanded solution on the adapt path.
    const problems: Problem[] = kept.map((p) => ({
      problem: p.problem,
      answer: p.answer,
      solution: p.solution,
      ...(p.solutionSketch ? { solutionSketch: p.solutionSketch } : {}),
    }));
    console.log(`[/api/generate] returned ${problems.length}/${count} verified problems`);
    console.log(accountant.summaryLine({ tier, count }));

    await prisma.session.update({
      where: { id: sessionId },
      data: { problems: problems as unknown as Prisma.InputJsonValue },
    });

    return NextResponse.json(problems);
  } catch (e) {
    console.error("[/api/generate POST]", e);
    return NextResponse.json({ error: "Generation failed — try again." }, { status: 500 });
  }
}
