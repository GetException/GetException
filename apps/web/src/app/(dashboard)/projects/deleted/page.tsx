import Link from "next/link";
import { dashboardOwner } from "../../../../server/dashboard";
import { getRuntime } from "../../../../server/runtime";
import { dateTime } from "../../../../lib/format";
import { projectPurgeAt } from "../../../../lib/project-lifecycle";
import { PAGE_SIZE } from "../../../../lib/pagination";
import { pageNumber, type Search } from "../../../../lib/search-params";
import { Pagination } from "../../../../components/dashboard/Pagination";
import { Empty } from "../../../../components/dashboard/Empty";
import { RestoreProjectForm } from "../../../../components/projects/RestoreProjectForm";

export default async function DeletedProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { member } = await dashboardOwner();
  const page = pageNumber((await searchParams).page);
  const { db } = getRuntime();
  const where = {
    organizationId: member.organizationId,
    deletedAt: { not: null },
  };
  const [projects, total] = await Promise.all([
    db.project.findMany({
      where,
      orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.project.count({ where }),
  ]);

  return (
    <div className="page narrow">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span>›</span>
        <span>Deleted projects</span>
      </nav>
      <h1>Deleted projects</h1>
      <p className="muted">
        Ingestion is stopped. Restore a project within seven days to keep its
        DSN and data. After the deadline, background cleanup removes it
        permanently. The deletion audit remains; backups expire under the
        server's backup policy.
      </p>
      {projects.length ? (
        projects.map((project) => {
          const purgeAt = projectPurgeAt(project.deletedAt!);

          return (
            <section className="panel form-panel" key={project.id}>
              <h2>{project.name}</h2>
              <p className="muted mono">{project.slug}</p>
              <p>Recovery deadline: {dateTime(purgeAt)}</p>
              {purgeAt.getTime() > Date.now() ? (
                <RestoreProjectForm id={project.id} />
              ) : (
                <p className="muted">
                  Recovery period ended. Permanent deletion is queued or in
                  progress.
                </p>
              )}
            </section>
          );
        })
      ) : (
        <Empty title="No deleted projects">
          Projects scheduled for deletion will appear here.
        </Empty>
      )}
      <Pagination
        path="/projects/deleted"
        values={{}}
        page={page}
        total={total}
      />
    </div>
  );
}
