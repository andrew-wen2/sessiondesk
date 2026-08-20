// A trend line under a KPI number. No hover, no state — so it stays a SERVER
// component and the stat tiles around it don't need to become client components
// just to show a shape. `niceMax` guards the all-zero case so this never divides by
// zero on a brand-new account with nothing plotted yet.
import { niceMax } from "@/lib/analytics";

export default function Sparkline({
  values,
  tone = "primary",
  className = "h-6 w-full",
}: {
  values: number[];
  tone?: "primary" | "good" | "warn";
  className?: string;
}) {
  if (values.length < 2) return null;

  const W = 100;
  const H = 28;
  const max = niceMax(Math.max(0, ...values));
  const step = W / (values.length - 1);
  const points = values.map((v, i) => [i * step, H - (v / max) * H] as const);

  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  const strokeClass = tone === "good" ? "stroke-good" : tone === "warn" ? "stroke-warn" : "stroke-primary";
  const fillClass = tone === "good" ? "fill-good/10" : tone === "warn" ? "fill-warn/10" : "fill-primary/10";
  const dotClass = tone === "good" ? "fill-good" : tone === "warn" ? "fill-warn" : "fill-primary";

  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} className={fillClass} stroke="none" />
      <path d={line} className={strokeClass} fill="none" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={1.75} className={dotClass} stroke="none" />
    </svg>
  );
}
