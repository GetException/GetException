import Link from "next/link";
import { notFound } from "next/navigation";
import { dashboardOwner } from "../../../../../server/dashboard";
import { projectScope } from "../../../../../server/access";
import { getRuntime } from "../../../../../server/runtime";
import { EditProjectForm } from "../../../../../components/projects/EditProjectForm";
import { DeleteProjectForm } from "../../../../../components/projects/DeleteProjectForm";
import { SourceMapTokens } from "../../../../../components/projects/SourceMapTokens";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { member } = await dashboardOwner();
  const { id } = await params;
  const project = await getRuntime().db.project.findFirst({
    where: { id, ...projectScope(member) },
    include: {
      origins: { orderBy: { origin: "asc" } },
      sourceMapTokens: {
        select: { id: true, name: true, expiresAt: true, revokedAt: true },
        orderBy: [
          { revokedAt: { sort: "asc", nulls: "first" } },
          { expiresAt: "desc" },
        ],
        take: 30,
      },
    },
  });

  if (!project) {
    notFound();
  }

  return (
    <div className="page narrow">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span>›</span>
        <Link href={`/projects/${id}`}>{project.name}</Link>
        <span>›</span>
        <span>Settings</span>
      </nav>
      <h1>Project settings</h1>
      <p className="muted">
        Manage {project.name}. Updating its name, slug or origins keeps the
        existing DSN and collected data.
      </p>
      <section className="panel form-panel">
        <h2>General settings</h2>
        <EditProjectForm
          project={{
            id,
            name: project.name,
            slug: project.slug,
            origins: project.origins.map((entry) => entry.origin),
          }}
        />
      </section>
      <SourceMapTokens
        projectId={id}
        tokens={project.sourceMapTokens.map((token) => ({
          ...token,
          expiresAt: token.expiresAt.toISOString(),
          revokedAt: token.revokedAt?.toISOString() ?? null,
        }))}
      />
      <section className="panel form-panel danger-panel">
        <h2>Delete project</h2>
        <DeleteProjectForm id={id} slug={project.slug} />
      </section>
    </div>
  );
}
