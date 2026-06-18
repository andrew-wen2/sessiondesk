import katex from "katex";
import type { Problem } from "@/lib/types";

// Render a string that may contain $...$ / $$...$$ math into safe HTML.
// Mirrors the segment split used by components/MathText.tsx so the PDF
// matches what's shown on screen; malformed LaTeX falls back to raw source.
function renderMath(text: string): string {
  const parts = text.split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$)/g);
  return parts
    .map((part) => {
      try {
        if (part.startsWith("$$") && part.endsWith("$$") && part.length >= 4) {
          return katex.renderToString(part.slice(2, -2), { displayMode: true });
        }
        if (part.startsWith("$") && part.endsWith("$") && part.length >= 2) {
          return katex.renderToString(part.slice(1, -1), { displayMode: false });
        }
      } catch {
        return escapeHtml(part);
      }
      return escapeHtml(part);
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// MM-DD-studentname (no extension; the browser appends .pdf when saving).
export function problemsFilename(startIso: string, studentName: string): string {
  const d = new Date(startIso);
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const name = studentName.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
  return `${date}-${name}`;
}

// Open a print window with the problems (questions first, answer key after)
// and trigger the browser's print-to-PDF. The document title becomes the
// suggested filename: MM-DD-studentname.pdf.
export function downloadProblemsPdf(
  problems: Problem[],
  opts: { startIso: string; studentName: string; subject?: string; topic?: string }
): boolean {
  if (problems.length === 0) return false;

  const filename = problemsFilename(opts.startIso, opts.studentName);
  // Match the installed katex version for the print window's stylesheet.
  const katexCss = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";

  const questions = problems
    .map(
      (p, i) => `
      <div class="item">
        <div class="label">Problem ${i + 1}</div>
        <div class="body">${renderMath(p.problem)}</div>
      </div>`
    )
    .join("");

  const answers = problems
    .map(
      (p, i) => `
      <div class="item">
        <div class="label">Problem ${i + 1}</div>
        <div class="body"><strong>Answer.</strong> ${renderMath(p.answer)}</div>
        <div class="body"><strong>Solution.</strong> ${renderMath(p.solution)}</div>
      </div>`
    )
    .join("");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(filename)}</title>
  <link rel="stylesheet" href="${katexCss}" />
  <style>
    * { box-sizing: border-box; }
    body { font-family: Georgia, "Times New Roman", serif; color: #111; margin: 48px; line-height: 1.5; }
    h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; color: #444;
         border-bottom: 1px solid #ccc; padding-bottom: 4px; margin: 28px 0 12px; }
    .item { margin: 0 0 18px; break-inside: avoid; }
    .label { font-size: 12px; font-weight: bold; color: #888; margin-bottom: 4px; }
    .body { margin-bottom: 6px; }
    .answer-key { page-break-before: always; }
  </style>
</head>
<body>
  <h2>Problems</h2>
  ${questions}

  <div class="answer-key">
    <h2>Answer Key</h2>
    ${answers}
  </div>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();

  // Wait for the KaTeX stylesheet (and layout) before invoking print.
  win.onload = () => {
    win.focus();
    win.print();
  };
  return true;
}
