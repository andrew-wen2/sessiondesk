// Admission test for one ladder rung: does this provider/model return a problem
// through the tool call, under the rung's real tool-choice/thinking settings, with
// LaTeX intact? Run it before adding a rung to a GENERATION_LADDER_* variable.
// SPENDS REAL API CREDIT (a few short calls) — refuses to run without --yes.
//
//   npm run gen:admit -- --yes --rung openweight:deepseek-flash[@medium] [--tier easy|mid|hard] [--trials 3] [--timeout 120]
// A thinking level after "@" overrides the tier default (the same syntax the ladder
// variables take); --timeout (seconds) overrides the rung's deadline to see how long
// a model actually needs.
import { parseLadder } from "@/lib/generation/cascade/ladder";
import { writersFor } from "@/lib/generation/cascade/generate";
import { RungError } from "@/lib/generation/cascade/writers";
import { ADMISSION_SYSTEM, admissionUser, evaluateAdmission } from "@/lib/generation/cascade/admission";
import type { Tier } from "@/lib/generation/plan";

async function main() {
  const argv = process.argv.slice(2);
  const val = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const known = new Set(["--yes", "--rung", "--tier", "--trials", "--timeout"]);
  const bad = argv.find((a) => a.startsWith("--") && !known.has(a));
  const spec = val("rung");
  const tier = (val("tier") ?? "mid") as Tier;
  const trials = Number(val("trials") ?? "3");
  if (bad || !spec || !["easy", "mid", "hard"].includes(tier) || !(trials >= 1)) {
    console.error("Usage: npm run gen:admit -- --yes --rung provider:model[@thinking] [--tier easy|mid|hard] [--trials 3] [--timeout seconds]");
    process.exit(1);
  }
  // Parse as a cheap rung (not the top) so it gets the tier's cheap-rung settings.
  const [parsed] = parseLadder(tier, `${spec},anthropic:claude-opus-5-5`);
  const timeoutS = val("timeout") ? Number(val("timeout")) : undefined;
  if (timeoutS !== undefined && !(timeoutS > 0)) {
    console.error("--timeout is in seconds and must be positive.");
    process.exit(1);
  }
  const rung = timeoutS ? { ...parsed, timeoutMs: timeoutS * 1000 } : parsed;
  const writer = writersFor(new Set([rung.provider]))[rung.provider];
  if (!writer) {
    console.error(`No credentials for ${rung.provider}. Run npm run gen:check.`);
    process.exit(1);
  }
  if (!argv.includes("--yes")) {
    console.error(`gen:admit makes ${trials} real call(s) to ${spec}. Re-run with --yes to spend.`);
    process.exit(1);
  }
  console.log(`${spec} as a ${tier} rung: thinking=${rung.thinking} tool=${rung.toolChoice} timeout=${rung.timeoutMs}ms`);
  // Two separate questions, reported separately:
  //  - fidelity: every call that finished used the tool and kept LaTeX intact. A
  //    corrupted or malformed result disqualifies the rung.
  //  - speed: how often a call hit the rung's deadline. On a ladder a timeout just
  //    escalates to the next rung (costing time, never correctness), so it is measured
  //    and warned about rather than treated as disqualifying.
  let finished = 0;
  let clean = 0;
  let timeouts = 0;
  let disqualified = false;
  const durations: number[] = [];
  for (let t = 1; t <= trials; t++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("rung-timeout"), rung.timeoutMs);
    const started = Date.now();
    try {
      const p = await writer({ rung, system: ADMISSION_SYSTEM, user: admissionUser(), signal: controller.signal, recordUsage: () => {} });
      const r = evaluateAdmission(p);
      finished++;
      durations.push(Date.now() - started);
      if (r.pass) clean++;
      if (r.corrupted.length) disqualified = true;
      console.log(
        `trial ${t}: ${r.pass ? "PASS" : "FAIL"} in ${Date.now() - started}ms` +
          (r.missing.length ? ` not used=[${r.missing.join(" ")}]` : "") +
          (r.corrupted.length ? ` CORRUPTED=[${r.corrupted.join(" ")}]` : "")
      );
    } catch (e) {
      const finish = e instanceof RungError ? e.finish : "error";
      if (finish === "timeout") timeouts++;
      else disqualified = disqualified || finish === "malformed-tool-call" || finish === "missing-tool-call";
      console.log(`trial ${t}: ${finish === "timeout" ? "TIMEOUT" : "FAIL"} ${finish}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const fidelityOk = !disqualified && finished >= 2 && clean === finished;
  const sorted = [...durations].sort((a, b) => a - b);
  console.log(
    `\nFidelity: ${fidelityOk ? "OK" : "NOT OK"} — ${clean}/${finished} finished calls clean${disqualified ? " (corrupted output or a malformed/missing tool call)" : ""}${finished < 2 ? " (fewer than 2 calls finished: not enough evidence)" : ""}.`
  );
  console.log(
    `Speed: ${timeouts}/${trials} timed out at ${rung.timeoutMs / 1000}s` +
      (sorted.length ? `; finished calls took ${Math.round(sorted[0] / 1000)}–${Math.round(sorted[sorted.length - 1] / 1000)}s` : "") +
      (timeouts > 0 ? ". On a ladder each timeout escalates to the next rung and costs that time — measure the rate with more --trials." : ".")
  );
  const admitted = fidelityOk;
  console.log(admitted ? `ADMITTED${timeouts > 0 ? " (with timeouts — see Speed)" : ""}: ${spec}` : `NOT ADMITTED: ${spec}`);
  process.exit(admitted ? 0 : 1);
}

main().catch((e) => {
  console.error("[gen:admit]", e);
  process.exit(1);
});
