import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { getRuntime } from "./runtime";
import { AuthError } from "./auth-error";

export async function dashboardUser() {
  const { service, db } = getRuntime();

  if (!(await db.systemSetting.findUnique({ where: { id: 1 } }))) {
    redirect("/setup");
  }

  try {
    return await service.authorize(await headers());
  } catch (error) {
    if (error instanceof AuthError) {
      redirect(error.status === 403 ? "/login?access=inactive" : "/login");
    }

    throw error;
  }
}

export async function dashboardOwner() {
  const current = await dashboardUser();

  if (current.member.role !== "owner") {
    notFound();
  }

  return current;
}
