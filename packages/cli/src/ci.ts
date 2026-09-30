import { ciContextSchema } from "@getexception/protocol";
import { projectApi } from "./api";
import type { CiCredential } from "./credentials";
import { CliError } from "./diagnostics";

export async function buildContext(
  address: string,
  project: string,
  credential: CiCredential,
  transport: typeof fetch = fetch,
) {
  const result = ciContextSchema.safeParse(
    await projectApi(address, project, credential, transport, {
      deadlineMs: 10_000,
      requestTimeoutMs: 10_000,
    })("/ci?version=2", "POST"),
  );

  if (!result.success) {
    throw new CliError("CONTRACT_RESPONSE", 200);
  }

  return result.data;
}
