"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { prepareForParse } from "@/lib/extract-pdf-text";
import { toDisplayChapters, type DisplayChapter } from "@/lib/book-chapters";
import { SaveIndicator, type SaveStatus } from "./SaveIndicator";

export type BookDetailData = {
  id: string;
  title: string;
  author: string;
  chapters: DisplayChapter[];
};

export default function BookDetail({ book }: { book: BookDetailData }) {
  const router = useRouter();

  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const [chapters, setChapters] = useState<DisplayChapter[]>(book.chapters);
  const [saved, setSaved] = useState({ title: book.title, author: book.author });
  const [status, setStatus] = useState<SaveStatus>("idle");

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  async function saveField(field: "title" | "author", value: string) {
    if (field === "title" && !value.trim()) {
      setTitle(saved.title); // title is required
      setStatus("idle");
      return;
    }
    if (value === saved[field]) return;
    setStatus("saving");
    try {
      const res = await fetch(`/api/books/${book.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error();
      setSaved((s) => ({ ...s, [field]: value }));
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch {
      setStatus("error");
    }
  }

  // Upload a PDF → extract in the browser (text layer for normal PDFs, a small
  // front-matter slice for scanned ones), post to the server, refresh the table.
  // Section/concept detail is stored server-side but not shown here.
  async function parsePdf(file: File) {
    setParseError(null);
    setParsing(true);
    try {
      const prepared = await prepareForParse(file);
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
        const { error } = await res.json().catch(() => ({ error: "" }));
        throw new Error(error || "Couldn't parse that PDF.");
      }
      const { chapters: parsed } = await res.json();
      setChapters(toDisplayChapters(parsed));
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch (e) {
      setParseError(
        e instanceof Error ? e.message : "Couldn't parse that PDF — try again."
      );
    } finally {
      setParsing(false);
    }
  }

  async function deleteBook() {
    setDeleteError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/books/${book.id}`, { method: "DELETE" });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        throw new Error(error || "Delete failed.");
      }
      router.push("/books");
      router.refresh();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed — try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        <SaveIndicator status={status} />
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-500">Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => saveField("title", title)}
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-500">Author</label>
        <input
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          onBlur={() => saveField("author", author)}
          placeholder="Optional"
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="block text-sm font-semibold text-gray-500">Chapter contents</label>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) parsePdf(f);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={parsing}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-60"
          >
            {parsing ? "Parsing PDF…" : "Upload PDF to fill chapters"}
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Uploading a PDF extracts the chapter list (and the section detail behind it,
          used by the generator). Only chapter titles are shown here.
        </p>
        {parseError && <p className="mt-1 text-sm text-red-600">{parseError}</p>}

        {chapters.length > 0 ? (
          <table className="mt-2 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                <th className="w-12 py-1.5 pr-3">#</th>
                <th className="py-1.5 pr-2">Chapter</th>
              </tr>
            </thead>
            <tbody>
              {chapters.map((c, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="py-1.5 pr-3 text-gray-500">{c.number || i + 1}</td>
                  <td className="py-1.5 pr-2">{c.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-sm text-gray-400">
            No chapters yet — upload a PDF to extract them.
          </p>
        )}
      </div>

      <div className="border-t border-gray-100 pt-4">
        {!confirmingDelete ? (
          <button
            onClick={() => {
              setDeleteError(null);
              setConfirmingDelete(true);
            }}
            className="text-sm text-red-600 hover:underline"
          >
            Delete book
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-700">
              Delete this book? Linked sessions keep their history.
            </span>
            <button
              onClick={deleteBook}
              disabled={deleting}
              className="rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700 disabled:opacity-60"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        )}
        {deleteError && <p className="mt-2 text-sm text-red-600">{deleteError}</p>}
      </div>
    </div>
  );
}
