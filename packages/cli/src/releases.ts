import { releaseRegistrationSchema } from "@getexception/protocol";
import { projectApi } from "./api";
import type { CiCredential } from "./credentials";

export async function registerRelease(
  address: string,
  project: string,
  token: CiCredential,
  value: unknown,
  transport: typeof fetch = fetch,
) {
  const input = releaseRegistrationSchema.parse(value);

  await projectApi(
    address,
    project,
    token,
    transport,
  )("/releases", "POST", JSON.stringify(input));
}
