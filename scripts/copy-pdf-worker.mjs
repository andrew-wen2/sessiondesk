// Copies pdf.js's main library + web worker out of node_modules into public/ so
// the browser-side PDF text extraction (lib/extract-pdf-text.ts) can load them as
// native ES modules from stable URLs (/pdf.min.mjs, /pdf.worker.min.mjs).
//
// We deliberately do NOT let webpack bundle pdfjs-dist on the client — its ESM
// build throws "Object.defineProperty called on non-object" at runtime when run
// through webpack. Loading from /public with a webpackIgnore'd dynamic import
// sidesteps the bundler entirely. Run on postinstall so the served files always
// match the installed pdfjs-dist version (a mismatch throws "API/Worker version").
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "node_modules", "pdfjs-dist", "build");
const destDir = join(root, "public");
const files = ["pdf.min.mjs", "pdf.worker.min.mjs"];

try {
  await mkdir(destDir, { recursive: true });
  for (const f of files) {
    await copyFile(join(buildDir, f), join(destDir, f));
    console.log(`[copy-pdf-worker] ${f} → public/${f}`);
  }
} catch (e) {
  // Don't fail install if pdfjs-dist isn't present yet (e.g. partial install).
  console.warn("[copy-pdf-worker] skipped:", e.message);
}
