// Build the problem-type taxonomy from the real corpus, once, offline
// (docs/designs/generation-research.md, phase 2). Per-request type menus were an LLM
// call per session with nothing fixed to exclude against; the published pipelines
// (KPDDS, MATH², MathScale) instead extract skills from real problems once and sample
// slots in code. Output: data/corpus-taxonomy.json, read by lib/generation/taxonomy.ts.
//
//   1. Label: every corpus problem → { category, type, method } (one cheap call each).
//   2. Cluster: per category, (a) one call proposes the canonical type names from all
//      its labels, then (b) each problem's label is assigned to one of them (one cheap
//      constrained call each). So "rectangle area → quadratic" and "age problem →
//      quadratic" become ONE type when they need the same key idea: the granularity
//      repetition is judged at. (One call returning every member list timed out.)
//   3. Count: per contest and problem number, how often each type occurs, so a slot can
//      be weighted toward types real problems at that difficulty actually use.
//
// Read-only against the database. SPENDS API CREDIT (cheap: ~1,200 thinking-off calls
// plus one clustering call per category); needs --yes.
//
//   npm run extract:taxonomy -- --yes [--labeler openweight:...@off] [--clusterer openweight:...@low]
//   npm run extract:taxonomy -- --yes --assign-new
//
// --assign-new keeps the existing catalog: it labels only unlabeled problems (new corpus
// rows, e.g. from scripts/ingest-e2h.ts) and assigns each to an existing type of its
// category, or to none when nothing fits. Type ids never change, so the typeIds recent
// sets recorded in genMeta stay valid. Re-clustering from scratch would renumber them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun } from "@/lib/generation/pricing";
import { parseRungSpec } from "@/lib/generation/cascade/ladder";
import type { CallOpenWeight, ToolSpec } from "@/lib/generation/cascade/verify-cheap";
import type { Taxonomy, TaxonomyType } from "@/lib/generation/taxonomy";
import { callerFromEnv } from "./eval-difficulty-judge";

const CATEGORIES = ["algebra", "number_theory", "geometry", "combinatorics", "probability", "mechanics", "other"] as const;
type Label = { id: string; source: string; number: number | null; category: string; type: string; method: string };

const LABEL_TOOL: ToolSpec = {
  name: "emit_label",
  description: "Label the problem.",
  parameters: {
    type: "object",
    properties: {
      category: { type: "string", enum: [...CATEGORIES] },
      type: { type: "string" },
      method: { type: "string" },
    },
    required: ["category", "type", "method"],
  },
};
const LABEL_SYSTEM = `You label a competition problem for a problem-type catalog.
- "category": the main area.
- "type": a short phrase naming the kind of setup AND the key idea a solver needs, general enough that other problems share it (e.g. "work-rate: two agents, combined rate", "integer roots via Vieta and factor-pair casework", "counting lattice paths with a forbidden point"). Never mention this problem's specific numbers or story details.
- "method": one line, the solution steps with no numbers.
Call emit_label.`;

const PROPOSE_TOOL: ToolSpec = {
  name: "emit_types",
  description: "Return the canonical problem type names.",
  parameters: { type: "object", properties: { types: { type: "array", items: { type: "string" } } }, required: ["types"] },
};
const proposeSystem = (category: string, n: number) => `You build a catalog of ${category.replace("_", " ")} competition problem TYPES from ${n} labels, each written for one real problem.
Propose the canonical types that cover them. One type per distinct KEY IDEA: labels whose problems need the same key idea are one type even when their stories differ (a rectangle-area word problem and an age word problem that both reduce to one quadratic are one type). Keep genuinely different key ideas apart. Aim for roughly ${Math.max(8, Math.min(60, Math.round(n / 6)))} types.
Name each as a short phrase: the setup and the key idea, e.g. "word problem reduced to one quadratic equation". Call emit_types with the names.`;

const ASSIGN_TOOL: ToolSpec = {
  name: "emit_assignment",
  description: "Return the number of the catalog type this problem belongs to.",
  parameters: { type: "object", properties: { type: { type: "integer" } }, required: ["type"] },
};
const assignSystem = (names: string[], allowNone = false) => `Assign a competition problem to the ONE catalog type whose key idea it needs most.
Catalog:
${names.map((n, i) => `${i}. ${n}`).join("\n")}
${allowNone ? "If no type's key idea fits the problem, answer -1 rather than forcing one.\n" : ""}Call emit_assignment with the type number.`;

function parseArgs(argv: string[]) {
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    yes: argv.includes("--yes"),
    assignNew: argv.includes("--assign-new"),
    labeler: value("labeler") ?? "openweight:deepseek-ai/DeepSeek-V4.1-Flash@off",
    clusterer: value("clusterer") ?? "openweight:deepseek-ai/DeepSeek-V4.1-Flash@low",
    labels: value("labels") ?? "runs/taxonomy-labels.jsonl", // resumable cache of step 1
    out: value("out") ?? "data/corpus-taxonomy.json",
    concurrency: Number(value("concurrency") ?? "24"),
  };
}

async function pool<T, R>(items: T[], k: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: k }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i]);
      }
    })
  );
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.yes) {
    console.error("extract:taxonomy makes real model calls. Re-run with --yes.");
    process.exit(1);
  }
  const call: CallOpenWeight = callerFromEnv();
  // The proposal call reads every label in a category; give it more than a solver's time.
  const longCall: CallOpenWeight = callerFromEnv(300_000);
  const labeler = parseRungSpec("easy", a.labeler);
  const clusterer = { ...parseRungSpec("mid", a.clusterer), maxTokens: 32_000, timeoutMs: 300_000 };
  const accountant = new UsageAccountant();

  const prisma = new PrismaClient();
  const rows = await prisma.referenceProblem.findMany({ select: { id: true, source: true, number: true, statement: true }, orderBy: { id: "asc" } });
  await prisma.$disconnect();

  // 1. Label (cached per problem id, so an interrupted run resumes).
  const cached = new Map<string, Label>(
    existsSync(a.labels) ? readFileSync(a.labels, "utf8").split("\n").filter(Boolean).map((l) => [JSON.parse(l).id, JSON.parse(l) as Label]) : []
  );
  const todo = rows.filter((r) => !cached.has(r.id));
  console.log(`${rows.length} corpus problems, ${cached.size} already labeled, labeling ${todo.length} with ${labeler.model}`);
  mkdirSync("runs", { recursive: true });
  let done = 0;
  await pool(todo, a.concurrency, async (r) => {
    const res = await call(labeler, { system: LABEL_SYSTEM, user: r.statement.slice(0, 3000) }, LABEL_TOOL, AbortSignal.timeout(120_000), (u) =>
      accountant.recordFor("plan", labeler.provider, labeler.model, u)
    );
    const x = res.ok ? (res.args as Partial<Label>) : null;
    if (x && typeof x.type === "string" && typeof x.method === "string") {
      const label: Label = {
        id: r.id,
        source: r.source,
        number: r.number,
        category: (CATEGORIES as readonly string[]).includes(String(x.category)) ? String(x.category) : "other",
        type: x.type.trim(),
        method: x.method.trim(),
      };
      cached.set(r.id, label);
      writeFileSync(a.labels, JSON.stringify(label) + "\n", { flag: "a" });
    }
    if (++done % 100 === 0) console.log(`  labeled ${done}/${todo.length}`);
  });
  const labels = [...cached.values()];
  console.log(`labels: ${labels.length}/${rows.length}; $${costForRun(accountant.perModelUsage()).total.toFixed(3)} so far`);

  if (a.assignNew) {
    await assignNew(a, labels, call, labeler, accountant);
    return;
  }

  // 2. Cluster per category: (a) propose names, (b) assign each problem.
  const types: TaxonomyType[] = [];
  const problemTypes: Record<string, string> = {};
  await Promise.all(
    CATEGORIES.map(async (category) => {
      const members = labels.filter((l) => l.category === category);
      if (members.length === 0) return;
      const proposed = await longCall(
        clusterer,
        { system: proposeSystem(category, members.length), user: members.map((m) => `- ${m.type}`).join("\n") },
        PROPOSE_TOOL,
        AbortSignal.timeout(clusterer.timeoutMs),
        (u) => accountant.recordFor("plan", clusterer.provider, clusterer.model, u)
      );
      const names = proposed.ok
        ? [...new Set(((proposed.args as { types?: unknown }).types as unknown[] | undefined ?? []).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))]
        : [];
      if (names.length === 0) {
        console.error(`  ${category}: no types proposed (${proposed.ok ? "empty list" : proposed.message}); its problems stay unlabeled`);
        return;
      }
      const system = assignSystem(names);
      const assigned = await pool(members, a.concurrency, async (m) => {
        const r = await call(labeler, { system, user: `Label: ${m.type}\nMethod: ${m.method}` }, ASSIGN_TOOL, AbortSignal.timeout(120_000), (u) =>
          accountant.recordFor("plan", labeler.provider, labeler.model, u)
        );
        const k = r.ok ? Number((r.args as { type?: unknown }).type) : NaN;
        return Number.isInteger(k) && k >= 0 && k < names.length ? k : -1;
      });
      names.forEach((name, k) => {
        const own = members.filter((_, i) => assigned[i] === k);
        if (own.length === 0) return;
        const id = `${category}:${k}`;
        const byContest: Record<string, number[]> = {};
        for (const l of own) {
          problemTypes[l.id] = id;
          if (l.number != null) (byContest[l.source] ??= []).push(l.number);
        }
        types.push({ id, name, category, count: own.length, numbers: byContest, methods: own.slice(0, 3).map((l) => l.method) });
      });
      console.log(`  ${category}: ${members.length} labels → ${names.length} proposed, ${types.filter((t) => t.category === category).length} used (${assigned.filter((k) => k < 0).length} unassigned)`);
    })
  );

  const taxonomy: Taxonomy = { builtAt: new Date().toISOString().slice(0, 10), labeler: labeler.model, clusterer: clusterer.model, types, problemTypes };
  mkdirSync("data", { recursive: true });
  writeFileSync(a.out, JSON.stringify(taxonomy) + "\n");
  console.log(`Wrote ${a.out}: ${types.length} types over ${Object.keys(problemTypes).length} problems. Total $${costForRun(accountant.perModelUsage()).total.toFixed(3)}`);
}

// --assign-new: sort unassigned labeled problems into the existing catalog's types.
async function assignNew(
  a: ReturnType<typeof parseArgs>,
  labels: Label[],
  call: CallOpenWeight,
  labeler: ReturnType<typeof parseRungSpec>,
  accountant: UsageAccountant
): Promise<void> {
  if (!existsSync(a.out)) throw new Error(`--assign-new needs an existing ${a.out}; build it first without the flag.`);
  const taxonomy = JSON.parse(readFileSync(a.out, "utf8")) as Taxonomy;
  const todo = labels.filter((l) => !taxonomy.problemTypes[l.id]);
  console.log(`${todo.length} labeled problems have no type; assigning within the existing ${taxonomy.types.length} types`);
  let assigned = 0;
  const byCategory = new Map<string, Label[]>();
  for (const l of todo) byCategory.set(l.category, [...(byCategory.get(l.category) ?? []), l]);
  for (const [category, members] of byCategory) {
    const catalog = taxonomy.types.filter((t) => t.category === category);
    if (catalog.length === 0) {
      console.log(`  ${category}: no catalog types, ${members.length} problems stay untyped`);
      continue;
    }
    const system = assignSystem(catalog.map((t) => t.name), true);
    const picks = await pool(members, a.concurrency, async (m) => {
      const r = await call(labeler, { system, user: `Label: ${m.type}\nMethod: ${m.method}` }, ASSIGN_TOOL, AbortSignal.timeout(120_000), (u) =>
        accountant.recordFor("plan", labeler.provider, labeler.model, u)
      );
      const k = r.ok ? Number((r.args as { type?: unknown }).type) : NaN;
      return Number.isInteger(k) && k >= 0 && k < catalog.length ? catalog[k] : null;
    });
    members.forEach((m, i) => {
      const t = picks[i];
      if (!t) return;
      taxonomy.problemTypes[m.id] = t.id;
      t.count++;
      if (m.number != null) (t.numbers[m.source] ??= []).push(m.number);
      assigned++;
    });
    console.log(`  ${category}: ${members.length} problems, ${picks.filter(Boolean).length} assigned`);
  }
  writeFileSync(a.out, JSON.stringify(taxonomy) + "\n");
  console.log(`Wrote ${a.out}: ${assigned} newly typed, ${Object.keys(taxonomy.problemTypes).length} typed problems in total. Total $${costForRun(accountant.perModelUsage()).total.toFixed(3)}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[extract:taxonomy]", e);
    process.exitCode = 1;
  });
}
