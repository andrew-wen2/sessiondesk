"use client";

import { useState } from "react";
import RichContent from "./RichContent";
import type { Problem } from "@/lib/types";

export type { Problem };

function ProblemBlock({
  problem,
  index,
  item,
  isMath,
}: {
  problem: Problem;
  index: number;
  item: string;
  isMath: boolean;
}) {
  const [showSolution, setShowSolution] = useState(false);
  // Open-ended content (e.g. a writing prompt) may have no short answer — hide the
  // Answer row entirely rather than showing an empty one.
  const hasAnswer = Boolean(problem.answer && problem.answer.trim());
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-sm font-semibold text-gray-500">{item} {index + 1}</div>
      <div className="text-base">
        <RichContent text={problem.problem} />
      </div>

      <button
        onClick={() => setShowSolution((v) => !v)}
        className="text-sm text-blue-600 hover:underline"
      >
        {showSolution ? "Hide solution" : "Show solution"}
      </button>

      {showSolution && (
        <div className="space-y-1 border-t border-gray-100 pt-2">
          {hasAnswer && (
            <>
              <div className="text-sm font-semibold text-gray-500">Answer</div>
              {/* Mono reads as a number/code answer — right for math, wrong for prose. */}
              <div className={isMath ? "font-mono" : ""}>
                <RichContent text={problem.answer} />
              </div>
            </>
          )}
          <div className="pt-2 text-sm font-semibold text-gray-500">Solution</div>
          <div className="text-sm text-gray-700">
            <RichContent text={problem.solution} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProblemSet({
  problems,
  item = "Problem",
  isMath = true,
}: {
  problems: Problem[];
  item?: string;
  isMath?: boolean;
}) {
  if (problems.length === 0) return null;
  return (
    <div className="space-y-3">
      {problems.map((p, i) => (
        <ProblemBlock key={i} problem={p} index={i} item={item} isMath={isMath} />
      ))}
    </div>
  );
}
