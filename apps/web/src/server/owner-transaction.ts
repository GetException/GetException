import type { Transaction } from "@getexception/db";
import type { AuthService } from "./auth-service";
import { AuthError } from "./auth-error";
import { requireOwner } from "./access";

export async function ownerTransaction<T>(
  service: AuthService,
  headers: Headers,
  action: (
    tx: Transaction,
    current: Awaited<ReturnType<AuthService["authorize"]>>,
  ) => Promise<T>,
) {
  requireOwner((await service.authorize(headers)).member);
  const current = await service.authorize(headers, true);

  return service.db.$transaction(
    async (tx) => {
      // Serializes permission changes and last-owner checks across concurrent requests.
      await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${current.member.organizationId} FOR UPDATE`;
      const member = await tx.member.findUnique({
        where: { id: current.member.id },
      });
      const session = await tx.session.findUnique({
        where: { id: current.session.id },
      });

      if (!member?.active || member.role !== "owner" || !session) {
        throw new AuthError(403);
      }

      return action(tx, current);
    },
    { timeout: 15000 },
  );
}
