import { projectScope } from "../../../../server/access";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRuntime } from "../../../../server/runtime";
import { dashboardUser } from "../../../../server/dashboard";
import { Empty } from "../../../../components/dashboard/Empty";
import { Stat } from "../../../../components/dashboard/Stat";
import { Status } from "../../../../components/dashboard/Status";
import { dateTime, number, releaseLabel } from "../../../../lib/format";
import { linkTo, type Search } from "../../../../lib/search-params";
import { releaseFilters } from "../../../../server/releases/filters";
import { ReleaseContext } from "../../../../components/releases/ReleaseContext";
import {
  releaseEnvironments,
  sourceMapStatus,
} from "../../../../components/releases/presentation";

export default async function ReleasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { environment } = releaseFilters(await searchParams);
  const { member } = await dashboardUser();
  const { id } = await params;
  const { db } = getRuntime();
  const release = await db.release.findFirst({
    where: { id, project: projectScope(member) },
    include: { project: { select: { name: true } }, deployments: true },
  });

  if (!release) {
    notFound();
  }

  const eventScope = {
    release: release.name,
    ...(environment !== "all" ? { environment } : {}),
  };
  const scope = { projectId: release.projectId, ...eventScope };
  const maps = sourceMapStatus(release.sourceMapsState);
  const locations = releaseEnvironments(release.deployments);
  const [events, issueCount, issues, mappedEvents] = await Promise.all([
    db.errorEvent.aggregate({
      where: scope,
      _count: { _all: true },
      _min: { receivedAt: true },
      _max: { receivedAt: true },
    }),
    db.issue.count({
      where: {
        projectId: release.projectId,
        events: { some: eventScope },
      },
    }),
    db.issue.findMany({
      where: {
        projectId: release.projectId,
        events: { some: eventScope },
      },
      orderBy: { lastSeen: "desc" },
      take: 10,
      include: {
        _count: { select: { events: { where: eventScope } } },
        events: {
          where: eventScope,
          orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { eventId: true },
        },
      },
    }),
    db.errorEvent.count({
      where: { ...scope, symbolicationState: "complete" },
    }),
  ]);
  const issuesLink = linkTo("/issues", {
    project: release.projectId,
    release: release.name,
    environment,
  });

  return (
    <div className="page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link
          href={linkTo("/releases", {
            project: release.projectId,
            environment,
          })}
        >
          Releases
        </Link>
        <span>›</span>
        <span className="mono">{releaseLabel(release.name)}</span>
      </nav>
      <div className="page-heading">
        <div>
          <h1>
            Release <span className="mono">{releaseLabel(release.name)}</span>
          </h1>
          <p className="muted mono release-name">{release.name}</p>
          <ReleaseContext
            projectId={release.projectId}
            deployments={release.deployments}
          />
        </div>
        <Link className="button primary" href={issuesLink}>
          View release issues ↗
        </Link>
      </div>
      <nav
        className="status-tabs release-environment-tabs"
        aria-label="Filter release events"
      >
        {[["all", "All environments"], ...locations].map(([value, label]) => (
          <Link
            key={value}
            href={linkTo(`/releases/${release.id}`, { environment: value })}
            aria-current={environment === value ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
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
          label="Environment"
          value={
            environment !== "all"
              ? (locations.find(([key]) => key === environment)?.[1] ??
                environment)
              : locations.map(([, label]) => label).join(" · ") || "Unknown"
          }
          caption={"Environments reported by events or CI"}
        />
        <Stat
          label="Source maps"
          value={maps.label}
          caption={
            release.sourceMapsState === "ready"
              ? `${number(mappedEvents)} of ${number(events._count._all)} retained events fully mapped`
              : maps.caption
          }
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
            <dt>Release created</dt>
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
                        href={linkTo(`/issues/${issue.id}`, {
                          event: issue.events[0]?.eventId,
                        })}
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
