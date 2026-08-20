"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SaveIndicator, type SaveStatus } from "./SaveIndicator";

// Fixed extra width added to the measured text: the input's own horizontal padding
// (px-2 = 8px each side) + its border (1px each side, transparent) + a few px of
// caret breathing room so the cursor never sits flush against the glyph.
const EXTRA_PX = 8 * 2 + 1 * 2 + 6;
// Rough average glyph width for text-xl font-semibold, used only for the very first
// paint before the real measurement below has run — close enough that there's no
// visible pop once it corrects, rather than a collapsed or oversized box.
const ESTIMATE_PX_PER_CHAR = 12;

// Inline-editable student name styled as the page heading. Saves on blur; an
// empty name reverts to the last saved value (names are required).
export default function StudentNameEditor({
  id,
  initialName,
}: {
  id: string;
  initialName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(initialName);
  const [status, setStatus] = useState<SaveStatus>("idle");

  // A bare <input> defaults to size=20 (~20 characters) regardless of its content,
  // and the `size` ATTRIBUTE (not the same fix) estimates width from a generic
  // digit glyph — both over- or under-shoot at this font's actual size/weight ("Ayan"
  // came out clipped when sized that way). A hidden mirror rendered in the identical
  // font measures the TRUE width, so the input can shrink to fit the name exactly and
  // grow/shrink live as the tutor types, without guessing at a per-character constant.
  const measureRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(() => Math.max(name.length, 1) * ESTIMATE_PX_PER_CHAR + EXTRA_PX);
  useLayoutEffect(() => {
    if (measureRef.current) setWidth(measureRef.current.offsetWidth + EXTRA_PX);
  }, [name]);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(saved); // can't be empty
      setStatus("idle");
      return;
    }
    if (trimmed === saved) return;
    setStatus("saving");
    try {
      const res = await fetch(`/api/students/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error();
      setName(trimmed);
      setSaved(trimmed);
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
      // The name is on the students list, the calendar chips, the ledger and the
      // session pages — invalidate the Router Cache so none of them show the old one
      // after a back navigation. See the note in StudentDetail.
      router.refresh();
    } catch {
      setStatus("error");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {/* `relative` scopes the mirror's `absolute` to this wrapper rather than
          whatever positioned ancestor happens to be further up the page. */}
      <span className="relative inline-block">
        {/* Same font/size/weight as the real input, no border or background — exists
            only to measure. Positioned out of flow (not visibility:hidden, which
            would still occupy space) so it never affects layout or shows on screen. */}
        <span
          ref={measureRef}
          aria-hidden
          className="pointer-events-none invisible absolute left-0 top-0 whitespace-pre text-xl font-semibold tracking-tight"
        >
          {name || " "}
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          aria-label="Student name"
          style={{ width }}
          // Borderless until you approach it: a hover border and a hover tint are
          // what tell you the page heading is actually a field. The focus ring is
          // global. No `max-w-full`: with an inline-block parent whose own width is
          // itself shrink-to-fit around this input, max-width:100% resolved against
          // that not-yet-settled parent width and clamped the input ~16px (one
          // padding's worth) short of its explicit style width, clipping the last
          // character. The explicit `width` above is already exact — nothing here
          // should be capping it further.
          className="-mx-2 rounded-control border border-transparent bg-transparent px-2 py-1 text-xl font-semibold tracking-tight text-ink transition-colors duration-150 hover:border-hairline-strong hover:bg-surface"
        />
      </span>
      <SaveIndicator status={status} />
    </span>
  );
}
