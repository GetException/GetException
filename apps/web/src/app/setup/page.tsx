import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SetupForm } from "../../components/forms/SetupForm";
import { AuthShell } from "../../components/forms/AuthShell";
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
    <AuthShell home="/setup">
      <h1>Set up your workspace</h1>
      <SetupForm
        access={access}
        domain={new URL(config.DASHBOARD_ORIGIN).hostname}
      />
    </AuthShell>
  );
}
