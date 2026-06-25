// Populate ReferenceProblem.solution with real worked solutions for AMC / AIME
// rows that don't have one yet, sourced from the NuminaMath-CoT dataset.
//
// WHY: the hard (variant) generation tier tells the model to "fully re-solve the
// problem from scratch" — that re-derivation of AIME #13–15 math is the dominant
// token (thinking) cost. If the corpus row already carries the real solution, the
// variant prompt can hand the model the *method* and ask it to adapt it to new
// numbers (light thinking) instead of re-deriving it (heavy thinking). The solution
// is INTERNAL generation context only — it grounds the variant the student sees;
// the original is never shown to the student (corpus is never redistributed).
//
// SOURCE: AoPS Wiki (the canonical solution source) is behind Cloudflare and 403s
// automated requests, so we instead use `AI-MO/NuminaMath-CoT` — its `amc_aime`
// split (~4,070 rows) carries real worked solutions and is served by the same
// HuggingFace datasets-server API the corpus ingest already uses (no Cloudflare).
//
// MATCHING: NuminaMath is keyed by `source`, not year/number, so we can't look a
// problem up directly. We download the amc_aime split, index every problem by its
// content tokens, and for each null-solution AMC/AIME corpus row find the
// NuminaMath problem whose statement best matches ours. Matching is deliberately
// STRICT (a wrong solution would mis-ground generation — worse than none): we
// require high coverage + Jaccard AND a clear margin over the runner-up, else we
// leave the row null (generation falls back to from-scratch for it).
//
// SCOPE: AMC10 / AMC12 / AIME only. F=ma has no NuminaMath solutions (it's pure
// math) — those rows stay null by design; revisit separately if needed.
//
// Run: npm run scrape:solutions                         (AMC + AIME, null-solution rows)
//      npm run scrape:solutions -- --source=AIME --limit=20
//      npm run scrape:solutions -- --force              (re-match rows that already have one)

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const HF = "https://datasets-server.huggingface.co";
// NuminaMath-1.5 over -CoT: it's larger, carries a canonical `answer` column, and a
// `solution_is_valid` flag. -CoT's machine-generated solutions are frequently WRONG
// (e.g. it "solves" an integer-answer AIME problem and boxes 23.6643), and our answer
// gate correctly rejected those — capping coverage. 1.5 lets us keep only solutions
// it marks valid and match on its own answer field.
const DATASET = "AI-MO/NuminaMath-1.5";
const NM_SOURCE = "amc_aime"; // the split that holds AMC + AIME problems
const MAX_SOLUTION_CHARS = 2500; // solutions feed a prompt; high enough to keep the concluding \boxed{}

// Strict acceptance (precision over recall — a mismatched solution is worse than
// null: it would mis-ground generation). A token match is gated below, and then
// CONFIRMED by the answer when we have one (AIME rows carry the integer answer and
// NuminaMath solutions end in \boxed{…}); a token match whose boxed answer
// disagrees with ours is rejected.
// Loose prefilter for surfacing candidates (the answer match is the real guard for
// numeric-answer rows).
const PREFILTER_SHARED = 4; // absolute shared content tokens to consider a candidate
const PREFILTER_JACCARD = 0.25; // minimal token Jaccard to consider a candidate
const CONFIRM_MIN_JACCARD = 0.3; // an answer-confirmed candidate must also clear this (anti-collision)
// Strict thresholds for the non-numeric (AMC letter / null answer) token-only path.
const MIN_COVERAGE = 0.6; // fraction of OUR statement's tokens present in the match
const MIN_JACCARD = 0.45; // token Jaccard between the two statements
const MIN_MARGIN = 0.1; // best Jaccard must beat 2nd-best by this (avoid ambiguity)

const MATH_SOURCES = new Set(["AIME", "AMC10", "AMC12"]);

type Row = {
  id: string;
  source: string;
  year: number | null;
  number: number | null;
  statement: string;
  answer: string | null;
};

// ---------- args ----------

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const SOURCE_FILTER = args.find((a) => a.startsWith("--source="))?.split("=")[1] ?? null;
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- tokenization & matching ----------

const STOP = new Set([
  "the", "and", "for", "are", "with", "that", "this", "from", "have", "let", "find",
  "all", "its", "can", "not", "any", "but", "what", "where", "which", "such", "each",
  "when", "then", "into", "how", "many", "number", "value", "let", "given", "suppose",
]);

// Keep the MATH content, don't strip it. AIME/AMC statements are math-dense, and
// their distinctive signal is the constants inside $…$ (2010, 468, 81). We only
// drop the LaTeX command names (\frac, \log) and delimiters, then keep words (len ≥ 3)
// and multi-digit numbers (len ≥ 2) — single letters/digits are too common to help.
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\\[a-zA-Z]+/g, " ") // strip LaTeX command names (\frac, \log, \boxed, …)
    .replace(/[^a-z0-9 ]/g, " ") // strip $ { } ^ _ \ and punctuation, keep alphanumerics
    .split(/\s+/)
    .filter((w) => !STOP.has(w) && (w.length >= 3 || /^\d{2,}$/.test(w)));
}

// ---------- clean a NuminaMath solution into prompt-ready text ----------

function cleanSolution(raw: string): string {
  let s = raw;
  // Normalize delimiters toward our $…$ / $$…$$ convention (this is context for the
  // model, not rendered to the student, so light-touch is fine).
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, x) => `$$${x.trim()}$$`);
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, x) => `$${x.trim()}$`);
  s = s.replace(/<[^>]+>/g, " "); // stray HTML
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > MAX_SOLUTION_CHARS) {
    s = s.slice(0, MAX_SOLUTION_CHARS).replace(/\s+\S*$/, "").trim() + " …";
  }
  return s;
}

// ---------- fetch the amc_aime split (paginated, retry while index warms up) ----------

// ---------- answer verification ----------

// Pull the value from the LAST \boxed{…} in a solution (balanced braces). Used to
// confirm the chosen solution actually *reaches* our answer — 1.5's `answer` field
// occasionally disagrees with its own solution, and we don't want to ground on that.
function boxedAnswer(sol: string): string | null {
  const marker = "\\boxed";
  let last: string | null = null;
  let from = 0;
  for (;;) {
    const at = sol.indexOf(marker, from);
    if (at === -1) break;
    let i = at + marker.length;
    while (i < sol.length && sol[i] !== "{") i++;
    if (sol[i] !== "{") {
      from = at + marker.length;
      continue;
    }
    let depth = 0;
    const start = i + 1;
    for (; i < sol.length; i++) {
      if (sol[i] === "{") depth++;
      else if (sol[i] === "}" && --depth === 0) break;
    }
    last = sol.slice(start, i);
    from = i + 1;
  }
  return last;
}

function normAns(a: string | null): string | null {
  if (a == null) return null;
  const s = a
    .replace(/\\(boxed|textbf|mathbf|mathrm|text|left|right|displaystyle)\b/g, "")
    .replace(/[$\s{}]/g, "")
    .replace(/[.,]+$/, "") // trailing punctuation
    .trim();
  return s || null;
}

// True only when both answers are present AND equal; integers compared numerically.
function answersAgree(our: string | null, nm: string | null): boolean {
  const a = normAns(our);
  const b = normAns(nm);
  if (!a || !b) return false;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) === Number(b);
  return a.toLowerCase() === b.toLowerCase();
}

type NMItem = { problem: string; solution: string; toks: Set<string>; answer: string | null };
type NMResponse = {
  rows?: { row: Record<string, unknown> }[];
  num_rows_total?: number;
  error?: string;
};

async function fetchAmcAime(): Promise<NMItem[]> {
  const where = encodeURIComponent(`"source"='${NM_SOURCE}'`);
  const out: NMItem[] = [];
  let offset = 0;
  const length = 100;
  let total = Infinity;
  while (offset < total) {
    const url = `${HF}/filter?dataset=${encodeURIComponent(DATASET)}&config=default&split=train&where=${where}&offset=${offset}&length=${length}`;
    let json: NMResponse | null = null;
    // Retry transient failures: index-still-loading, generic "Unexpected error",
    // network blips, and non-2xx responses all recover on a quick re-request.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const res = await fetch(url);
        json = (await res.json()) as NMResponse;
      } catch {
        json = { error: "network" };
      }
      if (json && Array.isArray(json.rows)) break; // got a good page
      const loading = json?.error && /index is loading/i.test(json.error);
      await sleep(loading ? 5000 : 1500 * (attempt + 1)); // back off, then retry
    }
    if (!json || !Array.isArray(json.rows)) throw new Error(`NuminaMath fetch failed: ${json?.error ?? "unknown"}`);
    if (json.num_rows_total != null) total = json.num_rows_total;
    const rows = json.rows ?? [];
    for (const r of rows) {
      const problem = String(r.row.problem ?? "");
      const solution = String(r.row.solution ?? "");
      // Keep only solutions the dataset marks valid — this is what filters out the
      // wrong machine-generated derivations that capped coverage on -CoT.
      if (String(r.row.solution_is_valid ?? "") !== "Yes") continue;
      if (!problem || !solution) continue;
      const answer = String(r.row.answer ?? "") || null;
      out.push({ problem, solution, toks: new Set(tokens(problem)), answer });
    }
    offset += length;
    if (rows.length === 0) break;
    process.stdout.write(`\r  fetched ${out.length}/${total} amc_aime rows…`);
  }
  process.stdout.write("\n");
  return out;
}

// ---------- main ----------

async function main() {
  const where: { solution?: null; source?: string | { in: string[] } } = {};
  if (!FORCE) where.solution = null;
  if (SOURCE_FILTER) {
    if (!MATH_SOURCES.has(SOURCE_FILTER)) {
      console.error(`--source must be one of ${[...MATH_SOURCES].join(", ")} (NuminaMath has no F=ma).`);
      process.exit(1);
    }
    where.source = SOURCE_FILTER;
  } else {
    where.source = { in: [...MATH_SOURCES] };
  }

  const rows = (await prisma.referenceProblem.findMany({
    where,
    select: { id: true, source: true, year: true, number: true, statement: true, answer: true },
    orderBy: [{ source: "asc" }, { year: "asc" }, { number: "asc" }],
    ...(LIMIT ? { take: LIMIT } : {}),
  })) as Row[];

  console.log(
    `Matching ${rows.length} corpus row(s)` +
      `${SOURCE_FILTER ? ` (source=${SOURCE_FILTER})` : " (AMC + AIME)"}` +
      `${FORCE ? " [--force]" : " (solution IS NULL)"}${LIMIT ? ` [limit ${LIMIT}]` : ""} ` +
      `against NuminaMath ${NM_SOURCE}…`
  );

  console.log("Downloading NuminaMath amc_aime split…");
  const nm = await fetchAmcAime();
  console.log(`  indexed ${nm.length} candidate problems.`);

  // Inverted index: token → list of NuminaMath indices, so each corpus row only
  // scores against problems that share content words (not all ~4k).
  const inverted = new Map<string, number[]>();
  nm.forEach((item, i) => {
    for (const t of item.toks) (inverted.get(t) ?? inverted.set(t, []).get(t)!).push(i);
  });

  const tally: Record<string, { updated: number; attempted: number }> = {};
  let done = 0;
  for (const row of rows) {
    const t = (tally[row.source] ??= { updated: 0, attempted: 0 });
    t.attempted++;
    done++;

    const dbToks = new Set(tokens(row.statement));
    if (dbToks.size === 0) continue;

    // Count shared tokens per candidate via the inverted index.
    const shared = new Map<number, number>();
    for (const tok of dbToks) {
      const list = inverted.get(tok);
      if (!list) continue;
      for (const idx of list) shared.set(idx, (shared.get(idx) ?? 0) + 1);
    }

    // Loose prefilter — surface plausible candidates. For numeric-answer rows the
    // exact \boxed{} match is the real guard, so a loose net + answer confirmation
    // beats a tight net (more recall, no precision loss). Non-numeric rows apply the
    // strict thresholds below.
    const gated: { idx: number; jac: number; cov: number }[] = [];
    let bestJac = 0;
    let secondJac = 0;
    for (const [idx, sh] of shared) {
      if (sh < PREFILTER_SHARED) continue;
      const cov = sh / dbToks.size;
      const jac = sh / (dbToks.size + nm[idx].toks.size - sh);
      if (jac < PREFILTER_JACCARD) continue;
      gated.push({ idx, jac, cov });
      if (jac > bestJac) {
        secondJac = bestJac;
        bestJac = jac;
      } else if (jac > secondJac) {
        secondJac = jac;
      }
    }
    if (gated.length === 0) continue;
    gated.sort((a, b) => b.jac - a.jac);

    // Pick the match. When we have an answer to verify against (AIME), it's the
    // arbiter: accept the best token-match whose boxed answer agrees; if some
    // candidate carries a boxed answer but NONE agree, the token match is
    // contradicted — reject (leave null). Only fall back to the token-margin rule
    // when neither side offers an answer to check.
    let chosen = -1;
    let how = "";
    const ans = normAns(row.answer);
    // "Confirmable" = our answer is a plain integer (every AIME row; some AMC). For
    // these we DEMAND the matched solution's \boxed{} agree — no unverified fallback,
    // so a token coincidence can't attach the wrong solution. Non-numeric answers
    // (AMC letters / nulls) can't be checked this way, so they use the token margin.
    const confirmable = ans != null && /^\d+$/.test(ans);
    const top = gated[0];
    // Confirmed candidate: shares enough tokens (not a pure same-answer coincidence —
    // answers collide within 0–999), the dataset's answer matches ours, AND the
    // solution's own \boxed value doesn't contradict ours (catches 1.5 rows whose
    // answer field and solution disagree; a solution with no box is allowed through).
    const ourN = normAns(row.answer);
    const ourNumeric = ourN != null && /^\d+$/.test(ourN);
    const agree = gated.find((g) => {
      if (g.jac < CONFIRM_MIN_JACCARD) return false;
      if (!answersAgree(row.answer, nm[g.idx].answer)) return false;
      // Reject only when the solution's own boxed value is a number that disagrees
      // with our (numeric) answer — a real answer-field/solution mismatch. AMC
      // solutions box the letter choice, which isn't comparable, so we don't reject
      // on those (the answer-field agreement above already gated them).
      const solN = normAns(boxedAnswer(nm[g.idx].solution));
      if (ourNumeric && solN != null && /^\d+$/.test(solN) && Number(solN) !== Number(ourN)) {
        return false;
      }
      return true;
    });

    if (confirmable) {
      if (agree) {
        chosen = agree.idx; // boxed answer matches ours → confident
        how = "answer";
      } // else: no candidate's boxed answer matches ours → reject (leave null)
    } else if (
      top.cov >= MIN_COVERAGE &&
      top.jac >= MIN_JACCARD &&
      bestJac - secondJac >= MIN_MARGIN
    ) {
      chosen = top.idx; // no numeric answer to confirm; require a strict, clear token match
      how = "tokens";
    }

    if (chosen >= 0) {
      const solution = cleanSolution(nm[chosen].solution);
      if (solution.length >= 40) {
        await prisma.referenceProblem.update({ where: { id: row.id }, data: { solution } });
        t.updated++;
        if (t.updated % 25 === 0 || done % 100 === 0) {
          console.log(`  [${done}/${rows.length}] ${row.source} ${row.year ?? "?"} #${row.number ?? "?"} → matched (${how})`);
        }
      }
    }
  }

  console.log("\nCoverage by source (matched / attempted):");
  for (const [src, t] of Object.entries(tally)) {
    const pct = t.attempted ? ((100 * t.updated) / t.attempted).toFixed(0) : "0";
    console.log(`  ${src}: ${t.updated}/${t.attempted} (${pct}%)`);
  }
  console.log(
    "\nUnmatched rows are left null on purpose (strict matching); variant generation " +
      "falls back to from-scratch for those. Loosen MIN_COVERAGE/MIN_JACCARD/MIN_MARGIN to trade precision for recall."
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
