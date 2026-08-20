import { describe, it, expect } from "vitest";
import { toCsv } from "./download-csv";

describe("toCsv", () => {
  it("quotes every field and doubles internal quotes", () => {
    const body = toCsv([
      ["a", 'say "hi"'],
      ["b,c", "line\nbreak"],
    ]).replace("﻿", "");
    const [row1, row2] = body.split("\r\n");
    expect(row1).toBe('"a","say ""hi"""');
    // A comma and a newline inside a field survive because every field is quoted.
    expect(row2).toBe('"b,c","line\nbreak"');
  });

  it("starts with a UTF-8 BOM so Excel reads non-ASCII names", () => {
    expect(toCsv([["Renée"]]).startsWith("﻿")).toBe(true);
  });

  it("neutralizes spreadsheet formula injection", () => {
    for (const dangerous of ["=SUM(A1:A9)", "+1", "-1", "@import"]) {
      const out = toCsv([[dangerous]]);
      expect(out.includes(`"'${dangerous}"`)).toBe(true);
    }
    // A leading digit or letter is left alone — no stray apostrophes in normal data.
    expect(toCsv([["90"]]).includes('"90"')).toBe(true);
  });
});
