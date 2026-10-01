// The problem statements a student worked in recent sessions, for the cascade's
// cross-session repetition guard (the writer is told not to reuse them, and keep-time
// dedup checks against them). `Session.problems` is Json, so read it defensively: a
// malformed or legacy value contributes nothing rather than failing generation.
export const RECENT_SESSIONS = 3;
export const MAX_RECENT_PROBLEMS = 30;

export function recentProblemStatements(rows: { problems: unknown }[]): string[] {
  const out: string[] = [];
  for (const row of rows.slice(0, RECENT_SESSIONS)) {
    if (!Array.isArray(row.problems)) continue;
    for (const p of row.problems) {
      const s = p && typeof p === "object" ? (p as { problem?: unknown }).problem : undefined;
      if (typeof s === "string" && s.trim()) out.push(s.trim());
      if (out.length >= MAX_RECENT_PROBLEMS) return out;
    }
  }
  return out;
}

// What recent sets' generation provenance says they practiced: the corpus-taxonomy type
// ids their slots used, and each kept problem's statement paired with its one-line
// method (cascade items are stored in the same order as the set's problems). Read
// defensively from genMeta (a Json column): anything malformed, or pre-dating these
// fields, contributes nothing. Same window as the statements.
export type RecentMemory = { typeIds: string[]; methods: { problem: string; method: string }[]; seedIds?: string[] };
export function recentGenerationMemory(rows: { problems: unknown; genMeta: unknown }[]): RecentMemory {
  const typeIds = new Set<string>();
  const methods: RecentMemory["methods"] = [];
  const seedIds = new Set<string>();
  for (const row of rows.slice(0, RECENT_SESSIONS)) {
    const cascade = (row.genMeta as { problems?: { cascade?: { typeIds?: unknown; items?: unknown } } } | null)?.problems?.cascade;
    if (!cascade || typeof cascade !== "object") continue;
    if (Array.isArray(cascade.typeIds)) for (const id of cascade.typeIds) if (typeof id === "string") typeIds.add(id);
    // Seed ids don't depend on the items lining up with the stored problems.
    if (Array.isArray(cascade.items)) {
      for (const it of cascade.items) {
        const id = it && typeof it === "object" ? (it as { seedId?: unknown }).seedId : undefined;
        if (typeof id === "string") seedIds.add(id);
      }
    }
    if (!Array.isArray(cascade.items) || !Array.isArray(row.problems) || cascade.items.length !== row.problems.length) continue;
    cascade.items.forEach((it, i) => {
      const m = it && typeof it === "object" ? (it as { method?: unknown }).method : undefined;
      const p = (row.problems as unknown[])[i];
      const statement = p && typeof p === "object" ? (p as { problem?: unknown }).problem : undefined;
      if (typeof m === "string" && m.trim() && typeof statement === "string" && methods.length < MAX_RECENT_PROBLEMS) {
        methods.push({ problem: statement, method: m.trim() });
      }
    });
  }
  return { typeIds: [...typeIds], methods, seedIds: [...seedIds] };
}
