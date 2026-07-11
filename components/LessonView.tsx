"use client";

import { useState } from "react";
import RichContent from "./RichContent";
import type { Lesson } from "@/lib/types";

// Renders a generated lesson: title, objectives, explanation sections, worked
// examples (each reveal-able), and a practice block. All prose runs through
// RichContent so math ($...$) and code (```fences```) render per subject.
function Reveal({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="text-sm text-blue-600 hover:underline">
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

export default function LessonView({ lesson, isMath = true }: { lesson: Lesson; isMath?: boolean }) {
  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      {lesson.title && <h3 className="text-lg font-semibold">{lesson.title}</h3>}

      {lesson.objectives.length > 0 && (
        <div>
          <div className="text-sm font-semibold text-gray-500">Objectives</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-gray-700">
            {lesson.objectives.map((o, i) => (
              <li key={i}>
                <RichContent text={o} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {lesson.sections.map((s, i) => (
        <div key={i}>
          {s.heading && <div className="text-sm font-semibold text-gray-700">{s.heading}</div>}
          <div className="mt-1 text-sm text-gray-700">
            <RichContent text={s.content} />
          </div>
        </div>
      ))}

      {lesson.workedExamples.length > 0 && (
        <div className="space-y-3 border-t border-gray-100 pt-3">
          <div className="text-sm font-semibold text-gray-500">Worked examples</div>
          {lesson.workedExamples.map((ex, i) => (
            <div key={i} className="space-y-1">
              <div className="text-sm">
                <RichContent text={ex.problem} />
              </div>
              <Reveal label="solution">
                <div className="text-sm text-gray-700">
                  <RichContent text={ex.solution} />
                </div>
              </Reveal>
            </div>
          ))}
        </div>
      )}

      {lesson.practice.length > 0 && (
        <div className="space-y-3 border-t border-gray-100 pt-3">
          <div className="text-sm font-semibold text-gray-500">Practice</div>
          {lesson.practice.map((p, i) => {
            const hasAnswer = Boolean(p.answer && p.answer.trim());
            return (
              <div key={i} className="space-y-1">
                <div className="text-sm">
                  <span className="font-semibold text-gray-500">{i + 1}. </span>
                  <RichContent text={p.problem} />
                </div>
                <Reveal label="solution">
                  <div className="space-y-1">
                    {hasAnswer && (
                      <div className={`text-sm ${isMath ? "font-mono" : ""}`}>
                        <span className="font-semibold text-gray-500">Answer: </span>
                        <RichContent text={p.answer} />
                      </div>
                    )}
                    <div className="text-sm text-gray-700">
                      <RichContent text={p.solution} />
                    </div>
                  </div>
                </Reveal>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
