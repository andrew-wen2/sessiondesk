// Solve-first experiment: the writer emits a problem STATEMENT only, then two solvers
// answer it blind in separate calls: the writer's own model ("self") and a different
// family ("cross"). Opus solves every item to settle the truth. Reports each solver's
// accuracy and what "ship only when self and cross agree" would ship.
// Scoring rules: eval-solve-first-lib.ts. Solvers and planning: eval-accuracy-shared.ts.
//
// The writer gets the cascade's real prompt (cascadeRequestBuilder) plus an override
// that asks for the statement alone, through a problem-only tool. That prompt still
// describes answer/solution fields; the override tells it to ignore them. Open-weight
// writers only, since that is what this experiment is for.
//
// --construct: the writer builds the problem BACKWARD from an answer it picks first,
// and reports that answer in a private "intended" field the solvers never see. It then
// counts as a third vote (scored against the truth, never part of it).
// --lean: construct with buildConstructPrompt (a construction-only prompt with a
// bounded procedure) instead of the cascade prompt plus the CONSTRUCT override.
// --forward: the writer solves forward, as in production: the cascade's own writer and
// unmodified prompt return problem + answer + solution (any provider, Opus included),
// the cascade's full guards apply, and the writer's answer is what the blind solvers
// are checked against.
// --no-opus: skip Opus entirely. Nothing is scored right or wrong; the report is only
// how the writer's intended answer and the two solvers line up.
//
// SPENDS REAL API CREDIT — refuses to run without --yes; stops starting new items at
// --max-dollars. Needs DATABASE_URL for contest fixtures (anchors are read-only).
//
//   npm run eval:solve-first -- --dry-run
//   npm run eval:solve-first -- --yes --contest-only --per-tier 10 --out runs/solve-first-easy.jsonl
//   npm run eval:solve-first -- --yes --contest-only --construct --no-opus --out runs/construct-easy.jsonl
//   npm run eval:solve-first -- --summary runs/solve-first-easy.jsonl
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { countForTier } from "@/lib/calibration";
import { envOr } from "@/lib/generation/config";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun } from "@/lib/generation/pricing";
import { problemOk } from "@/lib/generation/verifier";
import { parseLadder, type RungConfig } from "@/lib/generation/cascade/ladder";
import { buildSpecs } from "@/lib/generation/cascade/slots";
import {
  cascadeCheck,
  cascadeRequestBuilder,
  SPARES,
  writersFor,
} from "@/lib/generation/cascade/generate";
import { buildConstructPrompt } from "@/lib/generation-prompt";
import { getAnchors } from "@/lib/corpus-retrieval";
import { RungError } from "@/lib/generation/cascade/writers";
import type { Tier } from "@/lib/generation/plan";
import { prisma } from "@/lib/prisma";
import type { Fixture } from "./eval-lib";
import {
  equivKey,
  readToolCall,
  toolChoiceFor,
  type ChatToolResponse,
} from "./eval-accuracy-lib";
import {
  equivalent,
  fetchRetrying,
  openWeightSolve,
  opusSolve,
  planFixtures,
  type Planned,
  type SolveArgs,
} from "./eval-accuracy-shared";
import {
  compareStep,
  solveFirstStep,
  summarizeComparisons,
  summarizeSolveFirst,
  type SolveFirstRecord,
} from "./eval-solve-first-lib";

const FIXTURES = "scripts/eval-fixtures/generation-fixtures.json";
const USAGE = `Usage:
  npm run eval:solve-first -- --dry-run|--yes [--tier easy] [--per-tier 10] [--contest-only] [--construct] [--lean] [--forward] [--no-opus]
       [--writer openweight:deepseek-ai/DeepSeek-V4.1-Flash] [--self <spec, default: the writer's model @low>]
       [--cross openweight:zai-org/GLM-5.3] [--judge-model claude-opus-5-5]
       [--out runs/solve-first.jsonl] [--concurrency N, default: every item at once] [--max-dollars 3]
       [--timeout S  writer deadline in seconds, default: the rung's real ladder deadline]
       [--band LO-HI  pretend each contest student's band is this, anchors re-fetched to match]
       [--max-tokens N  writer output cap (thinking included), default: the rung's ladder value]
  npm run eval:solve-first -- --summary runs/solve-first.jsonl`;

type Args = {
  dryRun: boolean;
  yes: boolean;
  tier: Tier;
  perTier: number;
  contestOnly: boolean;
  construct: boolean;
  lean: boolean; // implies construct
  forward: boolean; // the cascade's own writer, answer and solution included
  noOpus: boolean;
  writer: string;
  self: string;
  cross: string;
  judgeModel: string;
  out: string;
  concurrency: number; // Infinity = every item at once (the default)
  maxDollars: number;
  timeoutS?: number; // overrides the writer's ladder deadline
  band?: [number, number]; // overrides each contest plan's difficulty band (the tier and everything else stay)
  maxTokens?: number; // overrides the writer's ladder output cap
  summary?: string;
};

function parseArgs(argv: string[]): Args {
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const num = (name: string, fallback: number) => {
    const v = value(name);
    const n = v === undefined ? fallback : Number(v);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`--${name} must be a positive number`);
    return n;
  };
  const tier = (value("tier") ?? "easy") as Tier;
  if (!["easy", "mid", "hard"].includes(tier))
    throw new Error("--tier must be easy, mid or hard");
  const writer =
    value("writer") ?? "openweight:deepseek-ai/DeepSeek-V4.1-Flash";
  return {
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes"),
    tier,
    perTier: num("per-tier", 10),
    contestOnly: argv.includes("--contest-only"),
    construct: argv.includes("--construct") || argv.includes("--lean"),
    lean: argv.includes("--lean"),
    forward: argv.includes("--forward"),
    noOpus: argv.includes("--no-opus"),
    writer,
    // The solver thinks even when the writer doesn't: with thinking off, a solver
    // either works in plain text until max_tokens (tool optional) or guesses with no
    // room to work (tool forced), and never flags a broken problem.
    self: value("self") ?? `${writer.replace(/@.*$/, "")}@low`,
    cross: value("cross") ?? "openweight:zai-org/GLM-5.3",
    judgeModel: value("judge-model") ?? "claude-opus-5-5",
    out: value("out") ?? "runs/solve-first.jsonl",
    concurrency:
      value("concurrency") === undefined ? Infinity : num("concurrency", 1),
    maxDollars: num("max-dollars", 3),
    timeoutS: value("timeout") === undefined ? undefined : num("timeout", 1),
    band: (() => {
      const v = value("band");
      if (v === undefined) return undefined;
      const m = /^(\d+)-(\d+)$/.exec(v);
      if (!m || Number(m[1]) > Number(m[2])) throw new Error("--band must look like 16-25");
      return [Number(m[1]), Number(m[2])] as [number, number];
    })(),
    maxTokens:
      value("max-tokens") === undefined ? undefined : num("max-tokens", 1),
    summary: value("summary"),
  };
}

// A cheap rung's config (thinking, max tokens, deadline) exactly as the ladder would
// build it for this tier. The Opus top rung is only there to satisfy the parser.
const rungFor = (tier: Tier, spec: string): RungConfig =>
  parseLadder(tier, `${spec},anthropic:claude-opus-5-5`)[0];
const writerRung = (
  a: Pick<Args, "tier" | "writer" | "timeoutS" | "maxTokens">,
): RungConfig => {
  const rung = rungFor(a.tier, a.writer);
  return {
    ...rung,
    ...(a.timeoutS ? { timeoutMs: a.timeoutS * 1000 } : {}),
    ...(a.maxTokens ? { maxTokens: a.maxTokens } : {}),
  };
};

// ---------------------------------------------------------------------------
// Problem-only writer
// ---------------------------------------------------------------------------

const PROBLEM_TOOL = {
  name: "emit_problem",
  description: "Return the problem statement only.",
  parameters: {
    type: "object",
    properties: {
      problem: {
        type: "string",
        description:
          "The full, self-contained problem statement. LaTeX in $...$ / $$...$$.",
      },
    },
    required: ["problem"],
  },
};

const CONSTRUCT_TOOL = {
  name: "emit_problem",
  description:
    "Return the problem statement, plus the answer it was built from (kept private from the solver).",
  parameters: {
    type: "object",
    properties: {
      problem: PROBLEM_TOOL.parameters.properties.problem,
      intended: {
        type: "string",
        description:
          "The final answer you chose first and built the problem from. Answer only, in the required format.",
      },
      construction: {
        type: "string",
        description:
          "One or two lines: the values you chose and how each given number was computed from them.",
      },
    },
    required: ["problem", "intended", "construction"],
  },
};

const CONSTRUCT = `

OVERRIDE FOR THIS CALL: build the problem BACKWARD from its answer, then call emit_problem.
1. First choose the final answer and every intermediate quantity a solver will find along the way (for example how many of each item, or the value of each unknown). Pick values that satisfy the problem's natural constraints: whole-number counts, real solutions, positive lengths.
2. Then compute every given number in the statement FROM those chosen values, so every stated condition holds exactly.
3. Check that the statement determines the answer uniquely: enough independent conditions to pin down every quantity the question depends on, and no other value of the asked quantity fits.
Put the statement alone in "problem" (no answer, solution, or hint), the chosen answer in "intended", and the chosen values and how the givens were computed in "construction". Ignore every instruction above about the "answer", "solution" and "solutionSketch" fields. Everything else above still applies.`;

const PROBLEM_ONLY = `

OVERRIDE FOR THIS CALL: write the problem STATEMENT only, and call emit_problem with it. Do not include an answer, a solution, or any working. Ignore every instruction above about the "answer", "solution" and "solutionSketch" fields: a separate solver produces those. Everything else still applies, and the problem must still have exactly one definite answer in the required answer format.`;

type Written = { problem: string; intended?: string; construction?: string };

// suffix: the override appended to the cascade prompt's user turn ("" for --lean,
// whose prompt already asks for exactly this).
async function writeProblem(
  rung: RungConfig,
  system: string,
  user: string,
  construct: boolean,
  suffix: string,
  accountant: UsageAccountant,
): Promise<Written> {
  const tool = construct ? CONSTRUCT_TOOL : PROBLEM_TOOL;
  if (rung.provider !== "openweight")
    throw new Error(`writer must be an openweight rung, got ${rung.provider}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), rung.timeoutMs);
  try {
    const res = await fetchRetrying(
      `${envOr("OPENWEIGHT_BASE_URL", "").replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${envOr("OPENWEIGHT_API_KEY", "")}`,
        },
        body: JSON.stringify({
          model: rung.model,
          max_tokens: rung.maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user + suffix },
          ],
          tools: [{ type: "function", function: tool }],
          tool_choice: toolChoiceFor(rung, tool.name),
          ...(rung.thinking === "off"
            ? { thinking: { type: "disabled" } }
            : {
                reasoning_effort:
                  rung.thinking === "max" ? "high" : rung.thinking,
              }),
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ChatToolResponse;
    accountant.recordFor("generation", "openweight", rung.model, {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
    } as Anthropic.Usage);
    const call = readToolCall(body, tool.name);
    if (!call.ok) throw new Error(call.message);
    const out = call.args as {
      problem?: unknown;
      intended?: unknown;
      construction?: unknown;
    };
    if (typeof out.problem !== "string" || !out.problem.trim())
      throw new Error("empty problem");
    if (!construct) return { problem: out.problem };
    if (typeof out.intended !== "string" || !out.intended.trim())
      throw new Error("no intended answer");
    return {
      problem: out.problem,
      intended: out.intended,
      construction:
        typeof out.construction === "string" ? out.construction : "",
    };
  } catch (e) {
    if (controller.signal.aborted) throw new Error("timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// One item: write, guard, solve twice, settle with Opus
// ---------------------------------------------------------------------------

async function runItem(
  a: Args,
  index: number,
  round: number,
  planned: Planned,
  opus: Anthropic,
): Promise<SolveFirstRecord> {
  const { plan, pool, mode, fixture } = planned;
  const accountant = new UsageAccountant();
  const count = countForTier(plan.tier);
  const { specs } = buildSpecs({
    plan,
    mode,
    seeds: mode === "variant" ? pool : [],
    total: count + SPARES,
  });
  const slot = round % specs.length;
  const calibration = mode === "variant" ? pool.slice(0, 4) : pool;
  const request = a.lean
    ? buildConstructPrompt({
        plan,
        profile: fixture.profile,
        topic: fixture.topic,
        recentTopics: fixture.recentTopics,
        anchors: calibration,
        avoidStatements: [],
        slot: { index: slot % count, of: count, hint: specs[slot].hint },
      })
    : cascadeRequestBuilder({
        plan,
        profile: fixture.profile,
        topic: fixture.topic,
        recentTopics: fixture.recentTopics,
        pool,
        calibration,
        count,
      })({ objective: slot % count, spec: specs[slot], kept: [], rung: rungFor(a.tier, a.writer) });

  const rec: SolveFirstRecord = {
    id: `${a.tier}|${a.writer}|${index}`,
    index,
    fixtureId: fixture.id,
    answerFormat: plan.answerFormat,
    write: { ok: false, ms: 0, finish: "api-error", message: "" },
    guard: null,
    opus: [],
    dollars: 0,
    unpriced: [],
  };
  const finish = () => {
    const cost = costForRun(accountant.perModelUsage());
    rec.dollars = cost.total;
    rec.unpriced = cost.unpriced;
    return rec;
  };

  const started = Date.now();
  try {
    if (a.forward) {
      const rung = writerRung(a);
      const writer = writersFor(new Set([rung.provider]))[rung.provider];
      if (!writer) throw new Error(`no credentials for ${rung.provider}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("rung-timeout"), rung.timeoutMs);
      try {
        const p = await writer({
          rung,
          ...request,
          signal: controller.signal,
          recordUsage: (u) => accountant.recordFor("generation", rung.provider, rung.model, u),
        });
        rec.write = { ok: true, ms: Date.now() - started, problem: p.problem, intended: p.answer, construction: p.solution };
        rec.guard = cascadeCheck(plan)(p, specs[slot]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      const written = await writeProblem(
        writerRung(a),
        request.system,
        request.user,
        a.construct,
        a.lean ? "" : a.construct ? CONSTRUCT : PROBLEM_ONLY,
        accountant,
      );
      const problem = written.problem;
      rec.write = { ok: true, ms: Date.now() - started, ...written };
      rec.guard = problemOk({ problem, answer: "", solution: "" }, plan)
        ? null
        : "guard-problem";
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    rec.write = {
      ok: false,
      ms: Date.now() - started,
      // The cascade writer (--forward) names its own failure; the eval writers throw
      // bare messages.
      finish:
        e instanceof RungError
          ? e.finish
          : message === "timeout"
          ? "timeout"
          : message === "truncated"
            ? "max-tokens"
            : "api-error",
      message: message.slice(0, 200),
    };
  }
  if (!rec.write.ok || rec.guard) return finish();

  const solveArgs: SolveArgs = {
    problem: rec.write.problem,
    plan,
    tier: a.tier,
    accountant,
  };
  [rec.self, rec.cross] = await Promise.all([
    openWeightSolve(rungFor(a.tier, a.self), solveArgs),
    openWeightSolve(rungFor(a.tier, a.cross), solveArgs),
  ]);
  const intended = rec.write.intended;
  if (a.noOpus) {
    for (;;) {
      const step = compareStep({
        format: plan.answerFormat,
        self: rec.self,
        cross: rec.cross,
        intended,
        equiv: rec.equiv,
      });
      if ("compared" in step) {
        rec.compared = step.compared;
        return finish();
      }
      rec.equiv = {
        ...rec.equiv,
        [equivKey(step.a, step.b)]: await equivalent(
          step.a,
          step.b,
          rec.write.problem,
          accountant,
        ),
      };
    }
  }
  for (;;) {
    const step = solveFirstStep({
      format: plan.answerFormat,
      self: rec.self,
      cross: rec.cross,
      opus: rec.opus,
      intended,
      equiv: rec.equiv,
    });
    if ("scored" in step) {
      rec.scored = step.scored;
      return finish();
    }
    if (step.need === "equiv") {
      rec.equiv = {
        ...rec.equiv,
        [equivKey(step.a, step.b)]: await equivalent(
          step.a,
          step.b,
          rec.write.problem,
          accountant,
        ),
      };
    } else rec.opus.push(await opusSolve(opus, a.judgeModel, solveArgs));
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const pct = (x: number | null) =>
  x == null ? "—" : `${(x * 100).toFixed(1)}%`;

function printSummary(
  a: Pick<Args, "self" | "cross">,
  records: SolveFirstRecord[],
) {
  const compared = records.flatMap((r) => (r.compared ? [r.compared] : []));
  if (compared.length) {
    const c = summarizeComparisons(compared);
    const written = records.filter((r) => r.write.ok).length;
    console.log(
      [
        "",
        `written ${written}/${records.length} | guard-rejected ${records.filter((r) => r.write.ok && r.guard).length} | compared ${c.compared} (no Opus: agreement only, nothing scored right or wrong)`,
        `solvers agree on an answer: ${c.solversAgree}/${c.compared} | both flag ill-posed: ${c.bothFlagged} | one flags: ${c.oneFlagged} | a solver errored: ${c.errors}`,
        ...(c.constructed
          ? [
              `writer's intended answer + both solvers agree: ${c.constructed.allThree} (what a three-way rule would ship)`,
              `solvers agree, writer differs: ${c.constructed.solversAgreeWriterDiffers} (likely a construction mistake)`,
              `solvers split: writer sides with self ${c.constructed.writerMatchesOnlySelf}, with cross ${c.constructed.writerMatchesOnlyCross}, with neither ${c.constructed.noneAgree}`,
            ]
          : []),
        `self = ${a.self}, cross = ${a.cross}`,
        `${records.reduce((n, r) => n + r.dollars, 0).toFixed(2)}`,
      ].join("\n"),
    );
    return;
  }
  const s = summarizeSolveFirst(records);
  console.log(
    [
      "",
      `written ${s.attempted - s.writeFailed}/${s.attempted} | guard-rejected ${s.guardRejected} | judged ${s.judged} | unresolved ${s.unresolved} | ill-posed ${s.illPosed}`,
      `self solver  (${a.self}): ${s.self.right}/${s.judged} right (${pct(s.self.rate)})`,
      `cross solver (${a.cross}): ${s.cross.right}/${s.judged} right (${pct(s.cross.rate)})`,
      `agreed on ${s.agreed}/${s.judged}`,
      ...(s.intended
        ? [
            `writer's intended answer: ${s.intended.right}/${s.judged} right (${pct(s.intended.rate)})`,
          ]
        : []),
      ...(s.allThree
        ? [
            `ship-if-all-three-agree: shipped ${s.allThree.shipped}, wrong ${s.allThree.shippedWrong} (${pct(s.allThree.wrongRate)}); dropped ${s.allThree.dropped} (${s.allThree.droppedGood} were well-posed)`,
          ]
        : []),
      `ship-if-both-agree: shipped ${s.both.shipped}, wrong ${s.both.shippedWrong} (${pct(s.both.wrongRate)}, 95% upper ${pct(s.both.upperBound)}); dropped ${s.both.dropped} (${s.both.droppedGood} were well-posed)`,
      `$${s.dollars.toFixed(2)}${s.unpriced.length ? ` + unpriced ${s.unpriced.join(", ")}` : ""}`,
      "A solver is right when it matches the settled answer, or flags a problem that is in fact ill-posed.",
    ].join("\n"),
  );
}

function readRecords(file: string): SolveFirstRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SolveFirstRecord);
}

// ---------------------------------------------------------------------------

async function main() {
  let a: Args;
  try {
    a = parseArgs(process.argv.slice(2));
    for (const spec of [a.writer, a.self, a.cross]) rungFor(a.tier, spec); // validates each spec
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    process.exit(1);
  }
  if (a.summary) {
    printSummary(a, readRecords(a.summary));
    return;
  }
  const w = writerRung(a);
  console.log(
    `Writer${a.forward ? "" : " (problem only)"}: ${a.writer} (thinking=${w.thinking} tool=${w.toolChoice} deadline=${w.timeoutMs / 1000}s max_tokens=${w.maxTokens})\n` +
      `Mode: ${a.forward ? "forward: the cascade's own writer (problem + answer + solution)" : a.lean ? "construct backward, construction-only prompt (--lean)" : a.construct ? "construct backward from a private intended answer" : "statement only"}${a.band ? `, band overridden to #${a.band[0]}-${a.band[1]}` : ""}\n` +
      `Solvers: self ${a.self} (thinking=${rungFor(a.tier, a.self).thinking}), cross ${a.cross} (thinking=${rungFor(a.tier, a.cross).thinking}); ${a.noOpus ? "no Opus (agreement only)" : `Opus ${a.judgeModel} on every item`}\n` +
      `${a.perTier} ${a.tier}-tier items${a.contestOnly ? " (contest fixtures only)" : ""}; capped at $${a.maxDollars}.`,
  );
  if (a.dryRun) return;
  if (!a.yes) {
    console.error(
      "eval:solve-first makes real model calls. Re-run with --yes to spend.",
    );
    process.exit(1);
  }
  // Planning still calls Anthropic for a non-contest fixture that isn't cached yet.
  for (const k of [
    "ANTHROPIC_API_KEY",
    "DATABASE_URL",
    "OPENWEIGHT_BASE_URL",
    "OPENWEIGHT_API_KEY",
  ]) {
    if (!process.env[k]) {
      console.error(`${k} is not set.`);
      process.exit(1);
    }
  }

  mkdirSync(path.dirname(a.out), { recursive: true });
  const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8")) as Fixture[];
  const planned = await planFixtures(fixtures, `${a.out}.plans.json`);
  if (a.band) {
    // Aim-high experiment: the same student, told a different band. Reference problems
    // come from the new band too, since they are part of what the band means.
    const [bandLow, bandHigh] = a.band;
    for (const p of planned) {
      const competition = p.plan.competition;
      if (!competition || p.mode !== "scratch") continue;
      p.plan = { ...p.plan, bandLow, bandHigh };
      p.pool = await getAnchors({ competition, bandLow, bandHigh, category: p.plan.category, count: p.plan.tier === "hard" ? 6 : 4 });
    }
  }
  const pool = planned.filter(
    (p) =>
      p.plan.tier === a.tier &&
      (!a.contestOnly || p.plan.competition) &&
      (p.mode === "scratch" || p.pool.length > 0),
  );
  if (pool.length === 0) {
    console.error(
      `No ${a.contestOnly ? "contest " : ""}fixture plans to the ${a.tier} tier.`,
    );
    process.exit(1);
  }
  const existing = readRecords(a.out);
  const done = new Set(existing.map((r) => r.index));
  let spent = existing.reduce((n, r) => n + r.dollars, 0);
  const queue: { index: number; round: number; planned: Planned }[] = [];
  for (let i = 0; i < a.perTier; i++) {
    if (!done.has(i))
      queue.push({
        index: i,
        round: Math.floor(i / pool.length),
        planned: pool[i % pool.length],
      });
  }
  console.log(
    `${queue.length} items to run (${done.size} already in ${a.out}).`,
  );

  const opus = new Anthropic({ maxRetries: 2 });
  let stopped = false;
  let finished = 0;
  await Promise.all(
    Array.from({ length: Math.min(a.concurrency, queue.length) }, async () => {
      for (;;) {
        if (spent >= a.maxDollars) {
          stopped = true;
          return;
        }
        const job = queue.shift();
        if (!job) return;
        const rec = await runItem(a, job.index, job.round, job.planned, opus);
        spent += rec.dollars;
        appendFileSync(a.out, JSON.stringify(rec) + "\n");
        finished++;
        const obs = (o?: { kind: string; answer?: string }) =>
          o?.kind === "answer" ? o.answer : o?.kind;
        const i =
          rec.write.ok && rec.write.intended !== undefined
            ? ` intended=${rec.write.intended}`
            : "";
        const cmp = rec.compared;
        const what = !rec.write.ok
          ? `write ${rec.write.finish}`
          : rec.guard
            ? rec.guard
            : cmp
              ? `${i.trim()} self=${obs(rec.self)} cross=${obs(rec.cross)} → ${cmp.selfCross ? "solvers agree" : "solvers split"}${cmp.intendedSelf === undefined ? "" : cmp.intendedSelf && cmp.selfCross ? ", writer agrees" : cmp.selfCross ? ", writer differs" : ""}`
              : `truth=${rec.scored?.truth.kind === "answer" ? rec.scored.truth.answer : rec.scored?.truth.kind} self=${obs(rec.self)}${rec.scored?.selfOk ? " (right)" : ""} cross=${obs(rec.cross)}${rec.scored?.crossOk ? " (right)" : ""} → ${rec.scored?.bothRule}`;
        console.log(
          `[${finished}/${finished + queue.length}] #${rec.index} ${rec.fixtureId}: ${what} — $${spent.toFixed(2)} so far`,
        );
      }
    }),
  );
  if (stopped)
    console.log(
      `\nStopped at --max-dollars $${a.maxDollars} (spent $${spent.toFixed(2)}). Re-run with a higher cap to resume.`,
    );
  printSummary(a, readRecords(a.out));
}

main()
  .catch((e) => {
    console.error("[eval:solve-first]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
