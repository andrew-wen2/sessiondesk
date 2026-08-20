"use client";

import { useState } from "react";
import RichContent from "./RichContent";
import { hasMath } from "@/lib/format";
import type { Problem } from "@/lib/types";

export type { Problem };

function ProblemBlock({ problem, index }: { problem: Problem; index: number }) {
  const [showSolution, setShowSolution] = useState(false);
  // Open-ended content (e.g. a writing prompt) may have no short answer — hide the
  // Answer row entirely rather than showing an empty one.
  const hasAnswer = Boolean(problem.answer && problem.answer.trim());
  return (
    <div className="overflow-hidden rounded-card border border-hairline bg-surface">
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft font-mono text-xs font-semibold text-primary"
          aria-hidden
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="text-base leading-relaxed text-ink">
            <RichContent text={problem.problem} />
          </div>
          <button
            onClick={() => setShowSolution((v) => !v)}
            className="cursor-pointer text-sm font-medium text-primary underline-offset-2 transition-colors duration-150 hover:underline"
          >
            {showSolution ? "Hide solution" : "Show solution"}
          </button>
        </div>
      </div>

      {showSolution && (
        <div className="space-y-2 border-t border-hairline bg-sunken/50 px-4 py-3">
          {hasAnswer && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Answer
              </div>
              {/* Mono reads as a number/code answer — right for math, wrong for prose.
                  Detected from the answer itself, per problem: one set can hold both. */}
              <div className={`mt-0.5 text-ink ${hasMath(problem.answer) ? "font-mono" : ""}`}>
                <RichContent text={problem.answer} />
              </div>
            </div>
          )}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Solution
            </div>
            <div className="mt-0.5 text-sm leading-relaxed text-ink-soft">
              <RichContent text={problem.solution} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProblemSet({ problems }: { problems: Problem[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="space-y-3">
      {problems.map((p, i) => (
        <ProblemBlock key={i} problem={p} index={i} />
      ))}
    </div>
  );
}
