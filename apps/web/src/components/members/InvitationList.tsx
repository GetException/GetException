import { dateTime } from "../../lib/format";
import { InvitationActions } from "./InvitationActions";
import { SortableTableHead } from "../dashboard/SortableTableHead";
import { Pagination } from "../dashboard/Pagination";
import type { TableSort } from "../../lib/table-sort";

export function InvitationList({
  invitations,
  sorting,
  values,
  page,
  total,
  now,
}: {
  sorting: TableSort;
  values: Record<string, string | number | undefined>;
  page: number;
  total: number;
  now: Date;
  invitations: {
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: Date;
  }[];
}) {
  return (
    <section className="panel" id="invitations">
      <div className="section-heading">
        <h2>Invitations</h2>
      </div>
      {invitations.length ? (
        <div className="table-scroll">
          <table>
            <SortableTableHead
              table="invitations"
              sorting={sorting}
              path="/members"
              values={values}
              prefix="invite"
            >
              <th scope="col">Actions</th>
            </SortableTableHead>
            <tbody>
              {invitations.map((invitation) => {
                const expired =
                  invitation.status === "pending" &&
                  invitation.expiresAt.getTime() <= now.getTime();

                return (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td className="role-badge">{invitation.role}</td>
                    <td>
                      <span className="pill">
                        {expired ? "expired" : invitation.status}
                      </span>
                    </td>
                    <td>{dateTime(invitation.expiresAt)}</td>
                    <td>
                      {["pending", "expired"].includes(invitation.status) && (
                        <InvitationActions id={invitation.id} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="content-note">
          No invitations yet. Create a personal link using the form below.
        </p>
      )}
      {total > 0 && (
        <Pagination
          path="/members"
          values={values}
          page={page}
          total={total}
          pageParam="invitePage"
        />
      )}
    </section>
  );
}
