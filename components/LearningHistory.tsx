// Derived learning history — a timeline of covered topics. Not stored; the
// caller queries sessions where topic != "" ordered by start desc.

export type HistoryItem = { start: string; topic: string };

export default function LearningHistory({
  items,
  emptyText = "No topics covered yet.",
}: {
  items: HistoryItem[];
  emptyText?: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted">{emptyText}</p>;
  }
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((it, i) => {
        const date = new Date(it.start).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return (
          <li key={i} className="flex gap-2.5">
            <span className="w-[5.5rem] shrink-0 font-mono text-xs leading-5 text-muted">
              {date}
            </span>
            <span className="min-w-0 text-ink-soft">{it.topic}</span>
          </li>
        );
      })}
    </ul>
  );
}
