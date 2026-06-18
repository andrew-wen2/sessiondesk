"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { prepareForParse } from "@/lib/extract-pdf-text";

// Add a book — primary path is uploading the book's PDF, which creates the book
// and auto-parses its chapters into contents. A title is optional (derived from
// the filename if blank); a title-only quick-add is still available for books
// whose chapters you'd rather paste by hand on the detail page.
export default function AddBookForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Drop ".pdf" and tidy separators so "Intro_to_NT.pdf" → "Intro to NT".
  function titleFromFilename(name: string) {
    return name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  }

  async function createBook(bookTitle: string): Promise<{ id: string }> {
    const res = await fetch("/api/books", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: bookTitle }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "" }));
      throw new Error(error || "Could not add book.");
    }
    return res.json();
  }

  // Title-only quick-add → jump to the detail page to fill chapters there.
  async function addByTitle() {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Enter a book title, or upload a PDF.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const book = await createBook(trimmed);
      router.push(`/books/${book.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add book — try again.");
      setSaving(false);
    }
  }

  // Upload-first add: create the book, then parse its PDF's chapters in one step.
  async function addByPdf(file: File) {
    setSaving(true);
    setError(null);
    try {
      const bookTitle = title.trim() || titleFromFilename(file.name) || "Untitled book";

      // Extract in the browser before creating anything — a parse failure here
      // (corrupt/locked PDF) shouldn't leave an empty book behind.
      const prepared = await prepareForParse(file);
      const book = await createBook(bookTitle);

      const res =
        prepared.kind === "text"
          ? await fetch(`/api/books/${book.id}/parse-pdf`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: prepared.text }),
            })
          : await (() => {
              const fd = new FormData();
              fd.append("file", prepared.frontMatter, "front-matter.pdf");
              return fetch(`/api/books/${book.id}/parse-pdf`, { method: "POST", body: fd });
            })();
      if (!res.ok) {
        // Book was created; chapters just didn't parse. Land on its detail page
        // so the upload can be retried or chapters pasted manually.
        const { error } = await res.json().catch(() => ({ error: "" }));
        router.push(`/books/${book.id}`);
        throw new Error(error || "Book added, but the PDF couldn't be parsed — try again on its page.");
      }
      router.push(`/books/${book.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add book — try again.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && addByTitle()}
        placeholder="Book title (optional if uploading a PDF)"
        className="rounded border border-gray-300 px-2 py-1.5 text-sm"
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) addByPdf(f);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={saving}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {saving ? "Working…" : "Upload book PDF"}
      </button>
      <button
        onClick={addByTitle}
        disabled={saving}
        className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-60"
      >
        Add by title
      </button>
      {error && <span className="w-full text-sm text-red-600">{error}</span>}
    </div>
  );
}
