import { buildContextSchema } from "@getexception/protocol";
import { projectApi } from "./api";
import type { CiCredential } from "./credentials";

export async function buildContext(
  address: string,
  project: string,
  credential: CiCredential,
  transport: typeof fetch = fetch,
) {
  return buildContextSchema.parse(
    await projectApi(address, project, credential, transport)("/ci", "POST"),
  );
}
