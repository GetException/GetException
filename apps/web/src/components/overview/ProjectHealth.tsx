import Link from "next/link";
import { number } from "../../lib/format";
import { linkTo } from "../../lib/search-params";
import type { ActivityFilters } from "../../lib/activity";
import type { ProjectHealth as Health } from "../../server/analytics/overview";
import { Empty } from "../dashboard/Empty";

export function ProjectHealth({
  projects,
  filters,
}: {
  projects: Health[];
  filters: ActivityFilters;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Activity by project</h2>
          <p className="muted">Projects with the most events in this view</p>
        </div>
        <Link className="text-link" href="/projects">
          All projects ↗
        </Link>
      </div>
      {projects.length ? (
        <div className="project-health">
          {projects.map((project) => (
            <Link
              className="health-row"
              key={project.id}
              href={linkTo("/issues", { ...filters, project: project.id })}
            >
              <span className="project-mark">{project.name.slice(0, 1)}</span>
              <span className="grow">
                <strong>{project.name}</strong>
                <small className="muted">{project.slug}</small>
              </span>
              <span className="health-count">
                <strong>{number(project.openIssues)}</strong>
                <small className="muted">open issues</small>
              </span>
              <span className="muted">{number(project.events)} events</span>
              <span>↗</span>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="No projects in this view">
          Select another project or connect an application.
        </Empty>
      )}
    </section>
  );
}
