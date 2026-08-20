"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { toDateKey } from "@/lib/dates";
import { Input, Select } from "./ui/Field";
import { buttonClass } from "./ui/Button";
import { Check } from "./icons";

// Collapsed range picker. Replaces the old ledger filter bar, which put five preset
// buttons, two date inputs, a student picker and a checkbox on screen at once — the
// single most cluttered control in the app.
//
// One <select>; the From/To inputs appear only when you pick Custom. Which preset is
// selected is DERIVED by matching the current from/to against each preset rather than
// stored in a separate `range` param, so the URL contract stays exactly what it was
// (`?from=&to=` as YYYY-MM-DD) and there is still one parser, on the server.

export type RangeFilters = {
  from: string; // YYYY-MM-DD, "" = unbounded
  to: string;
  // Explicit "no date bounds at all". This can't be expressed by leaving from/to
  // empty, because that's also what a first visit looks like — and a first visit
  // means "last 90 days". The old ledger had exactly this collision, which is why
  // its "All" button silently showed 90 days like the button next to it.
  all: boolean;
  unpaid: boolean;
};

type Preset = { label: string; from: () => string; to: () => string; all?: boolean };

const key = (d: Date) => toDateKey(d);
const startOfMonth = (offset = 0) => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth() + offset, 1);
};

// Presets are computed in the BROWSER, so "this month" means the tutor's month, not
// the UTC server's. They write plain YYYY-MM-DD into the URL so it stays readable
// and hand-editable.
const PRESETS: Preset[] = [
  {
    label: "This month",
    from: () => key(startOfMonth()),
    to: () => key(new Date(startOfMonth(1).getTime() - 86_400_000)),
  },
  {
    label: "Last month",
    from: () => key(startOfMonth(-1)),
    to: () => key(new Date(startOfMonth().getTime() - 86_400_000)),
  },
  {
    label: "Last 90 days",
    from: () => {
      const n = new Date();
      return key(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 90));
    },
    to: () => "",
  },
  {
    label: "This year",
    from: () => key(new Date(new Date().getFullYear(), 0, 1)),
    to: () => "",
  },
  { label: "All time", from: () => "", to: () => "", all: true },
];

const CUSTOM = "Custom…";

export default function DateRangeSelect({ filters }: { filters: RangeFilters }) {
  const router = useRouter();
  const pathname = usePathname();

  // Which preset does the current URL correspond to? Runs in the browser, matching
  // how the presets were generated. Anything that matches none of them — including a
  // hand-edited URL — falls through to Custom with the inputs revealed.
  const matched = filters.all
    ? PRESETS.find((p) => p.all)
    : PRESETS.find((p) => !p.all && p.from() === filters.from && p.to() === filters.to);

  // "I picked Custom" is local state, not a URL param. Choosing Custom only reveals
  // the inputs — it must not navigate, or the rows would jump before you've typed a
  // range. Without this flag the select would snap straight back to whatever preset
  // the unchanged URL still matches.
  const [customOpen, setCustomOpen] = useState(false);
  const selected = customOpen ? CUSTOM : matched?.label ?? CUSTOM;

  function apply(next: Partial<RangeFilters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.all) {
      params.set("all", "1");
    } else {
      if (merged.from) params.set("from", merged.from);
      if (merged.to) params.set("to", merged.to);
    }
    if (merged.unpaid) params.set("unpaid", "1");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function pick(label: string) {
    if (label === CUSTOM) {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    const preset = PRESETS.find((p) => p.label === label);
    if (preset) apply({ from: preset.from(), to: preset.to(), all: preset.all ?? false });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={selected}
        onChange={(e) => pick(e.target.value)}
        size="sm"
        className="w-auto"
        aria-label="Date range"
      >
        {PRESETS.map((p) => (
          <option key={p.label} value={p.label}>
            {p.label}
          </option>
        ))}
        <option value={CUSTOM}>{CUSTOM}</option>
      </Select>

      {selected === CUSTOM && (
        <>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            From
            <Input
              type="date"
              value={filters.from}
              onChange={(e) => apply({ from: e.target.value, all: false })}
              size="sm"
              className="w-auto font-mono text-xs"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            To
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => apply({ to: e.target.value, all: false })}
              size="sm"
              className="w-auto font-mono text-xs"
            />
          </label>
        </>
      )}

      <button
        type="button"
        aria-pressed={filters.unpaid}
        onClick={() => apply({ unpaid: !filters.unpaid })}
        className={buttonClass({
          variant: "secondary",
          size: "sm",
          className: filters.unpaid
            ? "border-primary/40 bg-primary-soft text-primary hover:bg-primary-soft"
            : "",
        })}
      >
        {filters.unpaid ? <Check className="h-3.5 w-3.5" /> : null}
        Unpaid only
      </button>
    </div>
  );
}
