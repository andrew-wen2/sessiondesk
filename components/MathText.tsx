"use client";

import { useMemo } from "react";
import { InlineMath, BlockMath } from "react-katex";
import { splitMath } from "@/lib/math-segments";

// Split a string into prose and math segments ($$...$$ display, $...$ inline)
// and render each. The split is escape-aware (\$ is a literal dollar, not a
// delimiter — see lib/math-segments.ts). Malformed LaTeX falls back to the raw
// source rather than crashing the whole problem display.
export default function MathText({ text }: { text: string }) {
  // splitMath is an O(n) escape-aware walk over the string; memoize so it only
  // re-runs when the text changes, not on every parent re-render.
  const segments = useMemo(() => splitMath(text), [text]);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "block") {
          return (
            <span key={i} className="block overflow-x-auto">
              <BlockMath math={seg.content} renderError={() => <code>{`$$${seg.content}$$`}</code>} />
            </span>
          );
        }
        if (seg.type === "inline") {
          return (
            <InlineMath key={i} math={seg.content} renderError={() => <code>{`$${seg.content}$`}</code>} />
          );
        }
        return <span key={i}>{seg.content}</span>;
      })}
    </>
  );
}
