import { CliError } from "./diagnostics";

export type CiCredential = string | { gitlabIdToken: string };

export function ciCredential(
  env: Record<string, string | undefined> = process.env,
): CiCredential {
  if (env.GETEXCEPTION_GITLAB_ID_TOKEN && env.GETEXCEPTION_UPLOAD_TOKEN) {
    throw new CliError("CLI_CONFIGURATION");
  }

  return env.GETEXCEPTION_GITLAB_ID_TOKEN
    ? { gitlabIdToken: env.GETEXCEPTION_GITLAB_ID_TOKEN }
    : (env.GETEXCEPTION_UPLOAD_TOKEN ?? "");
}

export function authorizationHeader(credential: CiCredential): string {
  if (typeof credential === "string") {
    if (!/^[a-f0-9]{64}$/.test(credential)) {
      throw new CliError("CLI_CONFIGURATION");
    }

    return `Bearer ${credential}`;
  }

  if (
    credential.gitlabIdToken.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      credential.gitlabIdToken,
    )
  ) {
    throw new CliError("CI_TOKEN_INVALID");
  }

  return `GitLab ${credential.gitlabIdToken}`;
}
