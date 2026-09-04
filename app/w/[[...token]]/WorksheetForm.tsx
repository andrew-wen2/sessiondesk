"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import RichContent from "@/components/RichContent";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import { Check, ArrowRight } from "@/components/icons";
import type { AnswerFormat } from "@/lib/generation/plan";
import type { PublicProblem } from "@/lib/worksheet";

// The student's whole surface. One problem at a time: type an answer, Check, get told
// right or wrong, and see the worked solution — then move on. Answers for a problem are
// not in this component's props until that problem is committed; they arrive in the
// check response and nowhere else.
//
// NOTE — this deliberately does NOT call router.refresh() after a write, against the
// CLAUDE.md convention. It writes on every attempt, and refreshing would re-render the
// server page, re-send the projection, and stomp in-flight card state ten to twenty times
// per worksheet. The check response is already authoritative. Do not "fix" this back.

type Reveal = { answer: string; solution: string };

type CardState = {
  value: string;
  attempts: string[];
  status: "idle" | "checking" | "wrong" | "resolved";
  verdict?: "correct" | "wrong";
  reveal?: Reveal;
  attemptsLeft: number;
  error?: string | null;
};

const FORMAT_HINT: Record<AnswerFormat, string> = {
  integer: "a whole number",
  numeric: "a number",
  expression: "an expression",
  "short-text": "a short answer",
  open: "your answer",
};

function initialState(item: PublicProblem): CardState {
  if (item.resolved) {
    return {
      value: item.attempts[item.attempts.length - 1] ?? "",
      attempts: item.attempts,
      status: "resolved",
      verdict: item.verdict,
      reveal: { answer: item.answer, solution: item.solution },
      attemptsLeft: 0,
    };
  }
  return {
    value: "",
    attempts: item.attempts,
    status: item.attempts.length ? "wrong" : "idle",
    attemptsLeft: item.attemptsLeft,
  };
}

export default function WorksheetForm({
  token,
  tutor,
  sessionDate,
  expiresOn,
  items,
  answerFormat,
  maxAttempts,
}: {
  token: string;
  tutor: string;
  sessionDate: string;
  expiresOn: string;
  items: PublicProblem[];
  answerFormat: AnswerFormat;
  maxAttempts: number;
}) {
  const [cards, setCards] = useState<CardState[]>(() =>
    items.map((i) => initialState(i))
  );
  const verdictRefs = useRef<(HTMLDivElement | null)[]>([]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);

  const done = cards.filter((c) => c.status === "resolved").length;
  const right = cards.filter((c) => c.verdict === "correct").length;
  const allDone = done === cards.length;

  // The reveal lands BELOW the input, and on a 375x667 phone with the keyboard up the
  // visible viewport is ~330px — so without this the student taps Check and, as far as
  // they can tell, nothing happens. Order matters:
  //   1. blur first. Scrolling while the keyboard is up makes iOS fight you via its own
  //      visualViewport adjustment.
  //   2. wait for the keyboard to finish retracting (~250ms animated), not one rAF (~16ms).
  //   3. wait for fonts, then scroll to the VERDICT — the answer to "did I get it" — which
  //      leaves the solution in the top two-thirds and the statement one swipe up.
  //   4. re-scroll once if KaTeX reflows: document.fonts.ready settles before KaTeX
  //      lazily pulls a per-glyph face (a tall \left( needs KaTeX_Size4), so the block
  //      can grow after the scroll has already run.
  const revealInto = useCallback((i: number) => {
    inputRefs.current[i]?.blur();

    const scroll = () =>
      verdictRefs.current[i]?.scrollIntoView({ block: "start", behavior: "smooth" });

    const afterKeyboard = () =>
      new Promise<void>((resolve) => {
        const vv = window.visualViewport;
        if (!vv) return void setTimeout(resolve, 300);
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          vv.removeEventListener("resize", finish);
          resolve();
        };
        vv.addEventListener("resize", finish);
        setTimeout(finish, 350); // fallback: no keyboard was up, or no resize fires
      });

    void afterKeyboard()
      .then(() => document.fonts?.ready ?? Promise.resolve())
      .then(() => {
        scroll();
        const el = verdictRefs.current[i];
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => scroll());
        ro.observe(el);
        setTimeout(() => ro.disconnect(), 800);
      });
  }, []);

  async function check(i: number) {
    const card = cards[i];
    const answer = card.value.trim();
    if (!answer || card.status === "checking" || card.status === "resolved") return;

    setCards((cs) => cs.map((c, n) => (n === i ? { ...c, status: "checking", error: null } : c)));

    try {
      const res = await fetch(`/api/w/${encodeURIComponent(token)}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: i, answer }),
      });
      const data = await res.json().catch(() => ({}));

      // 409 is reconciliation, not failure: another tab (or a retry that had actually
      // landed) already settled this one. Paint the settled state.
      if (!res.ok && res.status !== 409) {
        setCards((cs) =>
          cs.map((c, n) =>
            n === i
              ? {
                  ...c,
                  // attemptsLeft is SERVER state — never decremented locally, or a failed
                  // request that did land would leave the client and the server disagreeing
                  // about how many tries remain.
                  status: c.attempts.length ? "wrong" : "idle",
                  error:
                    typeof data?.error === "string"
                      ? data.error
                      : "Couldn't check that — check your connection and tap Check again.",
                }
              : c
          )
        );
        return;
      }

      const settled = Boolean(data.reveal);
      setCards((cs) =>
        cs.map((c, n) =>
          n === i
            ? {
                ...c,
                attempts: Array.isArray(data.attempts) ? data.attempts : c.attempts,
                verdict: data.verdict,
                reveal: data.reveal ?? undefined,
                attemptsLeft: typeof data.attemptsLeft === "number" ? data.attemptsLeft : 0,
                status: settled ? "resolved" : "wrong",
                error: null,
              }
            : c
        )
      );
      if (settled) revealInto(i);
    } catch {
      // The answer stays on screen. A student who has to retype ten answers does not
      // submit an eleventh time.
      setCards((cs) =>
        cs.map((c, n) =>
          n === i
            ? {
                ...c,
                status: c.attempts.length ? "wrong" : "idle",
                error: "Couldn't check that — check your connection and tap Check again.",
              }
            : c
        )
      );
    }
  }

  function goNext(from: number) {
    const next = cards.findIndex((c, n) => n > from && c.status !== "resolved");
    const target = next === -1 ? cards.length - 1 : next;
    cardRefs.current[target]?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (next !== -1) inputRefs.current[target]?.focus();
  }

  const hint = useMemo(() => FORMAT_HINT[answerFormat] ?? "your answer", [answerFormat]);

  return (
    <>
      {/* Sticky TOP, never a fixed bottom bar — a fixed bottom bar and the iOS keyboard
          fight each other. With no submit button this count is the student's only
          completion signal, which makes it more load-bearing than it was, not less. */}
      <div className="sticky top-0 z-10 -mx-4 mb-6 border-b border-hairline bg-canvas/90 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-ink">Practice set</span>
          <span className="font-mono text-xs tabular-nums text-muted">
            {done} of {cards.length} · {right} right
          </span>
        </div>
      </div>

      <header className="mb-8 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          From {tutor} · for your {sessionDate} session
        </h1>
        <p className="text-sm text-muted">
          {cards.length} problems. Answer one, check it, and I&apos;ll show you how it&apos;s done.
          You get {maxAttempts} tries each.
        </p>
        <p className="text-sm text-muted">
          Your work saves as you go — you can close this and come back. This link works until{" "}
          {expiresOn}.
        </p>
      </header>

      <div className="space-y-4">
        {items.map((item, i) => {
          const c = cards[i];
          const resolved = c.status === "resolved";
          return (
            <section
              key={item.index}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              className="scroll-mt-16 rounded-card border border-hairline bg-surface shadow-card"
            >
              <div className="space-y-3 p-4 sm:p-5">
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                      resolved ? "bg-sunken text-muted" : "bg-primary-soft text-primary"
                    }`}
                  >
                    {i + 1}
                  </span>
                  {resolved &&
                    (c.verdict === "correct" ? (
                      <Badge tone="good">Correct</Badge>
                    ) : (
                      <Badge tone="warn">Answer shown</Badge>
                    ))}
                </div>

                {/* Both the statement and the reveal need this: MathText gives BlockMath
                    its own overflow wrapper but leaves InlineMath bare (deliberately, so
                    inline math flows with prose everywhere else), and a long inline
                    expression otherwise blows out the page at 375px. */}
                <div className="overflow-x-auto break-words text-base leading-relaxed text-ink">
                  <RichContent text={item.statement} />
                </div>

                {!resolved && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void check(i);
                    }}
                    className="space-y-1.5"
                  >
                    <div className="flex items-end gap-2">
                      <div className="space-y-1.5">
                        <label
                          htmlFor={`answer-${i}`}
                          className="block text-sm font-medium text-ink"
                        >
                          Answer
                        </label>
                        <input
                          id={`answer-${i}`}
                          ref={(el) => {
                            inputRefs.current[i] = el;
                          }}
                          value={c.value}
                          onChange={(e) =>
                            setCards((cs) =>
                              cs.map((x, n) => (n === i ? { ...x, value: e.target.value } : x))
                            )
                          }
                          disabled={c.status === "checking"}
                          // text + inputMode, never type="number": that strips leading
                          // zeros (an AIME "007"), shows spinners, and reads back empty
                          // in some intermediate states.
                          type="text"
                          inputMode={answerFormat === "integer" ? "numeric" : "text"}
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          className="h-11 w-28 rounded-control border border-hairline-strong bg-surface px-3 text-center font-mono text-base text-ink transition-colors duration-150 hover:border-muted/60 disabled:cursor-not-allowed disabled:bg-sunken"
                        />
                      </div>
                      <Button type="submit" size="lg" loading={c.status === "checking"}>
                        Check
                      </Button>
                    </div>

                    {c.error ? (
                      <p role="status" aria-live="polite" className="text-xs text-danger">
                        {c.error}
                      </p>
                    ) : c.status === "wrong" ? (
                      // warn, never danger: danger is the delete-a-student colour, and a
                      // near-miss is not a destructive act.
                      <p role="status" aria-live="polite" className="text-xs text-warn">
                        Not quite{" "}
                        {c.attempts.length > 0 && (
                          <span className="font-mono text-muted line-through">
                            {c.attempts[c.attempts.length - 1]}
                          </span>
                        )}{" "}
                        — one more try, then I&apos;ll show you how it&apos;s done.
                      </p>
                    ) : (
                      <p className="text-xs text-muted">{hint}</p>
                    )}
                  </form>
                )}
              </div>

              {resolved && c.reveal && (
                <div
                  ref={(el) => {
                    verdictRefs.current[i] = el;
                  }}
                  className="scroll-mt-16 space-y-2 border-t border-hairline bg-sunken/50 px-4 py-3 sm:px-5"
                >
                  <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    {c.verdict === "correct" && <Check className="h-4 w-4 text-good" />}
                    Answer: <span className="font-mono">{c.reveal.answer}</span>
                  </p>
                  <div className="overflow-x-auto break-words text-sm leading-relaxed text-ink-soft">
                    <RichContent text={c.reveal.solution} />
                  </div>
                  {!allDone && (
                    <Button variant="secondary" size="sm" onClick={() => goNext(i)}>
                      Next problem
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* With no submit button there is otherwise no ending, and committing answers into
          a page with no account and no confirmation reads as shouting into a void. The
          second line is the return path made visible. */}
      {allDone && (
        <section className="mt-6 rounded-card bg-primary-soft px-5 py-4 text-center">
          <p className="text-sm font-semibold text-ink">
            Done — {cards.length} of {cards.length} · {right} right
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {tutor} will see this before your {sessionDate} session.
          </p>
        </section>
      )}
    </>
  );
}
