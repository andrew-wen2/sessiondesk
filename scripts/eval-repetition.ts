// Repetition eval: does a student who is seen repeatedly on one topic keep getting the
// same problems? Runs --sessions sets for one fixture IN ORDER (each session sees the
// previous sessions' problems, as the route passes them), then groups every problem by
// underlying type with one model call and counts repeats inside a set and across sets.
// Scoring: eval-repetition-lib.ts. --cluster FILE groups an existing eval:generation
// run instead (the baseline).
//
// SPENDS REAL API CREDIT; needs --yes. Sessions are sequential by design: session N's
// input depends on session N-1's output.
//
//   npm run eval:repetition -- --yes --fixtures runs/fixtures-amc-10-15.json --sessions 3 --out runs/rep.jsonl
//   npm run eval:repetition -- --yes --cluster runs/e2e-opus-10-15.jsonl
//   npm run eval:repetition -- --yes --compare runs/baseline.jsonl,runs/fixed.jsonl
//
// --compare groups several runs in ONE call and reports each run separately. Always
// compare this way: two separate grouping calls choose different granularities (one
// run's "word problem → quadratic" was another's four distinct setups), so their counts
// aren't comparable.
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { generateProblems } from "@/lib/generation/problems";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun } from "@/lib/generation/pricing";
import { RECENT_SESSIONS } from "@/lib/generation/recent-problems";
import { prisma } from "@/lib/prisma";
import type { Fixture } from "./eval-lib";
import { statementSimilarity } from "@/lib/generation/verifier";
import { diversityStats, repetitionStats, type Group, type Item } from "./eval-repetition-lib";
import { parseRungSpec } from "@/lib/generation/cascade/ladder";
import { callerFromEnv } from "./eval-difficulty-judge";

type SetRecord = {
  sampleId: string;
  ok: boolean;
  problems?: { problem: string; answer: string }[];
  types?: string[];
  typeIds?: string[]; // taxonomy slot ids, fed to the next session as the route does
  methods?: (string | null)[]; // per problem, in set order
  rejections?: Record<string, number>;
  dollars?: number;
  wallTimeMs?: number;
};

function parseArgs(argv: string[]) {
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    yes: argv.includes("--yes"),
    fixtures: value("fixtures"),
    sessions: Number(value("sessions") ?? "3"),
    out: value("out") ?? "runs/repetition.jsonl",
    cluster: value("cluster"),
    compare: value("compare"),
    model: value("judge-model") ?? "claude-opus-5-5",
    // Any rung spec ("openweight:...@high"); overrides --judge-model's Anthropic client.
    judge: value("judge"),
  };
}

const readJsonl = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);

const GROUP_SYSTEM = `You audit practice problem sets for repetition. Group the numbered problems by UNDERLYING PROBLEM TYPE: the key idea or setup a solver needs. Two problems with different stories, names or numbers but the same key idea (e.g. two work-rate problems, two "shared root of two quadratics" problems) are the SAME type. Problems needing genuinely different ideas are different types. Every problem goes in exactly one group; a problem unlike all others is a group of one. Call emit_groups with a short type name and the member numbers for each group.`;

const GROUP_TOOL: Anthropic.Tool = {
  name: "emit_groups",
  description: "Group the problems by underlying problem type.",
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: { type: { type: "string" }, members: { type: "array", items: { type: "integer" } } },
          required: ["type", "members"],
        },
      },
    },
    required: ["groups"],
  },
};

let judgeSpec: string | undefined;
async function groupByType(client: Anthropic, model: string, problems: string[], accountant: UsageAccountant): Promise<Group[]> {
  if (judgeSpec) return groupWithRung(judgeSpec, problems, accountant);
  const system = GROUP_SYSTEM;
  const user = problems.map((p, i) => `[${i}] ${p.replace(/\s+/g, " ")}`).join("\n\n");
  const msg = await client.messages.create({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    tools: [GROUP_TOOL],
    tool_choice: { type: "auto" },
    system,
    messages: [{ role: "user", content: user }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  accountant.recordFor("verification", "anthropic", model, msg.usage);
  const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const groups = (tool?.input as { groups?: unknown } | undefined)?.groups;
  if (!Array.isArray(groups)) throw new Error("the grouping call returned no groups");
  return groups.map((g) => ({ type: String((g as Group).type ?? ""), members: Array.isArray((g as Group).members) ? (g as Group).members.map(Number) : [] }));
}

// The same grouping through any provider (CallOpenWeight), for runs without Anthropic.
async function groupWithRung(spec: string, problems: string[], accountant: UsageAccountant): Promise<Group[]> {
  const rung = { ...parseRungSpec("mid", spec), maxTokens: 32_000 };
  const call = callerFromEnv(600_000);
  const tool = { name: GROUP_TOOL.name, description: GROUP_TOOL.description ?? "", parameters: GROUP_TOOL.input_schema as Record<string, unknown> };
  const r = await call(rung, { system: GROUP_SYSTEM, user: problems.map((p, i) => `[${i}] ${p.replace(/\s+/g, " ")}`).join("\n\n") }, tool, AbortSignal.timeout(600_000), (u: Anthropic.Usage) =>
    accountant.recordFor("verification", rung.provider, rung.model, u)
  );
  if (!r.ok) throw new Error(`the grouping call failed: ${r.message}`);
  const groups = (r.args as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) throw new Error("the grouping call returned no groups");
  return groups.map((g) => ({ type: String((g as Group).type ?? ""), members: Array.isArray((g as Group).members) ? (g as Group).members.map(Number) : [] }));
}

async function report(client: Anthropic, model: string, sets: SetRecord[], label: string) {
  const items: Item[] = [];
  const problems: string[] = [];
  sets.forEach((s, si) => (s.problems ?? []).forEach((p) => (items.push({ set: si, index: problems.length }), problems.push(p.problem))));
  if (problems.length === 0) throw new Error("no problems to group");
  const accountant = new UsageAccountant();
  const groups = await groupByType(client, model, problems, accountant);
  const s = repetitionStats(items, groups);
  const d = diversityStats(items, groups, problems, statementSimilarity);
  console.log(
    `\n${label}: ${s.sets} sets, ${s.problems} problems, ${s.types} distinct types` +
      `\n  within-set repeats: ${s.withinSetRepeats} (${(s.withinSetRepeats / s.sets).toFixed(1)} per set)` +
      `\n  types repeated across sets: ${s.crossSetRepeatedTypes} (${s.crossSetPairs} set-pair repeats)` +
      `\n  effective types per set: ${d.effectiveTypesPerSet.toFixed(2)}; pooled over sets: ${d.effectiveTypesPooled.toFixed(2)}; statement Vendi per set: ${d.statementVendiPerSet.toFixed(2)}` +
      `\n  grouping cost $${costForRun(accountant.perModelUsage()).total.toFixed(2)}`
  );
  for (const g of groups.filter((x) => x.members.length > 1)) {
    const where = g.members.map((m) => `S${items[m].set + 1}`).join(",");
    console.log(`  - ${g.type}: ${g.members.length} problems [${where}]`);
  }
}

// One grouping call over several runs; stats per run, so every run is judged at the
// same granularity.
async function compareRuns(client: Anthropic, model: string, files: string[]) {
  const runs = files.map((file) => ({ file, sets: readJsonl<SetRecord>(file).filter((r) => r.problems) }));
  const problems: string[] = [];
  const owner: { run: number; set: number }[] = [];
  runs.forEach((r, ri) => r.sets.forEach((set, si) => (set.problems ?? []).forEach((p) => (owner.push({ run: ri, set: si }), problems.push(p.problem)))));
  const accountant = new UsageAccountant();
  const groups = await groupByType(client, model, problems, accountant);
  console.log(`Grouped ${problems.length} problems from ${runs.length} runs in one call (${costForRun(accountant.perModelUsage()).total.toFixed(2)}).`);
  runs.forEach((r, ri) => {
    const globalIdx = owner.map((o, i) => (o.run === ri ? i : -1)).filter((i) => i >= 0);
    const local = new Map(globalIdx.map((g, li) => [g, li]));
    const items: Item[] = globalIdx.map((g, li) => ({ set: owner[g].set, index: li }));
    const runGroups: Group[] = groups
      .map((g) => ({ type: g.type, members: g.members.filter((m) => local.has(m)).map((m) => local.get(m)!) }))
      .filter((g) => g.members.length > 0);
    const st = repetitionStats(items, runGroups);
    const d = diversityStats(items, runGroups, globalIdx.map((g) => problems[g]), statementSimilarity);
    const pairs = (st.sets * (st.sets - 1)) / 2;
    console.log(
      `\n${r.file}: ${st.sets} sets, ${st.problems} problems, ${st.types} distinct types (${(st.types / st.problems).toFixed(2)} per problem)` +
        `\n  within-set repeats: ${(st.withinSetRepeats / st.sets).toFixed(1)} per set` +
        `\n  cross-set repeats: ${pairs ? (st.crossSetPairs / pairs).toFixed(1) : "—"} per pair of sets` +
        `\n  effective types per set: ${d.effectiveTypesPerSet.toFixed(2)}; pooled: ${d.effectiveTypesPooled.toFixed(2)}; statement Vendi per set: ${d.statementVendiPerSet.toFixed(2)}`
    );
    for (const g of runGroups.filter((x) => x.members.length > 1)) console.log(`  - ${g.type}: ${g.members.map((m) => `S${items[m].set + 1}`).join(",")}`);
  });
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.yes) {
    console.error("eval:repetition makes real model calls. Re-run with --yes.");
    process.exit(1);
  }
  const client = new Anthropic({ maxRetries: 4 });
  judgeSpec = a.judge;
  if (a.cluster) return report(client, a.model, readJsonl<SetRecord>(a.cluster).filter((r) => r.problems), `Baseline ${a.cluster}`);
  if (a.compare) return compareRuns(client, a.model, a.compare.split(",").map((x) => x.trim()));

  if (!a.fixtures) throw new Error("--fixtures is required");
  const [f] = JSON.parse(readFileSync(a.fixtures, "utf8")) as Fixture[];
  const done = readJsonl<SetRecord>(a.out);
  for (let s = done.length; s < a.sessions; s++) {
    const recentSets = readJsonl<SetRecord>(a.out)
      .filter((r) => r.problems)
      .reverse()
      .slice(0, RECENT_SESSIONS);
    const history = recentSets.flatMap((r) => r.problems!.map((p) => p.problem));
    // The same memory the route reads from genMeta: slot type ids and statement+method pairs.
    const recentMemory = {
      typeIds: [...new Set(recentSets.flatMap((r) => r.typeIds ?? []))],
      methods: recentSets.flatMap((r) => r.problems!.flatMap((p, i) => (r.methods?.[i] ? [{ problem: p.problem, method: r.methods[i]! }] : []))),
    };
    const accountant = new UsageAccountant();
    const start = Date.now();
    const r = await generateProblems({
      client,
      profile: f.profile,
      topic: f.topic,
      recentTopics: f.recentTopics,
      recentProblems: history,
      recentMemory,
      rotationKey: `repetition-${f.id}-session-${s}`,
      accountant,
      startedAt: start,
    });
    const rec: SetRecord = {
      sampleId: `${f.id}#session${s + 1}`,
      ok: r.ok,
      problems: r.ok ? r.problems.map((p) => ({ problem: p.problem, answer: p.answer })) : undefined,
      types: r.meta.cascade?.types,
      typeIds: r.meta.cascade?.typeIds,
      methods: r.meta.cascade?.items.map((it) => it.method ?? null),
      rejections: r.meta.cascade?.rejections,
      dollars: costForRun(r.meta.usage).total,
      wallTimeMs: Date.now() - start,
    };
    appendFileSync(a.out, JSON.stringify(rec) + "\n");
    console.log(`[session ${s + 1}/${a.sessions}] ok=${rec.ok} kept=${rec.problems?.length ?? 0} history=${history.length} $${rec.dollars?.toFixed(3)} ${Math.round(rec.wallTimeMs! / 1000)}s`);
    if (rec.rejections && Object.keys(rec.rejections).length) console.log(`  rejections: ${JSON.stringify(rec.rejections)}`);
    if (rec.types) console.log(`  types: ${rec.types.join(" | ")}`);
  }
  await report(client, a.model, readJsonl<SetRecord>(a.out).filter((r) => r.problems), `With typed slots + recent-problem memory (${a.out})`);
}

main()
  .catch((e) => {
    console.error("[eval:repetition]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
