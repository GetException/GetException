import Link from "next/link";
import { dashboardUser } from "../../server/dashboard";
import { getRuntime } from "../../server/runtime";
import { SignOut } from "../../components/forms/SignOut";
import { Location } from "../../components/navigation/Location";
import { Navigation } from "../../components/navigation/Navigation";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, member } = await dashboardUser();
  const workspace = await getRuntime().db.organization.findUniqueOrThrow({
    where: { id: member.organizationId },
    select: { name: true },
  });

  return (
    <div className="dashboard-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-icon">∴</span>GetException
        </Link>
        <div className="workspace-switch">
          <span className="avatar">{workspace.name.slice(0, 1)}</span>
          <div>
            {workspace.name}
            <small>Private workspace</small>
          </div>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <Navigation role={member.role} />
        <div className="sidebar-footer">
          <span className="live-dot" /> Private monitoring
          <div className="profile">
            <span className="avatar purple">{user.name.slice(0, 1)}</span>
            <div className="profile-name">
              {user.name}
              <small title={user.email}>{user.email}</small>
              <small className="role-badge">{member.role}</small>
            </div>
          </div>
          <SignOut />
        </div>
      </aside>
      <main className="main-content" id="main">
        <header className="topbar">
          <Location />
          <span className="top-badge">SELF-HOSTED</span>
        </header>
        {children}
      </main>
    </div>
  );
}
