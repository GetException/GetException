import { projectScope, canResolve } from "../../../../server/access";
import { EVENT_PAGE_SIZE } from "../../../../lib/pagination";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getRuntime } from "../../../../server/runtime";
import { dashboardUser } from "../../../../server/dashboard";
import { safeFrameSchema, safeBreadcrumbSchema } from "@getexception/protocol";
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
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const issue = await db.issue.findFirst({
    where: { id, project: projectScope(member) },
    include: { project: { select: { name: true } } },
  });

  if (!issue) {
    notFound();
  }

  const scope = { issueId: issue.id, projectId: issue.projectId };
  const ordering = [{ receivedAt: "desc" as const }, { id: "desc" as const }];
  const [selected, events, retained] = await Promise.all([
    db.errorEvent.findFirst({
      where: { ...scope, ...(eventId ? { eventId } : {}) },
      orderBy: ordering,
    }),
    db.errorEvent.findMany({
      where: scope,
      orderBy: ordering,
      skip: (page - 1) * EVENT_PAGE_SIZE,
      take: EVENT_PAGE_SIZE,
      select: {
        id: true,
        eventId: true,
        receivedAt: true,
        release: true,
        environment: true,
        handled: true,
        level: true,
      },
    }),
    db.errorEvent.count({ where: scope }),
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
              select: { id: true },
            })
          : null,
      ])
    : [null, null, null];
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
                <span>{selected.environment}</span>
                {selected.release && (
                  <>
                    <span className="separator" />
                    {release ? (
                      <Link className="mono" href={`/releases/${release.id}`}>
                        ◇ {releaseLabel(selected.release)}
                      </Link>
                    ) : (
                      <span className="mono">
                        {releaseLabel(selected.release)}
                      </span>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <Status status={issue.status} regression={issue.regression} />
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
      <div className="issue-columns">
        <div className="issue-stack-column">
          <StackTrace
            key={selected?.id ?? "empty"}
            frames={frames.success ? frames.data : []}
            release={selected?.release}
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
                        {releaseLabel(selected.release!)}
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
      <EventTabs
        breadcrumbs={breadcrumbs.success ? breadcrumbs.data : []}
        events={
          <>
            <div className="table-scroll">
              <table className="events-table">
                <thead>
                  <tr>
                    <th>Time · UTC</th>
                    <th>Event</th>
                    <th>Release</th>
                    <th>Environment</th>
                    <th>Level</th>
                    <th>Handling</th>
                  </tr>
                </thead>
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
                        {event.release ? releaseLabel(event.release) : "—"}
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
              values={{ event: selected?.eventId }}
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
