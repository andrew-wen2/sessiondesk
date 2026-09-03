// Per-stage token accounting for /api/generate. One generation request can fan out
// across several model calls in up to three stages — the heavy generation pass, an
// optional cheap verification audit, and a cheap solution-expansion pass. This
// aggregates `message.usage` from each call, tagged by stage, into a single summary
// line so the thinking-token cost of each stage is visible (the headline metric for
// the adapt-path optimization is `think/problem`).
//
// IMPORTANT: thinking tokens are a SUBSET of output_tokens, exposed separately at
// usage.output_tokens_details.thinking_tokens (null when thinking is off / older
// models). We surface that subset but never re-add it to the output total.

import type Anthropic from "@anthropic-ai/sdk";

export type Stage = "plan" | "seed-sketch" | "generation" | "verification" | "expansion" | "solve";

type StageTotals = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
  calls: number;
};

const emptyTotals = (): StageTotals => ({
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
  calls: 0,
});

export class UsageAccountant {
  private byStage = new Map<Stage, StageTotals>();

  // Fold one call's usage into its stage. Safe to call from inside the streamed
  // generation path and from the cheap Haiku stages alike.
  record(stage: Stage, u: Anthropic.Usage): void {
    const t = this.byStage.get(stage) ?? emptyTotals();
    t.input += u.input_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    // thinking is a subset of output_tokens — report it, do not add it to output.
    t.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
    t.calls += 1;
    this.byStage.set(stage, t);
  }

  // Read-only access to the per-stage totals for genMeta persistence (Eng C1: the
  // class used to expose only summaryLine(), a string — a log line, not data. This
  // is additive; summaryLine's behavior is unchanged.) `provider` is threaded in
  // by the caller per stage since UsageAccountant itself doesn't know which vendor
  // made a given call (today, always "anthropic" — see gen-meta.ts's provider field).
  totals(stage: Stage): StageTotals | undefined {
    return this.byStage.get(stage);
  }

  // StageTotals field names (input/cacheWrite/cacheRead/output/thinking) don't
  // match GenMeta's StageUsage names (inputTokens/cacheWriteTokens/...) — this is
  // the one place that mapping happens, so callers building a StageUsage (route.ts,
  // problems.ts) don't each re-derive it.
  asStageUsage(stage: Stage, provider: string, model: string): import("@/lib/generation/gen-meta").StageUsage | null {
    const t = this.byStage.get(stage);
    if (!t) return null;
    return {
      provider,
      model,
      calls: t.calls,
      inputTokens: t.input,
      outputTokens: t.output,
      thinkingTokens: t.thinking,
      cacheWriteTokens: t.cacheWrite,
      cacheReadTokens: t.cacheRead,
    };
  }

  // One log line per request. The headline metric is `gen-out/problem` — the generation
  // stage's OUTPUT tokens ÷ problems returned. On Sonnet 4.6 `thinking_tokens` reports 0
  // (the reasoning is billed inside output_tokens but not broken out), so `think/problem`
  // reads 0 and hides the real spend; generation output-per-problem is the honest cost
  // signal — the metric that tracks the heavy-reasoning regression the adapt staging targets.
  summaryLine(meta: { tier: string; count: number }): string {
    const order: Stage[] = ["plan", "seed-sketch", "generation", "verification", "expansion", "solve"];
    let totalThinking = 0;
    const parts: string[] = [];
    for (const stage of order) {
      const t = this.byStage.get(stage);
      if (!t) continue;
      totalThinking += t.thinking;
      parts.push(
        `${stage}{calls=${t.calls} in=${t.input} cacheW=${t.cacheWrite} cacheR=${t.cacheRead} out=${t.output} think=${t.thinking}}`
      );
    }
    const genOut = this.byStage.get("generation")?.output ?? 0;
    const genPerProblem = meta.count > 0 ? Math.round(genOut / meta.count) : 0;
    const thinkPerProblem = meta.count > 0 ? Math.round(totalThinking / meta.count) : 0;
    return `[/api/generate] usage-by-stage tier=${meta.tier} count=${meta.count} ${parts.join(
      " "
    )} TOTAL think=${totalThinking} think/problem=${thinkPerProblem} gen-out/problem=${genPerProblem}`;
  }
}
