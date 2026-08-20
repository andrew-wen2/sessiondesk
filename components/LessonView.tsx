"use client";

import { useState } from "react";
import RichContent from "./RichContent";
import { hasMath } from "@/lib/format";
import type { Lesson } from "@/lib/types";

// Renders a generated lesson: title, objectives, explanation sections, worked
// examples (each reveal-able), and a practice block. All prose runs through
// RichContent so math ($...$) and code (```fences```) render per subject.
function Reveal({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer text-sm font-medium text-primary underline-offset-2 transition-colors duration-150 hover:underline"
      >
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

export default function LessonView({ lesson }: { lesson: Lesson }) {
  return (
    <div className="space-y-4">
      {lesson.title && (
        <h3 className="text-lg font-semibold tracking-tight text-ink">{lesson.title}</h3>
      )}

      {lesson.objectives.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Objectives</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-soft">
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
          {s.heading && <div className="text-sm font-semibold text-ink">{s.heading}</div>}
          <div className="mt-1 text-sm leading-relaxed text-ink-soft">
            <RichContent text={s.content} />
          </div>
        </div>
      ))}

      {lesson.workedExamples.length > 0 && (
        <div className="space-y-3 border-t border-hairline pt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Worked examples
          </div>
          {lesson.workedExamples.map((ex, i) => (
            <div key={i} className="space-y-1">
              <div className="text-sm">
                <RichContent text={ex.problem} />
              </div>
              <Reveal label="solution">
                <div className="rounded-control bg-sunken px-3 py-2 text-sm leading-relaxed text-ink-soft">
                  <RichContent text={ex.solution} />
                </div>
              </Reveal>
            </div>
          ))}
        </div>
      )}

      {lesson.practice.length > 0 && (
        <div className="space-y-3 border-t border-hairline pt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Practice</div>
          {lesson.practice.map((p, i) => {
            const hasAnswer = Boolean(p.answer && p.answer.trim());
            return (
              <div key={i} className="space-y-1">
                <div className="text-sm">
                  <span className="font-mono font-semibold text-muted">{i + 1}. </span>
                  <RichContent text={p.problem} />
                </div>
                <Reveal label="solution">
                  <div className="space-y-1">
                    {hasAnswer && (
                      <div className={`text-sm ${hasMath(p.answer) ? "font-mono" : ""}`}>
                        <span className="font-semibold text-muted">Answer: </span>
                        <RichContent text={p.answer} />
                      </div>
                    )}
                    <div className="text-sm leading-relaxed text-ink-soft">
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
