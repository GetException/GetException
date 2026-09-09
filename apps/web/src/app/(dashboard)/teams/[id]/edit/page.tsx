import { notFound } from "next/navigation";
import { dashboardOwner } from "../../../../../server/dashboard";
import { getRuntime } from "../../../../../server/runtime";
import { TeamForm } from "../../../../../components/teams/TeamForm";
import { Heading } from "../../../../../components/dashboard/Heading";

export default async function EditTeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { member } = await dashboardOwner();
  const { id } = await params;
  const { db } = getRuntime();
  const [team, members, projects] = await Promise.all([
    db.team.findFirst({
      where: { id, organizationId: member.organizationId },
      include: { members: true, projects: true },
    }),
    db.member.findMany({
      where: { organizationId: member.organizationId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.project.findMany({
      where: { organizationId: member.organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!team) {
    notFound();
  }

  return (
    <div className="page">
      <Heading
        title={`Edit ${team.name}`}
        description="Manage this team's members and project access."
      />
      <section className="panel form-panel">
        <TeamForm
          team={{
            id: team.id,
            name: team.name,
            memberIds: team.members.map((value) => value.memberId),
            projectIds: team.projects.map((value) => value.projectId),
          }}
          members={members.map((entry) => ({
            id: entry.id,
            label: `${entry.user.name} · ${entry.user.email}`,
          }))}
          projects={projects.map((project) => ({
            id: project.id,
            label: project.name,
          }))}
        />
      </section>
    </div>
  );
}
