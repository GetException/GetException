import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SetupForm } from "../../components/forms/SetupForm";
import { getRuntime } from "../../server/runtime";
import { SETUP_COOKIE } from "../../server/http";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const { db, service, config } = getRuntime();

  if (await db.systemSetting.findUnique({ where: { id: 1 } })) {
    redirect("/login");
  }

  let access = false;

  try {
    await service.setupSession(
      (await cookies()).get(SETUP_COOKIE)?.value ?? "",
    );
    access = true;
  } catch {
    /* An unverified visitor sees only the token gate. */
  }

  return (
    <main className="auth-shell">
      <div className="auth-intro">
        <a href="/setup" className="brand">
          <span className="brand-icon">∴</span>GetException
        </a>
        <div>
          <span className="eyebrow">FIRST THINGS FIRST</span>
          <h1>
            A clear view
            <br />
            of what went wrong.
          </h1>
          <p>
            Private error monitoring.
            <br />
            Built around your applications.
          </p>
        </div>
        <span className="muted small">Your infrastructure. Your data.</span>
      </div>
      <section className="auth-panel">
        <span className="eyebrow">WELCOME ABOARD</span>
        <h2>Set up your workspace</h2>
        <SetupForm
          access={access}
          domain={new URL(config.DASHBOARD_ORIGIN).hostname}
        />
      </section>
    </main>
  );
}
