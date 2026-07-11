// Corpus-free generation engine for the "general" profile — any subject that
// isn't the competition-math corpus. Much simpler than the corpus pipeline: no
// anchor retrieval, no difficulty bands, no variant/adapt path. It builds a
// generic prompt, picks a model from a coarse tier, and runs a small
// generate → verify → refill-the-deficit loop reusing the shared primitives.

import Anthropic from "@anthropic-ai/sdk";
import { buildGeneralProblemPrompt } from "@/lib/generation/general-prompt";
import { PROBLEMS_TOOL, validateProblems, callToolWithRetry, type CallConfig } from "@/lib/generation/call-tool";
import { problemOk, solutionOk } from "@/lib/generation/verifier";
import { countForTier } from "@/lib/calibration";
import { generalTier } from "@/lib/subjects/general";
import type { Problem } from "@/lib/types";

// A Sonnet request is fanned into parallel chunks to stay under max_tokens, same
// as the corpus mid tier. Easy (Haiku) is a single non-streaming call.
const CHUNK = 4;

export type GeneralGenInput = {
  client: Anthropic;
  subject: string;
  level: string;
  topic: string;
  recentTopics: string[];
  validateAnswer: (p: Problem) => boolean;
  recordUsage: (u: Anthropic.Usage) => void;
};

export type GeneralGenResult =
  | { ok: true; problems: Problem[] }
  | { ok: false; error: string };

// Model selection mirrors the corpus route: GENERATION_MODEL overrides all;
// otherwise mid → Sonnet, easy → Haiku (env-overridable per tier).
function modelFor(tier: "easy" | "mid"): string {
  return (
    process.env.GENERATION_MODEL ??
    (tier === "mid"
      ? (process.env.GENERATION_MODEL_MID ?? "claude-sonnet-4-6")
      : (process.env.GENERATION_MODEL_EASY ?? "claude-haiku-4-5"))
  );
}

export async function generateGeneralProblems(input: GeneralGenInput): Promise<GeneralGenResult> {
  const { client, subject, level, topic, recentTopics, validateAnswer, recordUsage } = input;
  const tier = generalTier(level);
  const count = countForTier(tier); // 10 for easy/mid
  const model = modelFor(tier);
  const isSonnet = tier === "mid";
  console.log(`[/api/generate] general subject="${subject}" tier=${tier} model=${model} count=${count}`);

  // Haiku: thinking off, forced tool, single non-streaming call (avoids the
  // double-encode corruption the streaming partial-parser causes). Sonnet:
  // adaptive thinking (so tool_choice must be auto), streamed, chunked.
  const easyConfig: CallConfig = {
    thinking: { type: "disabled" },
    toolChoice: { type: "tool", name: "emit_problems" },
    maxTokens: Math.min(24000, 3000 + count * 2000),
    tool: PROBLEMS_TOOL,
    validate: validateProblems,
    stream: false,
  };
  const sonnetConfig = (chunkSize: number): CallConfig => ({
    thinking: { type: "adaptive" },
    effort: "medium",
    toolChoice: { type: "auto" },
    maxTokens: Math.min(32000, 8000 + chunkSize * 4500),
    tool: PROBLEMS_TOOL,
    validate: validateProblems,
  });

  // Sonnet: fan `askN` problems into parallel chunks; a failed chunk is non-fatal
  // (siblings + the deficit loop recover), all-failed propagates the first reason.
  async function generateSonnet(askN: number): Promise<Problem[]> {
    const chunks: number[] = [];
    for (let r = askN; r > 0; r -= CHUNK) chunks.push(Math.min(CHUNK, r));
    const settled = await Promise.allSettled(
      chunks.map((chunkSize) => {
        const { system, user } = buildGeneralProblemPrompt({ subject, level, topic, count: chunkSize, recentTopics });
        return callToolWithRetry(client, model, system, user, sonnetConfig(chunkSize), recordUsage);
      })
    );
    const out: Problem[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") out.push(...r.value);
      else console.warn(`[/api/generate] general chunk failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
    if (out.length === 0) {
      const firstReject = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      throw firstReject ? firstReject.reason : new Error("no_tool");
    }
    return out;
  }

  const maxAttempts = 2;
  const kept: Problem[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; attempt < maxAttempts && kept.length < count; attempt++) {
    const need = count - kept.length;
    const ask = attempt === 0 ? count : Math.min(need + 2, count);
    let batch: Problem[];
    try {
      if (isSonnet) {
        batch = await generateSonnet(ask);
      } else {
        const { system, user } = buildGeneralProblemPrompt({ subject, level, topic, count: ask, recentTopics });
        batch = await callToolWithRetry(client, model, system, user, easyConfig, recordUsage);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (kept.length > 0) break; // keep what we have if a retry fails
      console.error(`[/api/generate] general generation failed: ${msg}`);
      return {
        ok: false,
        error: msg === "truncated" ? "Generation was too long — try again." : "Generation failed — try again.",
      };
    }

    for (const p of batch) {
      if (kept.length >= count) break;
      if (seen.has(p.problem)) continue;
      if (!problemOk(p)) continue;
      if (!validateAnswer(p)) continue;
      if (!solutionOk(p)) continue;
      seen.add(p.problem);
      kept.push(p);
    }
  }

  if (kept.length === 0) return { ok: false, error: "Generation failed — couldn't produce usable problems. Try again." };

  // Strip the model's difficulty self-tag; it's a calibration aid, never shown.
  const problems: Problem[] = kept.map((p) => ({ problem: p.problem, answer: p.answer, solution: p.solution }));
  return { ok: true, problems };
}
