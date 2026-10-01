// Shared by the accuracy evals (eval-accuracy.ts, eval-solve-first.ts): the blind
// solvers (cheap open-weight judge, Opus), the answer-equivalence check, and fixture
// planning. Model calls live here; the pure judging logic stays in the *-lib.ts files.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { planFor, type GenerationPlan, type Tier } from "@/lib/generation/plan";
import { getAnchors } from "@/lib/corpus-retrieval";
import { countForTier } from "@/lib/calibration";
import { buildSolvePrompt } from "@/lib/generation-prompt";
import { SOLVE_TOOL } from "@/lib/generation/solve";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { envOr } from "@/lib/generation/config";
import { parseLadder, type RungConfig } from "@/lib/generation/cascade/ladder";
import { SPARES } from "@/lib/generation/cascade/generate";
import type { Anchor } from "@/lib/types";
import type { Fixture } from "./eval-lib";
import {
  EQUIV_JUDGE,
  JUDGE_MAX_TOKENS,
  readToolCall,
  toolChoiceFor,
  type ChatToolResponse,
  type SolveObs,
} from "./eval-accuracy-lib";

import { fetchRetrying } from "@/lib/generation/cascade/openweight-call";

// Re-exported for eval-solve-first.ts, which imports its helpers from here.
export { fetchRetrying };

// Judges get more time than a live rung: a slow judge costs this eval minutes, not a
// tutor's request, and a judge timeout only sends the item to Opus.
const CHEAP_JUDGE_TIMEOUT_MS = 240_000;
const OPUS_JUDGE_TIMEOUT_MS = 300_000;

export type Planned = { fixture: Fixture; plan: GenerationPlan; pool: Anchor[]; mode: "variant" | "scratch" };

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

export type SolveArgs = { problem: string; plan: GenerationPlan; tier: Tier; accountant: UsageAccountant };

export async function opusSolve(client: Anthropic, model: string, { problem, plan, tier, accountant }: SolveArgs): Promise<SolveObs> {
  const prompt = buildSolvePrompt({ problem, domain: plan.domain, rubric: plan.rubric, answerFormat: plan.answerFormat });
  try {
    const params = {
      model,
      max_tokens: JUDGE_MAX_TOKENS[tier],
      thinking: { type: "adaptive" as const },
      output_config: { effort: tier === "easy" ? "medium" : "high" },
      system: [{ type: "text" as const, text: prompt.system, cache_control: { type: "ephemeral" as const } }],
      tools: [SOLVE_TOOL],
      tool_choice: { type: "auto" as const },
      messages: [{ role: "user" as const, content: prompt.user }],
    };
    const message = await client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming, { timeout: OPUS_JUDGE_TIMEOUT_MS });
    accountant.recordFor("solve", "anthropic", model, message.usage);
    if (message.stop_reason === "max_tokens") return { kind: "error", message: "truncated" };
    const tool = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    return toObs(tool?.input);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export async function openWeightSolve(rung: RungConfig, { problem, plan, accountant }: SolveArgs): Promise<SolveObs> {
  const prompt = buildSolvePrompt({ problem, domain: plan.domain, rubric: plan.rubric, answerFormat: plan.answerFormat });
  const baseUrl = envOr("OPENWEIGHT_BASE_URL", "").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHEAP_JUDGE_TIMEOUT_MS);
  try {
    const res = await fetchRetrying(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${envOr("OPENWEIGHT_API_KEY", "")}` },
      body: JSON.stringify({
        model: rung.model,
        max_tokens: 16000,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        tools: [{ type: "function", function: { name: SOLVE_TOOL.name, description: SOLVE_TOOL.description, parameters: SOLVE_TOOL.input_schema } }],
        tool_choice: toolChoiceFor(rung, SOLVE_TOOL.name),
        ...(rung.thinking === "off" ? { thinking: { type: "disabled" } } : { reasoning_effort: rung.thinking === "max" ? "high" : rung.thinking }),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { kind: "error", message: `HTTP ${res.status}` };
    const body = (await res.json()) as ChatToolResponse;
    accountant.recordFor("solve", "openweight", rung.model, {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
    } as Anthropic.Usage);
    const call = readToolCall(body, SOLVE_TOOL.name);
    return call.ok ? toObs(call.args) : { kind: "error", message: call.message };
  } catch (e) {
    return { kind: "error", message: controller.signal.aborted ? "timeout" : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Are two final answers the same answer? Never solves anything: it sees the problem
// only so it knows how many parts an answer has. Thinking off, forced tool, so a few
// hundred tokens per comparison. An error counts as "not equivalent", which only ever
// sends the item on to Opus (more cost, never a wrong verdict on its own).
const EQUIV_TOOL = {
  name: "emit_equivalence",
  description: "Report whether the two final answers are the same answer.",
  parameters: {
    type: "object",
    properties: { equivalent: { type: "boolean" } },
    required: ["equivalent"],
  },
};

export async function equivalent(a: string, b: string, problem: string, accountant: UsageAccountant): Promise<boolean> {
  const [rung] = parseLadder("easy", `${EQUIV_JUDGE},anthropic:claude-opus-5-5`);
  const baseUrl = envOr("OPENWEIGHT_BASE_URL", "").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetchRetrying(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${envOr("OPENWEIGHT_API_KEY", "")}` },
      body: JSON.stringify({
        model: rung.model,
        max_tokens: 200,
        thinking: { type: "disabled" },
        messages: [
          {
            role: "system",
            content:
              "You compare two final answers to the same problem. They are equivalent when they state the same value(s) or content, ignoring notation, LaTeX, ordering of parts, variable labels, units written or omitted, and any explanation around the answer. They are NOT equivalent if any value differs, a part is missing or extra, or one answer hedges between options. Do not solve the problem or judge which answer is right. Call emit_equivalence.",
          },
          { role: "user", content: `Problem:\n${problem}\n\nAnswer A:\n${a}\n\nAnswer B:\n${b}` },
        ],
        tools: [{ type: "function", function: EQUIV_TOOL }],
        tool_choice: { type: "function", function: { name: EQUIV_TOOL.name } },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as ChatToolResponse;
    accountant.recordFor("verification", "openweight", rung.model, {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
    } as Anthropic.Usage);
    const call = readToolCall(body, EQUIV_TOOL.name);
    return call.ok && (call.args as { equivalent?: unknown }).equivalent === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function toObs(raw: unknown): SolveObs {
  const r = (raw ?? {}) as { answer?: unknown; ambiguous?: unknown; note?: unknown };
  if (r.ambiguous === true) return { kind: "ambiguous", note: typeof r.note === "string" ? r.note : "" };
  if (typeof r.answer !== "string" || !r.answer.trim()) return { kind: "error", message: "no answer" };
  return { kind: "answer", answer: r.answer };
}


// ---------------------------------------------------------------------------
// Planning (cached next to --out so a resume doesn't re-plan)
// ---------------------------------------------------------------------------

// From this machine, about 1 in 4 fresh connections to the Neon endpoint hangs until
// Prisma gives up (5s connect / 10s pool wait), while an immediate retry connects in
// under a second. Only the first query of a run opens one, so a short retry covers it.
async function withDbRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !/Can't reach database server|Timed out fetching a new connection/.test(String(e))) throw e;
      console.log(`database connection failed (attempt ${i}/${attempts}), retrying`);
    }
  }
}

export async function planFixtures(fixtures: Fixture[], cachePath: string): Promise<Planned[]> {
  const cache: Record<string, GenerationPlan> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const client = new Anthropic();
  const out: Planned[] = [];
  for (const f of fixtures) {
    const plan =
      cache[f.id] ??
      (await planFor({ client, profile: f.profile, topic: f.topic, recentTopics: f.recentTopics, recordUsage: () => {} }));
    cache[f.id] = plan;
    const mode = plan.tier === "hard" && plan.competition ? "variant" : "scratch";
    const count = countForTier(plan.tier);
    const competition = plan.competition;
    const pool = competition
      ? await withDbRetry(() => getAnchors({
          competition,
          bandLow: plan.bandLow,
          bandHigh: plan.bandHigh,
          category: plan.category,
          count: mode === "variant" ? count + SPARES : plan.tier === "hard" ? 6 : 4,
          strictBand: mode === "variant",
        }))
      : [];
    out.push({ fixture: f, plan, pool, mode });
    console.log(`plan ${f.id}: tier=${plan.tier} source=${plan.source} format=${plan.answerFormat}${mode === "variant" ? ` seeds=${pool.length}` : ""}`);
  }
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  return out;
}

