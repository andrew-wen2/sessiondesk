"use client";

export default function ProblemSlider({
  count,
  onChange,
  disabled,
}: {
  count: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="text-gray-600">Count</span>
      <input
        type="range"
        min={1}
        max={10}
        value={count}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-48"
      />
      <span className="w-6 font-mono text-gray-900">{count}</span>
    </label>
  );
}
