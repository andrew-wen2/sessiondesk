"use client";

import { InlineMath, BlockMath } from "react-katex";

// Split a string into prose and math segments ($$...$$ display, $...$ inline)
// and render each. Malformed LaTeX falls back to the raw source rather than
// crashing the whole problem display.
export default function MathText({ text }: { text: string }) {
  const parts = text.split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("$$") && part.endsWith("$$") && part.length >= 4) {
          const math = part.slice(2, -2);
          return (
            <span key={i} className="block overflow-x-auto">
              <BlockMath math={math} renderError={() => <code>{part}</code>} />
            </span>
          );
        }
        if (part.startsWith("$") && part.endsWith("$") && part.length >= 2) {
          const math = part.slice(1, -1);
          return <InlineMath key={i} math={math} renderError={() => <code>{part}</code>} />;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
