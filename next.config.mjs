/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse (used by /api/books/[id]/parse-pdf) loads pdfjs-dist's ESM build and
  // the native @napi-rs/canvas. Webpack bundling breaks pdfjs-dist at runtime
  // ("Object.defineProperty called on non-object") and can't bundle the .node
  // binary, so keep these as native server-side requires.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
};

export default nextConfig;
