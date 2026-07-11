// In-flight problem generation, tracked outside React so it survives navigation.
//
// The /api/generate POST already runs to completion server-side and persists
// problems onto the session regardless of the client. The only thing lost when
// you navigate away mid-generation is the *client's* view of it: the component
// unmounts, its local "generating" state and the pending fetch's setState are
// gone. We keep that state here, in a module-level singleton.
//
// Next App Router navigations (<Link>) are client-side — the JS runtime stays
// alive — so this store, and the fetch it owns, persist while you visit another
// page and return. The remounted SessionDetail re-subscribes by sessionId and
// picks the generation back up: still "Generating…" if in flight, or the result
// if it finished while you were away. (A full page reload clears the store, but
// the result is still safe in the DB and renders from the server on next load.)

import { useSyncExternalStore } from "react";
import type { Problem, Lesson } from "./types";

export type GenStatus = "idle" | "generating" | "error";

export type GenState = {
  status: GenStatus;
  problems: Problem[] | null; // most recent successful result for this session
  error: string | null;
};

type Entry = {
  state: GenState;
  listeners: Set<() => void>;
};

// Stable reference for the "nothing happening yet" snapshot — useSyncExternalStore
// compares snapshots by identity, so this must not be reallocated per read.
const EMPTY: GenState = { status: "idle", problems: null, error: null };

const store = new Map<string, Entry>();

function entryFor(sessionId: string): Entry {
  let e = store.get(sessionId);
  if (!e) {
    e = { state: EMPTY, listeners: new Set() };
    store.set(sessionId, e);
  }
  return e;
}

function setState(e: Entry, next: GenState) {
  e.state = next; // new object → identity changes → subscribers re-render
  for (const listener of e.listeners) listener();
}

export type GenerateBody = {
  studentId: string;
  sessionId: string;
  topic: string;
};

// Kick off a generation. No-op if one is already running for this session.
export function startGeneration(body: GenerateBody) {
  const e = entryFor(body.sessionId);
  if (e.state.status === "generating") return;

  setState(e, { status: "generating", problems: e.state.problems, error: null });

  fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(async (res) => {
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        throw new Error(error || "Generation failed — check topic and try again.");
      }
      return (await res.json()) as Problem[];
    })
    .then((problems) => {
      setState(e, { status: "idle", problems, error: null });
    })
    .catch((err) => {
      setState(e, {
        status: "error",
        problems: e.state.problems,
        error: err instanceof Error ? err.message : "Generation failed — try again.",
      });
    });
}

function getSnapshot(sessionId: string): GenState {
  return store.get(sessionId)?.state ?? EMPTY;
}

function subscribe(sessionId: string, listener: () => void): () => void {
  const e = entryFor(sessionId);
  e.listeners.add(listener);
  return () => {
    e.listeners.delete(listener);
  };
}

// React hook: subscribe a component to this session's generation state.
export function useGeneration(sessionId: string): GenState {
  return useSyncExternalStore(
    (cb) => subscribe(sessionId, cb),
    () => getSnapshot(sessionId),
    () => EMPTY // server render: nothing in flight
  );
}

// --- Lesson generation ------------------------------------------------------
// Same survives-navigation pattern as problems, in a separate keyspace so a
// lesson and a problem generation can be in flight for the same session at once.

export type LessonGenState = {
  status: GenStatus;
  lesson: Lesson | null;
  error: string | null;
};

type LessonEntry = { state: LessonGenState; listeners: Set<() => void> };

const LESSON_EMPTY: LessonGenState = { status: "idle", lesson: null, error: null };
const lessonStore = new Map<string, LessonEntry>();

function lessonEntryFor(sessionId: string): LessonEntry {
  let e = lessonStore.get(sessionId);
  if (!e) {
    e = { state: LESSON_EMPTY, listeners: new Set() };
    lessonStore.set(sessionId, e);
  }
  return e;
}

function setLessonState(e: LessonEntry, next: LessonGenState) {
  e.state = next;
  for (const listener of e.listeners) listener();
}

// Kick off a lesson generation. No-op if one is already running for this session.
export function startLessonGeneration(body: GenerateBody) {
  const e = lessonEntryFor(body.sessionId);
  if (e.state.status === "generating") return;

  setLessonState(e, { status: "generating", lesson: e.state.lesson, error: null });

  fetch("/api/generate-lesson", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(async (res) => {
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        throw new Error(error || "Lesson generation failed — try again.");
      }
      return (await res.json()) as Lesson;
    })
    .then((lesson) => setLessonState(e, { status: "idle", lesson, error: null }))
    .catch((err) =>
      setLessonState(e, {
        status: "error",
        lesson: e.state.lesson,
        error: err instanceof Error ? err.message : "Lesson generation failed — try again.",
      })
    );
}

export function useLessonGeneration(sessionId: string): LessonGenState {
  return useSyncExternalStore(
    (cb) => {
      const e = lessonEntryFor(sessionId);
      e.listeners.add(cb);
      return () => {
        e.listeners.delete(cb);
      };
    },
    () => lessonStore.get(sessionId)?.state ?? LESSON_EMPTY,
    () => LESSON_EMPTY
  );
}
