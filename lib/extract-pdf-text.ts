// Browser-side PDF handling for the Books "fill chapters from PDF" flow.
//
// Why client-side: textbooks run 50–100MB, over both our upload cap and Vercel's
// ~4.5MB serverless request-body limit. So instead of shipping the whole PDF to
// /api/books/[id]/parse-pdf, we extract here and send only what the server needs:
//   - normal (text-layer) PDFs → the extracted text (a few MB at most), which the
//     route feeds to Claude to pull chapters + sub-sections + per-section concepts.
//   - scanned/image PDFs (no text layer) → we can't read concepts, so we slice off
//     just the front matter (~25 pages) and upload that small PDF for the server's
//     vision path to read the table of contents.
//
// pdfjs-dist and pdf-lib are imported dynamically so they never evaluate during SSR
// (pdfjs touches browser-only globals); these functions only run in event handlers.

// Mirror the server's thresholds so both ends agree on what counts as "scanned".
const MIN_TEXT_CHARS = 200;
const FRONT_MATTER_PAGES = 25;
// Keep the posted text within Claude's context for a single full-book call.
const MAX_TEXT_CHARS = 700_000;

export type ExtractResult =
  | { kind: "text"; text: string; pages: number }
  | { kind: "scanned"; frontMatter: Blob; pages: number };

// Pull the embedded text layer out of a PDF, page by page. Returns "" for a
// scanned PDF (no text layer), which the caller treats as the vision case.
async function extractText(data: Uint8Array): Promise<{ text: string; pages: number }> {
  // Load pdfjs as a native browser module from /public — NOT bundled. webpack
  // corrupts pdfjs-dist's ESM build ("Object.defineProperty called on non-object"
  // at runtime), so webpackIgnore makes the browser fetch /pdf.min.mjs directly.
  // The specifier is a runtime /public URL with no on-disk module for TS to
  // resolve, so we suppress the resolution error and cast to pdfjs-dist's types.
  // @ts-expect-error - resolved at runtime from /public, not by the bundler
  const pdfjs = (await import(/* webpackIgnore: true */ "/pdf.min.mjs")) as typeof import("pdfjs-dist");
  // Load the worker from /public (copied there by scripts/copy-pdf-worker.mjs).
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const doc = await pdfjs.getDocument({ data }).promise;
  const parts: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      parts.push(
        content.items
          .map((it) => ("str" in it ? it.str : ""))
          .join(" ")
      );
      // Stop early once we've gathered enough — a full book's body is plenty for
      // concept extraction and we don't want to blow past the context budget.
      if (parts.join("\n").length > MAX_TEXT_CHARS) break;
    }
  } finally {
    await doc.destroy();
  }
  const text = parts.join("\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, MAX_TEXT_CHARS);
  return { text, pages: doc.numPages };
}

// Slice the first FRONT_MATTER_PAGES pages into a small standalone PDF for the
// server's vision OCR path (a scanned book's TOC always lives up front).
async function sliceFrontMatter(buf: ArrayBuffer): Promise<{ blob: Blob; pages: number }> {
  const { PDFDocument } = await import("pdf-lib");
  const src = await PDFDocument.load(buf);
  const n = Math.min(src.getPageCount(), FRONT_MATTER_PAGES);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, [...Array(n).keys()]);
  copied.forEach((p) => out.addPage(p));
  const bytes = await out.save();
  // Copy into a fresh ArrayBuffer so the Blob doesn't reference pdf-lib internals.
  return { blob: new Blob([bytes.slice()], { type: "application/pdf" }), pages: n };
}

// Decide which payload to send for a chosen PDF: extracted text when there's a
// real text layer, otherwise a small front-matter slice for vision OCR.
export async function prepareForParse(file: File): Promise<ExtractResult> {
  const buf = await file.arrayBuffer();
  // getDocument may detach the buffer it's handed, so give it a copy and keep buf
  // intact for the pdf-lib fallback below.
  const { text, pages } = await extractText(new Uint8Array(buf.slice(0)));
  if (text.length >= MIN_TEXT_CHARS) {
    return { kind: "text", text, pages };
  }
  const { blob, pages: frontPages } = await sliceFrontMatter(buf);
  return { kind: "scanned", frontMatter: blob, pages: frontPages };
}
