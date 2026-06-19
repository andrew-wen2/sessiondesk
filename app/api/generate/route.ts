import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildPrompt } from "@/lib/generation-prompt";
import { calibrationFor, categoryFor } from "@/lib/calibration";
import { getAnchors } from "@/lib/corpus-retrieval";
import { selectBookContents } from "@/lib/book-chapters";
import type { Problem } from "@/lib/types";

// POST /api/generate — server-only. Uses ANTHROPIC_API_KEY from env; never
// import this route or the SDK in a client component.
//
// Body: { studentId, sessionId, topic? }  — always generates 10 problems
//
// We use tool-use (structured output) rather than parsing free text: LaTeX is
// backslash-heavy and the model would frequently emit JSON that won't parse
// (bad escapes, preamble, truncated strings). Forcing an emit_problems tool
// call makes the SDK hand us already-valid structured data.

// Generating 10 hard problems with full solutions is a large, slow streamed call;
// up to two attempts (generate + regenerate the deficit). Needs a Vercel plan
// whose function limit allows this (Hobby caps at 60s).
export const maxDuration = 300;

const PROBLEMS_TOOL: Anthropic.Tool = {
  name: "emit_problems",
  description: "Return the generated practice problems for the session.",
  input_schema: {
    type: "object",
    properties: {
      problems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            problem: { type: "string", description: "Problem statement, LaTeX in $...$ / $$...$$" },
            answer: { type: "string", description: "Final answer only — no working" },
            solution: { type: "string", description: "Concise solution, 3–8 lines" },
            difficulty: {
              type: "string",
              description: "Difficulty self-estimate as a competition reference, e.g. 'AIME #12'",
            },
          },
          required: ["problem", "answer", "solution", "difficulty"],
        },
      },
    },
    required: ["problems"],
  },
};

function validateProblems(raw: unknown): Problem[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { problems?: unknown }).problems)) {
    throw new Error("Tool output missing problems array");
  }
  return (raw as { problems: unknown[] }).problems.map((p) => {
    if (
      !p ||
      typeof (p as Problem).problem !== "string" ||
      typeof (p as Problem).answer !== "string" ||
      typeof (p as Problem).solution !== "string"
    ) {
      throw new Error("Problem item missing required string fields");
    }
    const { problem, answer, solution, difficulty } = p as Problem;
    return { problem, answer, solution, difficulty: typeof difficulty === "string" ? difficulty : undefined };
  });
}

// One tool-forced generation call → structurally-valid Problem[]. Throws
// "truncated" / "no_tool" on infrastructure failures so the caller can map them.
//
// Hard problems with full worked solutions are long — 10 of them overran the old
// non-streaming cap. We stream so we can allow a high max_tokens without hitting
// the SDK's non-streaming HTTP timeout, and read the final message.
async function callTool(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  count: number
): Promise<Problem[]> {
  const stream = client.messages.stream({
    model,
    max_tokens: Math.min(32000, 4000 + count * 1600),
    // The stable instructions + rubric + (trimmed) book live in the system block
    // and are cached; the deficit-retry and same-student repeat generations read
    // them back at ~0.1× instead of full input price.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [PROBLEMS_TOOL],
    tool_choice: { type: "tool", name: "emit_problems" },
    messages: [{ role: "user", content: user }],
  });
  const message = await stream.finalMessage();
  // Token-cost visibility: cache_read should be > 0 on the deficit retry and on
  // same-student/topic repeats within the cache TTL (the cached system prefix).
  const u = message.usage;
  console.log(
    `[/api/generate] usage input=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} output=${u.output_tokens}`
  );
  if (message.stop_reason === "max_tokens") throw new Error("truncated");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("no_tool");
  return validateProblems(toolUse.input);
}

// Verification: reject problems the model didn't actually solve (placeholder
// answers) or that violate the competition's answer format. The model reliably
// hits the difficulty but sometimes can't solve a hard one and punts.
function answerOk(p: Problem, competition?: string): boolean {
  const a = (p.answer || "").trim();
  if (!a) return false;
  if (/\b(tbd|tba|todo|n\/?a|hint|see solution|to be determined|placeholder|unknown)\b/i.test(`${p.answer} ${p.solution}`))
    return false;
  if (/^\?+$/.test(a)) return false;
  // No multiple-choice option letters as the answer (we generate free-response).
  // "(C)" is never valid; a bare "C" is rejected for AMC (where MC leaks) but not
  // physics, where a lone symbol like energy E can be a legitimate answer.
  if (/^\(\s*[A-E]\s*\)$/.test(a)) return false;
  if ((competition === "AMC10" || competition === "AMC12") && /^[A-E]$/.test(a)) return false;
  // Only AIME's answer format is unambiguous enough to hard-enforce (integer
  // 0–999). F=ma may be a letter A–E OR a value with units; AMC varies — for
  // those, a real non-placeholder answer is enough (format is the prompt's job).
  if (competition === "AIME") return /^\d{1,3}$/.test(a) && Number(a) <= 999;
  return true;
}

// Content guard: reject malformed problem STATEMENTS the prompt tells the model
// never to emit — self-correction / thinking-out-loud inside the field (the
// "Actually disregard — here is the problem:" failure), figure dependence (a
// problem the student can't solve from text alone), and cut-off statements.
// A rejected problem is dropped and refilled by the regenerate-the-deficit loop,
// so this never blocks generation; it just filters bad items like answerOk does.
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
function problemOk(p: Problem): boolean {
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

export async function POST(request: Request) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Generation is not configured — set ANTHROPIC_API_KEY." },
        { status: 500 }
      );
    }

    const body = await request.json();
    const studentId = typeof body.studentId === "string" ? body.studentId : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const count = 10; // fixed problem set; no longer client-selectable
    const topic = typeof body.topic === "string" ? body.topic : "";

    if (!studentId || !sessionId) {
      return NextResponse.json({ error: "Missing student or session." }, { status: 400 });
    }

    // Batch all DB reads into two parallel queries — student + session-with-book
    // and recent topics — rather than three sequential round-trips.
    const [student, sessionRow, recent] = await Promise.all([
      prisma.student.findUniqueOrThrow({
        where: { id: studentId },
        select: { level: true },
      }),
      // The book assigned to this session (if any) — its chapter contents tell the
      // model what the chapters named in `topic` actually cover.
      prisma.session.findUnique({
        where: { id: sessionId },
        select: { book: { select: { title: true, contents: true, chapters: true } } },
      }),
      // Last 5 non-empty topics for this student, most recent first.
      prisma.session.findMany({
        where: { studentId, topic: { not: "" } },
        orderBy: { start: "desc" },
        take: 5,
        select: { topic: true },
      }),
    ]);
    const recentTopics = recent.map((s) => s.topic);

    // Trim the book outline to the chapters/sections the topic names — the book
    // is the dominant input cost. Falls back to the full outline when it can't
    // safely narrow (empty topic, legacy book, or no match).
    const book = sessionRow?.book
      ? {
          title: sessionRow.book.title,
          contents: selectBookContents(sessionRow.book.chapters, sessionRow.book.contents, topic),
        }
      : undefined;

    // Difficulty calibration: derive the competition + problem-number band, then
    // retrieve real same-difficulty anchor problems from the corpus.
    const cal = calibrationFor(student);
    const category = categoryFor(student.level, topic);
    const anchors = cal.competition
      ? await getAnchors({
          competition: cal.competition,
          bandLow: cal.bandLow,
          bandHigh: cal.bandHigh,
          category,
          count: 4,
        })
      : [];

    console.log(
      `[/api/generate] competition=${cal.competition ?? "none"} band=${cal.bandLow ?? "?"}-${cal.bandHigh ?? "?"} category=${category ?? "any"} anchors=${anchors.length}`
    );

    const built = buildPrompt({
      level: student.level,
      topic,
      count,
      recentTopics,
      book,
      competition: cal.competition ?? undefined,
      bandLow: cal.bandLow,
      bandHigh: cal.bandHigh,
      anchors,
    });

    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const model = process.env.GENERATION_MODEL ?? "claude-opus-4-8";

    // Generate, keep only well-solved problems, and regenerate the deficit once.
    const kept: Problem[] = [];
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 2 && kept.length < count; attempt++) {
      const need = count - kept.length;
      // On the deficit retry, only `count` changes in the prompt (user block).
      // system is stable (cached), so rebuild only the user block by calling
      // buildPrompt with the updated count — the system value is identical and
      // the prompt-cache hit still applies.
      const attemptBuilt =
        attempt === 0
          ? built
          : buildPrompt({
              level: student.level,
              topic,
              count: need, // only this differs from the first call
              recentTopics,
              book,
              competition: cal.competition ?? undefined,
              bandLow: cal.bandLow,
              bandHigh: cal.bandHigh,
              anchors,
            });

      let batch: Problem[];
      try {
        batch = await callTool(
          client,
          model,
          attemptBuilt.system,
          attemptBuilt.user,
          need // same as `count` on attempt 0; explicit for clarity
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (kept.length > 0) break; // keep what we have if a retry fails
        console.error("[/api/generate] generation failed:", msg);
        return NextResponse.json(
          {
            error:
              msg === "truncated"
                ? "Generation was too long — try fewer problems."
                : "Generation failed — try again.",
          },
          { status: 500 }
        );
      }

      for (const p of batch) {
        if (kept.length >= count) break;
        if (seen.has(p.problem)) continue;
        if (!problemOk(p)) {
          console.warn(`[/api/generate] dropped malformed problem: ${p.problem.slice(0, 80)}…`);
          continue;
        }
        if (!answerOk(p, cal.competition ?? undefined)) continue;
        seen.add(p.problem);
        kept.push(p);
      }
    }

    if (kept.length === 0) {
      return NextResponse.json(
        { error: "Generation failed — couldn't produce solvable problems. Try again." },
        { status: 500 }
      );
    }
    // Strip the model's difficulty self-tag (e.g. "AMC 10 #15"). It's a
    // generation-time calibration aid only — never surfaced on the problem.
    const problems: Problem[] = kept.map((p) => ({
      problem: p.problem,
      answer: p.answer,
      solution: p.solution,
    }));
    console.log(`[/api/generate] returned ${problems.length}/${count} verified problems`);

    await prisma.session.update({
      where: { id: sessionId },
      data: { problems: problems as unknown as Prisma.InputJsonValue },
    });

    return NextResponse.json(problems);
  } catch (e) {
    console.error("[/api/generate POST]", e);
    return NextResponse.json({ error: "Generation failed — try again." }, { status: 500 });
  }
}
