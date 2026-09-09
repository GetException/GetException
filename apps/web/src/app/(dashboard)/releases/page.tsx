import { projectScope } from "../../../server/access";
import { PAGE_SIZE } from "../../../lib/pagination";
import Link from "next/link";
import { getRuntime } from "../../../server/runtime";
import { dashboardUser } from "../../../server/dashboard";
import { Empty } from "../../../components/dashboard/Empty";
import { Heading } from "../../../components/dashboard/Heading";
import { Pagination } from "../../../components/dashboard/Pagination";
import { ProjectSelect } from "../../../components/dashboard/ProjectSelect";
import { dateTime, number, releaseLabel } from "../../../lib/format";
import { pageNumber, textParam, type Search } from "../../../lib/search-params";

export default async function ReleasesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const search = await searchParams;
  const q = textParam(search.q);
  const project = textParam(search.project, 64);
  const page = pageNumber(search.page);
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const where = {
    project: {
      ...projectScope(member),
      ...(project ? { id: project } : {}),
    },
    ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
  };
  const [releases, total, projects] = await Promise.all([
    db.release.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { project: { select: { name: true } } },
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
        },
        _count: { _all: true },
        _max: { receivedAt: true },
      })
    : [];

  return (
    <div className="page">
      <Heading
        title="Releases"
        description="Follow application versions and the errors associated with each one."
      />
      <section className="panel">
        <form className="filters" method="get">
          <label className="filter-field search-field">
            Search releases
            <input
              name="q"
              defaultValue={q}
              placeholder="Search by release name or commit…"
              maxLength={160}
            />
          </label>
          <ProjectSelect projects={projects} selected={project} />
          <button className="button">Apply filters</button>
        </form>
        {releases.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Release</th>
                  <th>Project</th>
                  <th>First received</th>
                  <th>Latest event</th>
                  <th className="numeric">Retained events</th>
                  <th>Source maps</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((release) => {
                  const count = counts.find(
                    (value) =>
                      value.projectId === release.projectId &&
                      value.release === release.name,
                  );

                  return (
                    <tr key={release.id}>
                      <td>
                        <Link
                          className="release-title"
                          href={`/releases/${release.id}`}
                        >
                          <span className="release-mark">◇</span>
                          <span>
                            <strong className="mono">
                              {releaseLabel(release.name)}
                            </strong>
                            <small className="muted mono" title={release.name}>
                              {release.name}
                            </small>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <Link
                          className="text-link"
                          href={`/projects/${release.projectId}`}
                        >
                          {release.project.name}
                        </Link>
                      </td>
                      <td className="muted date-cell">
                        {dateTime(release.createdAt)}
                      </td>
                      <td className="muted date-cell">
                        {count?._max.receivedAt
                          ? dateTime(count._max.receivedAt)
                          : "—"}
                      </td>
                      <td className="numeric">
                        {number(count?._count._all ?? 0)}
                      </td>
                      <td>
                        <span className="pill">Unavailable</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No releases found">
            Pass a release in SDK initialization to associate events with an
            application version.
          </Empty>
        )}
        <Pagination
          path="/releases"
          values={{ project, q }}
          page={page}
          total={total}
        />
      </section>
    </div>
  );
}
