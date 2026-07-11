"use client";

import { useMemo } from "react";
import MathText from "./MathText";
import { splitCode } from "@/lib/rich-segments";

// Subject-agnostic renderer for generated content. Auto-detects fenced code blocks
// (```lang … ```) and renders them verbatim in a scrollable <pre>; everything else
// goes through MathText, which handles $...$ / $$...$$ LaTeX and plain prose. Math-
// only content (no code fences) renders identically to using MathText directly, so
// the competition-math display is unchanged.
export default function RichContent({ text }: { text: string }) {
  const segments = useMemo(() => splitCode(text), [text]);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <pre
            key={i}
            className="my-2 overflow-x-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs font-mono text-gray-800"
          >
            <code>{seg.content}</code>
          </pre>
        ) : (
          <MathText key={i} text={seg.content} />
        )
      )}
    </>
  );
}
