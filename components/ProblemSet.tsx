"use client";

import { useState } from "react";
import MathText from "./MathText";
import type { Problem } from "@/lib/types";

export type { Problem };

function ProblemBlock({ problem, index }: { problem: Problem; index: number }) {
  const [showSolution, setShowSolution] = useState(false);
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-sm font-semibold text-gray-500">Problem {index + 1}</div>
      <div className="text-base">
        <MathText text={problem.problem} />
      </div>

      <button
        onClick={() => setShowSolution((v) => !v)}
        className="text-sm text-blue-600 hover:underline"
      >
        {showSolution ? "Hide solution" : "Show solution"}
      </button>

      {showSolution && (
        <div className="space-y-1 border-t border-gray-100 pt-2">
          <div className="text-sm font-semibold text-gray-500">Answer</div>
          <div className="font-mono">
            <MathText text={problem.answer} />
          </div>
          <div className="pt-2 text-sm font-semibold text-gray-500">Solution</div>
          <div className="text-sm text-gray-700">
            <MathText text={problem.solution} />
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
