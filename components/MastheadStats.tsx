export default function MastheadStats({
  thisWeek,
  outstanding,
}: {
  thisWeek: number;
  outstanding: number;
}) {
  return (
    <div className="flex flex-wrap gap-6 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm">
      <div>
        <span className="text-gray-500">This week: </span>
        <span className="font-semibold">{thisWeek}</span>
        <span className="text-gray-500"> session{thisWeek === 1 ? "" : "s"}</span>
      </div>
      <div>
        <span className="text-gray-500">Outstanding: </span>
        <span className={outstanding > 0 ? "font-semibold text-orange-600" : "font-semibold text-green-600"}>
          ${outstanding}
        </span>
      </div>
    </div>
  );
}
