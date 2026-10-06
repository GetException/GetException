import { historyScope } from "../../../../server/issues/history";
import { IssueReleaseHistory } from "../../../../components/issues/IssueReleaseHistory";
import { NewInRelease } from "../../../../components/issues/NewInRelease";
import { projectScope, canResolve } from "../../../../server/access";
import { EVENT_PAGE_SIZE } from "../../../../lib/pagination";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getRuntime } from "../../../../server/runtime";
import { dashboardUser } from "../../../../server/dashboard";
import {
  safeFrameSchema,
  safeBreadcrumbSchema,
  originalFrameSchema,
} from "@getexception/protocol";
import { dateTime, number, releaseLabel } from "../../../../lib/format";
import {
  linkTo,
  pageNumber,
  textParam,
  type Search,
} from "../../../../lib/search-params";
import { Pagination } from "../../../../components/dashboard/Pagination";
import { Status } from "../../../../components/dashboard/Status";
import { EventTabs } from "../../../../components/issues/EventTabs";
import { IssueStatusButton } from "../../../../components/issues/IssueStatusButton";
import { StackTrace } from "../../../../components/issues/StackTrace";
import { IssueActivity } from "../../../../components/issues/IssueActivity";
import { EventDiagnostics } from "../../../../components/issues/EventDiagnostics";
import { IssueBuildContext } from "../../../../components/issues/IssueBuildContext";
import { ActivityFilters } from "../../../../components/analytics/ActivityFilters";
import { ActivityChart } from "../../../../components/analytics/ActivityChart";
import { EventBreakdown } from "../../../../components/analytics/EventBreakdown";
import {
  eventActivity,
  eventBreakdowns,
} from "../../../../server/analytics/activity";
import {
  activityFilters,
  activityWindow,
  ACTIVITY_PERIODS,
} from "../../../../lib/activity";
import { tableSort } from "../../../../lib/table-sort";
import { eventOrder } from "../../../../server/issues/sorting";
import { SortableTableHead } from "../../../../components/dashboard/SortableTableHead";

export default async function IssuePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const page = pageNumber(search.page);
  const eventId = textParam(search.event, 32);
  const sorting = tableSort(search, "events");
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const issue = await db.issue.findFirst({
    where: { id, project: projectScope(member) },
    include: {
      project: { select: { name: true } },
      histories: { where: historyScope(), orderBy: { environment: "asc" } },
    },
  });

  if (!issue) {
    notFound();
  }

  const activities = await db.issueActivity.findMany({
    where: {
      projectId: issue.projectId,
      OR: [{ fromIssueId: issue.id }, { toIssueId: issue.id }],
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const scope = { issueId: issue.id, projectId: issue.projectId };
  const analyticsFilters = {
    ...activityFilters(search, "activity", "7d"),
    project: issue.projectId,
  };
  const window = activityWindow(analyticsFilters.period);
  const activityValues = {
    activityPeriod: analyticsFilters.period,
    activityEnvironment: analyticsFilters.environment,
  };
  const breakdownCaption = `${ACTIVITY_PERIODS[analyticsFilters.period].label} · ${analyticsFilters.environment === "all" ? "all environments" : analyticsFilters.environment}`;
  const ordering = [{ receivedAt: "desc" as const }, { id: "desc" as const }];
  const [selected, events, retained, activity, breakdowns] = await Promise.all([
    db.errorEvent.findFirst({
      where: { ...scope, ...(eventId ? { eventId } : {}) },
      orderBy: ordering,
    }),
    db.errorEvent.findMany({
      where: scope,
      orderBy: eventOrder(sorting),
      skip: (page - 1) * EVENT_PAGE_SIZE,
      take: EVENT_PAGE_SIZE,
      select: {
        id: true,
        eventId: true,
        receivedAt: true,
        release: true,
        appVersion: true,
        environment: true,
        handled: true,
        level: true,
      },
    }),
    db.errorEvent.count({ where: scope }),
    eventActivity(db, member, analyticsFilters, window, issue.id),
    eventBreakdowns(db, member, analyticsFilters, window, issue.id),
  ]);

  if (eventId && !selected) {
    notFound();
  }

  const [older, newer, release] = selected
    ? await Promise.all([
        db.errorEvent.findFirst({
          where: {
            ...scope,
            OR: [
              { receivedAt: { lt: selected.receivedAt } },
              { receivedAt: selected.receivedAt, id: { lt: selected.id } },
            ],
          },
          orderBy: ordering,
          select: { eventId: true },
        }),
        db.errorEvent.findFirst({
          where: {
            ...scope,
            OR: [
              { receivedAt: { gt: selected.receivedAt } },
              { receivedAt: selected.receivedAt, id: { gt: selected.id } },
            ],
          },
          orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
          select: { eventId: true },
        }),
        selected.release
          ? db.release.findUnique({
              where: {
                projectId_name: {
                  projectId: issue.projectId,
                  name: selected.release,
                },
              },
              select: { id: true, appVersion: true, deployments: true },
            })
          : null,
      ])
    : [null, null, null];
  const historyReleases = await db.release.findMany({
    where: {
      projectId: issue.projectId,
      name: {
        in: issue.histories.flatMap((h) =>
          [h.firstRelease, h.lastRelease].filter((r): r is string =>
            Boolean(r),
          ),
        ),
      },
    },
    select: { id: true, name: true, appVersion: true },
    take: 6,
  });
  const first = issue.histories.find(
    (h) => h.environment === selected?.environment,
  );
  const originals = originalFrameSchema
    .nullable()
    .array()
    .safeParse(selected?.originalFrames ?? []);
  const frames = safeFrameSchema.array().safeParse(selected?.frames ?? []);
  const breadcrumbs = safeBreadcrumbSchema
    .array()
    .safeParse(selected?.breadcrumbs ?? []);
  const tags =
    selected?.tags &&
    typeof selected.tags === "object" &&
    !Array.isArray(selected.tags)
      ? Object.entries(selected.tags).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )
      : [];

  return (
    <div className="page issue-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href="/issues">Issues</Link>
        <span>›</span>
        <span>{issue.exceptionType}</span>
      </nav>
      <div className="issue-heading">
        <div className="issue-heading-text">
          <h1>
            {issue.exceptionType}: {issue.title}
          </h1>
          <div className="issue-subtitle">
            <Link href={`/projects/${issue.projectId}`}>
              ⬡ {issue.project.name}
            </Link>
            {selected && (
              <>
                <span className="separator" />
                <IssueBuildContext
                  projectId={issue.projectId}
                  environment={selected.environment}
                  releaseName={selected.release}
                  release={release}
                  appVersion={selected.appVersion}
                />
              </>
            )}
          </div>
        </div>
        <div className="actions">
          {first?.firstSeenKnown &&
            first.firstRelease &&
            first.firstRelease === selected?.release && (
              <NewInRelease
                release={first.firstRelease}
                appVersion={release?.appVersion ?? first.firstAppVersion}
              />
            )}
          <Status status={issue.status} regression={issue.regression} />
        </div>
      </div>
      <div className="issue-toolbar">
        <span className="muted small">
          {selected
            ? `Selected event · ${dateTime(selected.receivedAt)}`
            : "No retained events"}
        </span>
        <div className="actions">
          {older ? (
            <Link
              className="button"
              href={linkTo(`/issues/${issue.id}`, {
                event: older.eventId,
                ...sorting,
                ...activityValues,
                page,
              })}
            >
              ← Previous event
            </Link>
          ) : (
            <span className="button disabled" aria-disabled="true">
              ← Previous event
            </span>
          )}
          {newer ? (
            <Link
              className="button"
              href={linkTo(`/issues/${issue.id}`, {
                event: newer.eventId,
                ...sorting,
                ...activityValues,
                page,
              })}
            >
              Next event →
            </Link>
          ) : (
            <span className="button disabled" aria-disabled="true">
              Next event →
            </span>
          )}
          {canResolve(member) && (
            <IssueStatusButton
              key={`${issue.id}:${issue.status}:${issue.eventCount}`}
              id={issue.id}
              status={issue.status}
              eventCount={issue.eventCount}
            />
          )}
        </div>
      </div>
      <section className="panel">
        <ActivityFilters
          filters={analyticsFilters}
          prefix="activity"
          preserve={{ ...sorting, event: selected?.eventId, page }}
        />
      </section>
      <ActivityChart
        key={JSON.stringify(analyticsFilters)}
        data={activity}
        period={analyticsFilters.period}
        title="Issue activity"
      />
      <div className="issue-columns">
        <div className="issue-stack-column">
          <StackTrace
            key={selected?.id ?? "empty"}
            frames={frames.success ? frames.data : []}
            originals={originals.success ? originals.data : []}
            state={selected?.symbolicationState}
          />
        </div>
        <aside className="panel event-aside">
          <div className="section-heading">
            <h2>Event details</h2>
          </div>
          <dl className="detail-list">
            <div>
              <dt>First seen</dt>
              <dd>{dateTime(issue.firstSeen)}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{dateTime(issue.lastSeen)}</dd>
            </div>
            <div>
              <dt>Total events</dt>
              <dd>{number(issue.eventCount)}</dd>
            </div>
            <div>
              <dt>Retained events</dt>
              <dd>{number(retained)}</dd>
            </div>
          </dl>
          {selected && (
            <>
              <dl className="detail-list">
                <div>
                  <dt>Environment</dt>
                  <dd>{selected.environment}</dd>
                </div>
                <div>
                  <dt>Level</dt>
                  <dd>
                    <span className="pill">{selected.level}</span>
                  </dd>
                </div>
                <div>
                  <dt>Handling</dt>
                  <dd>{selected.handled ? "Handled" : "Unhandled"}</dd>
                </div>
                {selected.route && (
                  <div>
                    <dt>Route</dt>
                    <dd className="mono">{selected.route}</dd>
                  </div>
                )}
                <div>
                  <dt>Release</dt>
                  <dd>
                    {release ? (
                      <Link
                        className="text-link mono"
                        href={`/releases/${release.id}`}
                      >
                        {releaseLabel(
                          selected.release!,
                          release.appVersion ?? selected.appVersion,
                        )}
                      </Link>
                    ) : (
                      "Not provided"
                    )}
                  </dd>
                </div>
                {selected.dist && (
                  <div>
                    <dt>Distribution</dt>
                    <dd>{selected.dist}</dd>
                  </div>
                )}
              </dl>
              <IssueReleaseHistory
                observations={issue.histories.filter(
                  (h) => h.environment === selected.environment,
                )}
                releases={historyReleases}
              />
              <EventDiagnostics event={selected} />
              <div className="tags-section">
                <h3>Tags</h3>
                {tags.length ? (
                  <div className="tag-cloud">
                    {tags.map(([key, value]) => (
                      <span className="tag" key={key}>
                        <span>{key}</span>
                        {value}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="muted small">No tags recorded</span>
                )}
              </div>
              <dl className="detail-list event-identifier">
                <div>
                  <dt>Event identifier</dt>
                  <dd className="mono">{selected.eventId}</dd>
                </div>
              </dl>
            </>
          )}
        </aside>
      </div>
      <details className="panel activity-distributions">
        <summary>
          Browsers and releases{" "}
          <span className="muted small">{breakdownCaption}</span>
        </summary>
        <div className="overview-columns">
          <EventBreakdown
            title="Browsers"
            total={activity.total}
            caption={breakdownCaption}
            rows={breakdowns.browsers.map((row) => ({
              label: row.label ?? "Not reported",
              count: row.count,
            }))}
          />
          <EventBreakdown
            title="Releases"
            total={activity.total}
            caption={breakdownCaption}
            rows={breakdowns.releases.map((row) => ({
              label: row.label
                ? releaseLabel(row.label, row.appVersion)
                : "Not reported",
              title: row.label ?? undefined,
              count: row.count,
              href: row.releaseId
                ? linkTo(`/releases/${row.releaseId}`, {
                    environment: analyticsFilters.environment,
                  })
                : undefined,
            }))}
          />
        </div>
      </details>
      <IssueActivity issueId={issue.id} activities={activities} />
      <EventTabs
        breadcrumbs={breadcrumbs.success ? breadcrumbs.data : []}
        events={
          <>
            <div className="table-scroll">
              <table className="events-table">
                <SortableTableHead
                  table="events"
                  sorting={sorting}
                  path={`/issues/${issue.id}`}
                  values={{
                    ...sorting,
                    ...activityValues,
                    event: selected?.eventId,
                    page,
                  }}
                />
                <tbody>
                  {events.map((event) => (
                    <tr
                      key={event.id}
                      data-selected={selected?.id === event.id}
                    >
                      <td>
                        <Link
                          className="text-link"
                          href={linkTo(`/issues/${issue.id}`, {
                            event: event.eventId,
                            ...sorting,
                            ...activityValues,
                            page,
                          })}
                        >
                          {dateTime(event.receivedAt)}
                        </Link>
                      </td>
                      <td className="mono">
                        {event.eventId.slice(0, 8)}
                        {selected?.id === event.id && (
                          <span className="pill selected-label">Selected</span>
                        )}
                      </td>
                      <td className="mono">
                        {event.release
                          ? releaseLabel(
                              event.release,
                              historyReleases.find(
                                (r) => r.name === event.release,
                              )?.appVersion ?? event.appVersion,
                            )
                          : "—"}
                      </td>
                      <td>{event.environment}</td>
                      <td>{event.level}</td>
                      <td>{event.handled ? "Handled" : "Unhandled"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!events.length && (
              <p className="content-note">
                Individual events have expired. Group history is retained.
              </p>
            )}
            <Pagination
              path={`/issues/${issue.id}`}
              values={{
                event: selected?.eventId,
                ...sorting,
                ...activityValues,
              }}
              page={page}
              total={retained}
              size={EVENT_PAGE_SIZE}
            />
          </>
        }
      />
    </div>
  );
}
