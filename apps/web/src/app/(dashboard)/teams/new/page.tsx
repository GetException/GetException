import { dashboardOwner } from "../../../../server/dashboard";
import { getRuntime } from "../../../../server/runtime";
import { TeamForm } from "../../../../components/teams/TeamForm";
import { Heading } from "../../../../components/dashboard/Heading";

export default async function NewTeamPage() {
  const { member } = await dashboardOwner();
  const { db } = getRuntime();
  const [members, projects] = await Promise.all([
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

  return (
    <div className="page">
      <Heading
        title="Create team"
        description="Connect people to the applications they work on."
      />
      <section className="panel form-panel">
        <TeamForm
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
