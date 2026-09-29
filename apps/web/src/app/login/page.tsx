import { redirect } from "next/navigation";
import { LoginForm } from "../../components/forms/LoginForm";
import { AuthShell } from "../../components/forms/AuthShell";
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
    <AuthShell>
      <h1>Sign in</h1>
      <p className="muted">
        Enter your login email, password and the current code from your
        authenticator.
      </p>
      {(await searchParams).registered === "1" && (
        <p role="status">
          Your account is ready. Sign in to open your workspace.
        </p>
      )}
      <LoginForm />
      {(await searchParams).access === "inactive" && (
        <p role="alert" className="alert">
          Your account has no active workspace access. Ask an Owner to activate
          your membership, or open your invitation link to join.
        </p>
      )}
    </AuthShell>
  );
}
