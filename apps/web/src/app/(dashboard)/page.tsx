import { projectScope } from "../../server/access";
import Link from "next/link";
import { getRuntime } from "../../server/runtime";
import { dashboardUser } from "../../server/dashboard";
import { Empty } from "../../components/dashboard/Empty";
import { Heading } from "../../components/dashboard/Heading";
import { Stat } from "../../components/dashboard/Stat";
import { dateTime, number, releaseLabel } from "../../lib/format";
import { linkTo } from "../../lib/search-params";

export default async function Overview() {
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const project = projectScope(member);
  const now = Date.now();
  const since = new Date(now - 86400_000);
  const [projects, totalProjects, open, regressions, count, events, releases] =
    await Promise.all([
      db.project.findMany({
        where: project,
        orderBy: { createdAt: "desc" },
        take: 6,
        select: {
          id: true,
          name: true,
          slug: true,
          enabled: true,
          _count: {
            select: {
              issues: { where: { status: "open" } },
              events: { where: { receivedAt: { gte: since } } },
            },
          },
        },
      }),
      db.project.count({ where: project }),
      db.issue.count({ where: { project, status: "open" } }),
      db.issue.count({ where: { project, status: "open", regression: true } }),
      db.errorEvent.count({ where: { project, receivedAt: { gte: since } } }),
      db.errorEvent.findMany({
        where: { project, receivedAt: { gte: since } },
        orderBy: { receivedAt: "desc" },
        select: { receivedAt: true },
        take: 25_000,
      }),
      db.release.findMany({
        where: { project },
        orderBy: { createdAt: "desc" },
        take: 4,
        include: { project: { select: { name: true } } },
      }),
    ]);
  const bars = Array<number>(24).fill(0);

  for (const event of events) {
    const index =
      23 - Math.floor((now - event.receivedAt.getTime()) / 3600_000);

    if (index >= 0 && index < 24) {
      bars[index]!++;
    }
  }

  const peak = Math.max(1, ...bars);

  return (
    <div className="page">
      <Heading
        title="Overview"
        description="A pulse on your applications. A clear place to start."
        action={
          <Link href="/issues" className="button primary">
            Explore issues ↗
          </Link>
        }
      />
      <div className="stats-grid">
        <Stat
          label="Events · last 24h"
          value={count}
          caption="Errors received across your projects"
        />
        <Stat
          label="Open issues"
          value={open}
          caption="Ready for investigation"
          href="/issues?status=open"
        />
        <Stat
          label="Regressions"
          value={regressions}
          caption="Resolved issues that returned"
          href="/issues?status=regression"
        />
        <Stat
          label="Projects"
          value={totalProjects}
          caption="Applications in this workspace"
          href="/projects"
        />
      </div>
      <section className="panel chart-panel">
        <div className="section-heading">
          <div>
            <h2>Error activity</h2>
            <p className="muted">Events received in the last 24 hours</p>
          </div>
          <span className="pill">
            <span className="live-dot" /> Last 24 hours
          </span>
        </div>
        <svg
          className="chart"
          viewBox="0 0 960 180"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${count} events received in the last 24 hours`}
        >
          <path d="M0 30H960 M0 85H960 M0 150H960" className="chart-grid" />
          {bars.map((value, i) => (
            <rect
              key={i}
              x={i * 40 + 8}
              y={150 - (value / peak) * 125}
              width="24"
              height={Math.max(2, (value / peak) * 125)}
              rx="4"
              className="chart-bar"
            >
              <title>
                {23 - i} hours ago: {value} events
              </title>
            </rect>
          ))}
        </svg>
        <div className="chart-axis">
          <span>24 hours ago</span>
          <span>12 hours ago</span>
          <span>Now</span>
        </div>
        {count > events.length && (
          <p className="chart-note muted">
            The chart shows the latest {number(events.length)} events.
          </p>
        )}
      </section>
      <div className="overview-columns">
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Project health</h2>
              <p className="muted">Where your attention is needed</p>
            </div>
            <Link className="text-link" href="/projects">
              All projects ↗
            </Link>
          </div>
          {projects.length ? (
            <div className="project-health">
              {projects.map((p) => (
                <Link
                  className="health-row"
                  key={p.id}
                  href={linkTo("/issues", { project: p.id, status: "open" })}
                >
                  <span className="project-mark">{p.name.slice(0, 1)}</span>
                  <span className="grow">
                    <strong>{p.name}</strong>
                    <small className="muted">{p.slug}</small>
                  </span>
                  <span className="health-count">
                    <strong>{number(p._count.issues)}</strong>
                    <small className="muted">open issues</small>
                  </span>
                  <span className="muted">
                    {number(p._count.events)} events
                  </span>
                  <span>↗</span>
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title={
                member.role === "owner"
                  ? "Connect your first project"
                  : "No projects assigned"
              }
              action={
                member.role === "owner" && (
                  <Link href="/projects/new">Create project ↗</Link>
                )
              }
            >
              {member.role === "owner"
                ? "Your application health will appear here once events arrive."
                : "Ask an Owner to add you to a team with project access."}
            </Empty>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Recent releases</h2>
              <p className="muted">Versions seen in your events</p>
            </div>
            <Link className="text-link" href="/releases">
              View all ↗
            </Link>
          </div>
          {releases.length ? (
            releases.map((release) => (
              <Link
                href={`/releases/${release.id}`}
                className="release-row"
                key={release.id}
              >
                <span className="release-mark">◇</span>
                <div className="grow">
                  <strong className="mono">{releaseLabel(release.name)}</strong>
                  <small className="muted">{release.project.name}</small>
                  <small className="muted">{dateTime(release.createdAt)}</small>
                </div>
                <span>↗</span>
              </Link>
            ))
          ) : (
            <Empty title="No releases yet">
              Include a release when initializing the SDK to track errors by
              version.
            </Empty>
          )}
        </section>
      </div>
    </div>
  );
}
