import { projectScope } from "../../../../server/access";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRuntime } from "../../../../server/runtime";
import { dashboardUser } from "../../../../server/dashboard";
import { Stat } from "../../../../components/dashboard/Stat";
import { dateTime, number } from "../../../../lib/format";
import { linkTo } from "../../../../lib/search-params";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { member } = await dashboardUser();
  const { id } = await params;
  const { db } = getRuntime();
  const project = await db.project.findFirst({
    where: { id, ...projectScope(member) },
    include: {
      origins: true,
      teams: { include: { team: { select: { name: true } } } },
      keys: {
        select: { id: true, createdAt: true, revokedAt: true, expiresAt: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
      _count: {
        select: {
          issues: { where: { status: "open" } },
          events: true,
          releases: true,
        },
      },
    },
  });

  if (!project) {
    notFound();
  }

  return (
    <div className="page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span>›</span>
        <span>{project.name}</span>
      </nav>
      <div className="page-heading">
        <div>
          <h1>{project.name}</h1>
          <p className="muted mono">{project.slug}</p>
        </div>
        <div className="actions">
          <Link
            className="button"
            href={linkTo("/releases", { project: project.id })}
          >
            View releases
          </Link>
          <Link
            className="button primary"
            href={linkTo("/issues", { project: project.id })}
          >
            View issues ↗
          </Link>
        </div>
      </div>
      <div className="stats-grid">
        <Stat
          label="Open issues"
          value={project._count.issues}
          caption="Current investigation queue"
        />
        <Stat
          label="Retained events"
          value={project._count.events}
          caption="Available for investigation"
        />
        <Stat
          label="Releases"
          value={project._count.releases}
          caption="Application versions received"
        />
        <Stat
          label="Daily quota"
          value={project.dailyQuota}
          caption="Maximum accepted events per day"
        />
      </div>
      <div className="settings-columns">
        <div>
          <section className="panel">
            <div className="section-heading">
              <h2>Project details</h2>
              <span className="pill resolved">
                {project.enabled ? "Active" : "Disabled"}
              </span>
            </div>
            <dl className="settings-list">
              <div>
                <dt>Project identifier</dt>
                <dd className="mono">{project.id}</dd>
              </div>
              <div>
                <dt>Teams</dt>
                <dd>
                  {project.teams.map((value) => value.team.name).join(", ") ||
                    "No teams assigned"}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{dateTime(project.createdAt)}</dd>
              </div>
              <div>
                <dt>Allowed tags</dt>
                <dd className="tag-cloud">
                  {project.allowedTags.map((tag) => (
                    <span className="pill mono" key={tag}>
                      {tag}
                    </span>
                  ))}
                </dd>
              </div>
            </dl>
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>Allowed origins</h2>
              <span className="count-badge">{project.origins.length}</span>
            </div>
            <div className="origin-list">
              {project.origins.map((origin) => (
                <div className="mono" key={origin.origin}>
                  <span className="live-dot" />
                  {origin.origin}
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>Ingestion keys</h2>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Created</th>
                    <th>Status</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {project.keys.map((key) => (
                    <tr key={key.id}>
                      <td>{dateTime(key.createdAt)}</td>
                      <td>
                        <span className="pill">
                          {key.revokedAt
                            ? "Revoked"
                            : key.expiresAt &&
                                key.expiresAt.getTime() < Date.now()
                              ? "Expired"
                              : "Active"}
                        </span>
                      </td>
                      <td>
                        {key.expiresAt
                          ? dateTime(key.expiresAt)
                          : "No expiration"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="content-note">
              Your DSN is shown once when the project is created. Saved key
              values cannot be revealed again.
            </p>
          </section>
        </div>
        <section className="panel integration-panel">
          <div className="section-heading">
            <h2>Connect your application</h2>
          </div>
          <div className="integration-content">
            <p className="muted">
              Initialize the SDK with the DSN you saved when creating this
              project.
            </p>
            <pre className="code-block">
              <code>{`import * as GetException from "@getexception/browser";\n\nGetException.init({\n  dsn: "<YOUR_SAVED_DSN>",\n  environment: "production",\n  release: "${project.slug}@<40_CHARACTER_GIT_SHA>",\n});\n\nGetException.captureException(\n  new Error("My first error")\n);`}</code>
            </pre>
            <p className="muted small">
              Use <code>@getexception/react</code> in a React application for
              ErrorBoundary support.
            </p>
            <div className="integration-note">
              <strong>{number(project.dailyQuota)} events / day</strong>
              <p className="muted small">
                Errors beyond this limit are declined. Individual events are
                retained for 30 days.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
