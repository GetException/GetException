import { teamScope, projectScope } from "../../../server/access";
import { TEAM_PAGE_SIZE } from "../../../lib/pagination";
import Link from "next/link";
import { dashboardUser } from "../../../server/dashboard";
import { getRuntime } from "../../../server/runtime";
import { Empty } from "../../../components/dashboard/Empty";
import { Heading } from "../../../components/dashboard/Heading";
import { Pagination } from "../../../components/dashboard/Pagination";
import { pageNumber, textParam, type Search } from "../../../lib/search-params";

export default async function TeamsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { member } = await dashboardUser();
  const { db } = getRuntime();
  const search = await searchParams;
  const q = textParam(search.q);
  const page = pageNumber(search.page);
  const where = {
    ...teamScope(member),
    ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
  };
  const [teams, total] = await Promise.all([
    db.team.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * TEAM_PAGE_SIZE,
      take: TEAM_PAGE_SIZE,
      include: {
        members: {
          take: 8,
          include: {
            member: {
              select: {
                active: true,
                user: { select: { name: true, email: true } },
              },
            },
          },
        },
        projects: {
          where: { project: projectScope(member) },
          take: 8,
          include: { project: { select: { id: true, name: true } } },
        },
        _count: { select: { members: true, projects: true } },
      },
    }),
    db.team.count({ where }),
  ]);

  return (
    <div className="page">
      <Heading
        title="Teams"
        description="See the people and applications connected to each team."
        action={
          member.role === "owner" && (
            <Link href="/teams/new" className="button primary">
              ＋ Create team
            </Link>
          )
        }
      />
      <form className="filters standalone-filters" method="get">
        <label className="filter-field search-field">
          Search teams
          <input
            name="q"
            defaultValue={q}
            placeholder="Search by team name…"
            maxLength={160}
          />
        </label>
        <button className="button">Search</button>
      </form>
      <div className="team-grid">
        {teams.map((team) => (
          <section className="panel team-card" key={team.id}>
            <div className="section-heading">
              {member.role === "owner" && (
                <Link
                  className="button compact"
                  href={`/teams/${team.id}/edit`}
                >
                  Edit team
                </Link>
              )}
              <div className="project-title">
                <span className="project-mark">#</span>
                <div>
                  <h2>{team.name}</h2>
                  <p className="muted">
                    {team._count.members} members · {team._count.projects}{" "}
                    projects
                  </p>
                </div>
              </div>
            </div>
            <div className="team-section">
              <h3>Members</h3>
              {team.members.length ? (
                team.members.map((entry) => (
                  <div className="team-member" key={entry.id}>
                    <span className="avatar purple">
                      {entry.member.user.name.slice(0, 1)}
                    </span>
                    <span className="grow">
                      <strong>{entry.member.user.name}</strong>
                      <small className="muted">{entry.member.user.email}</small>
                    </span>
                    {!entry.member.active && (
                      <span className="pill">Inactive</span>
                    )}
                  </div>
                ))
              ) : (
                <p className="muted">No members assigned.</p>
              )}
              {team._count.members > team.members.length && (
                <Link className="text-link" href="/members">
                  View all members ↗
                </Link>
              )}
            </div>
            <div className="team-section">
              <h3>Projects</h3>
              <div className="tag-cloud">
                {team.projects.map(({ project }) => (
                  <Link
                    className="project-chip"
                    href={`/projects/${project.id}`}
                    key={project.id}
                  >
                    ⬡ {project.name} ↗
                  </Link>
                ))}
                {!team.projects.length && (
                  <p className="muted">No projects assigned.</p>
                )}
              </div>
              {team._count.projects > team.projects.length && (
                <Link className="text-link" href="/projects">
                  View all projects ↗
                </Link>
              )}
            </div>
          </section>
        ))}
      </div>
      {!teams.length && (
        <section className="panel">
          <Empty title="No teams found">
            Try another search term to see the teams in this workspace.
          </Empty>
        </section>
      )}
      <Pagination
        path="/teams"
        values={{ q }}
        page={page}
        total={total}
        size={TEAM_PAGE_SIZE}
      />
    </div>
  );
}
