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
import { releasePageIds } from "../../../server/releases/list";
import { inPageOrder } from "../../../server/table-order";
import { SortableTableHead } from "../../../components/dashboard/SortableTableHead";
import { SortFields } from "../../../components/dashboard/SortFields";

export default async function ReleasesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const filters = releaseFilters(await searchParams);
  const { project, q, environment, review, maps, page } = filters;
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const where = releaseWhere(member, filters);
  const ids = await releasePageIds(db, member, filters);
  const [rows, total, projects] = await Promise.all([
    db.release.findMany({
      where: { ...where, id: { in: ids.map(({ id }) => id) } },
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
  const releases = inPageOrder(rows, ids);
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
  const groups: { key: string; items: typeof releases }[] = [];

  for (const release of releases) {
    const reviews = releaseReviews(release.deployments);
    const key =
      environment === "staging" && !review && reviews.length === 1
        ? `${release.projectId}/${reviews[0]}`
        : "";
    const previous = groups.at(-1);

    // Group adjacent builds only; regrouping the whole page would undo sorting.
    if (previous?.key === key) {
      previous.items.push(release);
    } else {
      groups.push({ key, items: [release] });
    }
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
                ...filters,
                page: 1,
                environment: value,
                review: value === "staging" ? review : undefined,
              })}
              aria-current={environment === value ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form key={JSON.stringify(filters)} className="filters" method="get">
          <SortFields sorting={filters} />
          <input type="hidden" name="environment" value={environment} />
          {review && <input type="hidden" name="review" value={review} />}
          <label className="filter-field search-field">
            Search releases
            <input
              name="q"
              defaultValue={q}
              placeholder="App version or commit SHA…"
              maxLength={160}
            />
          </label>
          <ProjectSelect projects={projects} selected={project} />
          <label className="filter-field">
            Source maps
            <select aria-label="Source maps" name="maps" defaultValue={maps}>
              <option value="all">All states</option>
              <option value="ready">Available</option>
              <option value="unavailable">Unavailable</option>
              <option value="removed">Removed</option>
              <option value="missing">Not uploaded</option>
              <option value="failed">Upload failed</option>
              <option value="pending">Processing</option>
            </select>
          </label>
          <button className="button">Apply filters</button>
          {review && (
            <Link
              className="text-link"
              href={linkTo("/releases", {
                ...filters,
                review: undefined,
                page: 1,
              })}
            >
              All merge requests
            </Link>
          )}
        </form>
        {releases.length ? (
          <div className="table-scroll">
            <table className="releases-table">
              <SortableTableHead
                table="releases"
                sorting={filters}
                path="/releases"
                values={filters}
              />
              {groups.map(({ key: group, items }) => (
                <tbody key={items[0]!.id}>
                  {group && (
                    <tr className="release-group">
                      <th colSpan={6} scope="rowgroup">
                        <Link
                          href={linkTo("/releases", {
                            ...filters,
                            page: 1,
                            project: items[0]!.projectId,
                            environment,
                            review: releaseReviews(items[0]!.deployments)[0],
                            maps,
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
                    const mapStatus = sourceMapStatus(
                      release.sourceMapsState,
                      release.sourceMapsVersion,
                    );

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
                                {releaseLabel(release.name, release.appVersion)}
                              </strong>
                              <small className="muted">
                                {release.project.name}
                                {release.appVersion
                                  ? ` · ${releaseLabel(release.name)}`
                                  : ""}
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
                                    ...filters,
                                    page: 1,
                                    project: release.projectId,
                                    environment: "staging",
                                    review: key,
                                    maps,
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
                            className={`pill map-state map-${mapStatus.tone}`}
                            title={mapStatus.caption}
                          >
                            {mapStatus.label}
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
          values={filters}
          page={page}
          total={total}
        />
      </section>
    </div>
  );
}
