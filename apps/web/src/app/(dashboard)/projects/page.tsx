import { projectScope } from "../../../server/access";
import { PAGE_SIZE } from "../../../lib/pagination";
import Link from "next/link";
import { getRuntime } from "../../../server/runtime";
import { dashboardUser } from "../../../server/dashboard";
import { Empty } from "../../../components/dashboard/Empty";
import { Heading } from "../../../components/dashboard/Heading";
import { Pagination } from "../../../components/dashboard/Pagination";
import { dateTime, number } from "../../../lib/format";
import { pageNumber, textParam, type Search } from "../../../lib/search-params";
import { tableSort } from "../../../lib/table-sort";
import { projectPageIds } from "../../../server/projects/list";
import { inPageOrder } from "../../../server/table-order";
import { SortableTableHead } from "../../../components/dashboard/SortableTableHead";
import { SortFields } from "../../../components/dashboard/SortFields";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const search = await searchParams;
  const q = textParam(search.q);
  const page = pageNumber(search.page);
  const sorting = tableSort(search, "projects");
  const values = { q, ...sorting };
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const where = {
    ...projectScope(member),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { slug: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const ids = await projectPageIds(db, member, q, sorting, page);
  const [rows, total] = await Promise.all([
    db.project.findMany({
      where: { ...where, id: { in: ids.map(({ id }) => id) } },
      take: PAGE_SIZE,
      include: {
        teams: {
          orderBy: { team: { name: "asc" } },
          include: { team: { select: { name: true } } },
        },
        _count: {
          select: {
            issues: { where: { status: "open", eventCount: { gt: 0 } } },
            events: true,
          },
        },
      },
    }),
    db.project.count({ where }),
  ]);
  const projects = inPageOrder(rows, ids);

  return (
    <div className="page">
      <Heading
        title="Projects"
        description="One place for each application, its errors, and its releases."
        action={
          member.role === "owner" && (
            <div className="actions">
              <Link className="button" href="/projects/deleted">
                Deleted projects
              </Link>
              <Link className="button primary" href="/projects/new">
                ＋ Create project
              </Link>
            </div>
          )
        }
      />
      <section className="panel">
        <form key={q} method="get" className="filters">
          <SortFields sorting={sorting} />
          <label className="filter-field search-field">
            Search projects
            <input
              name="q"
              placeholder="Search by project name or slug…"
              maxLength={160}
              defaultValue={q}
            />
          </label>
          <button className="button">Search</button>
        </form>
        {projects.length ? (
          <div className="table-scroll">
            <table>
              <SortableTableHead
                table="projects"
                sorting={sorting}
                path="/projects"
                values={values}
              />
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link
                        className="project-title"
                        href={`/projects/${p.id}`}
                      >
                        <span className="project-mark">
                          {p.name.slice(0, 1)}
                        </span>
                        <span>
                          <strong>{p.name}</strong>
                          <small className="muted">{p.slug}</small>
                        </span>
                      </Link>
                    </td>
                    <td>
                      {p.teams.map((team) => team.team.name).join(", ") || "—"}
                    </td>
                    <td>
                      <span className={`pill ${p.enabled ? "resolved" : ""}`}>
                        {p.enabled ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td className="numeric">{number(p._count.issues)}</td>
                    <td className="numeric">{number(p._count.events)}</td>
                    <td className="muted date-cell">{dateTime(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={
              q
                ? "No matching projects"
                : member.role === "owner"
                  ? "Connect your first application"
                  : "No projects assigned"
            }
            action={
              (q || member.role === "owner") && (
                <Link href={q ? "/projects" : "/projects/new"}>
                  {q ? "Clear search" : "Create project ↗"}
                </Link>
              )
            }
          >
            {member.role === "owner"
              ? "Projects organize your errors, releases, and application origins."
              : "Ask an Owner to add you to a team with project access."}
          </Empty>
        )}
        <Pagination
          path="/projects"
          values={values}
          page={page}
          total={total}
        />
      </section>
    </div>
  );
}
