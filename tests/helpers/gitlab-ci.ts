import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SignJWT } from "jose";

export const ciProject = "aef99328-6d32-4c52-9e94-999f79528257";

export const ciSha = "a".repeat(40);

export const ciIssuer = "https://gitlab.example.test";

export const ciAudience = "https://monitor.example.test";

export const ciRepository = "company/frontend/account";

export const ciFork = {
  repositoryId: 321,
  repositoryPath: "developer/account",
};

export const ciForkClaims = {
  project_id: String(ciFork.repositoryId),
  project_path: ciFork.repositoryPath,
  job_project_id: String(ciFork.repositoryId),
  job_project_path: ciFork.repositoryPath,
  ci_config_ref_uri: `gitlab.example.test/${ciFork.repositoryPath}//.gitlab-ci.yml@refs/heads/feature`,
};

// GitLab 19.3.2 uses the execution project's config URI even for a fork MR.
export const ciForkParentClaims = {
  ...ciForkClaims,
  job_project_id: "123",
  job_project_path: ciRepository,
  ci_config_ref_uri: `gitlab.example.test/${ciRepository}//.gitlab-ci.yml@refs/heads/feature`,
};

export function gitlabFixture(projectId = ciProject) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "ci-test-key",
    alg: "RS256",
    use: "sig",
  };
  const policy = {
    issuer: ciIssuer,
    jwks: { keys: [jwk] },
    projects: [
      {
        projectId,
        repositoryId: 123,
        repositoryPath: ciRepository,
        releasePrefix: "account",
        productionEnvironment: "production/app",
        productionRefs: ["refs/heads/stable", "refs/tags/v*"],
      },
    ],
  };

  async function sign(
    changes: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
  ) {
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({
      iss: ciIssuer,
      aud: ciAudience,
      sub: `project_path:${ciRepository}:ref_type:branch:ref:feature`,
      iat: now,
      nbf: now,
      exp: now + 1800,
      jti: randomUUID(),
      project_id: "123",
      project_path: ciRepository,
      job_project_id: "123",
      job_project_path: ciRepository,
      job_id: "456",
      pipeline_id: "789",
      pipeline_source: "merge_request_event",
      sha: ciSha,
      ref: "feature",
      ref_type: "branch",
      ref_path: "refs/heads/feature",
      ref_protected: "false",
      environment: "review/pr-554",
      ci_config_ref_uri: `gitlab.example.test/${ciRepository}//.gitlab-ci.yml@refs/heads/feature`,
      ci_config_sha: ciSha,
      ...changes,
    })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid, typ: "JWT", ...header })
      .sign(privateKey);
  }

  return { policy, sign, privateKey };
}
