export type CiCredential = string | { gitlabIdToken: string };

export function ciCredential(
  env: Record<string, string | undefined> = process.env,
): CiCredential {
  if (env.GETEXCEPTION_GITLAB_ID_TOKEN && env.GETEXCEPTION_UPLOAD_TOKEN) {
    throw new Error("Choose one CI authentication method");
  }

  return env.GETEXCEPTION_GITLAB_ID_TOKEN
    ? { gitlabIdToken: env.GETEXCEPTION_GITLAB_ID_TOKEN }
    : (env.GETEXCEPTION_UPLOAD_TOKEN ?? "");
}

export function authorizationHeader(credential: CiCredential): string {
  if (typeof credential === "string") {
    if (!/^[a-f0-9]{64}$/.test(credential)) {
      throw new Error(
        "Set GETEXCEPTION_UPLOAD_TOKEN or GETEXCEPTION_GITLAB_ID_TOKEN",
      );
    }

    return `Bearer ${credential}`;
  }

  if (
    credential.gitlabIdToken.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      credential.gitlabIdToken,
    )
  ) {
    throw new Error("Invalid GitLab build identity");
  }

  return `GitLab ${credential.gitlabIdToken}`;
}
