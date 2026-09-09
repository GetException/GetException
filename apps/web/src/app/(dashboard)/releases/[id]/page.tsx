import { projectScope } from "../../../../server/access";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRuntime } from "../../../../server/runtime";
import { dashboardUser } from "../../../../server/dashboard";
import { Empty } from "../../../../components/dashboard/Empty";
import { Stat } from "../../../../components/dashboard/Stat";
import { Status } from "../../../../components/dashboard/Status";
import { dateTime, number, releaseLabel } from "../../../../lib/format";
import { linkTo } from "../../../../lib/search-params";

export default async function ReleasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { member } = await dashboardUser();
  const { id } = await params;
  const { db } = getRuntime();
  const release = await db.release.findFirst({
    where: { id, project: projectScope(member) },
    include: { project: { select: { name: true } } },
  });

  if (!release) {
    notFound();
  }

  const scope = { projectId: release.projectId, release: release.name };
  const [events, issueCount, issues, environments] = await Promise.all([
    db.errorEvent.aggregate({
      where: scope,
      _count: { _all: true },
      _min: { receivedAt: true },
      _max: { receivedAt: true },
    }),
    db.issue.count({
      where: {
        projectId: release.projectId,
        events: { some: { release: release.name } },
      },
    }),
    db.issue.findMany({
      where: {
        projectId: release.projectId,
        events: { some: { release: release.name } },
      },
      orderBy: { lastSeen: "desc" },
      take: 10,
      include: {
        _count: { select: { events: { where: { release: release.name } } } },
      },
    }),
    db.errorEvent.groupBy({
      by: ["environment"],
      where: scope,
      _count: { _all: true },
    }),
  ]);
  const issuesLink = linkTo("/issues", {
    project: release.projectId,
    release: release.name,
  });

  return (
    <div className="page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href="/releases">Releases</Link>
        <span>›</span>
        <span className="mono">{releaseLabel(release.name)}</span>
      </nav>
      <div className="page-heading">
        <div>
          <h1>
            Release <span className="mono">{releaseLabel(release.name)}</span>
          </h1>
          <p className="muted mono release-name">{release.name}</p>
        </div>
        <Link className="button primary" href={issuesLink}>
          View release issues ↗
        </Link>
      </div>
      <div className="stats-grid">
        <Stat
          label="Retained events"
          value={events._count._all}
          caption="Events available for investigation"
        />
        <Stat
          label="Related issues"
          value={issueCount}
          caption="Groups seen in this release"
          href={issuesLink}
        />
        <Stat
          label="Environments"
          value={environments.length}
          caption={
            environments.map((value) => value.environment).join(" · ") ||
            "No retained events"
          }
        />
        <Stat
          label="Source maps"
          value="Unavailable"
          caption="Stack traces show compiled frames"
        />
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>Release details</h2>
        </div>
        <dl className="settings-list">
          <div>
            <dt>Project</dt>
            <dd>
              <Link
                className="text-link"
                href={`/projects/${release.projectId}`}
              >
                {release.project.name}
              </Link>
            </dd>
          </div>
          <div>
            <dt>First received</dt>
            <dd>{dateTime(release.createdAt)}</dd>
          </div>
          <div>
            <dt>Latest retained event</dt>
            <dd>
              {events._max.receivedAt
                ? dateTime(events._max.receivedAt)
                : "No retained events"}
            </dd>
          </div>
        </dl>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Issues in this release</h2>
          <Link className="text-link" href={issuesLink}>
            All related issues ↗
          </Link>
        </div>
        {issues.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Status</th>
                  <th className="numeric">Events in release</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => (
                  <tr key={issue.id}>
                    <td>
                      <Link
                        className="issue-title"
                        href={`/issues/${issue.id}`}
                      >
                        <span className="issue-icon">!</span>
                        <span>
                          <strong>{issue.exceptionType}</strong>
                          <small>{issue.title}</small>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <Status
                        status={issue.status}
                        regression={issue.regression}
                      />
                    </td>
                    <td className="numeric">{number(issue._count.events)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No retained events">
            Release history is kept after individual events expire.
          </Empty>
        )}
      </section>
    </div>
  );
}
