import { historyScope } from "../../../server/issues/history";
import { NewInRelease } from "../../../components/issues/NewInRelease";
import { releaseLabel } from "../../../lib/format";
import { projectScope } from "../../../server/access";
import { PAGE_SIZE } from "../../../lib/pagination";
import Link from "next/link";
import { issueOrder } from "../../../server/issues/sorting";
import { SortableTableHead } from "../../../components/dashboard/SortableTableHead";
import { SortFields } from "../../../components/dashboard/SortFields";
import { getRuntime } from "../../../server/runtime";
import { dashboardUser } from "../../../server/dashboard";
import { dateTime, number } from "../../../lib/format";
import { issueFilters, issueWhere } from "../../../server/filters";
import { linkTo, type Search } from "../../../lib/search-params";
import { Empty } from "../../../components/dashboard/Empty";
import { Heading } from "../../../components/dashboard/Heading";
import { Pagination } from "../../../components/dashboard/Pagination";
import { ProjectSelect } from "../../../components/dashboard/ProjectSelect";
import { Status } from "../../../components/dashboard/Status";
import { IssueBuildContext } from "../../../components/issues/IssueBuildContext";
import { latestIssueEvents } from "../../../server/issues/insights";

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const filters = issueFilters(await searchParams);
  const where = issueWhere(member, filters);
  const orderBy = issueOrder(filters);
  const [projects, issues, total, selectableReleases] = await Promise.all([
    db.project.findMany({
      where: projectScope(member),
      orderBy: { name: "asc" },
      select: { id: true, name: true },
      take: 200,
    }),
    db.issue.findMany({
      where,
      orderBy,
      skip: (filters.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        project: { select: { name: true } },
        histories: { where: historyScope(filters.environment) },
      },
    }),
    db.issue.count({ where }),
    db.release.findMany({
      where: {
        project: {
          ...projectScope(member),
          ...(filters.project ? { id: filters.project } : {}),
        },
        ...(filters.environment !== "all"
          ? { deployments: { some: { environment: filters.environment } } }
          : {}),
      },
      orderBy: { lastActivityAt: "desc" },
      take: 200,
      include: { project: { select: { name: true } } },
    }),
  ]);
  const latestEvents = await latestIssueEvents(
    db,
    issues.map((issue) => issue.id),
    filters,
  );
  const latestByIssue = new Map(
    latestEvents.map((event) => [event.issueId, event]),
  );
  const projectByIssue = new Map(
    issues.map((issue) => [issue.id, issue.projectId]),
  );
  const releasePairs = latestEvents
    .filter((event) => event.release)
    .map((event) => ({
      projectId: projectByIssue.get(event.issueId)!,
      name: event.release!,
    }));
  const releases = releasePairs.length
    ? await db.release.findMany({
        where: { OR: releasePairs },
        include: { deployments: true },
      })
    : [];
  const releasesByName = new Map(
    releases.map((release) => [
      `${release.projectId}:${release.name}`,
      release,
    ]),
  );

  return (
    <div className="page">
      <Heading
        title="Issues"
        description="Find, investigate, and resolve errors across your applications."
      />
      <section className="panel issue-browser">
        <div className="status-tabs" aria-label="Issue status">
          {[
            ["all", "All issues"],
            ["open", "Open"],
            ["regression", "Regressions"],
            ["resolved", "Resolved"],
          ].map(([value, label]) => (
            <Link
              key={value}
              aria-current={filters.status === value ? "page" : undefined}
              href={linkTo("/issues", { ...filters, status: value, page: 1 })}
            >
              {label}
            </Link>
          ))}
          <span className="muted result-count">{number(total)} issues</span>
        </div>
        <form key={JSON.stringify(filters)} className="filters" method="get">
          <SortFields sorting={filters} />
          <input type="hidden" name="status" value={filters.status} />

          <label className="filter-field search-field">
            Search
            <input
              name="q"
              placeholder="Search by error type or message…"
              defaultValue={filters.q}
              maxLength={160}
            />
          </label>
          <ProjectSelect projects={projects} selected={filters.project} />
          <label className="filter-field">
            Environment
            <select
              aria-label="Environment"
              name="environment"
              defaultValue={filters.environment}
            >
              <option value="all">All environments</option>
              {["production", "staging", "development"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            Release
            <select
              name="release"
              defaultValue={filters.release}
              aria-label="Release"
            >
              <option value="">All releases</option>
              {filters.release &&
                !selectableReleases.some((r) => r.name === filters.release) && (
                  <option value={filters.release}>
                    {releaseLabel(filters.release)}
                  </option>
                )}
              {selectableReleases.map((r) => (
                <option key={r.id} value={r.name}>
                  {r.project.name} · {releaseLabel(r.name, r.appVersion)}
                  {r.appVersion ? ` · ${releaseLabel(r.name)}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            First appearance
            <select
              name="novelty"
              defaultValue={filters.novelty}
              aria-label="First appearance"
            >
              <option value="all">All issues</option>
              <option value="new">New in selected release</option>
            </select>
          </label>
          <label className="filter-field">
            Source context
            <select
              aria-label="Source context"
              name="source"
              defaultValue={filters.source}
            >
              <option value="all">All issues</option>
              <option value="mapped">Has source context</option>
              <option value="unmapped">Compiled stacks only</option>
            </select>
          </label>
          <label className="filter-field">
            Time range
            <select
              aria-label="Time range"
              name="period"
              defaultValue={filters.period}
            >
              <option value="all">All time</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
          <button className="button">Apply filters</button>
        </form>
        {!filters.release && (
          <p className="content-note">
            Choose a release to filter issues first observed in that build.
            History expires after 90 days without activity.
          </p>
        )}
        {filters.release && (
          <div className="active-filters">
            <span className="pill mono">
              Release:{" "}
              {releaseLabel(
                filters.release,
                selectableReleases.find((r) => r.name === filters.release)
                  ?.appVersion,
              )}
            </span>
            <Link
              className="text-link"
              href={linkTo("/issues", {
                ...filters,
                release: undefined,
                page: 1,
              })}
            >
              Clear release ×
            </Link>
          </div>
        )}
        {issues.length ? (
          <div className="table-scroll">
            <table className="issues-table">
              <SortableTableHead
                table="issues"
                sorting={filters}
                path="/issues"
                values={filters}
              />
              <tbody>
                {issues.map((issue) => {
                  const latest = latestByIssue.get(issue.id);
                  const release = latest?.release
                    ? releasesByName.get(`${issue.projectId}:${latest.release}`)
                    : undefined;

                  const first = issue.histories.find(
                    (h) => h.environment === latest?.environment,
                  );

                  return (
                    <tr key={issue.id}>
                      <td>
                        <div className="issue-cell">
                          <Link
                            className="issue-title"
                            href={linkTo(`/issues/${issue.id}`, {
                              event: latest?.eventId,
                            })}
                          >
                            <span className="issue-icon">!</span>
                            <span>
                              <strong>{issue.exceptionType}</strong>
                              <small title={issue.title}>{issue.title}</small>
                            </span>
                          </Link>
                          {first?.firstSeenKnown &&
                            first.firstRelease &&
                            first.firstRelease === latest?.release && (
                              <NewInRelease
                                release={first.firstRelease}
                                appVersion={
                                  release?.appVersion ?? first.firstAppVersion
                                }
                              />
                            )}
                          {latest ? (
                            <IssueBuildContext
                              projectId={issue.projectId}
                              environment={latest.environment}
                              releaseName={latest.release}
                              appVersion={latest.appVersion}
                              release={release}
                              symbolicationState={latest.symbolicationState}
                            />
                          ) : (
                            <span className="muted issue-no-event">
                              No retained event
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <Link
                          className="text-link"
                          href={`/projects/${issue.projectId}`}
                        >
                          {issue.project.name}
                        </Link>
                      </td>
                      <td>
                        <Status
                          status={issue.status}
                          regression={issue.regression}
                        />
                      </td>
                      <td className="numeric">{number(issue.eventCount)}</td>
                      <td className="muted date-cell">
                        {dateTime(issue.firstSeen)}
                      </td>
                      <td className="muted date-cell">
                        {dateTime(issue.lastSeen)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No issues match this view"
            action={<Link href="/issues">Clear all filters</Link>}
          >
            Try a different project, search term, or time range.
          </Empty>
        )}
        <Pagination
          path="/issues"
          values={filters}
          page={filters.page}
          total={total}
        />
      </section>
    </div>
  );
}
