// Fit each difficulty judge's placements of REAL problems against their human ratings,
// per contest, into data/judge-calibration.json (lib/generation/judge-calibration.ts).
// Reads eval:difficulty-judge outputs; no model calls, no database. Ladder mode only,
// the mode production uses. Records without a `source` field (runs from before it was
// recorded) take it from a SOURCE=file argument.
//
//   npm run fit:judge-calibration -- AMC10=runs/judge-glm-AMC10-full.jsonl AIME=runs/judge-glm-AIME-full.jsonl
//
// Only runs whose anchors were picked by judgeAnchorIds (the whole-contest spread) are
// valid inputs: the fit holds only for the anchors it was measured with.
import { readFileSync, writeFileSync } from "node:fs";
import { fitLine, type LineFit } from "@/lib/generation/judge-calibration";

type JudgeRun = { judge: string; mode: string; source?: string; items?: { human: number; rating: number }[] };

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: fit-judge-calibration SOURCE=file.jsonl [SOURCE=file.jsonl ...]");
    process.exit(1);
  }
  const points = new Map<string, { human: number[]; judged: number[]; from: string[] }>();
  for (const arg of args) {
    const [fallbackSource, file] = arg.includes("=") ? arg.split("=") : [undefined, arg];
    for (const line of readFileSync(file, "utf8").trim().split("\n")) {
      const r = JSON.parse(line) as JudgeRun;
      const source = r.source ?? fallbackSource;
      if (r.mode !== "ladder" || !source || !r.items) continue;
      const key = `${r.judge}\u0000${source}`;
      const p = points.get(key) ?? { human: [], judged: [], from: [] };
      for (const it of r.items) {
        p.human.push(it.human);
        p.judged.push(it.rating);
      }
      p.from.push(file);
      points.set(key, p);
    }
  }
  const judges: Record<string, Record<string, LineFit & { from: string }>> = {};
  for (const [key, p] of points) {
    const [judge, source] = key.split("\u0000");
    const fit = fitLine(p.human, p.judged);
    if (!fit) continue;
    (judges[judge] ??= {})[source] = { ...fit, slope: round(fit.slope), intercept: round(fit.intercept), from: [...new Set(p.from)].join(",") };
    console.log(`${judge} ${source}: judged ≈ ${fit.slope.toFixed(3)} × human + ${fit.intercept.toFixed(3)} (n=${fit.n})`);
  }
  writeFileSync("data/judge-calibration.json", JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), judges }, null, 2) + "\n");
  console.log("Wrote data/judge-calibration.json");
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

main();
