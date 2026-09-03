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
//
// PLAN-AWARE (rewritten): problemOk / solutionOk / solutionSketchOk now take the
// plan. They were previously subject-blind — unable to apply a different rule to
// Spanish than to AIME — which is stale relative to the plan-driven pipeline every
// other stage already reasons about per-subject.
//
// SPLIT: answerOkFor no longer gates the KEEP/DROP decision on the generator's
// self-reported answer (see lib/generation/problems.ts). It's called post-solve
// against whichever answer ends up stored — the solver's, when one exists — so a
// good problem statement is never discarded for a value that was going to be
// overwritten anyway.

import type { Problem } from "@/lib/types";
import type { GenerationPlan } from "@/lib/generation/plan";

export type GuardPlan = Pick<GenerationPlan, "contentType">;

// --- Answer guard -----------------------------------------------------------

// The model punts with one of these when it couldn't actually solve the problem.
// "unknown" and "hint" were removed here (Eng/DX finding): "let the unknown be $x$"
// is routine algebra phrasing and "hint" appears in ordinary pedagogical solutions
// — neither is a placeholder, and both were dropping good problems.
const PLACEHOLDER_RE = /\b(tbd|tba|todo|n\/?a|see solution|to be determined|placeholder)\b/i;

// One answer guard for every subject, keyed off the plan's answerFormat rather
// than a stored engine choice. It enforces exactly what the prompt's
// ANSWER_FORMAT_RULES told the model to produce — keep the two in step.
//
// The empty-answer rule is the important one: an empty answer means nothing was
// solved, and is only legitimate for genuinely open-ended work ("open").
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
// FIGURE DEPENDENCE — only the phrases that mean "an image was provided and this
// problem can't be worked without it." The old guard also banned the bare words
// "figure"/"diagram"/"picture"/"illustration", which is standard vocabulary in AP
// Biology ("draw a diagram of..."), chemistry, and geometry ("the figure formed by
// the three midpoints") — that version dropped good problems across exactly the
// subjects this pipeline was generalized to serve.
const FIGURE_DEPENDENCE_PATTERNS = [
  /\b(shown|pictured|depicted|illustrated|drawn)\s+(above|below|here|to the (left|right))\b/i,
  /\bas shown\b/i,
];

// Reject malformed problem STATEMENTS the prompt tells the model never to emit:
// self-correction, figure dependence, cut-off statements, and answer-choice lists.
export function problemOk(p: Problem, plan: GuardPlan): boolean {
  const text = (p.problem || "").trim();
  if (!text) return false;
  // Cut-off / abandoned statement: ends in an ellipsis (a real problem ends with
  // proper punctuation; "1, 2, ..." mid-statement is fine, a trailing one is not).
  if (/(\.\.\.|…)\s*$/.test(text)) return false;
  if (META_PATTERNS.some((re) => re.test(text))) return false;
  // Figure-dependence is a real defect for math/mixed content (a geometry diagram,
  // a physics free-body diagram the student wasn't given). Code problems routinely
  // embed a self-contained ASCII diagram directly in the statement — "as shown
  // below" there usually points at text three lines down, not a missing image —
  // so the check is exempted for contentType "code" to avoid that false positive.
  if (plan.contentType !== "code" && FIGURE_DEPENDENCE_PATTERNS.some((re) => re.test(text))) return false;
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
// ("that's wrong", "scratch that"), but the model still leaks it. We can't fix the
// wording in place safely (the bad line may carry the final number), so a leaked
// solution drops the whole problem and the deficit loop regenerates a clean one.
//
// REWRITTEN (Eng/DX finding): the previous list also banned "recompute",
// "recalculate", "recheck", "double-check", and "let me (verify|check|confirm)" —
// which bans exactly the sentence "let me verify: substituting back gives 14",
// good pedagogy, not backtracking. Only genuine self-correction markers remain;
// a forward verification step is no longer confused with correcting an error.
const SOLUTION_BACKTRACK = [
  /\b(scratch that|never ?mind|on second thought|my mistake|oops)\b/i,
  /\bthat'?s wrong\b/i,
  /\bi made (an|a) (error|mistake)\b/i,
  /\bwait,/i,
];
export function solutionOk(p: Problem, _plan: GuardPlan): boolean {
  return !SOLUTION_BACKTRACK.some((re) => re.test(p.solution || ""));
}

// Adapt-path equivalent of solutionOk: the heavy pass emits a `solutionSketch`
// rather than a full `solution`, so the same backtracking vocabulary is checked
// against the sketch field. Reuses SOLUTION_BACKTRACK (single source of truth).
export function solutionSketchOk(p: Problem, _plan: GuardPlan): boolean {
  return !SOLUTION_BACKTRACK.some((re) => re.test(p.solutionSketch || ""));
}

// --- Seed-similarity guard (variant/hard tier only) -------------------------

// Similarity thresholds — kept lenient so the guard doesn't starve generation.
// A variant is rejected only when it's clearly too close to a seed on either axis.
export const SEED_NUMERIC_JACCARD_THRESHOLD = 0.5;
export const SEED_NUMERIC_OVERLAP_THRESHOLD = 3; // shared non-trivial integers
export const SEED_LEXICAL_JACCARD_THRESHOLD = 0.45;
// contentWords() strips ALL math out of a statement, so a short, templated problem
// ("Solve X by factoring") is left with only 2-4 generic instructional words. On a
// set that small, Jaccard is a noisy statistic: two problems sharing just 2 of
// those words already cross 0.45, even when the underlying equations are
// completely different (found via /investigate — reproduced from a live eval run
// where this dropped 19/20 candidates for a narrow algebra topic as "duplicates").
// This mirrors the numeric axis's own absolute-count floor (SEED_NUMERIC_OVERLAP_
// THRESHOLD) rather than trusting a proportional threshold alone at tiny set sizes.
export const SEED_LEXICAL_MIN_SHARED_WORDS = 3;

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
  others: { source: string; number: number | null; statement: string }[],
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

    // Lexical overlap axis. Requires an absolute minimum shared-word count in
    // ADDITION to the proportional Jaccard threshold — on a 3-4 word set (all
    // that's left after stripping math from a short problem), 2 shared words alone
    // already exceeds the threshold by chance, not by genuine similarity.
    const sharedWords = variantWords.filter((w) => seedWords.includes(w)).length;
    const lexJaccard = jaccardSets(variantWords, seedWords);
    if (sharedWords >= SEED_LEXICAL_MIN_SHARED_WORDS && lexJaccard > SEED_LEXICAL_JACCARD_THRESHOLD) {
      return `${label} lexical-jaccard=${lexJaccard.toFixed(2)}`;
    }
  }
  return null;
}
