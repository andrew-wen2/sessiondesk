import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import type { Problem, Lesson } from "@/lib/types";
import { splitCode } from "@/lib/rich-segments";
import { problemsFilename } from "@/lib/download-problems";

// Editable .docx export, parallel to the print-to-PDF path. Word has no KaTeX, so
// math is emitted as its raw $...$ source in a monospace run and fenced code as a
// monospace block — the tutor edits from there. Each file is a student worksheet
// followed by a tutor answer key on a fresh page. Blob is built client-side (no
// server round-trip), matching how the PDF path runs in the browser.

const MONO = "Consolas";

type FileOpts = { startIso: string; studentName: string; topic?: string; isMath?: boolean };

function hasText(s: string | undefined | null): s is string {
  return Boolean(s && s.trim());
}

function codeParagraph(code: string): Paragraph {
  const runs = code.split("\n").map(
    (line, i) => new TextRun({ text: line, font: MONO, size: 20, break: i === 0 ? undefined : 1 })
  );
  return new Paragraph({ children: runs, spacing: { after: 120 } });
}

// A rich string → Word paragraphs. Fenced code becomes a monospace block; the rest
// is emitted line-by-line as plain text (math stays as its raw $...$ source). `mono`
// styles short answers that read as a number/expression (math subjects).
function richParagraphs(text: string, mono = false): Paragraph[] {
  const out: Paragraph[] = [];
  for (const seg of splitCode(text)) {
    if (seg.type === "code") {
      out.push(codeParagraph(seg.content));
      continue;
    }
    for (const line of seg.content.split("\n")) {
      if (!line.trim()) continue;
      out.push(new Paragraph({ children: [new TextRun({ text: line, font: mono ? MONO : undefined })] }));
    }
  }
  return out;
}

function label(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, bold: true })], spacing: { before: 160, after: 40 } });
}

function heading(text: string, pageBreakBefore = false): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, pageBreakBefore });
}

function answerParagraphs(answer: string, mono: boolean): Paragraph[] {
  // Keep the "Answer:" tag and the value on one line where possible.
  return [
    new Paragraph({
      children: [
        new TextRun({ text: "Answer: ", bold: true }),
        new TextRun({ text: answer.replace(/\n/g, " ").trim(), font: mono ? MONO : undefined }),
      ],
      spacing: { after: 40 },
    }),
  ];
}

async function save(children: Paragraph[], filename: string): Promise<boolean> {
  try {
    const doc = new Document({ sections: [{ children }] });
    const blob = await Packer.toBlob(doc);
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
  opts: FileOpts & { item?: string }
): Promise<boolean> {
  if (problems.length === 0) return false;
  const item = opts.item ?? "Problem";
  const mono = opts.isMath !== false;
  const filename = problemsFilename(opts.startIso, opts.studentName);

  const children: Paragraph[] = [heading("Worksheet")];
  problems.forEach((p, i) => {
    children.push(label(`${item} ${i + 1}`));
    children.push(...richParagraphs(p.problem));
  });

  children.push(heading("Answer key", true));
  problems.forEach((p, i) => {
    children.push(label(`${item} ${i + 1}`));
    if (hasText(p.answer)) children.push(...answerParagraphs(p.answer, mono));
    children.push(...richParagraphs(p.solution));
  });

  return save(children, filename);
}

export async function downloadLessonDocx(lesson: Lesson, opts: FileOpts): Promise<boolean> {
  const mono = opts.isMath !== false;
  const filename = problemsFilename(opts.startIso, opts.studentName, "-lesson");

  const children: Paragraph[] = [];
  if (lesson.title) children.push(new Paragraph({ text: lesson.title, heading: HeadingLevel.TITLE }));
  children.push(heading("Lesson"));

  if (lesson.objectives.length) {
    children.push(label("Objectives"));
    for (const o of lesson.objectives) {
      children.push(new Paragraph({ text: o, bullet: { level: 0 } }));
    }
  }
  for (const s of lesson.sections) {
    if (s.heading) children.push(label(s.heading));
    children.push(...richParagraphs(s.content));
  }
  if (lesson.workedExamples.length) {
    children.push(label("Worked examples"));
    lesson.workedExamples.forEach((ex, i) => {
      children.push(label(`Example ${i + 1}`));
      children.push(...richParagraphs(ex.problem));
    });
  }
  if (lesson.practice.length) {
    children.push(label("Practice"));
    lesson.practice.forEach((p, i) => {
      children.push(label(`${i + 1}.`));
      children.push(...richParagraphs(p.problem));
    });
  }

  children.push(heading("Answer key", true));
  if (lesson.workedExamples.length) {
    children.push(label("Worked examples"));
    lesson.workedExamples.forEach((ex, i) => {
      children.push(label(`Example ${i + 1}`));
      children.push(...richParagraphs(ex.solution));
    });
  }
  if (lesson.practice.length) {
    children.push(label("Practice"));
    lesson.practice.forEach((p, i) => {
      children.push(label(`${i + 1}.`));
      if (hasText(p.answer)) children.push(...answerParagraphs(p.answer, mono));
      children.push(...richParagraphs(p.solution));
    });
  }

  return save(children, filename);
}
