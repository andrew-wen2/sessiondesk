// Admission test for a ladder rung: before a model is allowed onto a ladder, it must
// return a problem through the tool call with LaTeX backslashes intact. Gemini's raw
// JSON mode once silently turned "\binom" into a backspace plus "inom", with no error;
// a rung that corrupts silently is disqualified, never escalated past.
//
// Pure evaluation lives here (tested); scripts/gen-admit.ts makes the live call.
import type { Problem } from "@/lib/types";

// Commands whose first letter collides with a JSON escape (\b \f \n \r \t \u) or is
// otherwise easy to mangle. The model is asked to use every one of them verbatim.
export const LATEX_PROBES = ["\\binom", "\\frac", "\\theta", "\\nu", "\\right", "\\tau", "\\forall", "\\rho", "\\beta", "\\neq"] as const;

export const ADMISSION_SYSTEM =
  "You write one short math practice problem for a latex rendering test. Call the emit_problems tool with exactly one problem.";

export function admissionUser(): string {
  return `Write one problem whose statement and solution together use EVERY one of these LaTeX commands at least once, spelled exactly: ${LATEX_PROBES.join(
    ", "
  )}. Use $...$ for math. The answer is a single integer. Call the emit_problems tool with one problem and return nothing else.`;
}

export type AdmissionResult = { pass: boolean; missing: string[]; corrupted: string[] };

// A JSON string escape eats a backslash-letter and leaves a control character in its
// place: "\binom" arrives as backspace + "inom", "\right" as carriage return + "ight".
// That exact signature — escape character followed by the rest of the command — is what
// counts as corruption. (Looking for the bare word instead would false-alarm on plain
// text like "right triangle" or "fraction".)
const JSON_ESCAPES: Record<string, string> = { b: "\u0008", f: "\u000c", n: "\n", r: "\r", t: "\t" };

// Stray control characters other than tab/newline/CR never belong in a problem.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

// At least this share of the probe commands must appear, so the trial genuinely
// exercised escaping. A model leaving one out is an instruction slip, not corruption.
export const MIN_PROBES_PRESENT = 0.8;

export function evaluateAdmission(p: Problem): AdmissionResult {
  const text = `${p.problem}\n${p.solution}`;
  const missing = LATEX_PROBES.filter((cmd) => !text.includes(cmd));
  const corrupted: string[] = LATEX_PROBES.filter((cmd) => {
    const esc = JSON_ESCAPES[cmd[1]];
    return esc !== undefined && text.includes(esc + cmd.slice(2));
  });
  if (CONTROL.test(text) && corrupted.length === 0) corrupted.push("control-characters");
  const presentShare = (LATEX_PROBES.length - missing.length) / LATEX_PROBES.length;
  return { pass: corrupted.length === 0 && presentShare >= MIN_PROBES_PRESENT, missing, corrupted };
}
