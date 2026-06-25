// Shared, escape-aware splitter for mixed prose + LaTeX strings. Both the
// on-screen renderer (components/MathText.tsx) and the PDF renderer
// (lib/download-problems.ts) consume this so they stay in lock-step.
//
// `$...$` is inline math and `$$...$$` is display math, but a backslash-escaped
// `\$` is a LITERAL dollar sign, never a delimiter — so "$\$80$" is inline math
// whose content is `\$80` (KaTeX renders that as the string "$80"), and a bare
// `\$5` in prose is just "$5". The old naive regex split treated `\$` as a real
// delimiter and mangled currency; this walker respects the escape.

export type MathSegment = { type: "text" | "inline" | "block"; content: string };

// True when the `$` at index i is escaped by an odd number of preceding
// backslashes (\$ is literal, \\$ is a real delimiter after a literal backslash).
function isEscaped(text: string, i: number): boolean {
  let backslashes = 0;
  for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) backslashes++;
  return backslashes % 2 === 1;
}

// Index of the next unescaped occurrence of `delim` ("$" or "$$") at or after
// `from`, or -1 if there is none.
function findUnescaped(text: string, delim: string, from: number): number {
  for (let i = from; i <= text.length - delim.length; i++) {
    if (text.startsWith(delim, i) && !isEscaped(text, i)) return i;
  }
  return -1;
}

// In a prose segment the only escape we honor is `\$` → `$` (the escape we ask
// the model to use for currency). Other backslashes are left alone so LaTeX-ish
// prose is untouched.
function unescapeText(text: string): string {
  return text.replace(/\\\$/g, "$");
}

export function splitMath(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let buf = ""; // accumulating prose
  let i = 0;

  const flushText = () => {
    if (buf) {
      segments.push({ type: "text", content: unescapeText(buf) });
      buf = "";
    }
  };

  while (i < text.length) {
    // A `$` that is escaped (\$) is literal prose — consume the pair and move on.
    if (text[i] === "$" && isEscaped(text, i)) {
      buf += text[i];
      i++;
      continue;
    }

    if (text[i] === "$") {
      const isBlock = text.startsWith("$$", i);
      const delim = isBlock ? "$$" : "$";
      const close = findUnescaped(text, delim, i + delim.length);
      if (close !== -1) {
        flushText();
        segments.push({
          type: isBlock ? "block" : "inline",
          content: text.slice(i + delim.length, close),
        });
        i = close + delim.length;
        continue;
      }
      // No closing delimiter — treat the opener as literal text (never drop the
      // rest of the string).
      buf += text[i];
      i++;
      continue;
    }

    buf += text[i];
    i++;
  }

  flushText();
  return segments;
}
