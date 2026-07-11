// Splitter for fenced code blocks in generated content. The app began as pure
// competition math (everything was LaTeX in $...$), but the general profile serves
// coding and other subjects whose solutions contain code. We split code out FIRST
// so a code block is rendered verbatim (never fed to the math splitter, which would
// try to interpret `$` or `\` inside it); the non-code remainder still goes through
// the escape-aware math splitter (lib/math-segments.ts).
//
// A fenced block is ```lang\n … ``` (lang optional). Both the on-screen renderer
// (components/RichContent.tsx) and the PDF renderer (lib/download-problems.ts)
// consume this so they stay in lock-step.

export type RichSegment =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string };

// Matches a fenced block: ```optional-lang, optional newline, body (non-greedy),
// closing ```. The body may contain anything except the closing fence.
const FENCE_RE = /```([a-zA-Z0-9+#.-]*)\r?\n?([\s\S]*?)```/g;

export function splitCode(text: string): RichSegment[] {
  const segments: RichSegment[] = [];
  let last = 0;
  for (let m = FENCE_RE.exec(text); m !== null; m = FENCE_RE.exec(text)) {
    if (m.index > last) segments.push({ type: "text", content: text.slice(last, m.index) });
    segments.push({ type: "code", lang: m[1] || "", content: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type: "text", content: text.slice(last) });
  // A string with no fences yields a single text segment (identical to feeding the
  // whole string to the math splitter — so math-only content is unaffected).
  return segments;
}
