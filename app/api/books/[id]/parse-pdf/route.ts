import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { PDFParse } from "pdf-parse";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// POST /api/books/[id]/parse-pdf — server-only. Fills book.contents with a clean,
// section-level chapter outline (chapter → sub-sections → key concepts).
//
// The heavy lifting of getting a 50–100MB textbook past the request-size limit
// happens in the browser (lib/extract-pdf-text.ts): the client extracts the text
// layer and posts only that. So this route has two entry shapes:
//
//   1. JSON  { text }          — full book text from the client. Claude reads the
//      table of contents for structure AND the chapter bodies for the concepts
//      each section teaches. This is the primary, richest path.
//   2. multipart  file=<pdf>   — a small PDF (a scanned book's front matter, or a
//      hand-uploaded small file). We try its text layer; if there's none it's
//      scanned, and we fall back to Claude's PDF vision to read the TOC. Vision
//      sees only the front matter, so it yields structure but no body concepts.
//
// Structured output via a forced emit_chapters tool (same pattern as /api/generate)
// — we read tool_use.input, never parse prose. ANTHROPIC_API_KEY is server env.

// A full-book concept pass is a large, slow Claude call. (Vercel: needs a plan
// whose function limit allows this; Hobby caps at 60s.)
export const maxDuration = 300;

const MAX_BYTES = 25 * 1024 * 1024; // upload cap for the multipart (scanned) path
const MAX_TEXT_CHARS = 700_000; // full-book text fits Claude's context for one call
// Below this many chars we treat an uploaded PDF as scanned (no real text layer)
// and fall back to vision OCR rather than erroring.
const MIN_TEXT_CHARS = 200;

const CHAPTERS_TOOL: Anthropic.Tool = {
  name: "emit_chapters",
  description:
    "Return the book's chapter outline: each chapter, its sub-sections, and the key concepts each section teaches.",
  input_schema: {
    type: "object",
    properties: {
      chapters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            number: {
              type: "string",
              description: "Chapter number or label, e.g. '1', '7', 'A'. Empty string if it has none.",
            },
            title: { type: "string", description: "Chapter title" },
            sections: {
              type: "array",
              description:
                "The chapter's sub-sections, in order. Empty array if the chapter isn't subdivided.",
              items: {
                type: "object",
                properties: {
                  number: {
                    type: "string",
                    description: "Sub-section number, e.g. '3.1', '3.2'. Empty string if unnumbered.",
                  },
                  title: { type: "string", description: "Sub-section title" },
                  concepts: {
                    type: "string",
                    description:
                      "Key concepts this section teaches — definitions, theorems, techniques — comma-separated. Empty string if the source doesn't show the body (e.g. table-of-contents only).",
                  },
                },
                required: ["number", "title", "concepts"],
              },
            },
          },
          required: ["number", "title", "sections"],
        },
      },
    },
    required: ["chapters"],
  },
};

type Section = { number: string; title: string; concepts: string };
type Chapter = { number: string; title: string; sections: Section[] };

// Render the nested outline into the indented text the contents textarea shows and
// the generator reads:
//   Ch 3: Number Theory
//     3.1 Divisibility — gcd, division algorithm, Bezout
//     3.2 Primes — sieve, fundamental theorem of arithmetic
function formatChapters(chapters: Chapter[]): string {
  return chapters
    .map((c) => {
      const head = c.number ? `Ch ${c.number}: ${c.title}` : c.title;
      const lines = [head];
      for (const s of c.sections) {
        const sh = s.number ? `  ${s.number} ${s.title}` : `  ${s.title}`;
        lines.push(s.concepts ? `${sh} — ${s.concepts}` : sh);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

// A clean error the route can return to the UI without leaking internals.
class ParseError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

const NO_TOC_ERROR =
  "Couldn't find a chapter list in that PDF — paste the contents manually.";

function normalizeSections(raw: unknown): Section[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is { number?: unknown; title: string; concepts?: unknown } =>
        !!s && typeof (s as { title?: unknown }).title === "string"
    )
    .map((s) => ({
      number: typeof s.number === "string" ? s.number.trim() : "",
      title: (s.title as string).trim(),
      concepts: typeof s.concepts === "string" ? s.concepts.trim() : "",
    }))
    .filter((s) => s.title);
}

// Shared tail for every path: read the forced tool_use, validate it, render the
// contents string. Throws ParseError on anything unusable. Typed structurally so
// it accepts both a stable Message and a beta (PDF) BetaMessage.
function chaptersFromMessage(message: {
  stop_reason: string | null;
  content: ReadonlyArray<{ type: string; input?: unknown }>;
}): Chapter[] {
  if (message.stop_reason === "max_tokens") {
    throw new ParseError("The chapter list was too long to parse — paste it manually.");
  }
  const toolUse = message.content.find((b) => b.type === "tool_use");
  const raw = (toolUse?.input as { chapters?: unknown } | undefined)?.chapters;
  if (!toolUse || !Array.isArray(raw)) {
    throw new ParseError(NO_TOC_ERROR);
  }

  const clean: Chapter[] = raw
    .filter(
      (c): c is { number?: unknown; title: string; sections?: unknown } =>
        !!c && typeof (c as { title?: unknown }).title === "string"
    )
    .map((c) => ({
      number: typeof c.number === "string" ? c.number.trim() : "",
      title: (c.title as string).trim(),
      sections: normalizeSections(c.sections),
    }))
    .filter((c) => c.title);

  if (clean.length === 0) {
    throw new ParseError(NO_TOC_ERROR);
  }
  return clean;
}

function generationModel(): string {
  return process.env.GENERATION_MODEL ?? "claude-opus-4-8";
}

// pdf-parse emits a "-- N of M --" marker per page even for scanned PDFs with no
// real text layer. Left in, those markers inflate the text length past
// MIN_TEXT_CHARS and a scanned book wrongly takes the text path instead of vision.
// Strip them (and the blank lines they leave) so "scanned" is detected correctly.
function stripPdfParseArtifacts(text: string): string {
  return text
    .replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Primary path: Claude reads the full book text — TOC for structure, bodies for
// the concepts each section teaches.
//
// A full book's section-level concept dump is a large output (it overran 8K on a
// ~300-page book), so we stream and allow a high max_tokens. Streaming is required
// at this output size — a non-streaming request would hit the SDK's HTTP timeout.
async function chaptersFromText(client: Anthropic, text: string): Promise<Chapter[]> {
  const snippet = text.slice(0, MAX_TEXT_CHARS);
  const stream = client.messages.stream({
    model: generationModel(),
    max_tokens: 32000,
    tools: [CHAPTERS_TOOL],
    tool_choice: { type: "tool", name: "emit_chapters" },
    messages: [
      {
        role: "user",
        content:
          "Below is the full text of a math/physics book. Build its chapter outline.\n" +
          "For each chapter: its number and title.\n" +
          "For each chapter, list its sub-sections in order (numbered like 1.1, 1.2 when the book numbers them), " +
          "and for each sub-section give the key concepts it teaches — important definitions, theorems, formulas, and techniques — " +
          "read from that section's body, comma-separated and specific.\n" +
          "Use only what the text supports — do not invent chapters, sections, or concepts. Order by chapter then section number.\n\n---\n" +
          snippet,
      },
    ],
  });
  return chaptersFromMessage(await stream.finalMessage());
}

// Fallback path: a scanned PDF's front matter — Claude's PDF vision reads the
// table of contents off the rendered pages. Only structure is available (no body),
// so concepts come back empty.
async function chaptersFromVision(client: Anthropic, buf: Buffer): Promise<Chapter[]> {
  const data = buf.toString("base64");
  // PDF document blocks live in the beta Messages API in this SDK version, gated
  // by the pdfs-2024-09-25 beta header. Claude renders each page to an image.
  const message = await client.beta.messages.create({
    betas: ["pdfs-2024-09-25"],
    model: generationModel(),
    max_tokens: 8192,
    tools: [CHAPTERS_TOOL as Anthropic.Beta.Messages.BetaTool],
    tool_choice: { type: "tool", name: "emit_chapters" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data },
          },
          {
            type: "text",
            text:
              "These are the opening pages of a scanned math/physics book. Find the table of contents and " +
              "extract its outline: each chapter's number and title, and its sub-sections (number + title) in order. " +
              "The chapter bodies are not included, so leave each section's concepts empty unless the contents page states them. " +
              "Use only what the pages show — do not invent chapters or sections. Order by chapter then section number.",
          },
        ],
      },
    ],
  });
  return chaptersFromMessage(message);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "PDF parsing is not configured — set ANTHROPIC_API_KEY." },
        { status: 500 }
      );
    }

    const book = await prisma.book.findUnique({ where: { id }, select: { id: true } });
    if (!book) {
      return NextResponse.json({ error: "Book not found." }, { status: 404 });
    }

    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const contentType = request.headers.get("content-type") ?? "";

    let chapters: Chapter[];
    if (contentType.includes("application/json")) {
      // Primary path: the client extracted the text layer and posted it.
      const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (text.length < MIN_TEXT_CHARS) {
        return NextResponse.json(
          { error: "That PDF had no readable text — paste the contents manually." },
          { status: 422 }
        );
      }
      chapters = await chaptersFromText(client, text);
    } else {
      // Fallback path: a (small) PDF uploaded directly — scanned front matter, or a
      // hand-picked small file. Try its text layer, else vision OCR.
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: "No PDF uploaded — choose a file and try again." },
          { status: 400 }
        );
      }
      const isPdf =
        file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (!isPdf) {
        return NextResponse.json({ error: "That's not a PDF — upload a .pdf file." }, { status: 400 });
      }
      if (file.size > MAX_BYTES) {
        return NextResponse.json({ error: "PDF is too large — max 25MB." }, { status: 400 });
      }

      const buf = Buffer.from(await file.arrayBuffer());
      let text = "";
      try {
        const parsed = await new PDFParse({ data: buf }).getText();
        text = stripPdfParseArtifacts(parsed.text ?? "");
      } catch (e) {
        console.warn("[/api/books/[id]/parse-pdf] pdf-parse failed, trying vision", e);
      }

      chapters =
        text.length >= MIN_TEXT_CHARS
          ? await chaptersFromText(client, text)
          : await chaptersFromVision(client, buf);
    }

    // contents (the flattened text incl. sections + concepts) feeds the generator;
    // chapters (structured) drives the title table and stores the hidden detail.
    const contents = formatChapters(chapters);
    const updated = await prisma.book.update({
      where: { id },
      data: { contents, chapters: chapters as unknown as Prisma.InputJsonValue },
    });
    return NextResponse.json({ contents: updated.contents, chapters });
  } catch (e) {
    if (e instanceof ParseError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[/api/books/[id]/parse-pdf POST]", e);
    return NextResponse.json(
      { error: "Parsing failed — try again or paste the contents manually." },
      { status: 500 }
    );
  }
}
