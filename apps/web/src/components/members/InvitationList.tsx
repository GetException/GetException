import { dateTime } from "../../lib/format";
import { InvitationActions } from "./InvitationActions";

export function InvitationList({
  invitations,
}: {
  invitations: {
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: Date;
  }[];
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Invitations</h2>
        <span className="muted small">Latest 100</span>
      </div>
      {invitations.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Expires · UTC</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => {
                const expired =
                  invitation.status === "pending" &&
                  invitation.expiresAt.getTime() <= Date.now();

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
    </section>
  );
}
