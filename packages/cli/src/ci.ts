import { ciContextSchema } from "@getexception/protocol";
import { projectApi } from "./api";
import type { CiCredential } from "./credentials";

export async function buildContext(
  address: string,
  project: string,
  credential: CiCredential,
  transport: typeof fetch = fetch,
) {
  return ciContextSchema.parse(
    await projectApi(
      address,
      project,
      credential,
      transport,
    )("/ci?version=2", "POST"),
  );
}
