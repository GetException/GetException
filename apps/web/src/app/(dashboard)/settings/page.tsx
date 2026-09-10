import { MfaEnrollment } from "../../../components/forms/MfaEnrollment";
import { MfaDisableForm } from "../../../components/forms/MfaDisableForm";
import { dashboardUser } from "../../../server/dashboard";
import { getRuntime } from "../../../server/runtime";
import { Heading } from "../../../components/dashboard/Heading";
import { StepUpForm } from "../../../components/forms/StepUpForm";
import { dateTime } from "../../../lib/format";

export default async function SettingsPage() {
  const { user, session, member } = await dashboardUser();
  const { db, config } = getRuntime();
  const [workspace, installation] = await Promise.all([
    db.organization.findUniqueOrThrow({
      where: { id: member.organizationId },
      select: { name: true },
    }),
    db.systemSetting.findUniqueOrThrow({ where: { id: 1 } }),
  ]);

  return (
    <div className="page">
      <Heading
        title="Settings"
        description="Your workspace configuration and account security."
      />
      <div className="settings-columns">
        <div>
          <section className="panel">
            <div className="section-heading">
              <h2>Workspace</h2>
            </div>
            <dl className="settings-list">
              <div>
                <dt>Email delivery</dt>
                <dd>{config.MAIL_ENABLED ? "Enabled" : "Disabled"}</dd>
              </div>
              <div>
                <dt>Name</dt>
                <dd>{workspace.name}</dd>
              </div>
              <div>
                <dt>Installation domain</dt>
                <dd className="mono">{installation.domain}</dd>
              </div>
              <div>
                <dt>Ingestion endpoint</dt>
                <dd className="mono">{config.INGEST_ORIGIN}</dd>
              </div>
              <div>
                <dt>Activated</dt>
                <dd>{dateTime(installation.setupCompletedAt)}</dd>
              </div>
            </dl>
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>Data retention</h2>
            </div>
            <dl className="settings-list">
              <div>
                <dt>Individual events</dt>
                <dd>30 days</dd>
              </div>
              <div>
                <dt>Issue history</dt>
                <dd>Kept until the project is deleted</dd>
              </div>
            </dl>
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>Your account</h2>
              <span className="pill role-badge">{member.role}</span>
            </div>
            <dl className="settings-list">
              <div>
                <dt>Email</dt>
                <dd>{user.email}</dd>
              </div>
              <div>
                <dt>Two-factor authentication</dt>
                <dd
                  className={user.twoFactorEnabled ? "success-text" : undefined}
                >
                  {user.twoFactorEnabled
                    ? "Enabled · Authenticator app"
                    : "Not enabled"}
                </dd>
              </div>
              <div>
                <dt>Session expires</dt>
                <dd>{dateTime(session.expiresAt)}</dd>
              </div>
              <div>
                <dt>Last identity confirmation</dt>
                <dd>
                  {session.mfaVerifiedAt
                    ? dateTime(session.mfaVerifiedAt)
                    : "Not confirmed"}
                </dd>
              </div>
            </dl>
          </section>
        </div>
        <section className="panel form-panel" id="security">
          <span className="eyebrow">ACCOUNT SECURITY</span>
          <h2>
            {user.twoFactorEnabled
              ? member.role === "owner"
                ? "Confirm your identity"
                : "Authenticator enabled"
              : "Protect your account"}
          </h2>
          <p className="muted security-intro">
            {user.twoFactorEnabled
              ? member.role === "owner"
                ? "Confirm your password and a new authenticator code before changing projects, invitations or access. Confirmation lasts five minutes."
                : "Enter your authenticator code when signing in. If you lose access to it, use one of your saved recovery codes. Each recovery code works once."
              : "An authenticator adds a second factor to your password. It is required before an Owner can promote you to Owner."}
          </p>
          {member.role === "owner" ? (
            <StepUpForm />
          ) : (
            !user.twoFactorEnabled && <MfaEnrollment />
          )}
          {member.role !== "owner" && user.twoFactorEnabled && (
            <MfaDisableForm />
          )}
        </section>
      </div>
    </div>
  );
}
