import Link from "next/link";
import { InvitationForm } from "../../../components/members/InvitationForm";
import { InvitationList } from "../../../components/members/InvitationList";
import { PAGE_SIZE } from "../../../lib/pagination";
import { dashboardOwner } from "../../../server/dashboard";
import { getRuntime } from "../../../server/runtime";
import { Empty } from "../../../components/dashboard/Empty";
import { Heading } from "../../../components/dashboard/Heading";
import { Pagination } from "../../../components/dashboard/Pagination";
import { dateTime } from "../../../lib/format";
import { pageNumber, textParam, type Search } from "../../../lib/search-params";

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { member } = await dashboardOwner();
  const { db } = getRuntime();
  const search = await searchParams;
  const q = textParam(search.q);
  const page = pageNumber(search.page);
  const where = {
    organizationId: member.organizationId,
    ...(q
      ? {
          user: {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
            ],
          },
        }
      : {}),
  };
  const [members, total] = await Promise.all([
    db.member.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        role: true,
        active: true,
        createdAt: true,
        user: {
          select: {
            name: true,
            email: true,
            disabled: true,
            twoFactorEnabled: true,
          },
        },
        teams: { select: { team: { select: { name: true } } } },
      },
    }),
    db.member.count({ where }),
  ]);

  const [teams, invitations] = await Promise.all([
    db.team.findMany({
      where: { organizationId: member.organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.invitation.findMany({
      where: { organizationId: member.organizationId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        mail: { select: { kind: true, status: true } },
      },
    }),
  ]);

  return (
    <div className="page">
      <Heading
        title="Members"
        description="Workspace membership, access roles, and account protection."
      />
      <section className="panel">
        <form className="filters" method="get">
          <label className="filter-field search-field">
            Search members
            <input
              name="q"
              defaultValue={q}
              placeholder="Search by name or email…"
              maxLength={160}
            />
          </label>
          <button className="button">Search</button>
        </form>
        {members.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Teams</th>
                  <th>Two-factor auth</th>
                  <th>Status</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className="project-title">
                        <span className="avatar purple">
                          {entry.user.name.slice(0, 1)}
                        </span>
                        <span>
                          <Link
                            className="text-link"
                            href={`/members/${entry.id}`}
                          >
                            <strong>{entry.user.name}</strong>
                          </Link>
                          <small className="muted">{entry.user.email}</small>
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="pill role-badge">{entry.role}</span>
                    </td>
                    <td>
                      {entry.teams.map((value) => value.team.name).join(", ") ||
                        "—"}
                    </td>
                    <td>
                      <span
                        className={`pill ${entry.user.twoFactorEnabled ? "resolved" : ""}`}
                      >
                        {entry.user.twoFactorEnabled
                          ? "Enabled"
                          : "Not enabled"}
                      </span>
                    </td>
                    <td>
                      {entry.active && !entry.user.disabled
                        ? "Active"
                        : "Inactive"}
                    </td>
                    <td className="muted date-cell">
                      {dateTime(entry.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No matching members">Try another name or email.</Empty>
        )}
        <Pagination path="/members" values={{ q }} page={page} total={total} />
      </section>
      <InvitationList invitations={invitations} />
      <section className="panel form-panel" id="invite">
        <h2>Invite a teammate</h2>
        <p className="muted security-intro">
          Choose their role and teams. Confirm your identity in Settings if
          prompted.
        </p>
        <InvitationForm teams={teams} />
      </section>
    </div>
  );
}
