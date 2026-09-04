/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // The student practice link. The token lives in the URL path, which is the
        // accepted tradeoff for "no account" — these headers bound what leaks from it.
        source: "/w/:path*",
        headers: [
          // Without this, the token leaks in the Referer header on any outbound
          // navigation from the page (a link in a problem statement, an image host).
          { key: "Referrer-Policy", value: "no-referrer" },
          // A worksheet is not for search engines, and an indexed token URL is a
          // permanently public one.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          // Never cached by a proxy or a shared device's browser. The page is
          // per-student and carries revealed answers once problems are committed.
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;
