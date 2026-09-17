import Link from "next/link";
import { projectScope } from "../../../server/access";
import { PAGE_SIZE } from "../../../lib/pagination";
import { getRuntime } from "../../../server/runtime";
import { dashboardUser } from "../../../server/dashboard";
import { releaseFilters, releaseWhere } from "../../../server/releases/filters";
import { Empty } from "../../../components/dashboard/Empty";
import { Heading } from "../../../components/dashboard/Heading";
import { Pagination } from "../../../components/dashboard/Pagination";
import { ProjectSelect } from "../../../components/dashboard/ProjectSelect";
import { ReleaseContext } from "../../../components/releases/ReleaseContext";
import {
  ENVIRONMENT_LABELS,
  sourceMapStatus,
  reviewLabel,
  releaseReviews,
} from "../../../components/releases/presentation";
import { dateTime, number, releaseLabel } from "../../../lib/format";
import { linkTo, type Search } from "../../../lib/search-params";

export default async function ReleasesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const filters = releaseFilters(await searchParams);
  const { project, q, environment, review, page } = filters;
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const where = releaseWhere(member, filters);
  const [releases, total, projects] = await Promise.all([
    db.release.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { project: { select: { name: true } }, deployments: true },
    }),
    db.release.count({ where }),
    db.project.findMany({
      where: projectScope(member),
      orderBy: { name: "asc" },
      take: 200,
      select: { id: true, name: true },
    }),
  ]);
  const counts = releases.length
    ? await db.errorEvent.groupBy({
        by: ["projectId", "release"],
        where: {
          OR: releases.map((release) => ({
            projectId: release.projectId,
            release: release.name,
          })),
          ...(environment !== "all" ? { environment } : {}),
        },
        _count: { _all: true },
        _max: { receivedAt: true },
      })
    : [];
  const groups = new Map<string, typeof releases>();

  for (const release of releases) {
    const reviews = releaseReviews(release.deployments);
    const key =
      environment === "staging" && !review && reviews.length === 1
        ? `${release.projectId}/${reviews[0]}`
        : "";
    const group = groups.get(key) ?? [];

    group.push(release);
    groups.set(key, group);
  }

  return (
    <div className="page">
      <Heading
        title={review ? `${reviewLabel(review)} · Builds` : "Releases"}
        description="Each version identifies a build. Filter by environment or open a merge request to compare its builds."
      />
      <section className="panel">
        <nav className="status-tabs" aria-label="Release environments">
          {[
            ["all", "All environments"],
            ...Object.entries(ENVIRONMENT_LABELS),
          ].map(([value, label]) => (
            <Link
              key={value}
              href={linkTo("/releases", {
                project,
                q,
                environment: value,
                ...(value === "staging" ? { review } : {}),
              })}
              aria-current={environment === value ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form className="filters" method="get">
          <input type="hidden" name="environment" value={environment} />
          {review && <input type="hidden" name="review" value={review} />}
          <label className="filter-field search-field">
            Search releases
            <input
              name="q"
              defaultValue={q}
              placeholder="Release name or commit SHA…"
              maxLength={160}
            />
          </label>
          <ProjectSelect projects={projects} selected={project} />
          <button className="button">Apply filters</button>
          {review && (
            <Link
              className="text-link"
              href={linkTo("/releases", { project, environment, q })}
            >
              All merge requests
            </Link>
          )}
        </form>
        {releases.length ? (
          <div className="table-scroll">
            <table className="releases-table">
              <thead>
                <tr>
                  <th>Version / project</th>
                  <th>Environment</th>
                  <th>Merge request</th>
                  <th>Latest event</th>
                  <th className="numeric">Events</th>
                  <th>Source maps</th>
                </tr>
              </thead>
              {[...groups].map(([group, items]) => (
                <tbody key={group || "releases"}>
                  {group && (
                    <tr className="release-group">
                      <th colSpan={6} scope="rowgroup">
                        <Link
                          href={linkTo("/releases", {
                            project: items[0]!.projectId,
                            environment,
                            review: releaseReviews(items[0]!.deployments)[0],
                          })}
                        >
                          {reviewLabel(
                            releaseReviews(items[0]!.deployments)[0]!,
                          )}{" "}
                          · {items[0]!.project.name}
                          <span>View all builds ↗</span>
                        </Link>
                      </th>
                    </tr>
                  )}
                  {items.map((release) => {
                    const count = counts.find(
                      (value) =>
                        value.projectId === release.projectId &&
                        value.release === release.name,
                    );
                    const maps = sourceMapStatus(release.sourceMapsState);

                    return (
                      <tr key={release.id}>
                        <td>
                          <Link
                            className="release-title"
                            href={linkTo(`/releases/${release.id}`, {
                              environment,
                            })}
                          >
                            <span className="release-mark" aria-hidden="true">
                              ◇
                            </span>
                            <span>
                              <strong className="mono" title={release.name}>
                                {releaseLabel(release.name)}
                              </strong>
                              <small className="muted">
                                {release.project.name}
                              </small>
                            </span>
                          </Link>
                        </td>
                        <td>
                          <ReleaseContext
                            projectId={release.projectId}
                            deployments={release.deployments}
                            showReviews={false}
                          />
                        </td>
                        <td>
                          <div className="release-context">
                            {releaseReviews(release.deployments).length ? (
                              releaseReviews(release.deployments).map((key) => (
                                <Link
                                  className="review-badge"
                                  key={key}
                                  href={linkTo("/releases", {
                                    project: release.projectId,
                                    environment: "staging",
                                    review: key,
                                  })}
                                >
                                  {reviewLabel(key)} ↗
                                </Link>
                              ))
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </div>
                        </td>
                        <td className="date-cell">
                          {count?._max.receivedAt ? (
                            dateTime(count._max.receivedAt)
                          ) : (
                            <span className="muted">No retained events</span>
                          )}
                        </td>
                        <td className="numeric">
                          {number(count?._count._all ?? 0)}
                        </td>
                        <td>
                          <span
                            className={`pill map-state map-${maps.tone}`}
                            title={maps.caption}
                          >
                            {maps.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        ) : (
          <Empty title="No releases found">
            Try another environment or clear the filters.
          </Empty>
        )}
        <Pagination
          path="/releases"
          values={{ project, q, environment, review }}
          page={page}
          total={total}
        />
      </section>
    </div>
  );
}
