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
import { tableSort, sortValues } from "../../../lib/table-sort";
import { memberPageIds, invitationPageIds } from "../../../server/members/list";
import { inPageOrder } from "../../../server/table-order";
import { SortableTableHead } from "../../../components/dashboard/SortableTableHead";
import { SortFields } from "../../../components/dashboard/SortFields";

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
  const sorting = tableSort(search, "members");
  const invitationSorting = tableSort(search, "invitations", "invite");
  const invitePage = pageNumber(search.invitePage);
  const now = new Date();
  const values = {
    q,
    page,
    ...sorting,
    invitePage,
    ...sortValues(invitationSorting, "invite"),
  };
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
  const [ids, invitationIds] = await Promise.all([
    memberPageIds(db, member, q, sorting, page),
    invitationPageIds(db, member, invitationSorting, invitePage, now),
  ]);
  const [rows, total] = await Promise.all([
    db.member.findMany({
      where: { ...where, id: { in: ids.map(({ id }) => id) } },
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
        teams: {
          orderBy: { team: { name: "asc" } },
          select: { team: { select: { name: true } } },
        },
      },
    }),
    db.member.count({ where }),
  ]);

  const members = inPageOrder(rows, ids);
  const [teams, invitationRows, invitationTotal] = await Promise.all([
    db.team.findMany({
      where: { organizationId: member.organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.invitation.findMany({
      where: {
        organizationId: member.organizationId,
        id: { in: invitationIds.map(({ id }) => id) },
      },
      take: PAGE_SIZE,
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
      },
    }),
    db.invitation.count({ where: { organizationId: member.organizationId } }),
  ]);
  const invitations = inPageOrder(invitationRows, invitationIds);

  return (
    <div className="page">
      <Heading
        title="Members"
        description="Workspace membership, access roles, and account protection."
      />
      <section className="panel">
        <form key={q} className="filters" method="get">
          <SortFields sorting={sorting} />
          <SortFields sorting={invitationSorting} prefix="invite" />
          <input type="hidden" name="invitePage" value={invitePage} />
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
              <SortableTableHead
                table="members"
                sorting={sorting}
                path="/members"
                values={values}
              />
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
        <Pagination path="/members" values={values} page={page} total={total} />
      </section>
      <InvitationList
        invitations={invitations}
        sorting={invitationSorting}
        values={values}
        page={invitePage}
        total={invitationTotal}
        now={now}
      />
      <section className="panel form-panel" id="invite">
        <h2>Invite a teammate</h2>
        <p className="muted security-intro">
          Choose their role and teams. After identity confirmation, copy the
          one-time link and send it through a trusted private channel.
        </p>
        <InvitationForm teams={teams} />
      </section>
    </div>
  );
}
