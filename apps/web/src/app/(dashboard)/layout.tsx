import { dashboardUser } from "../../server/dashboard";
import { SignOut } from "../../components/forms/SignOut";
import { Navigation } from "../../components/navigation/Navigation";
import { Brand } from "../../components/branding/Brand";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, member } = await dashboardUser();

  return (
    <div className="dashboard-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand href="/" />
        <Navigation role={member.role} />
        <div className="sidebar-footer">
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
        {children}
      </main>
    </div>
  );
}
