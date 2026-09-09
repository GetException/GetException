import { projectScope } from "../../../server/access";
import { PAGE_SIZE } from "../../../lib/pagination";
import Link from "next/link";
import type { Prisma } from "@getexception/db";
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

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const filters = issueFilters(await searchParams);
  const where = issueWhere(member, filters);
  const orderBy: Prisma.IssueOrderByWithRelationInput[] =
    filters.sort === "events"
      ? [{ eventCount: "desc" }, { id: "desc" }]
      : filters.sort === "first"
        ? [{ firstSeen: "desc" }, { id: "desc" }]
        : [{ lastSeen: "desc" }, { id: "desc" }];
  const [projects, issues, total] = await Promise.all([
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
      include: { project: { select: { name: true } } },
    }),
    db.issue.count({ where }),
  ]);

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
        <form className="filters" method="get">
          <input type="hidden" name="status" value={filters.status} />
          {filters.release && (
            <input type="hidden" name="release" value={filters.release} />
          )}
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
          <label className="filter-field">
            Sort
            <select aria-label="Sort" name="sort" defaultValue={filters.sort}>
              <option value="recent">Last seen</option>
              <option value="events">Most events</option>
              <option value="first">First seen</option>
            </select>
          </label>
          <button className="button">Apply filters</button>
        </form>
        {filters.release && (
          <div className="active-filters">
            <span className="pill mono">Release: {filters.release}</span>
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
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Project</th>
                  <th>Status</th>
                  <th className="numeric">Events</th>
                  <th>First seen</th>
                  <th>Last seen</th>
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
                          <small title={issue.title}>{issue.title}</small>
                        </span>
                      </Link>
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
                ))}
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
