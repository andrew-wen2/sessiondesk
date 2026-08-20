import type { Paragraph } from "docx";
import type { Problem, Lesson } from "@/lib/types";
import { splitCode } from "@/lib/rich-segments";
import { problemsFilename } from "@/lib/download-problems";
import { hasMath } from "@/lib/format";

// Editable .docx export, parallel to the print-to-PDF path. Word has no KaTeX, so
// math is emitted as its raw $...$ source in a monospace run and fenced code as a
// monospace block — the tutor edits from there. Each file is a student worksheet
// followed by a tutor answer key on a fresh page. Blob is built client-side (no
// server round-trip), matching how the PDF path runs in the browser.

// `docx` is imported ONLY at type level up here; the runtime module is pulled in on
// demand by loadDocx(). It is a ~1MB dependency that nothing needs until the tutor
// clicks a download, and — the reason this isn't merely an optimization — a static
// import puts it in the session page's hydration chunk, where a failure to even
// parse the library takes the whole page down with it (no time editing, no topic
// autosave, no Generate). Loaded lazily, a broken export stays a broken export.
// Every helper below therefore takes the loaded module as `docx`.
type Docx = typeof import("docx");

let docxPromise: Promise<Docx> | null = null;

function loadDocx(): Promise<Docx> {
  // Cached so a second download reuses the chunk instead of re-awaiting the import.
  // A rejection is NOT cached: the usual failure here is a dropped network on the
  // chunk request, and keeping the rejected promise would make "click Download
  // again" fail forever with no way back short of a reload.
  if (!docxPromise) {
    docxPromise = import("docx").catch((e) => {
      docxPromise = null;
      throw e;
    });
  }
  return docxPromise;
}

const MONO = "Consolas";

type FileOpts = { startIso: string; studentName: string; topic?: string };

function hasText(s: string | undefined | null): s is string {
  return Boolean(s && s.trim());
}

function codeParagraph(docx: Docx, code: string): Paragraph {
  const runs = code.split("\n").map(
    (line, i) => new docx.TextRun({ text: line, font: MONO, size: 20, break: i === 0 ? undefined : 1 })
  );
  return new docx.Paragraph({ children: runs, spacing: { after: 120 } });
}

// A rich string → Word paragraphs. Fenced code becomes a monospace block; the rest
// is emitted line-by-line as plain text (math stays as its raw $...$ source). `mono`
// styles short answers that read as a number/expression (math subjects).
function richParagraphs(docx: Docx, text: string, mono = false): Paragraph[] {
  const out: Paragraph[] = [];
  for (const seg of splitCode(text)) {
    if (seg.type === "code") {
      out.push(codeParagraph(docx, seg.content));
      continue;
    }
    for (const line of seg.content.split("\n")) {
      if (!line.trim()) continue;
      out.push(
        new docx.Paragraph({
          children: [new docx.TextRun({ text: line, font: mono ? MONO : undefined })],
        })
      );
    }
  }
  return out;
}

function label(docx: Docx, text: string): Paragraph {
  return new docx.Paragraph({
    children: [new docx.TextRun({ text, bold: true })],
    spacing: { before: 160, after: 40 },
  });
}

function heading(docx: Docx, text: string, pageBreakBefore = false): Paragraph {
  return new docx.Paragraph({ text, heading: docx.HeadingLevel.HEADING_1, pageBreakBefore });
}

function answerParagraphs(docx: Docx, answer: string, mono: boolean): Paragraph[] {
  // Keep the "Answer:" tag and the value on one line where possible.
  return [
    new docx.Paragraph({
      children: [
        new docx.TextRun({ text: "Answer: ", bold: true }),
        new docx.TextRun({ text: answer.replace(/\n/g, " ").trim(), font: mono ? MONO : undefined }),
      ],
      spacing: { after: 40 },
    }),
  ];
}

async function save(docx: Docx, children: Paragraph[], filename: string): Promise<boolean> {
  try {
    const doc = new docx.Document({ sections: [{ children }] });
    const blob = await docx.Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

export async function downloadProblemsDocx(
  problems: Problem[],
  opts: FileOpts
): Promise<boolean> {
  if (problems.length === 0) return false;
  const item = "Problem";
  const filename = problemsFilename(opts.startIso, opts.studentName);

  // A failed chunk load reports the same "couldn't build the file" as a failed build.
  let docx: Docx;
  try {
    docx = await loadDocx();
  } catch {
    return false;
  }

  const children: Paragraph[] = [heading(docx, "Worksheet")];
  problems.forEach((p, i) => {
    children.push(label(docx, `${item} ${i + 1}`));
    children.push(...richParagraphs(docx, p.problem));
  });

  children.push(heading(docx, "Answer key", true));
  problems.forEach((p, i) => {
    children.push(label(docx, `${item} ${i + 1}`));
    if (hasText(p.answer)) children.push(...answerParagraphs(docx, p.answer, hasMath(p.answer)));
    children.push(...richParagraphs(docx, p.solution));
  });

  return save(docx, children, filename);
}

export async function downloadLessonDocx(lesson: Lesson, opts: FileOpts): Promise<boolean> {
  const filename = problemsFilename(opts.startIso, opts.studentName, "-lesson");

  let docx: Docx;
  try {
    docx = await loadDocx();
  } catch {
    return false;
  }

  const children: Paragraph[] = [];
  if (lesson.title) {
    children.push(new docx.Paragraph({ text: lesson.title, heading: docx.HeadingLevel.TITLE }));
  }
  children.push(heading(docx, "Lesson"));

  if (lesson.objectives.length) {
    children.push(label(docx, "Objectives"));
    for (const o of lesson.objectives) {
      children.push(new docx.Paragraph({ text: o, bullet: { level: 0 } }));
    }
  }
  for (const s of lesson.sections) {
    if (s.heading) children.push(label(docx, s.heading));
    children.push(...richParagraphs(docx, s.content));
  }
  if (lesson.workedExamples.length) {
    children.push(label(docx, "Worked examples"));
    lesson.workedExamples.forEach((ex, i) => {
      children.push(label(docx, `Example ${i + 1}`));
      children.push(...richParagraphs(docx, ex.problem));
    });
  }
  if (lesson.practice.length) {
    children.push(label(docx, "Practice"));
    lesson.practice.forEach((p, i) => {
      children.push(label(docx, `${i + 1}.`));
      children.push(...richParagraphs(docx, p.problem));
    });
  }

  children.push(heading(docx, "Answer key", true));
  if (lesson.workedExamples.length) {
    children.push(label(docx, "Worked examples"));
    lesson.workedExamples.forEach((ex, i) => {
      children.push(label(docx, `Example ${i + 1}`));
      children.push(...richParagraphs(docx, ex.solution));
    });
  }
  if (lesson.practice.length) {
    children.push(label(docx, "Practice"));
    lesson.practice.forEach((p, i) => {
      children.push(label(docx, `${i + 1}.`));
      if (hasText(p.answer)) children.push(...answerParagraphs(docx, p.answer, hasMath(p.answer)));
      children.push(...richParagraphs(docx, p.solution));
    });
  }

  return save(docx, children, filename);
}
