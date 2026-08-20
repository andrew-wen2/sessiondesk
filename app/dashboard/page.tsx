import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import { weekBounds, monthToDateWindows } from "@/lib/dates";
import { formatSessionDate, percentChange } from "@/lib/format";
import { normalizeStatus } from "@/lib/session-status";
import { computeDashboardSeries, isBillable, bucketSum } from "@/lib/analytics";
import { Card } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import { buttonClass } from "@/components/ui/Button";
import { ArrowRight, CalendarDays, TrendDown, TrendUp, Video } from "@/components/icons";
import Sparkline from "@/components/charts/Sparkline";
import DashboardCharts, { type ChartRowWithStudent } from "@/components/DashboardCharts";

// Reads live DB data — render on demand, never prerender at build time.
export const dynamic = "force-dynamic";

// Dashboard. A pure server component — no client components at THIS level. The only
// interactive element besides the charts is the Meet link, a plain anchor. Every
// value derived from "now" is computed once, here, so the tile numbers can never
// disagree with themselves.
//
// The chart subtree (<DashboardCharts>) IS a client component — hover tooltips need
// state — but it receives already-computed data as props rather than querying or
// reading the clock itself. See its file comment and lib/analytics.ts's
// computeDashboardSeries for the seed-then-correct pattern that keeps that
// interactivity from reintroducing a server/hydration mismatch.
//
// This page's job used to be "four numbers and what's next"; it's now "four numbers,
// three more, and how the practice is trending" — a this-week list and a
// needs-attention roll-up were deleted in an earlier pass because they restated what
// Calendar and Students already own, and that rule still holds: nothing here is a
// session list. Charts are the one thing that escapes it, because neither of those
// pages can show a trend.

const fmtTime = (d: Date) =>
  d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// "Earned"/"billable" here means started and not cancelled — not cash received.
// Session.paid is a boolean with no timestamp, so counting only paid rows would move
// a past month's total the moment an old invoice is settled, and any trend between
// two windows would be meaningless. Outstanding (unpaid AND billable) is the
// separate number that tracks what hasn't landed yet.
const billable = (userId: string, start: object) => ({
  userId,
  status: { not: "cancelled" },
  start,
});

// Chart rows are capped, matching the export route's precedent — a truncation must
// be visible, never a silently short chart.
const MAX_CHART_ROWS = 5000;

// The trend delta on the "This month" tile answers "is revenue up or down" without
// a whole tile to itself (a deleted "Last 30 days" tile used to headline this on its
// own). It compares month-to-date against the SAME elapsed span at the start of last
// month — not this-month-vs-full-last-month, which always reads as a false decline
// against a partial current month, and not an arbitrary rolling window either: the
// comparison has to be against a number that's actually derivable from what's on the
// tile, or the badge and the headline figure silently describe two different spans.
export default async function DashboardPage() {
  const userId = await requireUserId();
  const now = new Date();
  const nowMs = now.getTime();
  const { start: weekStart, end: weekEnd } = weekBounds(now, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const { priorStart, priorEnd } = monthToDateWindows(now);

  // The 12-month window every chart and sparkline draws from. Reusing monthSeries'
  // OWN month-back arithmetic (via computeDashboardSeries below) for the query bound
  // means there is exactly one place that says "12 months" rather than two that have
  // to be kept in sync — so the window is derived from a throwaway call to the same
  // function used for the real computation.
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  // All aggregates: cost is bounded by the (userId, start) index, not by session
  // count. The tile queries are untouched from before this change; only the chart
  // query below is new.
  const [nextSession, owed, weekCount, monthEarned, trendPrior, chartRowsRaw] =
    await Promise.all([
      prisma.session.findFirst({
        where: { userId, start: { gte: now }, status: { not: "cancelled" } },
        orderBy: { start: "asc" },
        select: {
          id: true,
          start: true,
          durationMin: true,
          topic: true,
          student: { select: { id: true, name: true, meetLink: true } },
        },
      }),
      // The SQL mirror of isOwed() in lib/session-status.ts — unpaid, started, not
      // cancelled. Keep the two in sync; it's the one place a divergence can hide.
      prisma.session.aggregate({
        where: { userId, paid: false, status: { not: "cancelled" }, start: { lte: now } },
        _sum: { amount: true },
        _count: true,
      }),
      // Sessions on the books this week, past and future — a schedule-volume figure,
      // so unlike the money tiles it is not restricted to sessions that have started.
      prisma.session.count({
        where: { userId, status: { not: "cancelled" }, start: { gte: weekStart, lt: weekEnd } },
      }),
      prisma.session.aggregate({
        where: billable(userId, { gte: monthStart, lte: now }),
        _sum: { amount: true },
      }),
      // The prior side of the "This month" trend delta — same elapsed span, last
      // calendar month. The current side reuses monthEarned below rather than a
      // separate query, since both are now "billable revenue, month to date".
      prisma.session.aggregate({
        where: billable(userId, { gte: priorStart, lt: priorEnd }),
        _sum: { amount: true },
      }),
      // Feeds every chart AND the KPI sparklines — one bounded round trip rather
      // than a dozen. Includes sessions still to come this month (for "booked
      // ahead") as well as the trailing 12 months (for the trend charts).
      prisma.session.findMany({
        where: { userId, start: { gte: twelveMonthsAgo, lt: monthEnd } },
        select: {
          start: true,
          amount: true,
          paid: true,
          status: true,
          durationMin: true,
          studentId: true,
          student: { select: { name: true } },
        },
        orderBy: { start: "asc" },
        take: MAX_CHART_ROWS,
      }),
    ]);

  const outstanding = owed._sum.amount ?? 0;
  const unpaidCount = owed._count;
  const earnedThisMonth = monthEarned._sum.amount ?? 0;
  const trendChange = percentChange(earnedThisMonth, trendPrior._sum.amount ?? 0);

  const chartRows: ChartRowWithStudent[] = chartRowsRaw.map((r) => ({
    start: r.start.getTime(),
    amount: r.amount,
    paid: r.paid,
    status: r.status,
    studentId: r.studentId,
    durationMin: r.durationMin,
    studentName: r.student.name,
  }));
  const chartsTruncated = chartRowsRaw.length === MAX_CHART_ROWS;

  // Computed ONCE, here, in the server's own timezone — this is the "seed" that
  // <DashboardCharts> renders on its very first (server + hydration) pass before its
  // own effect re-derives the same thing in the browser's local zone. See that
  // component's file comment for why the two-step matters.
  const series = computeDashboardSeries(chartRows, now);

  // Hours taught this month, and the derived effective rate. Filtered from the
  // already-fetched chart rows rather than a 7th query — cheap at this row count,
  // and it reuses the SAME billable definition as every other tile via isBillable.
  const hoursThisMonth =
    chartRows
      .filter((r) => r.start >= monthStart.getTime() && isBillable(r, nowMs))
      .reduce((a, r) => a + r.durationMin, 0) / 60;
  const effectiveRate = hoursThisMonth > 0 ? earnedThisMonth / hoursThisMonth : null;
  const hoursByMonth = bucketSum(
    chartRows.filter((r) => isBillable(r, nowMs)),
    series.monthly,
    (r) => r.durationMin / 60
  );

  // Revenue already on the books for the rest of this month — sessions that haven't
  // happened yet, so isBillable (which requires the session to have STARTED)
  // deliberately does not apply here; only "not cancelled" does.
  const bookedAhead = chartRows
    .filter((r) => normalizeStatus(r.status) !== "cancelled" && r.start > nowMs && r.start < monthEnd.getTime())
    .reduce((a, r) => a + r.amount, 0);

  const monthLabel = now.toLocaleDateString("en-US", { month: "short" });

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <PageHeader title="Dashboard" description="Where the practice stands right now." />

      {/* Six tiles — the numbers are the point of this page, so they lead it. */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Outstanding"
          value={`$${outstanding}`}
          tone={outstanding > 0 ? "warn" : "good"}
          sparkline={<Sparkline values={series.unpaidByMonth} tone="warn" />}
          footer={
            outstanding > 0 ? (
              <Link
                href="/students?unpaid=1"
                className="inline-flex items-center gap-1 font-medium text-primary transition-colors duration-150 hover:text-primary-hover"
              >
                {unpaidCount} unpaid session{unpaidCount === 1 ? "" : "s"}
                <ArrowRight className="h-3 w-3" />
              </Link>
            ) : (
              "Everything is paid up"
            )
          }
        />
        <Tile
          label="This week"
          value={String(weekCount)}
          sparkline={<Sparkline values={series.sessionsByWeek} />}
          footer={`session${weekCount === 1 ? "" : "s"} scheduled`}
        />
        <Tile
          label="This month"
          value={`$${earnedThisMonth}`}
          sparkline={<Sparkline values={series.revenueByMonth} />}
          footer={
            <span className="flex items-center gap-1">
              earned so far
              {trendChange !== null && trendChange !== 0 && (
                <span
                  className={`inline-flex items-center gap-0.5 font-medium ${trendChange > 0 ? "text-good" : "text-warn"}`}
                >
                  {trendChange > 0 ? <TrendUp className="h-3 w-3" /> : <TrendDown className="h-3 w-3" />}
                  {Math.abs(trendChange)}%
                </span>
              )}
            </span>
          }
        />
        <Tile
          label="Hours taught"
          value={hoursThisMonth.toFixed(1)}
          sparkline={<Sparkline values={hoursByMonth} />}
          footer="this month"
        />
        <Tile
          label="Effective rate"
          value={effectiveRate === null ? "—" : `$${Math.round(effectiveRate)}/hr`}
          footer="revenue ÷ hours, this month"
        />
        <Tile label="Booked ahead" value={`$${bookedAhead}`} footer={`rest of ${monthLabel}`} />
      </div>

      {/* Next session — the one thing on this page you act on. Join Meet has no other
          home in the app, which is why the strip survives when the lists didn't. */}
      <section className="space-y-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Next session
        </h2>
        {!nextSession ? (
          <EmptyState
            icon={<CalendarDays className="h-4 w-4" />}
            title="Nothing scheduled."
            action={
              <Link href="/" className={buttonClass({ variant: "secondary", size: "sm" })}>
                Add a session
              </Link>
            }
          />
        ) : (
          <Card className="flex flex-wrap items-center gap-4 px-4 py-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary"
              aria-hidden
            >
              {nextSession.student.name.trim().charAt(0).toUpperCase() || "?"}
            </span>
            <div className="min-w-0 flex-1">
              <Link
                href={`/sessions/${nextSession.id}`}
                className="text-base font-semibold text-ink transition-colors duration-150 hover:text-primary"
              >
                {nextSession.student.name}
              </Link>
              <p className="text-sm text-muted">
                <span className="font-mono">{formatSessionDate(nextSession.start)}</span>
                {" · "}
                <span className="font-mono">{fmtTime(nextSession.start)}</span>
                {" · "}
                {nextSession.durationMin} min
              </p>
              {nextSession.topic.trim() && (
                <p className="mt-1 truncate text-sm text-ink-soft">{nextSession.topic}</p>
              )}
            </div>
            {nextSession.student.meetLink && (
              <a
                href={nextSession.student.meetLink}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass()}
              >
                <Video className="h-4 w-4" />
                Join Meet
              </a>
            )}
          </Card>
        )}
      </section>

      {chartsTruncated && (
        <p className="text-xs text-muted">
          Charts are based on the most recent {MAX_CHART_ROWS.toLocaleString()} sessions.
        </p>
      )}
      <DashboardCharts rows={chartRows} nowMs={nowMs} seed={series} />
    </div>
  );
}

// One stat tile. Local to this page on purpose: the old shared MastheadStats existed
// to keep the dashboard and the payments ledger in step, and the ledger is gone.
function Tile({
  label,
  value,
  footer,
  icon,
  sparkline,
  tone = "plain",
}: {
  label: string;
  value: string;
  footer: React.ReactNode;
  icon?: React.ReactNode;
  sparkline?: React.ReactNode;
  tone?: "plain" | "good" | "warn";
}) {
  const valueTone = tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 flex items-center gap-1.5 ${valueTone}`}>
        {icon}
        <span className="font-mono text-2xl font-semibold leading-none">{value}</span>
      </div>
      <div className="mt-1.5 text-xs text-muted">{footer}</div>
      {sparkline && <div className="mt-1.5">{sparkline}</div>}
    </Card>
  );
}
