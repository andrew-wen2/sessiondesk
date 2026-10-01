// No-spend configuration check for problem generation. Prints what each tier would run
// and exits nonzero on anything that would fail or spend invisibly at request time.
//
//   npm run gen:check
import { checkGenerationConfig } from "@/lib/generation/check-config";

const { lines, errors, warnings } = checkGenerationConfig();
for (const l of lines) console.log(l);
for (const w of warnings) console.warn(`WARNING: ${w}`);
for (const e of errors) console.error(`ERROR: ${e}`);
console.log(errors.length === 0 ? "gen:check passed." : `gen:check failed with ${errors.length} error(s).`);
process.exit(errors.length === 0 ? 0 : 1);
