import katex from "katex";
import type { Problem, Lesson } from "@/lib/types";
import { splitMath } from "@/lib/math-segments";
import { splitCode } from "@/lib/rich-segments";
import { pad } from "@/lib/format";

// Render a string into safe HTML, matching what components/RichContent shows on
// screen: fenced code blocks (```lang … ```) become <pre>, and the non-code
// remainder is split into $...$ / $$...$$ math (escape-aware) with malformed LaTeX
// falling back to raw source. Math-only content is unchanged (no fences → one text
// segment fed straight to the math splitter).
function renderRich(text: string): string {
  return splitCode(text)
    .map((seg) => (seg.type === "code" ? `<pre class="code">${escapeHtml(seg.content)}</pre>` : renderMath(seg.content)))
    .join("");
}

function renderMath(text: string): string {
  return splitMath(text)
    .map((seg) => {
      if (seg.type === "text") return escapeHtml(seg.content);
      try {
        return katex.renderToString(seg.content, { displayMode: seg.type === "block" });
      } catch {
        const d = seg.type === "block" ? "$$" : "$";
        return escapeHtml(`${d}${seg.content}${d}`);
      }
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function hasText(s: string | undefined | null): s is string {
  return Boolean(s && s.trim());
}

// MM-DD-studentname (no extension; the browser appends .pdf when saving). `suffix`
// distinguishes artifacts sharing a session (e.g. "-lesson").
export function problemsFilename(startIso: string, studentName: string, suffix = ""): string {
  const d = new Date(startIso);
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const name = studentName.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
  return `${date}-${name}${suffix}`;
}

type FileOpts = { startIso: string; studentName: string; topic?: string; isMath?: boolean };

// Shared print-window plumbing: write the doc, wait for the KaTeX stylesheet, print.
// The document title becomes the suggested filename. Returns false if the pop-up was
// blocked so the caller can surface a "allow pop-ups" hint.
function printDoc(filename: string, bodyHtml: string): boolean {
  // Match the installed katex version for the print window's stylesheet.
  const katexCss = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(filename)}</title>
  <link rel="stylesheet" href="${katexCss}" />
  <style>
    * { box-sizing: border-box; }
    body { font-family: Georgia, "Times New Roman", serif; color: #111; margin: 48px; line-height: 1.5; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; color: #444;
         border-bottom: 1px solid #ccc; padding-bottom: 4px; margin: 28px 0 12px; }
    h3 { font-size: 14px; margin: 16px 0 4px; }
    .item { margin: 0 0 18px; break-inside: avoid; }
    .page-break { page-break-before: always; }
    .label { font-size: 12px; font-weight: bold; color: #888; margin-bottom: 4px; }
    .body { margin-bottom: 6px; }
    .answer { margin: 4px 0; }
    .answer .k { font-weight: bold; color: #555; }
    .mono { font-family: "SF Mono", Menlo, Consolas, monospace; }
    ul { margin: 6px 0; padding-left: 22px; }
    pre.code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px;
               background: #f6f6f6; border: 1px solid #ddd; border-radius: 4px;
               padding: 8px; white-space: pre-wrap; word-break: break-word; margin: 6px 0; }
  </style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.onload = () => {
    win.focus();
    win.print();
  };
  return true;
}

// Problems → a student worksheet (questions only) followed by a tutor answer key
// (answer + solution) on a fresh page.
export function downloadProblemsPdf(problems: Problem[], opts: FileOpts & { item?: string }): boolean {
  if (problems.length === 0) return false;
  const item = opts.item ?? "Problem";
  const mono = opts.isMath === false ? "" : "mono";
  const filename = problemsFilename(opts.startIso, opts.studentName);

  const worksheet = problems
    .map(
      (p, i) => `
      <div class="item">
        <div class="label">${escapeHtml(item)} ${i + 1}</div>
        <div class="body">${renderRich(p.problem)}</div>
      </div>`
    )
    .join("");

  const key = problems
    .map(
      (p, i) => `
      <div class="item">
        <div class="label">${escapeHtml(item)} ${i + 1}</div>
        ${hasText(p.answer) ? `<div class="answer ${mono}"><span class="k">Answer: </span>${renderRich(p.answer)}</div>` : ""}
        <div class="body">${renderRich(p.solution)}</div>
      </div>`
    )
    .join("");

  const body = `
    <h2>Worksheet</h2>
    ${worksheet}
    <div class="page-break"></div>
    <h2>Answer key</h2>
    ${key}`;

  return printDoc(filename, body);
}

// Lesson → a student worksheet (title, objectives, explanation, worked-example
// prompts, practice questions) then a tutor answer key (worked-example solutions +
// practice answers/solutions) on a fresh page.
export function downloadLessonPdf(lesson: Lesson, opts: FileOpts): boolean {
  const mono = opts.isMath === false ? "" : "mono";
  const filename = problemsFilename(opts.startIso, opts.studentName, "-lesson");

  const objectives = lesson.objectives.length
    ? `<h3>Objectives</h3><ul>${lesson.objectives.map((o) => `<li>${renderRich(o)}</li>`).join("")}</ul>`
    : "";
  const sections = lesson.sections
    .map((s) => `<div class="item">${s.heading ? `<h3>${escapeHtml(s.heading)}</h3>` : ""}<div class="body">${renderRich(s.content)}</div></div>`)
    .join("");
  const examplePrompts = lesson.workedExamples.length
    ? `<h3>Worked examples</h3>${lesson.workedExamples
        .map((ex, i) => `<div class="item"><div class="label">Example ${i + 1}</div><div class="body">${renderRich(ex.problem)}</div></div>`)
        .join("")}`
    : "";
  const practiceQuestions = lesson.practice.length
    ? `<h3>Practice</h3>${lesson.practice
        .map((p, i) => `<div class="item"><div class="label">${i + 1}.</div><div class="body">${renderRich(p.problem)}</div></div>`)
        .join("")}`
    : "";

  const exampleSolutions = lesson.workedExamples.length
    ? `<h3>Worked examples</h3>${lesson.workedExamples
        .map((ex, i) => `<div class="item"><div class="label">Example ${i + 1}</div><div class="body">${renderRich(ex.solution)}</div></div>`)
        .join("")}`
    : "";
  const practiceSolutions = lesson.practice.length
    ? `<h3>Practice</h3>${lesson.practice
        .map(
          (p, i) => `<div class="item"><div class="label">${i + 1}.</div>${
            hasText(p.answer) ? `<div class="answer ${mono}"><span class="k">Answer: </span>${renderRich(p.answer)}</div>` : ""
          }<div class="body">${renderRich(p.solution)}</div></div>`
        )
        .join("")}`
    : "";

  const body = `
    ${lesson.title ? `<h1>${escapeHtml(lesson.title)}</h1>` : ""}
    <h2>Lesson</h2>
    ${objectives}
    ${sections}
    ${examplePrompts}
    ${practiceQuestions}
    <div class="page-break"></div>
    <h2>Answer key</h2>
    ${exampleSolutions}
    ${practiceSolutions}`;

  return printDoc(filename, body);
}
