import { redirect } from "next/navigation";
import { LoginForm } from "../../components/forms/LoginForm";
import { getRuntime } from "../../server/runtime";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ registered?: string; access?: string }>;
}) {
  if (!(await getRuntime().db.systemSetting.findUnique({ where: { id: 1 } }))) {
    redirect("/setup");
  }

  return (
    <main className="auth-shell">
      <div className="auth-intro">
        <a href="/login" className="brand">
          <span className="brand-icon">∴</span>GetException
        </a>
        <div>
          <span className="eyebrow">LESS NOISE. MORE CLARITY.</span>
          <h1>
            Find the cause.
            <br />
            Move forward.
          </h1>
          <p>
            Your applications deserve
            <br />a little peace of mind.
          </p>
        </div>
        <span className="muted small">Private by design.</span>
      </div>
      <section className="auth-panel">
        <span className="eyebrow">YOUR WORKSPACE</span>
        <h2>Welcome back</h2>
        <p className="muted">
          Sign in with your password. Enter an authenticator code if two-factor
          authentication is enabled.
        </p>
        {(await searchParams).registered === "1" && (
          <p role="status">
            Your account is ready. Sign in to open your workspace.
          </p>
        )}
        <LoginForm />
        {(await searchParams).access === "inactive" && (
          <p role="alert" className="alert">
            Your account has no active workspace access. Ask an Owner to
            activate your membership, or open your invitation email to join.
          </p>
        )}
      </section>
    </main>
  );
}
