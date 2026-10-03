import Link from "next/link";
import { dateTime, number } from "../../lib/format";
import { linkTo } from "../../lib/search-params";
import type { ActivityFilters } from "../../lib/activity";
import { Status } from "../dashboard/Status";
import { Empty } from "../dashboard/Empty";

export function TopIssues({
  issues,
  filters,
}: {
  issues: {
    id: string;
    title: string;
    exceptionType: string;
    project: { name: string };
    matchingEvents: number;
    latest: Date;
    status: string;
    regression: boolean;
    eventId?: string;
  }[];
  filters: ActivityFilters;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Most frequent open issues</h2>
          <p className="muted">
            Ranked by events in the selected period and environment
          </p>
        </div>
        <Link
          className="text-link"
          href={linkTo("/issues", { ...filters, status: "open" })}
        >
          All open issues ↗
        </Link>
      </div>
      {issues.length ? (
        <div className="top-issues">
          {issues.map((issue) => (
            <Link
              className="top-issue"
              key={issue.id}
              href={linkTo(`/issues/${issue.id}`, {
                event: issue.eventId,
                activityPeriod: filters.period,
                activityEnvironment: filters.environment,
              })}
            >
              <span className="issue-icon" aria-hidden="true">
                !
              </span>
              <span className="grow">
                <strong>
                  {issue.exceptionType}: {issue.title}
                </strong>
                <small className="muted">
                  {issue.project.name} · Latest {dateTime(issue.latest)}
                </small>
              </span>
              <Status status={issue.status} regression={issue.regression} />
              <span className="health-count">
                <strong>{number(issue.matchingEvents)}</strong>
                <small className="muted">events in view</small>
              </span>
              <span aria-hidden="true">↗</span>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="No open issues in this view">
          No currently open issues received events in the selected period.
        </Empty>
      )}
    </section>
  );
}
