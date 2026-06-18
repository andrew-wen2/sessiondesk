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
    return <p className="text-sm text-gray-500">{emptyText}</p>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {items.map((it, i) => {
        const date = new Date(it.start).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return (
          <li key={i} className="flex gap-2">
            <span className="shrink-0 font-mono text-xs text-gray-500">{date}</span>
            <span className="text-gray-800">— {it.topic}</span>
          </li>
        );
      })}
    </ul>
  );
}
