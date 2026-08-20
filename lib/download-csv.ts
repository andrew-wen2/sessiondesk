// CSV export for the payments ledger. Built client-side as a Blob and saved through
// a synthetic anchor — the same shape as lib/download-docx.ts's save(), so there's no
// new API route and no server round-trip. That also means the export matches exactly
// what's on screen, including a mark-paid toggle made a second earlier that the
// server hasn't been re-read for.
//
// Returns false instead of throwing; the caller shows an inline message.

// Spreadsheets treat a leading =, +, - or @ as the start of a formula, so a topic
// like "=SUM(A1:A9)" would be *evaluated* on open — a real injection vector when the
// text came from somewhere else. Prefixing an apostrophe forces it to stay text.
function neutralizeFormula(field: string): string {
  return /^[=+\-@]/.test(field) ? `'${field}` : field;
}

// Quote every field and double any internal quote. Quoting unconditionally (rather
// than only when needed) keeps commas, quotes and newlines in topics safe without
// per-field branching.
function escapeField(value: string): string {
  return `"${neutralizeFormula(value).replace(/"/g, '""')}"`;
}

export function toCsv(rows: string[][]): string {
  // CRLF line endings and a UTF-8 BOM: without the BOM Excel reads the file as the
  // system codepage and mangles non-ASCII student names.
  return "﻿" + rows.map((r) => r.map(escapeField).join(",")).join("\r\n");
}

export function downloadCsv(rows: string[][], filename: string): boolean {
  try {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
