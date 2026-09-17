import { releaseRegistrationSchema } from "@getexception/protocol";
import { projectApi } from "./api";

export async function registerRelease(
  address: string,
  project: string,
  token: string,
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
