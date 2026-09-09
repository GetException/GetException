import { notFound } from "next/navigation";
import { dashboardOwner } from "../../../../server/dashboard";
import { getRuntime } from "../../../../server/runtime";
import { Heading } from "../../../../components/dashboard/Heading";
import { MemberForm } from "../../../../components/members/MemberForm";

export default async function MemberPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { member: current } = await dashboardOwner();
  const { id } = await params;
  const { db } = getRuntime();
  const [member, teams] = await Promise.all([
    db.member.findFirst({
      where: { id, organizationId: current.organizationId },
      include: { user: true, teams: true },
    }),
    db.team.findMany({
      where: { organizationId: current.organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!member) {
    notFound();
  }

  return (
    <div className="page">
      <Heading
        title={`Access for ${member.user.name}`}
        description={member.user.email}
      />
      <section className="panel form-panel">
        <MemberForm
          member={{
            id: member.id,
            role: member.role,
            active: member.active,
            mfa: member.user.twoFactorEnabled,
            teamIds: member.teams.map((value) => value.teamId),
          }}
          teams={teams}
        />
      </section>
    </div>
  );
}
