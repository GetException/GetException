import { RequiredMfaEnrollment } from "../../components/forms/RequiredMfaEnrollment";

export const dynamic = "force-dynamic";

export default function TwoFactorPage() {
  return (
    <main className="auth-shell">
      <div className="auth-intro">
        <a href="/login" className="brand">
          <span className="brand-icon">∴</span>GetException
        </a>
        <div>
          <span className="eyebrow">PROTECT YOUR ACCOUNT</span>
          <h1>
            One more step.
            <br />A safer workspace.
          </h1>
          <p>Every account uses two-factor authentication.</p>
        </div>
        <span className="muted small">Private by design.</span>
      </div>
      <section className="auth-panel">
        <span className="eyebrow">AUTHENTICATOR REQUIRED</span>
        <h2>Set up two-factor authentication</h2>
        <RequiredMfaEnrollment />
      </section>
    </main>
  );
}
