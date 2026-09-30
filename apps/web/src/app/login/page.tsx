import { redirect } from "next/navigation";
import { LoginForm } from "../../components/forms/LoginForm";
import { Brand } from "../../components/branding/Brand";
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
    <main className="auth-shell auth-shell-split">
      <div className="auth-intro">
        <Brand href="/login" />
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
          Enter your email, password and current authenticator code.
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
            activate your membership, or open your invitation link to join.
          </p>
        )}
      </section>
    </main>
  );
}
