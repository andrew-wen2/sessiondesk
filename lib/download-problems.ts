import katex from "katex";
import type { Problem } from "@/lib/types";
import { splitMath } from "@/lib/math-segments";
import { pad } from "@/lib/format";

// Render a string that may contain $...$ / $$...$$ math into safe HTML. Uses the
// same escape-aware split as components/MathText.tsx so the PDF matches what's
// shown on screen; malformed LaTeX falls back to raw source.
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
  opts: { startIso: string; studentName: string; topic?: string }
): boolean {
  if (problems.length === 0) return false;

  const filename = problemsFilename(opts.startIso, opts.studentName);
  // Match the installed katex version for the print window's stylesheet.
  const katexCss = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";

  const questions = problems
    .map(
      (p, i) => `
      <div class="item${i < problems.length - 1 ? " page-break" : ""}">
        <div class="label">Problem ${i + 1}</div>
        <div class="body">${renderMath(p.problem)}</div>
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
    /* One problem per page in the Problems section (last one needs no break —
       the answer key already starts on a fresh page). */
    .page-break { page-break-after: always; }
    .label { font-size: 12px; font-weight: bold; color: #888; margin-bottom: 4px; }
    .body { margin-bottom: 6px; }
  </style>
</head>
<body>
  ${questions}
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
