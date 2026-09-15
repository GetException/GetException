export const PROJECT_RECOVERY_MS = 7 * 86400_000;

export function projectPurgeAt(deletedAt: Date) {
  return new Date(deletedAt.getTime() + PROJECT_RECOVERY_MS);
}
