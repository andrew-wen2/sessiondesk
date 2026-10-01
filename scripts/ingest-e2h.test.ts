import { describe, expect, it } from "vitest";
import { duplicateOf, e2hId, e2hLabel, idsFor, SOURCE_FOR_TAG, type E2HRow } from "./ingest-e2h";

const row = (over: Partial<E2HRow> = {}): E2HRow => ({
  contest: "AMC",
  tag: "AMC10",
  subtest: "10A",
  year: 2016,
  index: 14,
  problem: "How many ways are there to write 2016 as the sum of twos and threes, ignoring order?",
  answer: "337",
  solution: "s",
  rating: 0.25,
  ...over,
});

describe("ingest-e2h", () => {
  it("gives every row a stable id and the join's label format", () => {
    expect(e2hId(row())).toBe(e2hId(row()));
    expect(e2hId(row({ subtest: "10B" }))).not.toBe(e2hId(row()));
    expect(e2hLabel(row())).toBe("AMC10 10A 2016 #14");
  });

  it("keeps two different problems that E2H labels the same as separate rows", () => {
    // 2021 had a spring and a fall AMC; E2H labels both "10B 2021".
    const spring = row({ year: 2021, subtest: "10B", index: 1, problem: "How many integer values of $x$ satisfy $|x|<3\\pi$?" });
    const fall = row({ year: 2021, subtest: "10B", index: 1, problem: "What is the value of $1234 + 2341 + 3412 + 4123$?" });
    const alone = row({ year: 2019 });
    const { idOf, shared } = idsFor([spring, fall, alone]);
    expect(idOf(spring)).not.toBe(idOf(fall));
    expect(idOf(alone)).toBe(e2hId(alone)); // unique labels keep the plain id
    expect([...shared]).toEqual(["AMC10 10B 2021 #1"]);
  });

  it("maps every E2H contest to a corpus source", () => {
    expect(Object.keys(SOURCE_FOR_TAG).sort()).toEqual(["AIME", "AMC10", "AMC12", "AMC8", "HMMT-Feb", "HMMT-Nov"]);
  });

  it("finds the corpus row an E2H row duplicates, only within the same contest and year", () => {
    const corpus = [
      { id: "same", source: "AMC10", year: 2016, number: 14, statement: "How many ways are there to write $2016$ as the sum of twos and threes, ignoring order?" },
      { id: "other-year", source: "AMC10", year: 2017, number: 14, statement: row().problem },
      { id: "other-contest", source: "AMC12", year: 2016, number: 14, statement: row().problem },
    ];
    expect(duplicateOf(row(), corpus)).toBe("same");
    expect(duplicateOf(row({ problem: "A circle of radius 5 is inscribed in a square. Find the area of the square." }), corpus)).toBeNull();
    expect(duplicateOf(row({ year: 2018 }), corpus)).toBeNull();
  });
});
