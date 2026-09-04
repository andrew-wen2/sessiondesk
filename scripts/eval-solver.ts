// Solver accuracy check — the eval that decides whether lib/generation/solve.ts
// can actually be an oracle. Feeds real, human-written, verified-answer corpus
// problems into solveProblem() and compares against the known answer. No
// generation involved, no labeling needed, no Prisma import (reads the committed
// fixture dump from scripts/dump-corpus-fixtures.ts instead of live production
// Neon — see that script's header, Eng S3).
//
// IMPORTANT (CEO review, corrected during Eng review): this is an UPPER BOUND on
// generated-problem accuracy, not an estimate of it. The fixture population is
// real, well-posed AIME/AMC statements; generated variants are model-written and
// frequently subtly ill-posed in ways this eval cannot see. Report it as a ceiling.
//
//   npx tsx scripts/eval-solver.ts --dry-run
//   npx tsx scripts/eval-solver.ts --yes --out runs/solver-baseline.jsonl
//   npx tsx scripts/eval-solver.ts --yes --sample 20   (a quick partial run)

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { solveProblem } from "@/lib/generation/solve";
import { solverConfig, SOLVER_CLIENT_TIMEOUT_MS } from "@/lib/generation/config";
import { answersMatch } from "@/lib/generation/answer-match";
import { costForRun, formatRunCost } from "@/lib/generation/pricing";
import type { AnswerFormat } from "@/lib/generation/plan";

type CorpusFixture = { id: string; source: string; number: number | null; statement: string; answer: string };

function parseArgs() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    dryRun: flag("dry-run"),
    yes: flag("yes"),
    sample: value("sample") ? Number(value("sample")) : undefined,
    out: value("out") ?? "runs/solver-eval.jsonl",
  };
}

type SolverRunRecord = { id: string; source: string; number: number | null; outcome: string; correct: boolean };

function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

// AIME answers are integers; AMC10/AMC12 corpus rows keep their original numeric
// value even though the live prompt strips multiple-choice framing — both are
// "numeric" enough for answersMatch's strict comparison.
function formatFor(source: string): AnswerFormat {
  return source === "AIME" ? "integer" : "numeric";
}

async function main() {
  const args = parseArgs();
  const fixturePath = path.join(__dirname, "eval-fixtures", "corpus-sample.json");
  if (!existsSync(fixturePath)) {
    console.error(`No fixture file at ${fixturePath}. Run: npx tsx scripts/dump-corpus-fixtures.ts`);
    process.exit(1);
  }
  let fixtures: CorpusFixture[] = JSON.parse(readFileSync(fixturePath, "utf8"));
  if (args.sample) fixtures = fixtures.slice(0, args.sample);

  const cfg = solverConfig();
  console.log(`Fixtures: ${fixtures.length}. Solver model: ${cfg.model} (escalate: ${cfg.escalateModel}).`);
  console.log(`Estimated worst case: ${fixtures.length * (1 + cfg.maxEscalations)} solver calls.`);
  console.log(`Typical case (most agree on round 1): ~${fixtures.length} solver calls.`);

  if (args.dryRun) {
    console.log("--dry-run: no calls made. Re-run with --yes to spend.");
    return;
  }
  if (!args.yes) {
    console.error("This spends real Anthropic API credit. Re-run with --yes to proceed (or --dry-run to preview).");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const outPath = path.join(process.cwd(), args.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  console.log(`Writing incrementally to ${outPath} (a crash mid-run doesn't lose completed fixtures).`);

  // Skip anything already answered CORRECTLY on a prior invocation — the file
  // accumulates across runs (appendFileSync, no truncation), and without this an
  // interrupted-then-resumed run silently re-solves and duplicates rows for
  // problems that already succeeded. A prior wrong/errored attempt is retried.
  const priorCorrect = new Set(
    readJsonl<SolverRunRecord>(outPath)
      .filter((r) => r.correct)
      .map((r) => r.id)
  );
  if (priorCorrect.size > 0) {
    console.log(`${priorCorrect.size} fixtures already correct in ${outPath} — skipping those, retrying the rest.`);
  }

  const client = new Anthropic({ maxRetries: 2, timeout: SOLVER_CLIENT_TIMEOUT_MS });
  let correct = 0;
  let attempted = 0;
  const bySource: Record<string, { correct: number; total: number }> = {};
  const usage: Record<string, { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; thinkingTokens: number; cacheWriteTokens: number; cacheReadTokens: number }> = {};

  for (const f of fixtures) {
    if (priorCorrect.has(f.id)) continue;
    const format = formatFor(f.source);
    const outcome = await solveProblem({
      client,
      model: cfg.model,
      escalateModel: cfg.escalateModel,
      effort: cfg.effort,
      problem: f.statement,
      domain: f.source,
      rubric: "",
      answerFormat: format,
      generatorAnswer: f.answer, // the KNOWN answer stands in for "the generator's" — agreement here means "the solver got it right"
      maxEscalations: cfg.maxEscalations,
      recordUsage: (u) => {
        const key = "solve";
        const e = usage[key] ?? {
          provider: "anthropic",
          model: cfg.model,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        };
        e.calls++;
        e.inputTokens += u.input_tokens ?? 0;
        e.outputTokens += u.output_tokens ?? 0;
        e.thinkingTokens += u.output_tokens_details?.thinking_tokens ?? 0;
        e.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
        e.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        usage[key] = e;
      },
    });

    attempted++;
    const bucket = (bySource[f.source] ??= { correct: 0, total: 0 });
    bucket.total++;

    const isCorrect =
      outcome.kind === "answer" &&
      answersMatch(outcome.answer, f.answer, { format, strictness: "strict" });
    if (isCorrect) {
      correct++;
      bucket.correct++;
    }

    const record = {
      id: f.id,
      source: f.source,
      number: f.number,
      outcome: outcome.kind,
      solverAnswer: outcome.kind === "answer" ? outcome.answer : null,
      knownAnswer: f.answer,
      correct: isCorrect,
      attempts: "attempts" in outcome ? outcome.attempts : 0,
    };
    appendFileSync(outPath, JSON.stringify(record) + "\n");
    console.log(
      `[${attempted}/${fixtures.length}] ${f.source}#${f.number ?? "?"} ${isCorrect ? "✓" : "✗"} (${outcome.kind})`
    );
  }

  console.log("\n=== Solver accuracy (UPPER BOUND on generated-problem accuracy, see file header) ===");
  console.log(`Overall: ${correct}/${attempted} = ${((correct / attempted) * 100).toFixed(1)}%`);
  for (const [source, b] of Object.entries(bySource)) {
    console.log(`  ${source}: ${b.correct}/${b.total} = ${((b.correct / b.total) * 100).toFixed(1)}%`);
  }
  console.log(
    `Estimated cost: ${formatRunCost(costForRun(usage))} (verify model pricing is current — see pricing.ts)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
