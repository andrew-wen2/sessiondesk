// Verification guards for generated problems — pure, dependency-free predicates
// extracted from /api/generate so they can be reasoned about and unit-tested in
// isolation (no Anthropic client, no Prisma, no closure capture).
//
// Each guard mirrors a rule the generation prompt states. The model reliably
// hits the target difficulty but sometimes (a) can't actually solve a hard
// problem and punts a placeholder answer, (b) leaks thinking-out-loud /
// self-correction into a field the prompt forbids it in, or (c) emits a
// figure-dependent or cut-off statement. A rejected problem is dropped and
// refilled by the route's regenerate-the-deficit loop, so these never block
// generation — they just filter bad items.

import type { Problem, Anchor } from "@/lib/types";
import type { GenerationPlan } from "@/lib/generation/plan";

// --- Answer guard -----------------------------------------------------------

// The model punts with one of these when it couldn't actually solve the problem.
const PLACEHOLDER_RE =
  /\b(tbd|tba|todo|n\/?a|hint|see solution|to be determined|placeholder|unknown)\b/i;

// One answer guard for every subject, keyed off the plan's answerFormat rather
// than a stored engine choice. It enforces exactly what the prompt's
// ANSWER_FORMAT_RULES told the model to produce — keep the two in step.
//
// The empty-answer rule is the important one: an empty answer means the model
// declined to solve its own problem, and is only legitimate for genuinely
// open-ended work ("open"). The old lenient guard accepted it for every
// non-competition subject, which is how unsolved problems reached the page.
export function answerOkFor(
  p: Problem,
  plan: Pick<GenerationPlan, "answerFormat" | "competition">
): boolean {
  const a = (p.answer || "").trim();
  if (!a) return plan.answerFormat === "open";
  if (PLACEHOLDER_RE.test(`${p.answer} ${p.solution}`)) return false;
  if (/^\?+$/.test(a)) return false;
  // No multiple-choice option letters as the answer (everything is free-response).
  // "(C)" is never valid anywhere.
  if (/^\(\s*[A-E]\s*\)$/.test(a)) return false;
  // A BARE "C" is rejected wherever a lone letter can't be a real answer. It can
  // be one in symbolic physics (energy E) and in open work, so those are exempt.
  if (plan.answerFormat !== "expression" && plan.answerFormat !== "open" && /^[A-E]$/.test(a))
    return false;
  // AIME is the one format unambiguous enough to hard-enforce: integer 0–999.
  if (plan.competition === "AIME") return /^\d{1,3}$/.test(a) && Number(a) <= 999;
  if (plan.answerFormat === "integer") return /^-?\d+$/.test(a);
  // numeric / expression / short-text: a real non-placeholder answer is enough —
  // enforcing shape beyond this is the prompt's job, not the guard's.
  return true;
}

// --- Statement guard --------------------------------------------------------

// Self-correction / thinking-out-loud inside the problem field (the "Actually
// disregard — here is the problem:" failure).
const META_PATTERNS = [
  /\bdisregard\b/i,
  /\b(here\s+is|here's)\s+(the|a|another|your|an)\s+(actual\s+|real\s+|correct\s+|clean\s+|new\s+|better\s+)?(problem|question|one)\b/i,
  /\blet me (restate|rephrase|rewrite|try|redo|give)\b/i,
  /\b(i'?ll|i will|let me) (give|provide|write|offer)\b.*\b(instead|problem)\b/i,
  /\b(scratch that|never ?mind|on second thought|my mistake|oops|wait,)\b/i,
  /\bactually,?\s+(disregard|ignore|the|let|here|i)\b/i,
  /\b(ignore|forget) (the|that|this|everything) (above|prior|previous|earlier)\b/i,
  /\bsee (the )?solution\b/i,
];
// "figure"/"diagram" are never legitimate in a text-only problem. "graph" is
// excluded — it's a valid math term (graph of a function) and would false-positive.
const FIGURE_PATTERNS = [
  /\b(figure|diagram|picture|illustration)\b/i,
  /\b(shown|pictured|depicted|illustrated|drawn)\s+(above|below|here|to the (left|right))\b/i,
  /\bas shown\b/i,
];

// Reject malformed problem STATEMENTS the prompt tells the model never to emit:
// self-correction, figure dependence, cut-off statements, and answer-choice lists.
export function problemOk(p: Problem): boolean {
  const text = (p.problem || "").trim();
  if (!text) return false;
  // Cut-off / abandoned statement: ends in an ellipsis (a real problem ends with
  // proper punctuation; "1, 2, ..." mid-statement is fine, a trailing one is not).
  if (/(\.\.\.|…)\s*$/.test(text)) return false;
  if (META_PATTERNS.some((re) => re.test(text))) return false;
  if (FIGURE_PATTERNS.some((re) => re.test(text))) return false;
  // Multiple-choice option list — we generate free-response only. Collect the
  // distinct parenthesized letters (also matches \textbf{(A)} etc., which contain
  // "(A)"); 4+ of {A..E} is an answer-choice list, not incidental labeling.
  const optionLetters = new Set(
    (text.match(/\(\s*([A-E])\s*\)/g) || []).map((m) => m.replace(/[^A-E]/g, ""))
  );
  if (optionLetters.size >= 4) return false;
  return true;
}

// --- Solution guard ---------------------------------------------------------

// The prompt forbids backtracking / self-correction narration in the solution
// ("recompute", "wait, let me recheck", "that's wrong"), but the model still
// leaks it. We can't fix the wording in place safely (the bad line may carry the
// final number), so a leaked solution drops the whole problem and the deficit
// loop regenerates a clean one. Only the clear self-correction verbs and phrases
// are matched — bare "verify"/"actually" are left out to avoid false-positives.
//
// This is the single source of truth for the self-correction vocabulary on the
// guard side; the generation prompt forbids the same phrases in prose.
const SOLUTION_BACKTRACK = [
  /\brecomput\w*/i, // recompute / recomputing / recomputed
  /\brecalculat\w*/i, // recalculate / recalculating
  /\brecheck\w*/i, // recheck / rechecking
  /\bdouble-?check\w*/i,
  /\b(scratch that|never ?mind|on second thought|my mistake|oops)\b/i,
  /\bthat'?s wrong\b/i,
  /\bi made (an|a) (error|mistake)\b/i,
  /\bwait,/i,
  /\blet me (recompute|recalculate|recheck|redo|try|verify|check|confirm|reconsider)\b/i,
];
export function solutionOk(p: Problem): boolean {
  return !SOLUTION_BACKTRACK.some((re) => re.test(p.solution || ""));
}

// Adapt-path equivalent of solutionOk: the heavy pass emits a `solutionSketch`
// rather than a full `solution`, so the same backtracking vocabulary is checked
// against the sketch field. Reuses SOLUTION_BACKTRACK (single source of truth).
export function solutionSketchOk(p: Problem): boolean {
  return !SOLUTION_BACKTRACK.some((re) => re.test(p.solutionSketch || ""));
}

// --- Seed-similarity guard (variant/hard tier only) -------------------------

// Similarity thresholds — kept lenient so the guard doesn't starve generation.
// A variant is rejected only when it's clearly too close to a seed on either axis.
const SEED_NUMERIC_JACCARD_THRESHOLD = 0.5;
const SEED_NUMERIC_OVERLAP_THRESHOLD = 3; // shared non-trivial integers
const SEED_LEXICAL_JACCARD_THRESHOLD = 0.45;

// Extract integer/decimal tokens from a string, excluding trivial values (0, 1, 2).
function extractNumbers(text: string): number[] {
  const nums: number[] = [];
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\b/g)) {
    const n = Number(m[1]);
    if (n > 2) nums.push(n);
  }
  return nums;
}

// Jaccard similarity between two arrays treated as multisets → sets for speed.
function jaccardSets(a: number[] | string[], b: number[] | string[]): number {
  const sa = new Set(a as (number | string)[]);
  const sb = new Set(b as (number | string)[]);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Tokenize a statement into content words (strip LaTeX commands and stopwords).
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\$\$[\s\S]*?\$\$/g, " ") // strip display math
    .replace(/\$[^$]*?\$/g, " ")        // strip inline math
    .replace(/\\[a-zA-Z]+/g, " ")       // strip LaTeX commands
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 2 &&
        !/^(the|and|for|are|was|that|with|from|this|into|have|each|find|let|such|all|its|can|not|any|but)$/.test(
          w
        )
    );
}

// Reject a problem that's too recognizable as one of `others`. Two uses:
//   - variant path: `others` are the corpus seeds, so the student can still do the
//     real AIME problem later (logged, not dropped);
//   - every path: `others` are the problems already kept, so a set can't ship two
//     dressings of the same question. This is the near-duplicate check the old
//     corpus-free engine lacked entirely — it deduped on exact string equality, so
//     four parallel chunks working from one prompt happily returned paraphrases.
//
// Set `numeric: false` for non-mathematical content: two Spanish exercises sharing
// the integers 12 and 30 tell you nothing, and the axis only produces false drops.
// Returns a short diagnostic (which item + which axis + the value) when too
// similar, else null — logging the axis distinguishes a true echo from an
// over-strict lexical drop.
export function tooSimilarToSeed(
  p: Problem,
  others: Anchor[],
  opts: { numeric?: boolean } = {}
): string | null {
  const { numeric = true } = opts;
  const variantNums = extractNumbers(p.problem);
  const variantWords = contentWords(p.problem);

  for (const seed of others) {
    const seedWords = contentWords(seed.statement);
    const label = `${seed.source}${seed.number != null ? `#${seed.number}` : ""}`;

    // Numeric overlap axis
    if (numeric) {
      const seedNums = extractNumbers(seed.statement);
      const sharedNums = variantNums.filter((n) => seedNums.includes(n)).length;
      if (sharedNums >= SEED_NUMERIC_OVERLAP_THRESHOLD) return `${label} shared-numbers=${sharedNums}`;
      const numJaccard = jaccardSets(variantNums, seedNums);
      if (numJaccard > SEED_NUMERIC_JACCARD_THRESHOLD) return `${label} numeric-jaccard=${numJaccard.toFixed(2)}`;
    }

    // Lexical overlap axis
    const lexJaccard = jaccardSets(variantWords, seedWords);
    if (lexJaccard > SEED_LEXICAL_JACCARD_THRESHOLD) return `${label} lexical-jaccard=${lexJaccard.toFixed(2)}`;
  }
  return null;
}
