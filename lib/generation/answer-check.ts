// Code-computed answer keys (docs/designs/generation-research.md, finding 1). The
// cascade writer emits `answerCheck`: a short mathjs program that computes the answer
// FORWARD from the statement's givens. Run here, it either agrees with the stated
// answer, contradicts it (the candidate is rejected before any solver is paid for),
// or abstains (non-numeric answer, unsupported program, a program that fails to run).
//
// Why: in the last seven Opus sets, 26 of 40 rejected candidates were wrong answer
// keys caught only by the blind solvers, 2–3 paid calls each. Programs catch the
// arithmetic and counting slips cheaply (PAL, "Programs as Verifiers": +8–18% over
// majority voting), and they fail differently from text solvers, which is what makes
// agreement mean something (strong models share wrong answers ~60% of the time).
//
// The program is model-written, so it is never run as JavaScript. It is parsed by
// mathjs and accepted only if every node is on an allowlist:
//  - no strings, objects, property access, or functions outside ALLOWED_FUNCTIONS
//    (so none of parse/evaluate/import/createUnit/etc. are reachable);
//  - no recursion (an unmemoized recurrence can run for minutes; direct and mutual
//    recursion are rejected from the AST);
//  - ranges share a budget of MAX_RANGE_ELEMENTS and a wall-clock limit, checked
//    inside the range function itself, so nested enumeration is bounded too.
import { all, create, type MathNode } from "mathjs";

export type AnswerCheck =
  | { kind: "match"; value: number }
  | { kind: "mismatch"; value: number; stated: number }
  | { kind: "abstain"; reason: string };

export const MAX_PROGRAM_CHARS = 1500;
export const MAX_RANGE_ELEMENTS = 1_000_000;
export const MAX_EVAL_MS = 250;

// Pure numeric functions only. Anything not here is rejected at parse time.
const ALLOWED_FUNCTIONS = new Set([
  "abs", "sqrt", "cbrt", "nthRoot", "pow", "exp", "log", "log10", "log2", "floor", "ceil", "round", "fix", "sign",
  "mod", "gcd", "lcm", "max", "min", "sum", "prod", "mean", "median", "factorial", "combinations", "permutations",
  "isPrime", "isInteger", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "range", "map", "filter", "size",
  "count", "sort", "setDistinct", "setSize", "polynomialRoot", "lusolve", "det", "number", "fraction", "cumsum",
  "diff", "dot", "cross", "norm", "hypot", "flatten", "and", "or", "not", "xor", "equal", "unequal", "largerEq", "smallerEq",
  "larger", "smaller",
]);
const ALLOWED_CONSTANTS = new Set(["pi", "e", "true", "false", "phi"]);
const ALLOWED_NODES = new Set([
  "BlockNode", "AssignmentNode", "FunctionAssignmentNode", "FunctionNode", "SymbolNode", "ConstantNode",
  "OperatorNode", "ParenthesisNode", "ConditionalNode", "ArrayNode", "RangeNode", "RelationalNode",
  "AccessorNode", "IndexNode",
]);

const math = create(all);
const baseRange = math.range as (...a: unknown[]) => unknown;
let budget = { elements: 0, deadline: 0 };
// The expression layer's range (and `a:b`) includes its end; overriding it drops that
// transform, so the replacement includes the end itself. Numbers only: the string
// form ("1:5") can't occur, since string constants are rejected.
math.import(
  {
    range: math.typed("range", {
      "number, number": (start: number, end: number) => budgetedRange(start, end, 1),
      "number, number, number": (start: number, end: number, step: number) => budgetedRange(start, end, step),
    }),
  },
  { override: true }
);
function budgetedRange(start: number, end: number, step: number): unknown {
  if (Date.now() > budget.deadline) throw new Error("answer check ran too long");
  const n = step === 0 ? Infinity : Math.max(0, Math.floor((end - start) / step) + 1);
  budget.elements += n;
  if (budget.elements > MAX_RANGE_ELEMENTS) throw new Error("answer check enumerates too much");
  return baseRange(start, end, step, true);
}

// Reject anything outside the allowlist. Returns the reason, or null when acceptable.
export function unsafeReason(root: MathNode): string | null {
  const userFunctions = new Map<string, Set<string>>(); // name → user functions it calls
  const assigned = new Set<string>();
  root.traverse((node) => {
    if (node.type === "FunctionAssignmentNode") userFunctions.set((node as unknown as { name: string }).name, new Set());
    if (node.type === "AssignmentNode") {
      const target = (node as unknown as { object: MathNode }).object;
      if (target.type === "SymbolNode") assigned.add((target as unknown as { name: string }).name);
    }
  });
  let reason: string | null = null;
  const fail = (r: string) => (reason ??= r);
  const visit = (node: MathNode, params: Set<string>, inside: string | null) => {
    if (!ALLOWED_NODES.has(node.type)) return fail(`${node.type} is not allowed`);
    if (node.type === "ConstantNode" && typeof (node as unknown as { value: unknown }).value === "string") return fail("strings are not allowed");
    if (node.type === "AssignmentNode") {
      const n = node as unknown as { object: MathNode; index: unknown; value: MathNode };
      if (n.object.type !== "SymbolNode" || n.index) return fail("only plain variables can be assigned");
      const name = (n.object as unknown as { name: string }).name;
      if (ALLOWED_FUNCTIONS.has(name) || ALLOWED_CONSTANTS.has(name)) return fail(`cannot redefine ${name}`);
      return visit(n.value, params, inside);
    }
    if (node.type === "AccessorNode") {
      const n = node as unknown as { object: MathNode; index: MathNode & { dotNotation?: boolean; dimensions: MathNode[] } };
      if (n.index.dotNotation) return fail("property access is not allowed");
      visit(n.object, params, inside);
      for (const d of n.index.dimensions) visit(d, params, inside);
      return;
    }
    if (node.type === "IndexNode") {
      const n = node as unknown as { dotNotation?: boolean; dimensions: MathNode[] };
      if (n.dotNotation) return fail("property access is not allowed");
      for (const d of n.dimensions) visit(d, params, inside);
      return;
    }
    if (node.type === "FunctionAssignmentNode") {
      const n = node as unknown as { name: string; params: string[]; expr: MathNode };
      if (ALLOWED_FUNCTIONS.has(n.name) || ALLOWED_CONSTANTS.has(n.name)) return fail(`cannot redefine ${n.name}`);
      return visit(n.expr, new Set([...params, ...n.params]), n.name);
    }
    if (node.type === "FunctionNode") {
      const n = node as unknown as { fn: MathNode; args: MathNode[] };
      if (n.fn.type !== "SymbolNode") return fail("only named functions can be called");
      const name = (n.fn as unknown as { name: string }).name;
      if (userFunctions.has(name)) {
        if (inside) userFunctions.get(inside)!.add(name);
      } else if (!ALLOWED_FUNCTIONS.has(name) && !params.has(name)) return fail(`function ${name} is not allowed`);
      for (const a of n.args) visit(a, params, inside);
      return;
    }
    if (node.type === "SymbolNode") {
      const name = (node as unknown as { name: string }).name;
      // A bare name may be a variable, a parameter, a constant, or a function passed by
      // reference (map(1:9, f), filter(1:99, isPrime)).
      if (userFunctions.has(name)) {
        if (inside) userFunctions.get(inside)!.add(name);
        return;
      }
      if (!assigned.has(name) && !params.has(name) && !ALLOWED_CONSTANTS.has(name) && !ALLOWED_FUNCTIONS.has(name)) return fail(`unknown name ${name}`);
      return;
    }
    node.forEach((child) => visit(child, params, inside));
  };
  visit(root, new Set(), null);
  if (reason) return reason;
  // No recursion, direct or mutual: DFS over the user-function call graph.
  const state = new Map<string, 1 | 2>();
  const cyclic = (f: string): boolean => {
    if (state.get(f) === 1) return true;
    if (state.get(f) === 2) return false;
    state.set(f, 1);
    for (const g of userFunctions.get(f) ?? []) if (cyclic(g)) return true;
    state.set(f, 2);
    return false;
  };
  for (const f of userFunctions.keys()) if (cyclic(f)) return `recursion (${f}) is not allowed`;
  return null;
}

// The program's final value as one number, or null when it isn't a single real number.
function toNumber(v: unknown): number | null {
  const last = (x: unknown): unknown => (math.typeOf(x) === "ResultSet" ? (x as { entries: unknown[] }).entries.at(-1) : x);
  let r = last(v);
  if (math.isMatrix(r) || Array.isArray(r)) {
    const flat = (math.flatten(r as math.Matrix) as math.Matrix).valueOf() as unknown[];
    if (flat.length !== 1) return null;
    r = flat[0];
  }
  if (typeof r === "boolean") return null;
  try {
    const n = math.number(r as number);
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Rewrite the two habits models bring from JavaScript/Python that mathjs can't parse
// (a third of Gemini's programs failed on them): "//" comments, and lambdas
// ("x -> e", "(a, b) -> e"), which become mathjs's inline function assignment
// ("_f1(x) = e") — valid wherever a function argument is expected. Then newlines
// become statement separators.
export function normalizeProgram(src: string): string {
  let k = 0;
  return src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\(\s*([A-Za-z]\w*(?:\s*,\s*[A-Za-z]\w*)*)\s*\)\s*->/g, (_m, params: string) => `_f${++k}(${params.replace(/\s+/g, "")}) =`)
    .replace(/\b([A-Za-z]\w*)\s*->/g, (_m, param: string) => `_f${++k}(${param}) =`)
    .replace(/\r?\n/g, ";")
    .replace(/;(\s*;)+/g, ";")
    .replace(/^\s*;|;\s*$/g, "");
}

// Run a program. null source, "none", or anything unsafe/unrunnable → abstain.
export function runAnswerCheck(source: string | undefined): { ok: true; value: number } | { ok: false; reason: string } {
  const src = (source ?? "").trim();
  if (!src || /^none\.?$/i.test(src)) return { ok: false, reason: "no program" };
  if (src.length > MAX_PROGRAM_CHARS) return { ok: false, reason: "program too long" };
  let root: MathNode;
  try {
    root = math.parse(normalizeProgram(src));
  } catch (e) {
    return { ok: false, reason: `does not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
  const unsafe = unsafeReason(root);
  if (unsafe) return { ok: false, reason: unsafe };
  budget = { elements: 0, deadline: Date.now() + MAX_EVAL_MS };
  try {
    const value = toNumber(root.compile().evaluate({}));
    return value === null ? { ok: false, reason: "result is not a single number" } : { ok: true, value };
  } catch (e) {
    return { ok: false, reason: `failed to run: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Compare the program's value with the stated answer. `statedValue` is the stated
// answer's numeric value (answer-match.ts evaluateAnswer), null when it has none.
export function checkAnswer(source: string | undefined, statedValue: number | null): AnswerCheck {
  if (statedValue === null) return { kind: "abstain", reason: "stated answer is not a number" };
  const r = runAnswerCheck(source);
  if (!r.ok) return { kind: "abstain", reason: r.reason };
  const close = Math.abs(r.value - statedValue) <= 1e-6 * Math.max(1, Math.abs(r.value), Math.abs(statedValue));
  return close ? { kind: "match", value: r.value } : { kind: "mismatch", value: r.value, stated: statedValue };
}
